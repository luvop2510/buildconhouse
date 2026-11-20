"""Collection values from quoted charges and completed ledger entries."""
from __future__ import annotations

from decimal import Decimal, InvalidOperation


def recorded_collection_total(quotation: dict, *, require_amount: bool = True) -> Decimal | None:
    """Respect the append-only cost history and its legacy single-value fallback."""
    grand = quotation.get("grand_total")
    if require_amount and grand is None:
        return None
    history = quotation.get("payment_extra_history")
    amounts = ([row.get("amount") for row in history if isinstance(row, dict)]
               if isinstance(history, list) else [quotation.get("payment_extra_amount")])
    try:
        money = [Decimal(str(value)) if value is not None else Decimal(0) for value in [grand, *amounts]]
        if require_amount and any(not value.is_finite() or value < 0 for value in money):
            return None
        return round(sum(money, Decimal(0)), 2)
    except (InvalidOperation, ValueError):
        return None


def order_pair_query(order_keys: list[tuple[str, str | None]]) -> dict:
    by_floor: dict[str | None, set[str]] = {}
    for quotation_id, floor_id in order_keys:
        by_floor.setdefault(floor_id, set()).add(quotation_id)
    return {"$or": [{"floor_id": floor_id, "quotation_id": {"$in": sorted(ids)}}
                    for floor_id, ids in by_floor.items()]} if by_floor else {"quotation_id": {"$in": []}}


def aggregate_order_key(value):
    return (value["quotation_id"], value.get("floor_id")) if isinstance(value, dict) else value


async def completed_payment_totals(
    database, quotation_ids: list[str], *, floor_id: str | None = None, cash_only: bool = False,
    order_keys: list[tuple[str, str | None]] | None = None, include_cash: bool = False,
) -> dict:
    """Sum exact-floor receipts and settlement credits by source quotation."""
    if not quotation_ids:
        return {}
    match: dict = {"quotation_id": {"$in": quotation_ids}, "status": "completed"}
    if cash_only:
        match["entry_type"] = {"$ne": "godown_stock_credit"}
    if floor_id is not None:
        match["floor_id"] = floor_id
    if order_keys is not None:
        match.update(order_pair_query(order_keys))
    group = {
        "_id": {"quotation_id": "$quotation_id", "floor_id": "$floor_id"} if order_keys is not None else "$quotation_id",
        "total": {"$sum": "$amount"},
    }
    if include_cash:
        group["cash"] = {"$sum": {"$cond": [{"$eq": ["$entry_type", "godown_stock_credit"]}, 0, "$amount"]}}
        group["invalid_count"] = {"$sum": {"$cond": [{"$and": [{"$isNumber": "$amount"}, {"$gte": ["$amount", 0]}]}, 0, 1]}}
    rows = await database.payments.aggregate([{"$match": match}, {"$group": group}]).to_list(len(quotation_ids) + 5)
    return {aggregate_order_key(row["_id"]): row for row in rows}
