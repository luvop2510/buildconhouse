"""Unified read-only analytics, entity drilldowns and scoped report exports."""
from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import datetime, timezone
from io import BytesIO
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from pymongo.errors import ExecutionTimeout

from auth import UserPublic, accessible_floor_ids, require_roles
from db import db
from services.analytics.filters import FloorAccessError
from services.analytics.unified import (KINDS, Query as SalesQuery, dashboard, entity_query, load_model,
                                       page_rows, period_for, record_public, scope_for,
                                       select_period, sorted_rows)
from services.analytics.unified_exports import MAX_EXPORT_ROWS, export_bytes, report_sections
from services.analytics.unified_profiles import directory, order_detail, profile

router = APIRouter(prefix="/sales-analytics", tags=["sales-analytics"])
Kind = Literal["companies", "products", "architects", "customers"]


def filters(
    floor_id: str = Query("all", max_length=200), preset: str = Query("this_month", max_length=40),
    date_from: str | None = Query(None, max_length=50), date_to: str | None = Query(None, max_length=50),
    date_basis: Literal["confirmation", "quotation", "payment", "delivery"] = "confirmation",
    company_id: str | None = Query(None, max_length=200), product_id: str | None = Query(None, max_length=200),
    architect_id: str | None = Query(None, max_length=200), customer_id: str | None = Query(None, max_length=200),
    status: str | None = Query(None, max_length=40), search: str | None = Query(None, max_length=150),
    sort: Literal["sales_desc", "sales_asc", "orders_desc", "aov_desc", "name_asc", "date_desc", "date_asc", "sales", "orders", "aov", "name", "date"] = "sales_desc",
    granularity: Literal["day", "month", "quarter", "year"] = "month",
    category: str | None = Query(None, max_length=200), size: str | None = Query(None, max_length=120), finish: str | None = Query(None, max_length=120),
    series: str | None = Query(None, max_length=120),
    source: Literal["catalog", "kitchen", "furniture"] | None = None,
    dimension: str | None = Query(None, max_length=200), metric: str | None = Query(None, max_length=100),
):
    return SalesQuery(**locals())


async def model(q, user):
    floors = accessible_floor_ids(user)
    try:
        scope_for(q, floors)
        period_for(q)
        async with asyncio.timeout(20):
            rows = await load_model(db, q, floors)
    except FloorAccessError as exc:
        raise HTTPException(403, "You do not have access to the selected sales department") from exc
    except (TimeoutError, ExecutionTimeout) as exc:
        raise HTTPException(503, "Sales analysis took too long; narrow the filters and retry") from exc
    return rows, floors


@router.get("/dashboard")
async def get_dashboard(response: Response, q: SalesQuery = Depends(filters), user: UserPublic = Depends(require_roles("owner", "admin", "manager"))):
    rows, floors = await model(q, user)
    response.headers["Cache-Control"] = "no-store"
    return dashboard(rows, q, floors)


@router.get("/records")
async def get_records(response: Response, q: SalesQuery = Depends(filters), page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100), user: UserPublic = Depends(require_roles("owner", "admin", "manager"))):
    rows, _ = await model(q, user)
    selected = select_period(rows, q, period_for(q))
    # Metric-specific drilldowns use only records contributing to that metric.
    if q.metric == "customers":
        selected = [row for row in selected if row.get("customer_id")]
    if q.metric == "products":
        selected = [row for row in selected if any(line.get("product_id") for line in row["lines"])]
    response.headers["Cache-Control"] = "no-store"
    return {**page_rows([record_public(row) for row in sorted_rows(selected, q.sort)], page, page_size), "filters": q.public()}


@router.get("/entities/{kind}")
async def get_entities(kind: Kind, response: Response, q: SalesQuery = Depends(filters), page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100), user: UserPublic = Depends(require_roles("owner", "admin", "manager"))):
    # Directory search filters entity labels, not unrelated order/customer text.
    rows, _ = await model(replace(q, search=None), user)
    result = await directory(db, rows, q, accessible_floor_ids(user), kind, page=page, page_size=page_size)
    response.headers["Cache-Control"] = "no-store"
    return {**result, "filters": q.public()}


@router.get("/entities/{kind}/{identity}")
async def get_profile(kind: Kind, identity: str, response: Response, q: SalesQuery = Depends(filters), page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100), user: UserPublic = Depends(require_roles("owner", "admin", "manager"))):
    q = entity_query(q, kind, identity)
    rows, floors = await model(q, user)
    result = await profile(db, rows, q, floors, kind, identity, contacts=not user.custom_access, table_page=page, table_page_size=page_size)
    response.headers["Cache-Control"] = "no-store"
    return result


@router.get("/orders/{identity}")
async def get_order(identity: str, response: Response, q: SalesQuery = Depends(filters), user: UserPublic = Depends(require_roles("owner", "admin", "manager"))):
    rows, _ = await model(replace(q, order_id=identity), user)
    matches = select_period(rows, q, period_for(q))
    if not matches:
        raise HTTPException(404, "This order is unavailable in the selected sales scope")
    if len(matches) != 1:
        raise HTTPException(409, "Choose the record's catalog, Kitchen or Furniture source")
    response.headers["Cache-Control"] = "no-store"
    return order_detail(next(row for row in rows if row["id"] == identity and row["source"] == matches[0]["source"]))


@router.get("/export")
async def export_report(
    format: Literal["pdf", "xlsx"],
    view: Literal["dashboard", "companies", "products", "architects", "customers", "records", "profile", "order", "data_quality"] = "dashboard",
    kind: Kind | None = None, entity_id: str | None = Query(None, max_length=200),
    scope: Literal["full", "current", "records"] = "full", tab: str | None = Query(None, max_length=80),
    report_title: str | None = Query(None, max_length=200),
    q: SalesQuery = Depends(filters), user: UserPublic = Depends(require_roles("owner", "admin", "manager")),
):
    if view == "data_quality":
        if not kind:
            raise HTTPException(422, "Choose the identity directory to export")
        from services.analytics.identity_review import duplicate_groups
        try:
            async with asyncio.timeout(20):
                groups = await duplicate_groups(db, q, accessible_floor_ids(user), kind)
        except FloorAccessError as exc:
            raise HTTPException(403, "You do not have access to the selected sales department") from exc
        except TimeoutError as exc:
            raise HTTPException(503, "Identity review took too long; choose one department and retry") from exc
        identity_rows = [{"review_id": group["id"], "kind": kind, **entity, **(group["review"] or {"decision": "Pending review"})} for group in groups for entity in group["entities"]]
        if len(identity_rows) > MAX_EXPORT_ROWS:
            raise HTTPException(422, "Identity review export exceeds 10,000 rows; choose one department")
        report = {"title": "Identity review", "notes": ["Same names are review candidates, not proof of duplicate identity. Source IDs and records are retained."]}
        metadata = {"Title": "Identity review", "Generated at": datetime.now(timezone.utc).isoformat(), "Directory": kind,
                    "Date basis": "Identity audit: all recorded identities, not date-bounded", "Floor": q.floor_id}
        data = await asyncio.to_thread(export_bytes, report, [("Identity review", identity_rows)], format, metadata)
        mime = "application/pdf" if format == "pdf" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        return StreamingResponse(BytesIO(data), media_type=mime, headers={"Cache-Control": "no-store", "Content-Disposition": f'attachment; filename="buildcon-identity-review.{format}"'})
    if view == "profile":
        if not kind or not entity_id:
            raise HTTPException(422, "Choose an entity for the profile export")
        q = entity_query(q, kind, entity_id)
    if view == "order":
        if not entity_id:
            raise HTTPException(422, "Choose an order for export")
        q = replace(q, order_id=entity_id)
    rows, floors = await model(replace(q, search=None) if view in KINDS else q, user)
    selected = select_period(rows, q, period_for(q))
    if q.metric == "customers":
        selected = [row for row in selected if row.get("customer_id")]
    if q.metric == "products":
        selected = [row for row in selected if any(line.get("product_id") for line in row["lines"])]
    records = [record_public(row) for row in sorted_rows(selected, q.sort)]
    if view == "profile":
        report = await profile(db, rows, q, floors, kind, entity_id, contacts=not user.custom_access, table_page_size=MAX_EXPORT_ROWS)
        if scope == "current" and tab and tab not in {"overview", *report["tables"]}:
            raise HTTPException(422, "Choose a valid profile analysis tab")
    elif view == "order":
        if len(selected) != 1:
            raise HTTPException(404, "This order is unavailable in the selected sales scope")
        report = {"title": "Order " + selected[0]["number"], **order_detail(next(row for row in rows if row["id"] == entity_id and row["source"] == selected[0]["source"]))}
    else:
        report = dashboard(rows, q, floors)
        if view in KINDS:
            entity_rows = await directory(db, rows, q, floors, view, page_size=MAX_EXPORT_ROWS)
            if entity_rows["total"] > len(entity_rows["items"]):
                raise HTTPException(422, "Directory export exceeds 10,000 rows; narrow the department or entity search")
            records = entity_rows["items"]
            report = {"title": view.title(), "coverage": report["coverage"], "insights": [f"{len(records)} permitted {view} match the selected directory filters."]}
    if isinstance(report_title, str) and report_title.strip():
        report = {**report, "title": report_title.strip()}
    sections = report_sections(report, records, view=view, scope=scope, tab=tab)
    metadata = {"Title": report.get("title", "Sales analytics"), "Generated at": datetime.now(timezone.utc).isoformat(),
                "Date basis": q.date_basis, "Period": period_for(q).label, "Date from": period_for(q).start, "Date to (exclusive)": period_for(q).end,
                "Filters": q.public(), "Export view": view, "Export scope": scope, "Selected entity ID": entity_id}
    data = await asyncio.to_thread(export_bytes, report, sections, format, metadata)
    mime = "application/pdf" if format == "pdf" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return StreamingResponse(BytesIO(data), media_type=mime, headers={"Cache-Control": "no-store", "Content-Disposition": f'attachment; filename="buildcon-sales-{view}.{format}"'})
