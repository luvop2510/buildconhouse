"""The compact Sales Data view; no health, opportunity or forecast machinery."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Response

from auth import UserPublic, accessible_floor_ids, require_roles
from db import db
from routes.executive_overview_routes import _floor_error_to_http
from services.analytics.filters import AnalyticsFilter, FloorAccessError
from services.analytics.periods import resolve
from services.analytics.sales_summary import financial_scope, gather_financial_summary, gather_followup_summary

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/sales-summary")
async def sales_summary(
    response: Response,
    floor_id: str | None = None, preset: str = "this_month",
    date_from: str | None = None, date_to: str | None = None, fresh: bool = False,
    user: UserPublic = Depends(require_roles("owner", "admin", "manager")),
):
    f = AnalyticsFilter(floor_id=floor_id or "all", preset=preset, date_from=date_from, date_to=date_to)
    floors = accessible_floor_ids(user)
    now = datetime.now(timezone.utc)
    try:
        financial_scope(f, floors)  # Reject unauthorized scope before any read or cache hit.
        period = resolve(preset, date_from, date_to, now=now)
        financial, followups = await asyncio.gather(
            # Furniture deposit edits and customer deletions are not analytics-versioned.
            # Every visit/refresh therefore reads the authoritative financial ledgers.
            gather_financial_summary(db, f, floors, period),
            # Follow-up mutations are not versioned; never cache the live queue.
            gather_followup_summary(db, f, floors, now),
        )
    except FloorAccessError as exc:
        raise _floor_error_to_http(exc) from exc
    response.headers["Cache-Control"] = "no-store"
    return {**financial, "kpis": {**financial["kpis"], **followups}}
