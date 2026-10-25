"""The Referral Analytics surface (spec §7 Workspace 3), mirroring
`sales_performance_routes.py`'s shape exactly: `_filter_from_query` /
`_floor_error_to_http` are imported from `executive_overview_routes.py`
rather than redefined, every non-export read goes through `cache.cached`,
and exports check `format` before any caching and bypass it entirely.

`AnalyticsFilter` does carry `referrer_type` and `referrer_id` fields
(services/analytics/filters.py), both hashed by `metrics.filter_signature`
(it runs `dataclasses.asdict(f)` over every field) — but that only helps if
something actually sets them on the `f` this router builds. It does not:
`_filter_from_query` (imported from `executive_overview_routes.py`) only
maps `floor_id`/`preset`/`date_from`/`date_to`, so the `f` every endpoint
here builds always has `referrer_type=None` and `referrer_id=None`
regardless of the request. That means the list endpoint's `type=` query
param and the detail endpoint's `referrer_id` path param are plain function
arguments with no home on `f` — exactly Task 13's `granularity`/`view`
situation, not the "for free" case the fields' mere existence might suggest.
Both therefore get the same manual signature-suffixing treatment:
`:{referrer_type}` on the list cache key, `:{granularity}:{referrer_id}` on
the detail cache key. (`gather_referrer_raw`'s single-referrer call inside
the detail endpoint's own loader does thread `referrer_id` through a
`dataclasses.replace(f, referrer_id=...)`, but that `f` is never the one
`filter_signature` hashes for the cache key, so it doesn't change this.)
"""
from __future__ import annotations

from dataclasses import asdict, replace
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import UserPublic, accessible_floor_ids, require_roles
from db import db
from routes.executive_overview_routes import _filter_from_query, _floor_error_to_http
from services import export
from services.analytics import cache
from services.analytics.attention import THRESHOLDS
from services.analytics.filters import AnalyticsFilter, FloorAccessError
from services.analytics.gather_referrals import gather_referrer_profile_data, gather_referrer_raw
from services.analytics.metrics import filter_signature
from services.analytics.periods import Period, resolve
from services.analytics.referrals import referrer_profile, referrer_summary_rows, summary_dict

router = APIRouter(prefix="/analytics", tags=["analytics"])

_ANALYTICS_ROLES = ("owner", "admin", "manager")
_CACHE_TTL = 60

ReferrerType = Literal["architect", "interior_designer"]
Granularity = Literal["day", "week", "month", "quarter", "year"]
ExportFormat = Literal["csv", "xlsx"]

# Source collections each cached metric reads — same discipline as
# sales_performance_routes.CACHED_SURFACES. The list endpoint only reads
# quotations (for the raw group) and payments (collected_by_quotation, for
# pending_payments). The detail endpoint additionally resolves the Referrer
# doc itself and the products/brands catalog for preference rows.
CACHED_SURFACES: dict[str, list[str]] = {
    "referrers": ["customers", "quotations", "kitchen_projects", "payments", "referrers"],
    "referrer_detail": ["customers", "quotations", "kitchen_projects", "payments", "referrers", "products", "brands"],
}

# The 14-card summary fields (ReferrerSummary), in the order the task brief's
# prose lists them. quotations_total is included alongside
# quotations_confirmed even though the top-level task's shorter column list
# omitted it — the brief itself (the prose spec of record for this router)
# lists both, and a "total referred vs. confirmed" pair is more useful in an
# export than confirmed alone.
_REFERRER_COLUMNS: list[tuple[str, str]] = [
    ("name", "Name"), ("type", "Type"), ("customers_referred", "Customers Referred"),
    ("quotations_total", "Quotations Total"), ("quotations_confirmed", "Orders Confirmed"),
    ("revenue", "Revenue"), ("aov", "AOV"), ("conversion_rate", "Conversion %"),
    ("pending_value", "Pending Value"), ("pending_payments", "Pending Payments"),
    ("is_active", "Active"), ("repeat_customers", "Repeat Customers"),
]


def _period_of(f: AnalyticsFilter) -> Period:
    return resolve(f.preset, f.date_from, f.date_to)


# ---------------------------------------------------------------------------
# Referrer list
# ---------------------------------------------------------------------------

async def _referrer_summary_rows(f: AnalyticsFilter, floors, period: Period, referrer_type: str | None) -> list[dict]:
    window = (period.start, period.end)
    raw = await gather_referrer_raw(db, f, floors, window, referrer_type)
    now = datetime.now(timezone.utc)
    return [summary_dict(row) for row in referrer_summary_rows(raw, now, THRESHOLDS)]


async def _cached_referrer_summary_rows(f: AnalyticsFilter, floors, period: Period, referrer_type: str | None) -> list[dict]:
    # referrer_type is a plain function argument here, NOT threaded onto `f`
    # by `_filter_from_query` (that helper only maps floor_id/preset/
    # date_from/date_to — confirmed by reading it). filter_signature(f)
    # therefore does NOT vary with it, so — same as Task 13's `granularity`/
    # `view` suffixing — it must be appended to the cache signature by hand,
    # or `type=architect` and `type=interior_designer` requests would collide
    # on one cache entry.
    signature = f"{filter_signature(f)}:{referrer_type or 'all'}"
    return await cache.cached(
        "referrers", CACHED_SURFACES["referrers"], signature, floors,
        lambda: _referrer_summary_rows(f, floors, period, referrer_type), ttl=_CACHE_TTL,
    )


@router.get("/referrers")
async def referrers(
    type: ReferrerType | None = Query(None),
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
            rows = await _referrer_summary_rows(f, floors, period, type)
            return export.export_response(rows, _REFERRER_COLUMNS, f"revenue-by-{type or 'referrer'}", format)
        rows = await _cached_referrer_summary_rows(f, floors, period, type)
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
    return {"rows": rows}


# ---------------------------------------------------------------------------
# Referrer detail
# ---------------------------------------------------------------------------

async def _referrer_profile_dict(f: AnalyticsFilter, floors, referrer_id: str, granularity: str, period: Period) -> dict:
    """Assemble an authorized referrer's profile, including a zero profile
    for a newly added directory member with no quotations yet."""
    referrer_doc, monthly_trend, brand_rows, product_rows, floor_rows = await gather_referrer_profile_data(
        db, f, floors, referrer_id, granularity,
    )
    if referrer_doc is None:
        raise HTTPException(status_code=404, detail="Referrer not found")

    window = (period.start, period.end)
    raw = await gather_referrer_raw(db, replace(f, referrer_id=referrer_id), floors, window, None)

    now = datetime.now(timezone.utc)
    summary = referrer_summary_rows(raw, now, THRESHOLDS)[0]
    profile = referrer_profile(referrer_doc, summary, monthly_trend, brand_rows, product_rows, floor_rows)
    return asdict(profile)


@router.get("/referrers/{referrer_id}")
async def referrer_detail(
    referrer_id: str,
    granularity: Granularity = Query("month"),
    floor_id: str | None = Query(None),
    preset: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    user: UserPublic = Depends(require_roles(*_ANALYTICS_ROLES)),
):
    f = _filter_from_query(floor_id, preset, date_from, date_to)
    floors = accessible_floor_ids(user)
    period = _period_of(f)
    signature = f"{filter_signature(f)}:{granularity}:{referrer_id}"
    try:
        return await cache.cached(
            "referrer_detail", CACHED_SURFACES["referrer_detail"], signature, floors,
            lambda: _referrer_profile_dict(f, floors, referrer_id, granularity, period), ttl=_CACHE_TTL,
        )
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
