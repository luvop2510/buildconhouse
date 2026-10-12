"""The only place an analytics Mongo match document is built."""
from __future__ import annotations

from services.multi_filters import filter_values, filter_condition
from dataclasses import dataclass
from typing import Optional, Sequence


class FloorAccessError(Exception):
    """Caller asked for a floor they cannot see. Routes turn this into a 403."""


@dataclass(frozen=True)
class AnalyticsFilter:
    floor_id: Optional[str] = None          # None or "all" → every accessible floor
    preset: str = "this_month"
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    brand_id: Optional[str] = None
    category_id: Optional[str] = None
    supplier_id: Optional[str] = None
    salesperson_id: Optional[str] = None
    referrer_type: Optional[str] = None
    referrer_id: Optional[str] = None
    customer_id: Optional[str] = None
    status: str = "ordered"                 # "any" drops the status clause


def date_field_for(status: str) -> str:
    """Revenue dates by ordered_at — the write-once confirmation stamp.

    updated_at is never used: it is re-stamped on every edit, so an edited
    old order would move between reporting periods. Non-revenue queries
    (open quotations, pipeline) date by created_at instead.
    """
    return "ordered_at" if status == "ordered" else "created_at"


def build_match(
    f: AnalyticsFilter,
    accessible_floors: Optional[Sequence[str]],
    window: tuple[Optional[str], Optional[str]],
    product_ids: Optional[Sequence[str]] = None,
) -> dict:
    """Build the match stage every analytics pipeline starts from.

    accessible_floors is None for owner/manager (all floors) — an empty list
    is NOT the same thing: it means a restricted caller with no floors, which
    must match nothing. window is an already-resolved (start, end) pair from
    periods.resolve. product_ids is supplied by the caller when filtering by
    brand, so this stays free of database access and unit-testable.
    """
    match: dict = {}

    if f.status != "any":
        match["status"] = f.status

    if f.floor_id and f.floor_id != "all":
        if accessible_floors is not None and any(value not in accessible_floors for value in filter_values(f.floor_id)):
            raise FloorAccessError(f.floor_id)
        match["floor_id"] = {"$in": filter_values(f.floor_id)}
    elif accessible_floors is not None:
        match["floor_id"] = {"$in": list(accessible_floors)}

    start, end = window
    if start or end:
        # Periods and chart buckets share [start, end) boundaries. Including
        # the end counts midnight orders in both adjacent days/months.
        bounds = {k: v for k, v in (("$gte", start), ("$lt", end)) if v}
        match[date_field_for(f.status)] = bounds

    if f.salesperson_id:
        match["created_by"] = filter_condition(f.salesperson_id)
    if f.customer_id:
        match["customer_id"] = filter_condition(f.customer_id)
    if f.referrer_id:
        match["referrer_id"] = filter_condition(f.referrer_id)
    if f.referrer_type:
        match["referrer_type"] = filter_condition(f.referrer_type)
    if f.brand_id is not None and product_ids is not None:
        # Deliberately keeps an empty list: a brand with no products must
        # match nothing, not everything.
        match["items.product_id"] = {"$in": list(product_ids)}

    return match
