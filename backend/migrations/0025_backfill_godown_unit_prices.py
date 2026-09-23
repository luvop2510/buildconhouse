"""Recover prices for older godown lots from their original purchase lines.

Only source purchase amounts are used; an unrelated current catalog price must
not be presented as the historical stock value. Lots without a source price
remain explicitly unpriced for staff to review.
"""
from __future__ import annotations

from datetime import datetime, timezone


async def up(db) -> None:
    now = datetime.now(timezone.utc).isoformat()
    async for lot in db.godown_stock.find({"unit_price": {"$exists": False}}, {"_id": 0, "id": 1, "source_purchase_order_id": 1, "source_purchase_item_id": 1}):
        po_id = lot.get("source_purchase_order_id")
        item_id = lot.get("source_purchase_item_id")
        if not po_id or not item_id:
            continue
        po = await db.purchase_orders.find_one({"id": po_id}, {"_id": 0, "items": 1})
        item = next((row for row in (po or {}).get("items", []) if row.get("id") == item_id), None)
        if not item or item.get("unit_cost") is None:
            continue
        await db.godown_stock.update_one(
            {"id": lot["id"], "unit_price": {"$exists": False}},
            {"$set": {"unit_price": float(item["unit_cost"]), "updated_at": now}},
        )
