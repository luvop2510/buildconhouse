"""The only place Referral Analytics (spec §7 Workspace 3) reads Mongo.

Same rule as every other gather module in this package: every read goes
through build_match, so floor scoping and the ordered_at-vs-created_at
date-field choice exist in exactly one place. Referrer itself carries zero
metrics (spec §5.1) — every number here is read straight off
quotations.referrer_* and joined to db.payments for money actually
collected, never a second definition of "collected" (collected_by_quotation,
Phase 1's gather.py, reused exactly as gather_performance's
gather_collections_orders, Task 10, already does).
"""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone

from services.analytics.attention import OPEN_QUOTATION_STATUSES
from services.analytics.filters import AnalyticsFilter, build_match
from services.analytics.gather import collected_by_quotation
from services.analytics.metrics import line_revenue_pipeline, revenue_pipeline
from services.analytics.periods import buckets
from services.analytics.kitchen_referrals import kitchen_referral_pipeline

_MAX_ROWS = 5000

# The only two floors this business has (auth.py's TILES_FLOOR_ID =
# "ground-floor" and Quotation.floor_id's "first-floor" default). floor_rows
# is seeded with both at 0.0 before merging real aggregation results so a
# referrer active on only one floor still reports the other as an explicit
# zero — never a silently-dropped key (referrals.py's referrer_profile test,
# Task 7, pins this).
KNOWN_FLOOR_IDS = ("first-floor", "ground-floor")


def _directory_match(
    f: AnalyticsFilter, accessible_floors, referrer_type: str | None,
) -> dict:
    """Build the directory's authorized floor/type/id scope.

    Directory members intentionally are not limited by the report period: a
    new architect or interior designer should appear with zeroes until their
    first attributed quotation is created.
    """
    from services.referrer_identity import referrer_query
    query = build_match(
        AnalyticsFilter(
            floor_id=f.floor_id,
            status="any",
            referrer_type=referrer_type,
        ),
        accessible_floors,
        (None, None),
    ) | ({"id": f.referrer_id} if f.referrer_id else {})
    if "referrer_type" in query:
        query["type"] = query.pop("referrer_type")
    return referrer_query(query)


def _zero_referrer_row(referrer: dict) -> dict:
    return {
        "referrer_id": referrer["id"],
        "name": referrer.get("name"),
        "type": referrer.get("type"),
        "customers_referred": 0,
        "quotations_total": 0,
        "quotations_approved": 0,
        "quotations_confirmed": 0,
        "revenue": 0.0,
        "pending_count": 0,
        "pending_value": 0.0,
        "pending_payments": 0.0,
        "first_referral_at": None,
        "last_referral_at": None,
        "repeat_customers": 0,
    }


async def _repeat_customers_by_referrer(db, match: dict) -> dict[str, int]:
    """Customers with >=2 quotations from the SAME referrer, per referrer.

    Two-stage group: first (referrer_id, customer_id) counts each customer's
    quotations from that referrer, then a second group over those rows counts
    how many customer-groups hit >=2. A single group on customer_id alone
    would instead count total repeat-quotations, or conflate customers who
    happen to share a quotation count across different referrers — neither is
    "repeat customers".
    """
    pipeline = [
        {"$match": match},
        {"$unionWith": {"coll": "kitchen_projects", "pipeline": [*kitchen_referral_pipeline(match, include_leads=True), {"$match": {"status": {"$ne": "lead"}}}]}},
        {"$group": {
            "_id": {"referrer_id": "$referrer_id", "customer_id": "$customer_id"},
            "count": {"$sum": 1},
        }},
        {"$group": {
            "_id": "$_id.referrer_id",
            "repeat_customers": {"$sum": {"$cond": [{"$gte": ["$count", 2]}, 1, 0]}},
        }},
    ]
    rows = await db.quotations.aggregate(pipeline).to_list(None)
    return {r["_id"]: r["repeat_customers"] for r in rows if r.get("_id")}


async def _pending_payments_by_referrer(
    db, f: AnalyticsFilter, accessible_floors, window, referrer_type: str | None,
) -> dict[str, float]:
    """Outstanding money on ordered-but-not-fully-paid quotations, rolled up
    per referrer — collected_by_quotation joined against the ordered subset,
    exactly the pattern gather_performance.gather_collections_orders (Task
    10) uses per-order, just summed by referrer_id here instead of listed."""
    match = build_match(
        AnalyticsFilter(floor_id=f.floor_id, status="ordered", referrer_type=referrer_type, referrer_id=f.referrer_id),
        accessible_floors, window,
    )
    match.setdefault("referrer_id", {"$ne": None})
    orders = await db.quotations.find(
        match, {"_id": 0, "id": 1, "referrer_id": 1, "grand_total": 1},
    ).to_list(_MAX_ROWS)
    collected = await collected_by_quotation(db, [o.get("id") for o in orders])
    pending: dict[str, float] = {}
    for o in orders:
        rid = o.get("referrer_id")
        if not rid:
            continue
        outstanding = float(o.get("grand_total") or 0) - collected.get(o.get("id"), 0.0)
        if outstanding > 0:
            pending[rid] = pending.get(rid, 0.0) + outstanding
    kitchen_rows = await db.quotations.aggregate([
        {"$match": {"id": {"$in": []}}},
        {"$unionWith": {"coll": "kitchen_projects", "pipeline": kitchen_referral_pipeline(match)}},
        {"$group": {"_id": "$referrer_id", "kitchen_outstanding": {"$sum": {"$max": [0, {"$subtract": ["$grand_total", "$_kitchen_paid"]}]}}}},
    ]).to_list(None)
    for row in kitchen_rows:
        rid = row.get("_id")
        if rid:
            pending[rid] = pending.get(rid, 0.0) + float(row.get("kitchen_outstanding", 0))
    return {rid: round(v, 2) for rid, v in pending.items()}


async def gather_referrer_raw(
    db, f: AnalyticsFilter, accessible_floors, window, referrer_type: str | None,
) -> list[dict]:
    """One dict per referrer matching referrals.py's `_raw()` shape — every
    field referrer_summary_rows reads: referrer_id, name, type,
    customers_referred, quotations_total, quotations_approved,
    quotations_confirmed, revenue, pending_count, pending_value,
    pending_payments, first_referral_at, last_referral_at, repeat_customers.

    Built entirely from db.quotations grouped by referrer_id/referrer_name —
    Referrer itself carries zero metrics (spec §5.1), so this is the only
    source of truth for a referrer's numbers. `referrer_type` filters to one
    referrer type when given (the two Referral Analytics sub-workspaces);
    accessible_floors=None means an unrestricted caller (owner/manager).
    """
    match = build_match(
        AnalyticsFilter(floor_id=f.floor_id, status="any", referrer_type=referrer_type, referrer_id=f.referrer_id),
        accessible_floors, window,
    )
    match.setdefault("referrer_id", {"$ne": None})

    pipeline = [
        {"$match": match},
        {"$unionWith": {"coll": "kitchen_projects", "pipeline": kitchen_referral_pipeline(match, include_leads=True)}},
        {"$group": {
            "_id": "$referrer_id",
            "name": {"$first": "$referrer_name"},
            "type": {"$first": "$referrer_type"},
            "customers": {"$addToSet": "$customer_id"},
            "quotations_total": {"$sum": {"$cond": [{"$eq": ["$status", "lead"]}, 0, 1]}},
            "quotations_approved": {"$sum": {"$cond": [{"$eq": ["$status", "approved"]}, 1, 0]}},
            "quotations_confirmed": {"$sum": {"$cond": [{"$eq": ["$status", "ordered"]}, 1, 0]}},
            "revenue": {"$sum": {"$cond": [{"$eq": ["$status", "ordered"]}, "$grand_total", 0]}},
            "pending_count": {"$sum": {"$cond": [{"$in": ["$status", list(OPEN_QUOTATION_STATUSES)]}, 1, 0]}},
            "pending_value": {"$sum": {"$cond": [{"$in": ["$status", list(OPEN_QUOTATION_STATUSES)]}, "$grand_total", 0]}},
            "first_referral_at": {"$min": "$created_at"},
            "last_referral_at": {"$max": "$created_at"},
        }},
        {"$project": {
            "_id": 0,
            "referrer_id": "$_id",
            "name": 1,
            "type": 1,
            "customers_referred": {"$size": "$customers"},
            "quotations_total": 1,
            "quotations_approved": 1,
            "quotations_confirmed": 1,
            "revenue": {"$round": ["$revenue", 2]},
            "pending_count": 1,
            "pending_value": {"$round": ["$pending_value", 2]},
            "first_referral_at": 1,
            "last_referral_at": 1,
        }},
    ]
    rows = await db.quotations.aggregate(pipeline).to_list(None)
    by_referrer: dict[str, dict] = {r["referrer_id"]: r for r in rows if r.get("referrer_id")}

    repeat_counts = await _repeat_customers_by_referrer(db, match)
    pending_payments = await _pending_payments_by_referrer(db, f, accessible_floors, window, referrer_type)

    for rid, row in by_referrer.items():
        row["repeat_customers"] = repeat_counts.get(rid, 0)
        row["pending_payments"] = pending_payments.get(rid, 0.0)

    # Quotes define the financial metrics, but the directory defines who can
    # be attributed. Seed active, authorized directory entries with zero rows
    # so people appear in Sales Data immediately after being added.
    directory = await db.referrers.find(
        _directory_match(f, accessible_floors, referrer_type),
        {"_id": 0, "id": 1, "name": 1, "type": 1, "active": 1},
    ).to_list(_MAX_ROWS)
    for referrer in directory:
        if referrer.get("id") and referrer.get("active") is not False:
            by_referrer.setdefault(referrer["id"], _zero_referrer_row(referrer))

    return list(by_referrer.values())


def _twelve_months_ago(now: datetime) -> datetime:
    """First-of-month anchor 12 calendar months before `now`. Always day=1,
    so — unlike periods._add_months, which must clamp an arbitrary day to the
    target month's length — there is no leap-day/short-month edge case here.
    """
    month_index = now.month - 1 - 12
    year = now.year + month_index // 12
    month = month_index % 12 + 1
    return now.replace(year=year, month=month, day=1, hour=0, minute=0, second=0, microsecond=0)


async def _referrer_monthly_trend(
    db, f: AnalyticsFilter, accessible_floors, referrer_id: str, granularity: str,
) -> list[dict]:
    """Bucketed revenue for one referrer over the last 12 months — mirrors
    gather_performance.gather_revenue_trend's loop (one revenue_pipeline call
    per bucket, the same KPI definition the top-line Revenue card uses, never
    a re-derived $group), filtered to this referrer via
    AnalyticsFilter.referrer_id — build_match's own clause, no hand-written
    {"referrer_id": ...}."""
    now = datetime.now(timezone.utc)
    start = _twelve_months_ago(now)
    result: list[dict] = []
    for period in buckets(start.isoformat(), now.isoformat(), granularity):
        match = build_match(
            AnalyticsFilter(floor_id=f.floor_id, status="ordered", referrer_id=referrer_id),
            accessible_floors, (period.start, period.end),
        )
        pipeline = revenue_pipeline(match)
        pipeline.insert(1, {"$unionWith": {"coll": "kitchen_projects", "pipeline": kitchen_referral_pipeline(match)}})
        rows = await db.quotations.aggregate(pipeline).to_list(None)
        result.append({"bucket": period.label, "revenue": rows[0]["revenue"] if rows else 0.0})
    return result


async def _referrer_brand_and_product_rows(
    db, f: AnalyticsFilter, accessible_floors, referrer_id: str,
) -> tuple[list[dict], list[dict]]:
    """Brand and product revenue preference, all-time, for one referrer.

    line_revenue_pipeline groups on items.product_id directly — that field
    IS on QuotationLineItem — giving product_rows straight away. brand_id is
    NOT on the line item (verified against models.py: only Product carries
    brand_id, QuotationLineItem does not denormalize it), so brand_rows
    re-aggregates those same per-product revenue rows in Python after one
    db.products lookup resolves product_id -> brand_id, rather than a second
    Mongo pass or a hand-rolled $lookup.
    """
    match = build_match(
        AnalyticsFilter(floor_id=f.floor_id, status="ordered", referrer_id=referrer_id),
        accessible_floors, (None, None),
    )
    rows = await db.quotations.aggregate(line_revenue_pipeline(match, group_by="items.product_id")).to_list(None)

    # Product and Brand are both floor-owned (Product.floor_id, Brand.floor_id),
    # so their name lookups are floor-scoped through build_match too — the
    # same choice gather_performance.gather_category_revenue already makes
    # for its db.categories name lookup.
    catalog_match = build_match(AnalyticsFilter(floor_id=f.floor_id, status="any"), accessible_floors, (None, None))

    product_ids = [r["key"] for r in rows if r.get("key")]
    products: dict[str, dict] = {}
    if product_ids:
        async for p in db.products.find(
            {**catalog_match, "id": {"$in": product_ids}}, {"_id": 0, "id": 1, "name": 1, "brand_id": 1},
        ):
            products[p["id"]] = p

    product_rows = [
        {
            "product_id": r["key"],
            "product_name": products.get(r["key"], {}).get("name") or "Unknown",
            "revenue": float(r.get("revenue") or 0),
        }
        for r in rows if r.get("key")
    ]

    brand_revenue: dict[str, float] = {}
    for r in rows:
        pid = r.get("key")
        brand_id = products.get(pid, {}).get("brand_id") if pid else None
        if not brand_id:
            continue
        brand_revenue[brand_id] = brand_revenue.get(brand_id, 0.0) + float(r.get("revenue") or 0)

    brands: dict[str, dict] = {}
    if brand_revenue:
        async for b in db.brands.find(
            {**catalog_match, "id": {"$in": list(brand_revenue)}}, {"_id": 0, "id": 1, "name": 1},
        ):
            brands[b["id"]] = b

    brand_rows = [
        {"brand_id": bid, "brand_name": brands.get(bid, {}).get("name") or "Unknown", "revenue": round(rev, 2)}
        for bid, rev in brand_revenue.items()
    ]

    return brand_rows, product_rows


async def _referrer_floor_split(db, f: AnalyticsFilter, accessible_floors, referrer_id: str) -> dict[str, float]:
    """Revenue per floor, all-time, seeded with both KNOWN_FLOOR_IDS at 0.0
    before merging real results — see the module-level comment on
    KNOWN_FLOOR_IDS for why an explicit zero matters here."""
    match = build_match(
        AnalyticsFilter(floor_id=f.floor_id, status="ordered", referrer_id=referrer_id),
        accessible_floors, (None, None),
    )
    pipeline = [
        {"$match": match},
        {"$unionWith": {"coll": "kitchen_projects", "pipeline": kitchen_referral_pipeline(match)}},
        {"$group": {"_id": "$floor_id", "revenue": {"$sum": "$grand_total"}}},
    ]
    rows = await db.quotations.aggregate(pipeline).to_list(None)
    floor_rows: dict[str, float] = dict.fromkeys(KNOWN_FLOOR_IDS, 0.0)
    for r in rows:
        fid = r.get("_id")
        if fid:
            floor_rows[fid] = round(float(r.get("revenue") or 0), 2)
    return floor_rows


async def gather_referrer_profile_data(
    db, f: AnalyticsFilter, accessible_floors, referrer_id: str, granularity: str,
) -> tuple[dict | None, list[dict], list[dict], list[dict], dict[str, float]]:
    """(referrer_doc, monthly_trend, brand_rows, product_rows, floor_rows)
    for one referrer's profile page.

    db.referrers.find keyed on `id` and the caller's authorized floor. A
    missing or other-floor referrer returns the empty shape below, so contact
    information is never exposed across business units.
    """
    scoped = _directory_match(replace(f, referrer_id=referrer_id), accessible_floors, None)
    docs = await db.referrers.find(scoped, {"_id": 0}).to_list(1)
    referrer_doc = docs[0] if docs else None
    if referrer_doc is None:
        return None, [], [], [], {}

    monthly_trend = await _referrer_monthly_trend(db, f, accessible_floors, referrer_id, granularity)
    brand_rows, product_rows = await _referrer_brand_and_product_rows(db, f, accessible_floors, referrer_id)
    floor_rows = await _referrer_floor_split(db, f, accessible_floors, referrer_id)

    return referrer_doc, monthly_trend, brand_rows, product_rows, floor_rows
