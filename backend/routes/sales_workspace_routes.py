"""Owner-only data resources for the Sales Data workspaces.

These routes deliberately sit beside, rather than inside, the launch Sales
Data dashboard.  The dashboard's response shapes are a stable contract; the
new workspaces consume this small, paginated read model instead.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Query

from auth import UserPublic, accessible_floor_ids, require_roles
from db import db
from routes.executive_overview_routes import _floor_error_to_http
from services.analytics.filters import AnalyticsFilter, FloorAccessError, build_match
from services.referrer_identity import referrer_query
from services.analytics.gather_breakdowns import gather_order_collections, gather_product_brands, gather_product_line_revenue
from services.analytics.breakdowns import brand_rows, order_rows, product_rows
from services.analytics.gather_breakdowns import _ordered_match
from services.analytics.workspaces import ORDER_FIELDS, gather_workspace, gather_workspace_labels, merge_reference_currencies
from services.analytics.furniture import gather_furniture_reference_rows
from services.analytics.periods import resolve
from services.analytics.lead_referrals import gather_acquired_customers

router = APIRouter(prefix="/analytics/workspaces", tags=["analytics"])

Workspace = Literal["revenue", "collections", "forecasting", "customers", "architects", "interior-designers", "relationships", "products", "brands", "suppliers", "operations"]


def _filter(
    floor_id: str | None, preset: str | None, date_from: str | None, date_to: str | None,
    brand_id: str | None, customer_id: str | None, salesperson_id: str | None, referrer_id: str | None,
) -> AnalyticsFilter:
    return AnalyticsFilter(
        floor_id=floor_id or "all", preset=preset or "this_month", date_from=date_from, date_to=date_to,
        brand_id=brand_id, customer_id=customer_id, salesperson_id=salesperson_id, referrer_id=referrer_id,
    )


def _money(value: float | int | None) -> float:
    return round(float(value or 0), 2)


async def _mark_historical_references(relationships: list[dict], floor_id: str | None, floors) -> list[dict]:
    # Off-page contacts are not historical. Read only report identity IDs.
    scope = build_match(AnalyticsFilter(floor_id=floor_id, status="any"), floors, (None, None))
    if not relationships:
        return []
    if not floor_id or floor_id == "all":
        # Match the directory's active-floor union, retaining old-floor sales
        # as historical rows instead of classifying unreachable contacts active.
        visible = await db.floors.find({"active": True}, {"_id": 0, "id": 1}).sort("created_at", 1).to_list(50)
        scope = {"floor_id": {"$in": [row["id"] for row in visible if floors is None or row["id"] in floors]}}
    ids = [row["id"] for row in relationships]
    batches = await asyncio.gather(*[
        db.referrers.find(referrer_query(scope, {
            "id": {"$in": ids[start:start + 500]}, "active": {"$ne": False},
        }), {"_id": 0, "id": 1}).to_list(500)
        for start in range(0, len(ids), 500)
    ])
    active_ids = {doc["id"] for batch in batches for doc in batch}
    return [{**row, "historical": row["id"] not in active_ids} for row in relationships]


async def _forecast(f: AnalyticsFilter, floors, now: datetime | None = None) -> dict:
    """A baseline requires observed orders in three complete calendar months.

    Empty months alone cannot establish history: a new installation with no
    orders must not claim a measured zero forecast. The baseline always uses
    the three prior complete months and preserves the report's entity scope.
    """
    now = now or datetime.now(timezone.utc)
    end_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    monthly: list[float] = []
    months_with_orders = 0
    for i in range(3, 0, -1):
        month_index = end_month.month - 1 - i
        start = end_month.replace(year=end_month.year + month_index // 12, month=month_index % 12 + 1)
        end = start.replace(month=start.month % 12 + 1, year=start.year + (start.month == 12))
        match = await _ordered_match(db, f, floors, (start.isoformat(), end.isoformat()))
        rows = await db.quotations.find(match, {"_id": 0, "grand_total": 1}).to_list(None)
        months_with_orders += bool(rows)
        monthly.append(sum(float(row.get("grand_total") or 0) for row in rows))
    available = months_with_orders == 3
    return {
        "months_used": months_with_orders,
        "history_state": "ok" if available else "insufficient_history",
        "monthly_history": [_money(value) for value in monthly],
        "forecast": _money(sum(monthly) / 3) if available else None,
        "method": "Mean revenue over the previous three complete calendar months; requires orders in each month",
    }


@router.get("/sales-records")
async def sales_records(
    floor_id: str | None = None, preset: str | None = None, date_from: str | None = None, date_to: str | None = None,
    brand_id: str | None = None, customer_id: str | None = None, salesperson_id: str | None = None, referrer_id: str | None = None,
    offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
    user: UserPublic = Depends(require_roles("owner")),
):
    f = _filter(floor_id, preset, date_from, date_to, brand_id, customer_id, salesperson_id, referrer_id)
    try:
        period = resolve(f.preset, f.date_from, f.date_to)
        match = await _ordered_match(db, f, accessible_floor_ids(user), (period.start, period.end))
        docs = await db.quotations.find(match, ORDER_FIELDS).sort([
            ("ordered_at", -1), ("id", -1),
        ]).skip(offset).limit(limit).to_list(limit)
        total = await db.quotations.count_documents(match)
        collected = await gather_order_collections(db, docs)
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
    rows = order_rows(docs, collected)
    return {"rows": [r.__dict__ for r in rows], "total": total, "offset": offset, "limit": limit}


@router.get("/facets")
async def facets(user: UserPublic = Depends(require_roles("owner"))):
    """Small option lists for filters; owner floor access is applied to brands."""
    floors = accessible_floor_ids(user)
    brand_query = {} if floors is None else {"floor_id": {"$in": floors}}
    brands = await db.brands.find(brand_query, {"_id": 0, "id": 1, "name": 1}).sort("name", 1).to_list(2000)
    customers = await db.customers.find(brand_query, {"_id": 0, "id": 1, "name": 1}).sort("name", 1).to_list(2000)
    people = await db.users.find({"role": {"$in": ["owner", "admin", "manager", "sales"]}}, {"_id": 0, "id": 1, "full_name": 1}).sort("full_name", 1).to_list(500)
    referrers = await db.referrers.find(brand_query, {"_id": 0, "id": 1, "name": 1, "type": 1}).sort("name", 1).to_list(2000)
    return {"brands": brands, "customers": customers, "salespeople": people, "referrers": referrers}


@router.get("/{workspace}")
async def workspace(
    workspace: Workspace,
    floor_id: str | None = None, preset: str | None = None, date_from: str | None = None, date_to: str | None = None,
    brand_id: str | None = None, customer_id: str | None = None, salesperson_id: str | None = None, referrer_id: str | None = None,
    user: UserPublic = Depends(require_roles("owner", "admin", "manager")),
):
    f = _filter(floor_id, preset, date_from, date_to, brand_id, customer_id, salesperson_id, referrer_id)
    floors = accessible_floor_ids(user)
    period = resolve(f.preset, f.date_from, f.date_to)
    kind = "architect" if workspace == "architects" else "interior_designer" if workspace == "interior-designers" else None
    references = workspace in ("architects", "interior-designers", "relationships")
    if not references:
        await require_roles("owner")(user)
    reference_limit = 2000
    try:
        match = await _ordered_match(db, f, floors, (period.start, period.end))
        reads = [gather_workspace(db, match, kind, include_kitchen=references, reference_limit=reference_limit + 1 if references else 100), gather_product_line_revenue(db, f, floors, (period.start, period.end), limit=None)]
        if references:
            reads.extend([gather_acquired_customers(db, f, floors, (period.start, period.end), kind, match, limit=reference_limit + 1),
                          gather_furniture_reference_rows(db, f, floors, (period.start, period.end), kind, limit=reference_limit + 1)])
        results = await asyncio.gather(*reads)
        summary, line = results[:2]
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
    # The line pipeline remains the source of truth for product/brand numbers.
    product_ids = [r.get("key") for r in line if r.get("key")]
    (product_brand, brand_names), (names, skus) = await asyncio.gather(
        gather_product_brands(db, product_ids), gather_workspace_labels(db, match, product_ids[:100]))
    brands = [r.__dict__ for r in brand_rows(line, product_brand, brand_names)]
    products = [r.__dict__ for r in product_rows([r for r in line if r.get("key")][:100], names, skus, product_brand, brand_names)]
    hansgrohe = next((r["revenue"] for r in brands if r["name"].strip().lower() == "hansgrohe"), 0.0)
    payload: dict = {
        "workspace": workspace, "period": period.label,
        "kpis": {**summary["kpis"], "hansgrohe_revenue": _money(hansgrohe)},
        "brands": brands[:100], "products": products[:100], "customers": summary["customers"],
        "floors": summary["floors"],
    }
    if references:
        relationships = merge_reference_currencies(summary["relationships"], results[2], results[3])
        payload["relationships"] = await _mark_historical_references(relationships[:reference_limit], f.floor_id, floors)
        payload["relationships_truncated"] = len(relationships) > reference_limit
    if workspace == "forecasting":
        payload["forecast"] = await _forecast(f, floors)
    return payload
