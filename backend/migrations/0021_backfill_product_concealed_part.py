"""Backfill the editable concealed-part configuration from legacy SKU fields.

This is additive and idempotent: old import pipelines can keep writing
``concealed_sku`` while all interactive product editors use
``concealed_part``. No existing configured part is replaced.
"""
from __future__ import annotations


async def up(db) -> None:
    cursor = db.products.find({
        "concealed_part": {"$exists": False},
        "$or": [
            {"concealed_sku": {"$type": "string", "$ne": ""}},
            {"concealed_skus.0": {"$exists": True}},
        ],
    }, {"_id": 0, "id": 1, "concealed_sku": 1, "concealed_skus": 1})
    async for product in cursor:
        sku = product.get("concealed_sku") or next(iter(product.get("concealed_skus") or []), None)
        if sku:
            await db.products.update_one(
                {"id": product["id"], "concealed_part": {"$exists": False}},
                {"$set": {"concealed_part": {"sku": str(sku), "qty": 1}}},
            )
