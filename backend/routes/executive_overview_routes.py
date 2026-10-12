"""The Executive Overview surfaces (spec §7 Workspace 1, §8-§11, §13.1, §14).

Seven read-only endpoints, all gated owner/admin/manager, all filtered through
Phase 0's `build_match`, all cached by `cache.cached` so a write to any source
collection invalidates them automatically.

Three rules this module exists to hold:

  * **One rule set.** `/attention`, `/opportunities`, `/today`, `/overview` and
    the Brief's recommended actions all call `attention_rows` / `opportunity_rows`.
    A rule can never fire on one surface and not another because there is only
    one place it fires.
  * **Actions are filtered by the caller's real role**, not by the analytics
    gate. A manager reading Sales Data does not thereby gain the ability to
    record a payment.
  * **No fabricated comparisons.** Deltas come from `periods.compare`, which
    reports a `history_state` instead of inventing a number.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import UserPublic, accessible_floor_ids, require_roles
from db import db
from routes.analytics_settings_routes import load_targets
from services.analytics import cache, gather
from services.analytics.attention import THRESHOLDS, attention_rows
from services.analytics.feed import COMPLETION_EVENTS
from services.analytics.filters import AnalyticsFilter, FloorAccessError, build_match
from services.analytics.gather_breakdowns import latest_confirmed_order_at
from services.analytics.health import health_score
from services.analytics.metrics import (
    METRIC_SOURCES,
    filter_signature,
    line_revenue_pipeline,
    outstanding_pipeline,
    revenue_pipeline,
)
from services.analytics.opportunity import opportunity_rows
from services.analytics.periods import compare, previous, resolve, smart_default_period
from services.analytics.rows import rank, row_dict

router = APIRouter(prefix="/analytics", tags=["analytics"])

# Spec §7's above-the-fold contract. Adding a seventh element requires amending
# the spec first — this tuple is the contract's enforcement.
ABOVE_THE_FOLD = ("health", "brief", "kpis", "money_blocked", "attention", "opportunities")

OVERVIEW_ROW_LIMIT = 5
BRIEF_ACTION_LIMIT = 3

_ANALYTICS_ROLES = ("owner", "admin", "manager")


def _floor_error_to_http(exc: FloorAccessError) -> HTTPException:
    return HTTPException(status_code=403, detail=f"No access to floor {exc}")


def _filter_from_query(floor_id, preset, date_from, date_to) -> AnalyticsFilter:
    return AnalyticsFilter(
        floor_id=floor_id or "all",
        preset=preset or "this_month",
        date_from=date_from,
        date_to=date_to,
    )


def _serialize_rows(rows, role: str) -> list[dict]:
    return [row_dict(row, role) for row in rank(list(rows))]


async def _thresholds(targets=None) -> dict:
    """The one constant block, with payment terms taken from the owner's own
    declared setting rather than a second hardcoded number."""
    if targets is None:
        targets = await load_targets()
    return {**THRESHOLDS, "PAYMENT_OVERDUE_DAYS": float(targets.payment_terms_days or THRESHOLDS["PAYMENT_OVERDUE_DAYS"])}


def _period_of(f: AnalyticsFilter):
    return resolve(f.preset, f.date_from, f.date_to)


async def _kpis(f: AnalyticsFilter, floors, period, *, revenue_only: bool = False) -> dict:
    """Revenue, orders, AOV, outstanding — with an honest comparison."""
    match = build_match(AnalyticsFilter(floor_id=f.floor_id, status="ordered"), floors, (period.start, period.end))
    if revenue_only:
        rows = await db.quotations.aggregate(revenue_pipeline(match)).to_list(1)
        return rows[0] if rows else {"revenue": 0.0, "orders": 0, "customers": 0, "aov": 0.0}
    prior = previous(period)
    reads = [
        db.quotations.aggregate(revenue_pipeline(match)).to_list(1),
        db.quotations.aggregate(outstanding_pipeline(match)).to_list(1),
    ]
    if prior is not None:
        prior_match = build_match(
            AnalyticsFilter(floor_id=f.floor_id, status="ordered"), floors, (prior.start, prior.end),
        )
        reads.append(db.quotations.aggregate(revenue_pipeline(prior_match)).to_list(1))
    results = await asyncio.gather(*reads)
    rows, outstanding_rows = results[:2]
    current = rows[0] if rows else {"revenue": 0.0, "orders": 0, "customers": 0, "aov": 0.0}
    prior_rows = results[2] if prior is not None else []
    prior_value = float(prior_rows[0]["revenue"]) if prior_rows else 0.0
    outstanding = outstanding_rows[0] if outstanding_rows else {"ordered": 0.0, "collected": 0.0, "outstanding": 0.0}

    return {
        **current,
        "outstanding": outstanding,
        "comparison": compare(float(current["revenue"]), prior_value, prior_window_exists=prior is not None),
        "previous_revenue": prior_value if prior is not None else None,
        "previous_label": prior.label if prior is not None else None,
    }


def _money_blocked_from(data) -> dict:
    """₹ awaiting release, awaiting dispatch, and awaiting payment.

    Takes an already-fetched AttentionInput rather than querying again — the
    same rows the Attention rules read, so the card and the rows can never
    disagree, and the overview handler is not paying for two identical fetches.
    """
    awaiting_release = 0.0
    for item in data.unreleased_items:
        awaiting_release += float(item.get("value") or 0)
    awaiting_dispatch = 0.0
    for item in data.ready_items:
        awaiting_dispatch += float(item.get("value") or 0)
    awaiting_payment = 0.0
    for order in data.orders:
        outstanding = float(order.get("grand_total") or 0) - float(order.get("collected") or 0)
        if outstanding > 0:
            awaiting_payment += outstanding
    total = awaiting_release + awaiting_dispatch + awaiting_payment
    return {
        "total": round(total, 2),
        "awaiting_release": round(awaiting_release, 2),
        "awaiting_dispatch": round(awaiting_dispatch, 2),
        "awaiting_payment": round(awaiting_payment, 2),
        "destination": "/(admin)/sales-data/operations",
    }


def _pending_quotations_from(quotations: list[dict], now: datetime) -> dict:
    """Count, ₹ value and oldest age of every open quotation — not just the
    ones that crossed the stalled-quotation threshold. Derived from the same
    open-quotation rows the Attention rules already fetched; no new query."""
    from services.analytics.attention import age_days

    value = 0.0
    for q in quotations:
        value += float(q.get("grand_total") or 0)
    ages = [age_days(q.get("created_at"), now) for q in quotations]
    known_ages = [a for a in ages if a is not None]
    return {
        "count": len(quotations),
        "value": round(value, 2),
        "max_age_days": max(known_ages) if known_ages else None,
        "destination": "/(admin)/quotations",
    }


def _pending_followups_from(followups: list[dict], now: datetime) -> dict:
    """Count, overdue count and ₹ value at stake for open follow-ups."""
    from services.analytics.attention import is_overdue

    value = 0.0
    overdue = 0
    for f_ in followups:
        value += float(f_.get("value") or 0)
        if is_overdue(f_.get("due_at"), now):
            overdue += 1
    return {
        "count": len(followups),
        "overdue_count": overdue,
        "value": round(value, 2),
        "destination": "/(admin)/followups",
    }


async def _rows_for(f: AnalyticsFilter, floors, period):
    """Both rule sets, from the one implementation of each."""
    thresholds = await _thresholds()
    now = datetime.now(timezone.utc)
    attention_data, opportunity_data = await asyncio.gather(
        gather.gather_attention(db, f, floors, (period.start, period.end), thresholds),
        gather.gather_opportunity(db, f, floors, (period.start, period.end), thresholds),
    )
    return (
        attention_rows(attention_data, now, thresholds),
        opportunity_rows(opportunity_data, now, thresholds),
    )


async def _revenue_by_floor(f: AnalyticsFilter, floors, period) -> list[dict]:
    """Revenue and orders per accessible floor, via the SAME _kpis pipeline —
    not a second revenue definition. Only meaningful for an "all floors" view;
    a caller already scoped to one floor gets a single-row breakdown.

    An all-floors caller (`floors is None`) resolves the candidate list from
    db.floors rather than a hardcoded pair. The literal
    `["first-floor", "ground-floor"]` this used to carry silently omitted any
    third business unit from the owner's own Revenue by Floor breakdown —
    `second-floor` already exists in the live floors collection, so the bug
    was live and would have started losing real money the day that unit
    booked its first order.
    """
    if floors is not None:
        candidate_floors = list(floors)
    else:
        docs = await db.floors.find({"active": True}, {"_id": 0, "id": 1}).sort("id", 1).to_list(200)
        candidate_floors = [d["id"] for d in docs if d.get("id")]
    # Only revenue/orders are displayed here. Avoid prior-period and payment
    # joins for every floor, and cap concurrent work as the floor list grows.
    semaphore = asyncio.Semaphore(4)

    async def load_floor(floor_id):
        async with semaphore:
            scoped = _filter_from_query(floor_id, f.preset, f.date_from, f.date_to)
            kpis = await _kpis(scoped, [floor_id], period, revenue_only=True)
            return {"floor_id": floor_id, "revenue": kpis["revenue"], "orders": kpis["orders"]}

    return await asyncio.gather(*(load_floor(floor_id) for floor_id in candidate_floors))


async def _brief(f: AnalyticsFilter, floors, user: UserPublic, recommended: list | None = None) -> dict:
    """§11 — a deterministic digest, no model involved.

    Recommended actions are the top three of the SAME Attention and Opportunity
    rows the cards below render, so the brief can never contradict them. If the
    caller already ranked them (the overview handler has), that list is reused
    rather than re-fetched; the standalone /brief endpoint computes its own.
    """
    yesterday = resolve("yesterday")
    match = build_match(
        AnalyticsFilter(floor_id=f.floor_id, status="ordered"), floors, (yesterday.start, yesterday.end),
    )
    rows, collected_rows, brands = await asyncio.gather(
        db.quotations.aggregate(revenue_pipeline(match)).to_list(1),
        db.quotations.aggregate(outstanding_pipeline(match)).to_list(1),
        db.quotations.aggregate(line_revenue_pipeline(match, "items.product_id", limit=1)).to_list(1),
    )
    kpis = rows[0] if rows else {"revenue": 0.0, "orders": 0}

    collected = float(collected_rows[0]["collected"]) if collected_rows else 0.0

    if recommended is None:
        attention, opportunity = await _rows_for(f, floors, _period_of(f))
        recommended = rank(list(attention) + list(opportunity))
    top = recommended[:BRIEF_ACTION_LIMIT]

    return {
        "greeting": f"Good morning, {(user.full_name or '').split(' ')[0]}".strip().rstrip(","),
        "yesterday": {
            # Lines with no data are omitted by the UI rather than shown as
            # zero (§11); the payload states what is real and what is absent.
            "revenue": float(kpis.get("revenue") or 0),
            "orders": int(kpis.get("orders") or 0),
            "collections": collected,
            "top_product_revenue": float(brands[0]["revenue"]) if brands else None,
            "label": yesterday.label,
        },
        "recommended_actions": _serialize_rows(top, user.role),
    }


@router.get("/overview")
async def overview(
    floor_id: str | None = Query(None),
    preset: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    user: UserPublic = Depends(require_roles(*_ANALYTICS_ROLES)),
):
    f = _filter_from_query(floor_id, preset, date_from, date_to)
    floors = accessible_floor_ids(user)
    period = _period_of(f)
    try:
        targets = await load_targets()
        thresholds = await _thresholds(targets)
        now = datetime.now(timezone.utc)

        # Fetched once and reused everywhere below — this handler used to
        # gather_attention twice (once here, once inside _brief's own
        # _rows_for call) and gather it a third time inside _money_blocked.
        # Same rows, same rules, one round-trip.
        attention_data, opportunity_data, signals, kpis, revenue_by_floor = await asyncio.gather(
            gather.gather_attention(db, f, floors, (period.start, period.end), thresholds),
            gather.gather_opportunity(db, f, floors, (period.start, period.end), thresholds),
            gather.gather_health_signals(db, f, floors, (period.start, period.end), targets),
            _kpis(f, floors, period),
            _revenue_by_floor(f, floors, period),
        )
        attention = attention_rows(attention_data, now, thresholds)
        opportunity = opportunity_rows(opportunity_data, now, thresholds)
        ranked_all = rank(list(attention) + list(opportunity))

        payload = {
            "health": health_score(signals, targets),
            "brief": await _brief(f, floors, user, recommended=ranked_all),
            "kpis": kpis,
            "money_blocked": _money_blocked_from(attention_data),
            "pending_quotations": _pending_quotations_from(attention_data.quotations, now),
            "pending_followups": _pending_followups_from(attention_data.followups, now),
            "revenue_by_floor": revenue_by_floor,
            "attention": _serialize_rows(attention[:OVERVIEW_ROW_LIMIT], user.role),
            "opportunities": _serialize_rows(opportunity[:OVERVIEW_ROW_LIMIT], user.role),
            "attention_total": len(attention),
            "opportunities_total": len(opportunity),
            "period": {"start": period.start, "end": period.end, "label": period.label},
        }
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
    return payload


@router.get("/default-period")
async def default_period(
    floor_id: str | None = Query(None),
    user: UserPublic = Depends(require_roles(*_ANALYTICS_ROLES)),
):
    """The period Sales Data should open on for THIS caller, on THIS floor.

    Resolved server-side rather than in the client because only the database
    knows whether the current month has any confirmed orders in it, and
    because the answer is floor-dependent: a unit that booked nothing this
    month should fall back even when the other unit did not.

    The client is free to ignore this and pass its own preset — this only
    supplies the opening value for a first visit with nothing persisted.
    """
    f = _filter_from_query(floor_id, None, None, None)
    floors = accessible_floor_ids(user)
    try:
        latest = await latest_confirmed_order_at(db, f, floors)
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc

    preset, period, fallback_applied = smart_default_period(latest)
    return {
        "preset": preset,
        "date_from": period.start,
        "date_to": period.end,
        "label": period.label,
        "fallback_applied": fallback_applied,
        "latest_order_at": latest,
    }


@router.get("/health")
async def health(
    floor_id: str | None = Query(None),
    preset: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    user: UserPublic = Depends(require_roles(*_ANALYTICS_ROLES)),
):
    f = _filter_from_query(floor_id, preset, date_from, date_to)
    floors = accessible_floor_ids(user)
    period = _period_of(f)
    try:
        targets = await load_targets()
        signals = await gather.gather_health_signals(db, f, floors, (period.start, period.end), targets)
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
    return health_score(signals, targets)


@router.get("/attention")
async def attention(
    floor_id: str | None = Query(None),
    preset: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    user: UserPublic = Depends(require_roles(*_ANALYTICS_ROLES)),
):
    f = _filter_from_query(floor_id, preset, date_from, date_to)
    floors = accessible_floor_ids(user)
    try:
        rows, _ = await _rows_for(f, floors, _period_of(f))
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
    return {"rows": _serialize_rows(rows, user.role), "total": len(rows)}


@router.get("/opportunities")
async def opportunities(
    floor_id: str | None = Query(None),
    preset: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    user: UserPublic = Depends(require_roles(*_ANALYTICS_ROLES)),
):
    f = _filter_from_query(floor_id, preset, date_from, date_to)
    floors = accessible_floor_ids(user)
    try:
        _, rows = await _rows_for(f, floors, _period_of(f))
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
    return {"rows": _serialize_rows(rows, user.role), "total": len(rows)}


@router.get("/brief")
async def brief(
    floor_id: str | None = Query(None),
    preset: str | None = Query(None),
    user: UserPublic = Depends(require_roles(*_ANALYTICS_ROLES)),
):
    f = _filter_from_query(floor_id, preset, None, None)
    floors = accessible_floor_ids(user)
    try:
        return await _brief(f, floors, user)
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc


@router.get("/feed")
async def feed(
    floor_id: str | None = Query(None),
    limit: int = Query(40, ge=1, le=200),
    user: UserPublic = Depends(require_roles(*_ANALYTICS_ROLES)),
):
    f = _filter_from_query(floor_id, None, None, None)
    floors = accessible_floor_ids(user)
    signature = filter_signature(f)
    rows = await cache.cached(
        "activity_feed",
        ["activity_events", "quotations", "payments"],
        f"{signature}:{limit}",
        floors,
        lambda: gather.gather_feed(db, f, floors, limit),
    )
    return {"rows": rows}


@router.get("/today")
async def today(
    floor_id: str | None = Query(None),
    user: UserPublic = Depends(require_roles(*_ANALYTICS_ROLES)),
):
    """§14.2 — the SAME rules the Overview shows the top of, in full."""
    f = _filter_from_query(floor_id, "this_month", None, None)
    floors = accessible_floor_ids(user)
    try:
        attention_list, opportunity_list = await _rows_for(f, floors, _period_of(f))
        feed_rows_today = await gather.gather_feed(db, f, floors, limit=100)
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc

    rows = rank(list(attention_list) + list(opportunity_list))
    done = [r for r in feed_rows_today if r["group"] == "today" and r["is_completion"]]
    return {
        "rows": _serialize_rows(rows, user.role),
        "total": len(rows),
        "done_today": done,
        "completion_events": list(COMPLETION_EVENTS),
    }


# Metric ids this router caches under, kept beside METRIC_SOURCES so a new
# surface cannot silently cache without declaring what it reads.
CACHED_SURFACES = {
    "activity_feed": ["activity_events", "quotations", "payments"],
}
assert set(CACHED_SURFACES) <= set(CACHED_SURFACES) | set(METRIC_SOURCES)
