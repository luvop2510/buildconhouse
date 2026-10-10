"""Normalize purchase stages without discarding immutable delivery history.

Dispatched is the final customer delivery stage. Old supplier receipt events
labeled delivered become inbox; explicit delivered/in-transit rows become
 dispatched. Preserve legacy_stage, timestamps, quantities and stage_history.
The server-side map is bounded by each PO and is idempotent on repeat runs.
"""
from __future__ import annotations

from pymongo.errors import OperationFailure
from services.purchase_stages import stage_expression


async def up(db) -> None:
    normalized = stage_expression("$$item")
    await db.purchase_orders.update_many(
        {"items.stage": {"$in": ["in_transit", "delivered"]}},
        [{"$set": {"items": {"$map": {
            "input": "$items", "as": "item", "in": {"$cond": [
                {"$in": ["$$item.stage", ["in_transit", "delivered"]]},
                {"$mergeObjects": ["$$item", {
                    "legacy_stage": {"$ifNull": ["$$item.legacy_stage", "$$item.stage"]},
                    "stage": normalized,
                    "dispatched_at": {"$cond": [{"$eq": [normalized, "dispatched"]}, {"$ifNull": ["$$item.dispatched_at", "$$item.last_moved_at"]}, None]},
                    "delivered_at": {"$cond": [{"$eq": [normalized, "dispatched"]}, {"$ifNull": ["$$item.delivered_at", "$$item.last_moved_at"]}, None]},
                }]}, "$$item",
            ]},
        }}}}],
    )
    try:
        await db.purchase_orders.create_index(
            [("floor_id", 1), ("status", 1), ("customer_id", 1)],
            name="purchase_orders_floor_status_customer",
        )
    except OperationFailure as error:
        if error.code != 85:
            raise
