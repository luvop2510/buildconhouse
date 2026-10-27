"""Furniture analytics preserve the saved RNB ledger and finalization date."""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException

from services.analytics.filters import AnalyticsFilter, build_match
from services.furniture_quotations import FURNITURE_FLOOR_ID


def furniture_match(f: AnalyticsFilter, floors, window) -> dict:
    match = build_match(f, floors, (None, None))
    requested = match.get("floor_id", {}).get("$in")
    match["floor_id"] = {"$in": [FURNITURE_FLOOR_ID] if requested is None or FURNITURE_FLOOR_ID in requested else []}
    match.update(status="final", is_deleted={"$ne": True}, is_archived={"$ne": True}, archived_at=None)
    start, end = window
    if start or end:
        match["finalized_at"] = {key: value for key, value in (("$gte", start), ("$lt", end)) if value}
    # Furniture has no product attribution; these filters cannot include its ledger.
    if any((f.brand_id, f.category_id, f.supplier_id)):
        match["id"] = {"$in": []}
    return match


def money_decimal(field: str) -> dict:
    return {"$convert": {"input": field, "to": "decimal", "onError": None, "onNull": None}}


def _public_money(value) -> float:
    number = value.to_decimal() if hasattr(value, "to_decimal") else Decimal(str(value))
    if not number.is_finite():
        raise HTTPException(503, "Furniture financial values need review before reporting.")
    return float(number.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


async def gather_furniture_reference_rows(db, f: AnalyticsFilter, floors, window, kind: str | None = None, *, limit=100) -> list[dict]:
    match = furniture_match(f, floors, window)
    match.setdefault("referrer_id", {"$nin": [None, ""]})
    if kind:
        match["referrer_type"] = kind
    result = await db.furniture_quotations.aggregate([
        {"$match": match},
        {"$set": {"_revenue_rnb": money_decimal("$total_payable_rmb")}},
        {"$facet": {
            "invalid": [{"$match": {"$or": [{"_revenue_rnb": None}, {"_revenue_rnb": {"$lt": 0}}]}}, {"$count": "count"}],
            "rows": [
                {"$group": {"_id": "$referrer_id", "name": {"$max": "$referrer_name"},
                            "company": {"$max": "$referrer_company"}, "type": {"$max": "$referrer_type"},
                            "revenue_rnb": {"$sum": "$_revenue_rnb"}, "orders_rnb": {"$sum": 1},
                            "last_order_at": {"$max": "$finalized_at"}}},
                {"$sort": {"revenue_rnb": -1, "_id": 1}}, {"$limit": limit},
                {"$project": {"_id": 0, "id": "$_id", "name": 1, "company": 1, "type": 1,
                              "revenue_rnb": 1, "orders_rnb": 1, "last_order_at": 1}},
            ],
        }},
    ]).to_list(1)
    data = result[0] if result else {}
    if data.get("invalid"):
        raise HTTPException(503, "Furniture financial values need review before reporting.")
    return [{**row, "revenue_rnb": _public_money(row["revenue_rnb"])} for row in data.get("rows", [])]


async def gather_furniture_reference_records(db, f: AnalyticsFilter, floors, window) -> tuple[list[dict], float, int]:
    """Bound detail rows; the total covers every final ledger before the row cap."""
    result = await db.furniture_quotations.aggregate([
        {"$match": furniture_match(f, floors, window)},
        {"$set": {"_payable": money_decimal("$total_payable_rmb"),
                  "_received": money_decimal("$total_received_rmb"), "_balance": money_decimal("$balance_rmb")}},
        {"$facet": {
            "invalid": [{"$match": {"$or": [{"_payable": None}, {"_received": None}, {"_balance": None},
                                             {"_payable": {"$lt": 0}}, {"_received": {"$lt": 0}}]}}, {"$count": "count"}],
            "total": [{"$group": {"_id": None, "revenue_rnb": {"$sum": "$_payable"}, "count": {"$sum": 1}}}],
            "rows": [{"$sort": {"finalized_at": -1, "id": -1}}, {"$limit": 100},
                     {"$project": {"_id": 0, "id": 1, "customer_name": 1, "customer_id": 1,
                                   "referrer_name": 1, "referrer_type": 1, "referrer_company": 1,
                                   "total_payable_rmb": 1, "total_received_rmb": 1, "balance_rmb": 1, "finalized_at": 1}}],
        }},
    ]).to_list(1)
    data = result[0] if result else {}
    if data.get("invalid"):
        raise HTTPException(503, "Furniture financial values need review before reporting.")
    totals = (data.get("total") or [{}])[0]
    return data.get("rows", []), _public_money(totals.get("revenue_rnb", 0)), int(totals.get("count", 0))
