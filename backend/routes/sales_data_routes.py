"""Sales Data dashboard (owner/admin only) — revenue by floor, by
architect/interior-designer referrer, and by brand. Revenue comes from the
current `ordered` workflow state, plus legacy `won` records that pre-date
that state. Aggregation happens in Python over an in-memory list —
matches the existing dashboard_routes.py convention — rather than a Mongo
pipeline, since won-quotation volume stays small and this is far easier to
unit-test against the codebase's existing fake-db pattern. See
docs/superpowers/specs/2026-07-27-sales-data-dashboard-design.md."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import accessible_floor_ids, require_roles
from db import db
from models import ReferrerType, UserPublic
from services.pricing import per_line_net_amounts

router = APIRouter(prefix="/sales-data", tags=["sales-data"])

Granularity = Literal["day", "month", "quarter", "year"]
CONFIRMED_STATUSES = ("ordered", "won")


def _bucket_label(iso_ts: str, granularity: Granularity) -> str:
    dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    if granularity == "day":
        return dt.strftime("%Y-%m-%d")
    if granularity == "month":
        return dt.strftime("%Y-%m")
    if granularity == "year":
        return dt.strftime("%Y")
    q = (dt.month - 1) // 3 + 1
    return f"{dt.year}-Q{q}"


def _resolve_floor_ids(user: UserPublic, floor_id: Optional[str]) -> Optional[list[str]]:
    """Combines the caller's own floor access with the Floor filter the
    frontend sent. None means "no floor restriction" (query every floor).

    Every route in this file is already gated to owner/admin via
    `require_roles` — company-wide sales reporting, not day-to-day
    floor-scoped ops — so an explicit single-floor filter is still honored
    and still checked against the caller's own assignment (an admin
    restricted to Ground Floor can't peek at First Floor numbers by typing
    a different floor_id), but the "Both"/unset case returns every floor
    unconditionally instead of silently narrowing to `accessible_floor_ids`.
    That narrowing is correct for operational screens (Quotations,
    Purchases) but was wrong here: an `admin` (not `owner`/`manager`) has
    `has_all_floor_access() == False`, so "Both floors" would silently
    shrink to just that admin's own `floor_ids` even though this endpoint
    already requires an elevated role to reach at all."""
    if floor_id and floor_id != "both":
        allowed = accessible_floor_ids(user)
        if allowed is not None and floor_id not in allowed:
            raise HTTPException(status_code=403, detail="You do not have access to this floor")
        return [floor_id]
    # Delegated reporting keeps the operation's granted floors even when
    # the caller selects the combined view or omits a floor filter.
    return accessible_floor_ids(user) if user.custom_access else None


def _revenue_timestamp(quotation: dict) -> Optional[str]:
    """Return the immutable revenue date, with a legacy compatibility path.

    New orders are always dated from their write-once ``ordered_at`` value.
    Historic ``won`` documents pre-date that field, so retaining their
    existing ``updated_at`` date avoids silently dropping prior revenue while
    those records are migrated. New reporting must never use ``updated_at``
    for an ``ordered`` document.
    """
    if quotation.get("status") == "ordered":
        return quotation.get("ordered_at")
    return quotation.get("updated_at") or quotation.get("created_at")


async def _confirmed_quotations(
    floor_ids: Optional[list[str]], date_from: Optional[str], date_to: Optional[str],
) -> list[dict]:
    query: dict = {"status": {"$in": list(CONFIRMED_STATUSES)}}
    if floor_ids is not None:
        query["floor_id"] = {"$in": floor_ids}
    if date_from or date_to:
        rng: dict = {}
        if date_from:
            rng["$gte"] = date_from
        if date_to:
            rng["$lte"] = date_to
        # Keep the date predicate aligned with the status that produced the
        # revenue. This allows old records to remain visible without letting
        # an edit move a current order into a different reporting period.
        query["$or"] = [
            {"status": "ordered", "ordered_at": rng},
            {"status": "won", "updated_at": rng},
        ]
    return await db.quotations.find(query, {"_id": 0}).to_list(10000)


@router.get("/overview")
async def sales_overview(
    floor_id: Optional[str] = Query(None),
    referrer_type: Optional[ReferrerType] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    granularity: Granularity = Query("month"),
    user: UserPublic = Depends(require_roles("owner", "admin")),
):
    floor_ids = _resolve_floor_ids(user, floor_id)
    quotations = await _confirmed_quotations(floor_ids, date_from, date_to)

    if referrer_type:
        quotations = [q for q in quotations if q.get("referrer_type") == referrer_type]

    total_revenue = round(sum(q.get("grand_total", 0) for q in quotations), 2)

    by_floor: dict[str, float] = defaultdict(float)
    for q in quotations:
        by_floor[q.get("floor_id", "unknown")] += q.get("grand_total", 0)
    revenue_by_floor = [{"floor_id": fid, "revenue": round(rev, 2)} for fid, rev in by_floor.items()]

    trend_map: dict[str, float] = defaultdict(float)
    for q in quotations:
        ts = _revenue_timestamp(q)
        if ts:
            trend_map[_bucket_label(ts, granularity)] += q.get("grand_total", 0)
    trend = [{"bucket": k, "revenue": round(v, 2)} for k, v in sorted(trend_map.items())]

    referrers = None
    if referrer_type:
        by_referrer: dict[str, dict] = {}
        for q in quotations:
            rid = q.get("referrer_id")
            if not rid:
                continue
            entry = by_referrer.setdefault(
                rid, {"referrer_id": rid, "name": q.get("referrer_name") or "Unknown", "revenue": 0.0},
            )
            entry["revenue"] += q.get("grand_total", 0)
        referrers = sorted(
            ({**e, "revenue": round(e["revenue"], 2)} for e in by_referrer.values()),
            key=lambda e: e["revenue"], reverse=True,
        )

    return {
        "total_revenue": total_revenue,
        "quotation_count": len(quotations),
        "revenue_by_floor": revenue_by_floor,
        "trend": trend,
        "referrers": referrers,
    }


@router.get("/referrers/{referrer_id}")
async def referrer_detail(
    referrer_id: str,
    floor_id: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    granularity: Granularity = Query("month"),
    user: UserPublic = Depends(require_roles("owner", "admin")),
):
    floor_ids = _resolve_floor_ids(user, floor_id)
    quotations = await _confirmed_quotations(floor_ids, date_from, date_to)
    quotations = [q for q in quotations if q.get("referrer_id") == referrer_id]

    referrer_query = {"id": referrer_id}
    if user.custom_access:
        referrer_query["floor_id"] = {"$in": floor_ids or []}
    referrer = await db.referrers.find_one(referrer_query, {"_id": 0})
    if not referrer:
        if not quotations:
            raise HTTPException(status_code=404, detail="Referrer not found")
        # The referrer record was renamed/deleted after being credited on a
        # won quotation — a real revenue history shouldn't dead-end into a
        # 404 just because the lookup doc is gone; fall back to whatever
        # was already denormalized onto the quotation at the time.
        sample = quotations[0]
        referrer = {
            "id": referrer_id, "name": sample.get("referrer_name") or "Unknown",
            "type": sample.get("referrer_type"), "phone": None, "company": None,
        }

    trend_map: dict[str, float] = defaultdict(float)
    for q in quotations:
        ts = _revenue_timestamp(q)
        if ts:
            trend_map[_bucket_label(ts, granularity)] += q.get("grand_total", 0)
    trend = [{"bucket": k, "revenue": round(v, 2)} for k, v in sorted(trend_map.items())]

    quotes = sorted(
        (
            {
                "id": q["id"], "number": q["number"], "customer_name": q["customer_name"],
                "grand_total": q.get("grand_total", 0), "updated_at": _revenue_timestamp(q),
            }
            for q in quotations
        ),
        key=lambda q: q["updated_at"] or "", reverse=True,
    )

    return {
        "referrer": referrer,
        "total_revenue": round(sum(q.get("grand_total", 0) for q in quotations), 2),
        "trend": trend,
        "quotations": quotes,
    }


async def _product_brand_map(product_ids: set[str]) -> dict[str, str]:
    if not product_ids:
        return {}
    products = await db.products.find(
        {"id": {"$in": list(product_ids)}}, {"_id": 0, "id": 1, "brand_id": 1},
    ).to_list(len(product_ids))
    return {p["id"]: p.get("brand_id") for p in products if p.get("brand_id")}


@router.get("/brands")
async def brands_ranked(
    floor_id: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    user: UserPublic = Depends(require_roles("owner", "admin")),
):
    floor_ids = _resolve_floor_ids(user, floor_id)
    quotations = await _confirmed_quotations(floor_ids, date_from, date_to)

    product_ids = {it["product_id"] for q in quotations for it in q.get("items", [])}
    product_brand = await _product_brand_map(product_ids)

    brand_ids = set(product_brand.values())
    brands = await db.brands.find(
        {"id": {"$in": list(brand_ids)}}, {"_id": 0, "id": 1, "name": 1},
    ).to_list(len(brand_ids) or 1)
    brand_name = {b["id"]: b["name"] for b in brands}

    by_brand: dict[str, float] = defaultdict(float)
    for q in quotations:
        line_nets = per_line_net_amounts(q)
        for it in q.get("items", []):
            bid = product_brand.get(it["product_id"])
            if bid:
                by_brand[bid] += line_nets.get(it["id"], 0.0)

    ranked = sorted(
        (
            {"brand_id": bid, "brand_name": brand_name.get(bid, "Unknown"), "revenue": round(rev, 2)}
            for bid, rev in by_brand.items()
        ),
        key=lambda e: e["revenue"], reverse=True,
    )
    return {"brands": ranked}


@router.get("/brands/{brand_id}")
async def brand_detail(
    brand_id: str,
    floor_id: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    granularity: Granularity = Query("month"),
    user: UserPublic = Depends(require_roles("owner", "admin")),
):
    floor_ids = _resolve_floor_ids(user, floor_id)
    quotations = await _confirmed_quotations(floor_ids, date_from, date_to)

    product_ids = {it["product_id"] for q in quotations for it in q.get("items", [])}
    product_brand = await _product_brand_map(product_ids)
    ids_for_brand = {pid for pid, bid in product_brand.items() if bid == brand_id}

    brand = await db.brands.find_one({"id": brand_id}, {"_id": 0})
    if not brand:
        if not ids_for_brand:
            raise HTTPException(status_code=404, detail="Brand not found")
        # `/brands` can rank a brand_id that a product still references but
        # whose own `brands` doc was since merged/deleted — the "By Brand"
        # row (labelled "Unknown" there) has real revenue behind it, so
        # clicking through shouldn't dead-end into a 404.
        brand = {"id": brand_id, "name": "Unknown"}

    trend_map: dict[str, float] = defaultdict(float)
    product_revenue: dict[str, dict] = {}
    total = 0.0
    for q in quotations:
        ts = _revenue_timestamp(q)
        line_nets = per_line_net_amounts(q)
        for it in q.get("items", []):
            if it["product_id"] not in ids_for_brand:
                continue
            net = line_nets.get(it["id"], 0.0)
            total += net
            if ts:
                trend_map[_bucket_label(ts, granularity)] += net
            entry = product_revenue.setdefault(
                it["product_id"], {"product_id": it["product_id"], "name": it["name"], "sku": it["sku"], "revenue": 0.0},
            )
            entry["revenue"] += net

    trend = [{"bucket": k, "revenue": round(v, 2)} for k, v in sorted(trend_map.items())]
    top_products = sorted(
        ({**e, "revenue": round(e["revenue"], 2)} for e in product_revenue.values()),
        key=lambda e: e["revenue"], reverse=True,
    )[:10]

    return {"brand": brand, "total_revenue": round(total, 2), "trend": trend, "top_products": top_products}
