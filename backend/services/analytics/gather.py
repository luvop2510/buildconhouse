"""The only module Phase 1 reads Mongo from.

Every rule in attention.py / opportunity.py is pure, and every read here goes
through Phase 0's `build_match`, so floor scoping and the `ordered_at`-vs-
`created_at` date-field choice exist in exactly one place. A surface that built
its own `{"floor_id": ...}` would be one edit away from the cross-floor leaks
this codebase has already fixed three times.

One subtlety worth stating: the open-pipeline reads deliberately carry NO date
window. A quotation stalled for 40 days is exactly what the owner needs to see
in a this-month view; windowing it out would hide the oldest, most valuable
problems — the ones the Attention Center exists for.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from models import AnalyticsTargets
from services.analytics.attention import (
    OPEN_QUOTATION_STATUSES,
    SETTLED_PURCHASE_STATUSES,
    THRESHOLDS,
    age_days,
    is_overdue,
)
from services.analytics.attention import AttentionInput
from services.analytics.feed import feed_rows
from services.analytics.filters import AnalyticsFilter, build_match
from services.analytics.opportunity import OpportunityInput

_MAX_ROWS = 500

# How many recent allowlisted events the feed considers before filtering.
FEED_CANDIDATE_CAP = 1000


def _fold(values) -> float:
    total = 0.0
    for v in values:
        total += float(v or 0)
    return total


def _open_match(f: AnalyticsFilter, accessible_floors, statuses=OPEN_QUOTATION_STATUSES) -> dict:
    """Floor-scoped, un-windowed, status-filtered.

    Built from build_match with an open window so the floor clause is produced
    by the same code path as every other query, then the status clause is
    replaced — never the floor clause.
    """
    match = build_match(AnalyticsFilter(floor_id=f.floor_id, status="any"), accessible_floors, (None, None))
    match["status"] = {"$in": list(statuses)}
    return match


async def collected_by_quotation(db, quotation_ids: list[str]) -> dict[str, float]:
    """Completed payments only — a pending payment is recorded, not received,
    and counting it as collected would understate what the business is owed."""
    ids = [qid for qid in quotation_ids if qid]
    if not ids:
        return {}
    collected: dict[str, float] = {}
    async for p in db.payments.find(
        {"quotation_id": {"$in": ids}, "status": "completed"},
        {"_id": 0, "quotation_id": 1, "amount": 1},
    ):
        qid = p.get("quotation_id")
        collected[qid] = round(collected.get(qid, 0.0) + float(p.get("amount") or 0), 2)
    return collected


async def _open_quotations(db, f, accessible_floors) -> list[dict]:
    return await db.quotations.find(
        _open_match(f, accessible_floors),
        {"_id": 0, "id": 1, "number": 1, "status": 1, "grand_total": 1, "customer_id": 1,
         "customer_name": 1, "created_by": 1, "created_by_name": 1, "created_at": 1,
         "updated_at": 1, "referrer_id": 1, "referrer_name": 1, "floor_id": 1},
    ).to_list(_MAX_ROWS)


async def _ordered_quotations(db, f, accessible_floors, window) -> list[dict]:
    match = build_match(AnalyticsFilter(floor_id=f.floor_id, status="ordered"), accessible_floors, window)
    return await db.quotations.find(
        match,
        {"_id": 0, "id": 1, "number": 1, "grand_total": 1, "customer_id": 1, "customer_name": 1,
         "created_by": 1, "created_by_name": 1, "ordered_at": 1, "items": 1, "floor_id": 1},
    ).to_list(_MAX_ROWS)


async def _with_collected(db, orders: list[dict]) -> list[dict]:
    collected = await collected_by_quotation(db, [o.get("id") for o in orders])
    return [{**o, "collected": collected.get(o.get("id"), 0.0)} for o in orders]


async def _collected_orders(db, f, accessible_floors, window) -> list[dict]:
    return await _with_collected(db, await _ordered_quotations(db, f, accessible_floors, window))


async def gather_attention(db, f: AnalyticsFilter, accessible_floors, window, thresholds: dict) -> AttentionInput:
    """Fetch everything the §9 rules need, already floor-scoped."""
    now = datetime.now(timezone.utc)

    followup_match = build_match(AnalyticsFilter(floor_id=f.floor_id, status="any"), accessible_floors, (None, None))
    followup_read = db.followups.find(
        {**followup_match, "status": "open"},
        {"_id": 0, "id": 1, "status": 1, "due_at": 1, "value": 1, "customer_id": 1, "customer_name": 1,
         "customer_phone": 1, "reason": 1, "assigned_to": 1, "assigned_to_name": 1, "floor_id": 1,
         # Today's Priorities (§14.2) stars: the real followup_engine output,
         # already computed and stored — read, never recomputed here.
         "priority_score": 1, "priority_level": 1, "reason_factors": 1},
    ).to_list(_MAX_ROWS)

    po_match = build_match(AnalyticsFilter(floor_id=f.floor_id, status="any"), accessible_floors, (None, None))
    purchase_read = db.purchase_orders.find(
        {**po_match, "status": {"$nin": list(SETTLED_PURCHASE_STATUSES)}},
        {"_id": 0, "id": 1, "number": 1, "status": 1, "supplier_id": 1, "supplier_name": 1,
         "expected_delivery_at": 1, "total": 1, "grand_total": 1, "floor_id": 1},
    ).to_list(_MAX_ROWS)
    quotations, orders, followups, purchase_orders, ready_items, unreleased_items = await asyncio.gather(
        _open_quotations(db, f, accessible_floors),
        _collected_orders(db, f, accessible_floors, (None, None)),
        followup_read,
        purchase_read,
        _ready_items(db, f, accessible_floors),
        _unreleased_items(db, f, accessible_floors),
    )
    for po in purchase_orders:
        po.setdefault("total", po.get("grand_total"))

    salespeople = await _salespeople(db, quotations, followups, now)

    return AttentionInput(
        quotations=quotations,
        orders=orders,
        followups=followups,
        # Ready/unreleased material lives in the tile-orders collections; the
        # Operations workspace (Phase 5) owns their full aggregation. Phase 1
        # reads only what the two rules need.
        ready_items=ready_items,
        unreleased_items=unreleased_items,
        salespeople=salespeople,
        purchase_orders=purchase_orders,
        brands=[],      # comparison rules need a prior window; wired in Phase 3
        referrers=[],   # referral analytics is Phase 2
    )


async def _ready_items(db, f: AnalyticsFilter, accessible_floors) -> list[dict]:
    """Ready tile batches, constrained to both caller access and selected floor."""
    match = {
        **build_match(AnalyticsFilter(floor_id=f.floor_id, status="any"), accessible_floors, (None, None)),
        "is_deleted": False,
        "boxes_ready": {"$gt": 0},
    }
    rows = await db.ready_batches.find(
        match,
        {"_id": 0, "id": 1, "purchase_order_id": 1, "customer_order_id": 1, "customer_name": 1,
         "boxes_ready": 1, "value": 1, "created_at": 1, "floor_id": 1},
    ).to_list(_MAX_ROWS)
    return [{**r, "ready_at": r.get("created_at")} for r in rows]


async def _unreleased_items(db, f: AnalyticsFilter, accessible_floors) -> list[dict]:
    """Unreleased tile material, constrained to both caller access and selected floor."""
    match = {
        **build_match(AnalyticsFilter(floor_id=f.floor_id, status="any"), accessible_floors, (None, None)),
        "is_deleted": False,
        "boxes_pending": {"$gt": 0},
    }
    return await db.purchase_orders.find(
        match,
        {"_id": 0, "id": 1, "purchase_order_id": 1, "brand_name": 1, "boxes_pending": 1,
         "value": 1, "ordered_at": 1, "created_at": 1, "floor_id": 1},
    ).to_list(_MAX_ROWS)


async def _salespeople(db, open_quotations: list[dict], followups: list[dict], now: datetime) -> list[dict]:
    """Open pipeline and last activity per salesperson, derived from rows we
    have already fetched — no extra query, no second definition of pipeline."""
    staff = await db.users.find(
        {"active": True, "role": {"$in": ["sales", "manager"]}},
        {"_id": 0, "id": 1, "full_name": 1},
    ).to_list(_MAX_ROWS)
    if not staff:
        return []
    pipeline: dict[str, float] = {}
    last_seen: dict[str, str] = {}
    for q in open_quotations:
        uid = q.get("created_by")
        if not uid:
            continue
        pipeline[uid] = pipeline.get(uid, 0.0) + float(q.get("grand_total") or 0)
        stamp = q.get("updated_at") or q.get("created_at")
        if stamp and stamp > last_seen.get(uid, ""):
            last_seen[uid] = stamp
    for f in followups:
        uid = f.get("assigned_to")
        stamp = f.get("last_contacted_at") or f.get("updated_at")
        if uid and stamp and stamp > last_seen.get(uid, ""):
            last_seen[uid] = stamp
    return [{
        "id": s["id"],
        "full_name": s.get("full_name"),
        "open_pipeline": round(pipeline.get(s["id"], 0.0), 2),
        "last_activity_at": last_seen.get(s["id"]),
    } for s in staff]


async def gather_opportunity(db, f: AnalyticsFilter, accessible_floors, window, thresholds: dict) -> OpportunityInput:
    """Fetch everything the §10 rules need, already floor-scoped."""
    now = datetime.now(timezone.utc)
    walkin_match = build_match(AnalyticsFilter(floor_id=f.floor_id, status="any"), accessible_floors, (None, None))
    walkin_read = db.walkins.find(
        {**walkin_match, "is_deleted": {"$ne": True}},
        {"_id": 0, "id": 1, "customer_id": 1, "customer_name": 1, "customer_phone": 1, "budget": 1,
         "interested_products": 1, "visited_at": 1, "selection_quotation_id": 1, "floor_id": 1},
    ).to_list(_MAX_ROWS)

    quotations, walkins, orders = await asyncio.gather(
        _open_quotations(db, f, accessible_floors),
        walkin_read,
        _ordered_quotations(db, f, accessible_floors, (None, None)),
    )
    customers = _customer_cadence(orders, quotations)

    return OpportunityInput(
        partners=[],     # referral analytics is Phase 2
        brands=[],       # brand comparison is Phase 3
        quotations=quotations,
        walkins=walkins,
        customers=customers,
        salespeople=await _salespeople(db, quotations, [], now),
    )


def _customer_cadence(orders: list[dict], open_quotations: list[dict]) -> list[dict]:
    """Order history per customer: count, mean gap, average order, last order.

    Derived from the ordered rows already fetched rather than a second
    aggregation, so "average order" here is the same number the KPI shows.
    """
    by_customer: dict[str, list[dict]] = {}
    for o in orders:
        cid = o.get("customer_id")
        if cid:
            by_customer.setdefault(cid, []).append(o)
    open_ids = {q.get("customer_id") for q in open_quotations}

    out = []
    for cid, rows in by_customer.items():
        rows.sort(key=lambda r: r.get("ordered_at") or "")
        totals = _fold(r.get("grand_total") for r in rows)
        stamps = [r.get("ordered_at") for r in rows if r.get("ordered_at")]
        gaps = []
        for earlier, later in zip(stamps, stamps[1:]):
            try:
                gap = (datetime.fromisoformat(later) - datetime.fromisoformat(earlier)).days
            except (TypeError, ValueError):
                continue
            if gap > 0:
                gaps.append(gap)
        out.append({
            "customer_id": cid,
            "customer_name": rows[-1].get("customer_name"),
            "orders": len(rows),
            "mean_gap_days": (_fold(gaps) / len(gaps)) if gaps else None,
            "average_order": round(totals / len(rows), 2) if rows else 0.0,
            "lifetime_revenue": round(totals, 2),
            "last_order_at": stamps[-1] if stamps else None,
            "has_open_quotation": cid in open_ids,
        })
    return out


async def gather_health_signals(db, f: AnalyticsFilter, accessible_floors, window, targets: AnalyticsTargets) -> dict:
    """The seven §8 component values, or None where they cannot be measured.

    None is never 0.0: an unmeasurable signal is excluded and the score
    renormalizes, while zero would say the business scored nothing on it.
    """
    now = datetime.now(timezone.utc)
    followup_match = build_match(AnalyticsFilter(floor_id=f.floor_id, status="any"), accessible_floors, (None, None))
    walkin_match = build_match(AnalyticsFilter(floor_id=f.floor_id, status="any"), accessible_floors, window)
    orders, open_quotations, followups, ready, walkins = await asyncio.gather(
        _collected_orders(db, f, accessible_floors, window),
        _open_quotations(db, f, accessible_floors),
        db.followups.find({**followup_match, "status": "open"}, {"_id": 0, "due_at": 1}).to_list(_MAX_ROWS),
        _ready_items(db, f, accessible_floors),
        db.walkins.count_documents({**walkin_match, "is_deleted": {"$ne": True}}),
    )
    ordered_total = _fold(o.get("grand_total") for o in orders)
    collected_total = _fold(o.get("collected") for o in orders)

    outstanding_rows = [
        (o, float(o.get("grand_total") or 0) - float(o.get("collected") or 0)) for o in orders
    ]
    total_outstanding = _fold(amount for _, amount in outstanding_rows if amount > 0)
    terms = float(getattr(targets, "payment_terms_days", None) or THRESHOLDS["PAYMENT_OVERDUE_DAYS"])
    overdue_outstanding = _fold(
        amount for o, amount in outstanding_rows
        if amount > 0 and (age_days(o.get("ordered_at"), now) or 0) > terms
    )

    open_value = _fold(q.get("grand_total") for q in open_quotations)
    fresh_value = _fold(
        q.get("grand_total") for q in open_quotations
        if (age_days(q.get("created_at"), now) or 0) <= THRESHOLDS["QUOTATION_STALE_DAYS"]
    )

    # Strict, not day-floored: a follow-up due this morning is overdue this
    # afternoon. See is_overdue() for what day-granularity cost here.
    not_overdue = [f_ for f_ in followups if not is_overdue(f_.get("due_at"), now)]

    dispatched_in_time = [
        r for r in ready if (age_days(r.get("ready_at"), now) or 0) <= THRESHOLDS["DISPATCH_WAITING_DAYS"]
    ]

    revenue_target = getattr(targets, "monthly_revenue_target", None)
    conversion_target = getattr(targets, "target_conversion_pct", None)
    conversion_pct = (len(orders) / walkins * 100) if walkins else None

    return {
        "collection_health": (collected_total / ordered_total * 100) if ordered_total > 0 else None,
        "overdue_money": ((1 - overdue_outstanding / total_outstanding) * 100) if total_outstanding > 0 else None,
        "pipeline_health": (fresh_value / open_value * 100) if open_value > 0 else None,
        "dispatch_health": (len(dispatched_in_time) / len(ready) * 100) if ready else None,
        "followup_health": (len(not_overdue) / len(followups) * 100) if followups else None,
        "revenue_attainment": (ordered_total / float(revenue_target) * 100) if revenue_target else None,
        "conversion_health": (
            conversion_pct / float(conversion_target) * 100
            if conversion_target and conversion_pct is not None else None
        ),
    }


async def gather_feed(db, f: AnalyticsFilter, accessible_floors, limit: int = 40) -> list[dict]:
    """Recent executive events, floor-derived by joining the referenced entity."""
    from services.analytics.feed import EXECUTIVE_EVENTS

    now = datetime.now(timezone.utc)
    # Read a wide candidate window rather than limit*5: events whose entity no
    # longer resolves are dropped (they cannot be floor-derived), and a run of
    # them at the head of the stream would otherwise empty the feed. The live
    # database has exactly that — the newest allowlisted events are test
    # follow-ups pointing at a customer id that does not exist.
    events = await db.activity_events.find(
        {"event_type": {"$in": list(EXECUTIVE_EVENTS)}},
        {"_id": 0, "id": 1, "event_type": 1, "created_at": 1, "actor_name": 1, "summary": 1,
         "payload": 1, "quotation_id": 1, "customer_id": 1, "purchase_id": 1},
    ).sort("created_at", -1).to_list(FEED_CANDIDATE_CAP)
    if not events:
        return []

    quotation_ids = {e["quotation_id"] for e in events if e.get("quotation_id")}
    customer_ids = {e["customer_id"] for e in events if e.get("customer_id")}

    entity_floors: dict[str, str] = {}
    values: dict[str, float] = {}
    if quotation_ids:
        async for q in db.quotations.find(
            {"id": {"$in": list(quotation_ids)}}, {"_id": 0, "id": 1, "floor_id": 1, "grand_total": 1},
        ):
            entity_floors[q["id"]] = q.get("floor_id") or "first-floor"
            values[q["id"]] = float(q.get("grand_total") or 0) or None
    if customer_ids:
        async for c in db.customers.find(
            {"id": {"$in": list(customer_ids)}}, {"_id": 0, "id": 1, "floor_id": 1},
        ):
            entity_floors.setdefault(c["id"], c.get("floor_id") or "first-floor")

    return feed_rows(events, entity_floors, values, now, accessible_floors)[:limit]
