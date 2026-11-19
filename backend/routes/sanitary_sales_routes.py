"""Owner-only reporting on the selected Sanitary workspace."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import re
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from pymongo.errors import ExecutionTimeout

from auth import UserPublic, accessible_floor_ids, get_current_user
from db import db
from services.sanitary_sales import (
    Basis, GroupUnavailable, INTERIOR_REPORTS, Ledger, Preset, Report, SalesWindow, Sort,
    report_page, report_sort, sales_window,
)
from services.sanitary_sales_excel import workbook_bytes
from services.sanitary_sales_pdf import SANITARY_FLOOR, SavedQuotationPdfUnavailable, load_saved_pdf
from services.sanitary_sales_source import SanitarySalesLimitError, list_brands, load_records

router = APIRouter(prefix="/sanitary-sales", tags=["sanitary-sales"])
NO_STORE = {"Cache-Control": "private, no-store"}
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DAY_PATTERN = r"^\d{4}-\d{2}-\d{2}$"


async def _require_sanitary_owner(user: UserPublic = Depends(get_current_user)) -> UserPublic:
    if user.role != "owner":
        raise HTTPException(403, "Sales Data is available only to the owner.")
    permitted = accessible_floor_ids(user)
    if user.active_floor_id != SANITARY_FLOOR or (permitted is not None and SANITARY_FLOOR not in permitted):
        raise HTTPException(403, "Select The Sanitary Bathroom to view this report.")
    return user


Owner = Annotated[UserPublic, Depends(_require_sanitary_owner)]


@dataclass(frozen=True)
class Filters:
    brand_id: str | None
    preset: Preset
    basis: Basis
    sort: Sort | None
    window: SalesWindow


def _filters(
    brand_id: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
    preset: Preset = "all_time",
    date_from: Annotated[str | None, Query(pattern=DAY_PATTERN)] = None,
    date_to: Annotated[str | None, Query(pattern=DAY_PATTERN)] = None,
    value_basis: Basis = "offer",
    sort: Sort | None = None,
) -> Filters:
    try:
        window = sales_window(preset, date_from, date_to)
    except ValueError as exc:
        raise HTTPException(422, "Choose a valid start and end date.") from exc
    return Filters(brand_id, preset, value_basis, sort, window)


FilterParams = Annotated[Filters, Depends(_filters)]


async def _ledger(report: Report, params: Filters, *, include_pdfs: bool = False) -> Ledger:
    kind = "pending" if report.startswith("pending") else "placed"
    try:
        async with asyncio.timeout(20):
            records = await load_records(
                db, kind=kind, start=params.window.start, end=params.window.end,
                brand_id=params.brand_id, include_pdfs=include_pdfs,
            )
    except SanitarySalesLimitError as exc:
        raise HTTPException(422, str(exc)) from exc
    except (TimeoutError, ExecutionTimeout) as exc:
        raise HTTPException(503, "The report took too long. Try again with a shorter date range.") from exc
    return Ledger(records)


def _sort(report: Report, filters: Filters) -> Sort:
    try:
        return report_sort(report, filters.sort)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/brands")
async def brands(response: Response, _owner: Owner):
    try:
        async with asyncio.timeout(10):
            items = await list_brands(db)
    except (TimeoutError, ExecutionTimeout) as exc:
        raise HTTPException(503, "The company list took too long. Try again.") from exc
    response.headers.update(NO_STORE)
    return {"items": items}


@router.get("/quotation-pdfs/{quotation_id}")
async def quotation_pdf(quotation_id: Annotated[str, Path(min_length=1, max_length=200)], _owner: Owner):
    try:
        async with asyncio.timeout(15):
            data, filename = await load_saved_pdf(db, quotation_id)
    except SavedQuotationPdfUnavailable as exc:
        raise HTTPException(404, "A saved PDF is unavailable for this quotation revision.") from exc
    except (TimeoutError, ExecutionTimeout) as exc:
        raise HTTPException(503, "The saved PDF took too long to load. Try again.") from exc
    stem = re.sub(r"\.pdf$", "", filename, flags=re.IGNORECASE)
    safe_number = _filename_part(stem) or "quotation"
    return Response(data, media_type="application/pdf", headers={
        **NO_STORE, "Content-Disposition": f'inline; filename="{safe_number}.pdf"',
    })


@router.get("/{report}")
async def get_report(
    report: Report, response: Response, filters: FilterParams, _owner: Owner,
    page: Annotated[int, Query(ge=1, le=100_000)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 25,
    group_id: Annotated[str | None, Query(min_length=1, max_length=256)] = None,
    customer_id: Annotated[str | None, Query(min_length=1, max_length=256)] = None,
):
    sort = _sort(report, filters)
    if customer_id is not None and (group_id is None or report not in INTERIOR_REPORTS):
        raise HTTPException(422, "Choose an interior or architect first.")
    include_pdfs = (report == "pending-company" and group_id is not None) or (
        report == "pending-interior" and customer_id is not None
    )
    ledger = await _ledger(report, filters, include_pdfs=include_pdfs)
    try:
        result = await asyncio.to_thread(
            report_page, ledger, report, filters.basis, sort,
            group_id=group_id, customer_id=customer_id, page=page, page_size=page_size,
        )
    except GroupUnavailable as exc:
        raise HTTPException(404, "This record is unavailable under the current filters.") from exc
    response.headers.update(NO_STORE)
    return {
        **result, "page": page, "page_size": page_size,
        "date_from": filters.window.first, "date_to": filters.window.last,
    }


def _filename_part(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9-]+", "-", value).strip("-")[:64]


@router.get("/{report}/export")
async def export_report(report: Report, filters: FilterParams, _owner: Owner):
    sort = _sort(report, filters)
    ledger = await _ledger(report, filters)
    brand = "All companies"
    if filters.brand_id:
        catalog = await list_brands(db)
        brand = next((record["name"] for record in catalog if record["id"] == filters.brand_id), filters.brand_id)
    data = await asyncio.to_thread(workbook_bytes, ledger, report, filters.basis, sort, filters.window, brand, filters.preset)
    dates = f"{filters.window.first}_{filters.window.last}" if filters.window.first else "all-time"
    name = f"Sanitary_{report}_{_filename_part(brand) or 'brand'}_{dates}_{filters.basis}.xlsx"
    return Response(data, media_type=XLSX, headers={**NO_STORE, "Content-Disposition": f'attachment; filename="{name}"'})
