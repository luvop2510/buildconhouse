"""Derive customer fulfillment from every active purchase quantity, never PO status.

The same aggregation backs Customers, Purchases and Quotations. A newly opened
order immediately returns a customer to active views; no lifecycle flag is stored.
"""
from __future__ import annotations

import asyncio

from auth import floor_query
from services.purchase_stages import active_quantity_expression, delivery_timestamp_expression, stage_expression
from services.purchase_workspace import delivered_tracker_quantity_expression, pending_tracker_quantity_expression


def active_purchase_customer_pipeline(user, *, customer_ids: list[str] | None = None) -> list[dict]:
    return [
        {"$match": floor_query(user, {"status": {"$ne": "cancelled"}})},
        {"$unwind": "$items"},
        {"$match": {"items.cancelled": {"$ne": True}}},
        {"$match": {"$expr": {"$gt": [active_quantity_expression(), 0]}}},
        *([] if customer_ids is None else [{"$match": {"$expr": {"$in": [{"$ifNull": ["$items.customer_id", "$customer_id"]}, customer_ids]}}}]),
    ]


def completed_customer_pipeline(user, *, customer_ids: list[str] | None = None) -> list[dict]:
    return active_purchase_customer_pipeline(user, customer_ids=customer_ids) + [
        {"$group": {
            "_id": {"$ifNull": ["$items.customer_id", "$customer_id"]},
            "name": {"$last": {"$ifNull": ["$items.customer_name", "$customer_name"]}},
            "item_count": {"$sum": 1},
            "quantity": {"$sum": active_quantity_expression()},
            "open_count": {"$sum": {"$cond": [{"$eq": [stage_expression(), "dispatched"]}, 0, 1]}},
            "last_delivered_at": {"$max": delivery_timestamp_expression()},
        }},
        {"$match": {"_id": {"$nin": [None, ""]}, "item_count": {"$gt": 0}, "open_count": 0}},
    ]


async def completed_customer_ids(database, user, customer_ids: list[str] | None = None) -> set[str]:
    if customer_ids == []:
        return set()
    rows = await database.purchase_orders.aggregate(
        completed_customer_pipeline(user, customer_ids=customer_ids) + [{"$project": {"_id": 1}}],
    ).to_list(None)
    return {row["_id"] for row in rows}


def dispatched_customer_pipeline(user) -> list[dict]:
    """Delivered products remain discoverable before the whole buyer completes."""
    return active_purchase_customer_pipeline(user) + [
        {"$group": {
            "_id": {"$ifNull": ["$items.customer_id", "$customer_id"]},
            "name": {"$last": {"$ifNull": ["$items.customer_name", "$customer_name"]}},
            "item_count": {"$sum": {"$cond": [{"$gt": [delivered_tracker_quantity_expression(), 0]}, 1, 0]}},
            "quantity": {"$sum": delivered_tracker_quantity_expression()},
            "pending_quantity": {"$sum": pending_tracker_quantity_expression()},
            "last_delivered_at": {"$max": {"$cond": [{"$gt": [delivered_tracker_quantity_expression(), 0]}, delivery_timestamp_expression(), None]}},
        }},
        {"$match": {"_id": {"$nin": [None, ""]}, "item_count": {"$gt": 0}}},
    ]


async def purchase_customer_ids(database, user) -> set[str]:
    """Direct and historical purchase customers also have confirmed orders.

    Item ownership can differ from the original PO customer after a transfer.
    Share the active quantity/cancellation policy with the completion register.
    """
    rows = await database.purchase_orders.aggregate(active_purchase_customer_pipeline(user) + [
        {"$group": {"_id": {"$ifNull": ["$items.customer_id", "$customer_id"]}}},
        {"$match": {"_id": {"$nin": [None, ""]}}},
    ]).to_list(None)
    return {row["_id"] for row in rows}


async def confirmed_customer_ids(database, user) -> set[str]:
    """Buyers with an actual order, regardless of legacy lifecycle metadata.

    Walk-in profiles and draft quotations are prospective identities used by
    selection workflows. They do not belong in Customers or Purchases until
    an order exists. Retain direct/legacy orders and transferred item owners.
    Independent floor-scoped reads run concurrently to avoid serial latency.
    """
    quotation_ids, tile_ids, purchase_ids = await asyncio.gather(
        database.quotations.distinct(
            "customer_id", floor_query(user, {"status": {"$in": ["ordered", "won"]}}),
        ),
        database.customer_orders.distinct(
            "customer_id", floor_query(user, {"is_deleted": {"$ne": True}}),
        ),
        purchase_customer_ids(database, user),
    )
    return {value for value in set(quotation_ids + tile_ids) | purchase_ids
            if isinstance(value, str) and value}
