"""Index the floor-scoped purchase lookups used by stage moves and loans.

Both indexes are non-unique: one PO has many embedded items, and a product
may appear in several orders.  Creating them is safe to repeat.
"""
from __future__ import annotations

from pymongo.errors import OperationFailure


async def _create_index_tolerant(collection, keys, **kwargs) -> None:
    try:
        await collection.create_index(keys, **kwargs)
    except OperationFailure as error:
        # A deployment may already have the same keys under another name.
        if error.code != 85:
            raise


async def up(db) -> None:
    await _create_index_tolerant(
        db.purchase_orders, [("floor_id", 1), ("items.id", 1)],
        name="purchase_orders_floor_item_id",
    )
    await _create_index_tolerant(
        db.purchase_orders,
        [("floor_id", 1), ("items.product_id", 1), ("customer_id", 1)],
        name="purchase_orders_floor_product_customer",
    )
