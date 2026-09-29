"""The Performance + Collections surfaces (spec §7 Workspace 2 and Workspace 3).

Six read-only endpoints, all gated owner/admin/manager, mirroring
`executive_overview_routes.py`'s shape: `_filter_from_query` / `_floor_error_to_http`
are imported from that module rather than redefined — they are already generic
over `AnalyticsFilter`, nothing Executive-Overview-specific about them. Every
Mongo read still goes through Phase 0's `build_match` (inside the
`gather_performance` functions this router calls), so floor scoping and the
ordered_at-vs-created_at date-field choice exist in exactly one place, same as
every other analytics surface.

Two rules this module exists to hold:

  * **Every non-export response is cached.** `cache.cached` keys on the metric
    id, the source collections it reads, the resolved filter, and the
    caller's accessible floors, so a write to any source collection
    invalidates it automatically and one user's floor-scoped rows can never
    leak into another's cache entry.
  * **Exports are never cached.** `format=csv|xlsx` is checked before the
    cache wrapper and short-circuits straight to `export.export_response` —
    a downloaded file must reflect the moment it was requested, not a
    minute-old snapshot (Global Constraints).

One deliberate deviation from what `gather_salespeople`'s own `(None, None)`
window "previous_window" argument would otherwise do: see `_salespeople_rows`
below.
"""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import UserPublic, accessible_floor_ids, require_roles
from db import db
from routes.executive_overview_routes import _filter_from_query, _floor_error_to_http
from services import export
from services.analytics import cache
from services.analytics.collections import collections_by_age, collections_by_customer
from services.analytics.filters import AnalyticsFilter, FloorAccessError
from services.analytics.gather_performance import (
    gather_category_revenue,
    gather_collections_orders,
    gather_funnel,
    gather_revenue_trend,
    gather_salespeople,
)
from services.analytics.metrics import filter_signature
from services.analytics.performance import category_rows, funnel_stages, salesperson_rows
from services.analytics.periods import Period, previous, resolve

router = APIRouter(prefix="/analytics", tags=["analytics"])

# The Performance workspace's above-the-fold contract, mirroring
# executive_overview_routes.ABOVE_THE_FOLD. Adding a fifth element requires
# amending the spec first — this tuple is the contract's enforcement.
ABOVE_THE_FOLD_PERFORMANCE = ("revenue_trend", "salespeople", "funnel", "categories")

_ANALYTICS_ROLES = ("owner", "admin", "manager")
_CACHE_TTL = 60

Granularity = Literal["day", "week", "month", "quarter", "year"]
ExportFormat = Literal["csv", "xlsx"]

# Source collections each cached metric reads, read straight off the
# gather_performance functions below — kept beside the metric ids so a new
# surface cannot silently cache without declaring what it invalidates on.
CACHED_SURFACES: dict[str, list[str]] = {
    "revenue_trend": ["quotations"],
    "salespeople": ["quotations", "walkins", "followups"],
    "funnel": ["walkins", "quotations", "customer_orders", "ready_batches", "dispatches", "payments"],
    "categories": ["quotations", "categories"],
    "collections": ["quotations", "payments"],
}
assert set(ABOVE_THE_FOLD_PERFORMANCE) <= set(CACHED_SURFACES), "every above-the-fold metric must declare its cache surface"

_SALESPEOPLE_COLUMNS: list[tuple[str, str]] = [
    ("name", "Name"), ("revenue", "Revenue"), ("orders", "Orders"),
    ("aov", "AOV"), ("conversion_pct", "Conversion %"), ("rank", "Rank"),
]
_REVENUE_TREND_COLUMNS: list[tuple[str, str]] = [
    ("bucket", "Period"), ("revenue", "Revenue"),
]
_CATEGORY_COLUMNS: list[tuple[str, str]] = [
    ("name", "Category"), ("revenue", "Revenue"), ("qty", "Qty"),
]
_COLLECTIONS_BY_CUSTOMER_COLUMNS: list[tuple[str, str]] = [
    ("customer_name", "Customer"), ("grand_total", "Order Value"), ("collected", "Collected"),
    ("outstanding", "Outstanding"), ("age_days", "Age (days)"), ("age_bucket", "Age Bucket"),
]
_COLLECTIONS_BY_AGE_COLUMNS: list[tuple[str, str]] = [
    ("bucket", "Age Bucket"), ("count", "Count"), ("outstanding", "Outstanding"),
]


def _period_of(f: AnalyticsFilter) -> Period:
    return resolve(f.preset, f.date_from, f.date_to)


# ---------------------------------------------------------------------------
# Revenue trend
# ---------------------------------------------------------------------------

async def _revenue_trend_points(f: AnalyticsFilter, floors, period: Period, granularity: str) -> list[dict]:
    if not period.start or not period.end:
        # periods.buckets() requires two real ISO timestamps to align calendar
        # buckets against; an open "all time" window (preset=all, or a custom
        # range missing a bound) has none. Rather than crash or silently clamp
        # to an arbitrary range, an unbounded window reports no points — the
        # caller already knows the preset it asked for was open-ended.
        return []
    return await gather_revenue_trend(db, f, floors, (period.start, period.end), granularity)


@router.get("/revenue-trend")
async def revenue_trend(
    granularity: Granularity = Query("day"),
    floor_id: str | None = Query(None),
    preset: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    format: ExportFormat | None = Query(None),
    user: UserPublic = Depends(require_roles(*_ANALYTICS_ROLES)),
):
    f = _filter_from_query(floor_id, preset, date_from, date_to)
    floors = accessible_floor_ids(user)
    period = _period_of(f)
    signature = f"{filter_signature(f)}:{granularity}"
    try:
        if format:
            points = await _revenue_trend_points(f, floors, period, granularity)
            return export.export_response(points, _REVENUE_TREND_COLUMNS, "revenue-over-time", format)
        points = await cache.cached(
            "revenue_trend", CACHED_SURFACES["revenue_trend"], signature, floors,
            lambda: _revenue_trend_points(f, floors, period, granularity), ttl=_CACHE_TTL,
        )
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
    return {"points": points}


# ---------------------------------------------------------------------------
# Salespeople
# ---------------------------------------------------------------------------

async def _salespeople_rows(f: AnalyticsFilter, floors, period: Period) -> list[dict]:
    """Ranked salesperson rows for `period`, compared against the immediately
    preceding equal window.

    `gather_salespeople`'s `previous_window` argument is passed straight to
    `filters.build_match`, and `build_match` only adds a date clause when the
    window has a start or an end — a `(None, None)` window therefore does NOT
    mean "match nothing" the way one might assume from the name; it means "no
    date filter at all", i.e. every ordered quotation ever. So when
    `periods.previous(period)` returns None (an unbounded "all time" period
    has no comparable prior window), we deliberately do NOT let
    `gather_salespeople` compute a `(None, None)` "previous" revenue map —
    that would silently compare the current period against all-time revenue,
    which is a worse answer than "no prior period" ever was. We still pass
    `(None, None)` as the argument (so the call shape stays uniform and never
    raises), but then discard whatever it computed and hand
    `salesperson_rows` empty maps ourselves, so every row's comparison reports
    `history_state="no_prior_period"` instead of a fabricated delta against
    all-time totals.
    """
    window = (period.start, period.end)
    prior = previous(period)
    previous_window = (prior.start, prior.end) if prior is not None else (None, None)

    current, prev_revenue, prev_rank = await gather_salespeople(db, f, floors, window, previous_window)
    if prior is None:
        prev_revenue, prev_rank = {}, {}

    return [asdict(row) for row in salesperson_rows(current, prev_revenue, prev_rank)]


async def _cached_salespeople(f: AnalyticsFilter, floors, period: Period) -> list[dict]:
    signature = filter_signature(f)
    return await cache.cached(
        "salespeople", CACHED_SURFACES["salespeople"], signature, floors,
        lambda: _salespeople_rows(f, floors, period), ttl=_CACHE_TTL,
    )


@router.get("/salespeople")
async def salespeople(
    floor_id: str | None = Query(None),
    preset: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    format: ExportFormat | None = Query(None),
    user: UserPublic = Depends(require_roles(*_ANALYTICS_ROLES)),
):
    f = _filter_from_query(floor_id, preset, date_from, date_to)
    floors = accessible_floor_ids(user)
    period = _period_of(f)
    try:
        if format:
            rows = await _salespeople_rows(f, floors, period)
            return export.export_response(rows, _SALESPEOPLE_COLUMNS, "salespeople", format)
        rows = await _cached_salespeople(f, floors, period)
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
    return {"rows": rows}


@router.get("/salespeople/{salesperson_id}")
async def salesperson_detail(
    salesperson_id: str,
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
        rows = await _cached_salespeople(f, floors, period)
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
    for row in rows:
        if row["salesperson_id"] == salesperson_id:
            return row
    raise HTTPException(status_code=404, detail="Salesperson not found")


# ---------------------------------------------------------------------------
# Funnel
# ---------------------------------------------------------------------------

async def _funnel_stage_rows(f: AnalyticsFilter, floors, period: Period) -> list[dict]:
    window = (period.start, period.end)
    counts, stage_durations, avg_order_value = await gather_funnel(db, f, floors, window)
    return [asdict(stage) for stage in funnel_stages(counts, stage_durations, avg_order_value)]


@router.get("/funnel")
async def funnel(
    floor_id: str | None = Query(None),
    preset: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    user: UserPublic = Depends(require_roles(*_ANALYTICS_ROLES)),
):
    f = _filter_from_query(floor_id, preset, date_from, date_to)
    floors = accessible_floor_ids(user)
    period = _period_of(f)
    signature = filter_signature(f)
    try:
        stages = await cache.cached(
            "funnel", CACHED_SURFACES["funnel"], signature, floors,
            lambda: _funnel_stage_rows(f, floors, period), ttl=_CACHE_TTL,
        )
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
    return {"stages": stages}


# ---------------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------------

async def _category_revenue_rows(f: AnalyticsFilter, floors, period: Period) -> list[dict]:
    window = (period.start, period.end)
    raw, names = await gather_category_revenue(db, f, floors, window)
    return [asdict(row) for row in category_rows(raw, names)]


async def _cached_categories(f: AnalyticsFilter, floors, period: Period) -> list[dict]:
    signature = filter_signature(f)
    return await cache.cached(
        "categories", CACHED_SURFACES["categories"], signature, floors,
        lambda: _category_revenue_rows(f, floors, period), ttl=_CACHE_TTL,
    )


@router.get("/categories")
async def categories(
    floor_id: str | None = Query(None),
    preset: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    format: ExportFormat | None = Query(None),
    user: UserPublic = Depends(require_roles(*_ANALYTICS_ROLES)),
):
    f = _filter_from_query(floor_id, preset, date_from, date_to)
    floors = accessible_floor_ids(user)
    period = _period_of(f)
    try:
        if format:
            rows = await _category_revenue_rows(f, floors, period)
            return export.export_response(rows, _CATEGORY_COLUMNS, "categories", format)
        rows = await _cached_categories(f, floors, period)
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
    return {"rows": rows}


# ---------------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------------

async def _collections_orders(f: AnalyticsFilter, floors, period: Period) -> list[dict]:
    window = (period.start, period.end)
    return await gather_collections_orders(db, f, floors, window)


async def _collections_by_customer_rows(f: AnalyticsFilter, floors, period: Period) -> list[dict]:
    orders = await _collections_orders(f, floors, period)
    now = datetime.now(timezone.utc)
    return [asdict(row) for row in collections_by_customer(orders, now)]


async def _collections_by_age_buckets(f: AnalyticsFilter, floors, period: Period) -> dict:
    orders = await _collections_orders(f, floors, period)
    now = datetime.now(timezone.utc)
    return collections_by_age(orders, now)


async def _cached_collections_by_customer(f: AnalyticsFilter, floors, period: Period) -> list[dict]:
    signature = f"{filter_signature(f)}:by_customer"
    return await cache.cached(
        "collections", CACHED_SURFACES["collections"], signature, floors,
        lambda: _collections_by_customer_rows(f, floors, period), ttl=_CACHE_TTL,
    )


async def _cached_collections_by_age(f: AnalyticsFilter, floors, period: Period) -> dict:
    signature = f"{filter_signature(f)}:by_age"
    return await cache.cached(
        "collections", CACHED_SURFACES["collections"], signature, floors,
        lambda: _collections_by_age_buckets(f, floors, period), ttl=_CACHE_TTL,
    )


@router.get("/collections")
async def collections_view(
    view: Literal["by_customer", "by_age"] = Query("by_customer"),
    floor_id: str | None = Query(None),
    preset: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    format: ExportFormat | None = Query(None),
    user: UserPublic = Depends(require_roles(*_ANALYTICS_ROLES)),
):
    f = _filter_from_query(floor_id, preset, date_from, date_to)
    floors = accessible_floor_ids(user)
    period = _period_of(f)
    try:
        if format:
            if view == "by_age":
                buckets = await _collections_by_age_buckets(f, floors, period)
                rows = [{"bucket": label, **data} for label, data in buckets.items()]
                return export.export_response(rows, _COLLECTIONS_BY_AGE_COLUMNS, "collections-by-age", format)
            rows = await _collections_by_customer_rows(f, floors, period)
            return export.export_response(rows, _COLLECTIONS_BY_CUSTOMER_COLUMNS, "collections-by-customer", format)

        if view == "by_age":
            return {"buckets": await _cached_collections_by_age(f, floors, period)}
        return {"rows": await _cached_collections_by_customer(f, floors, period)}
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
