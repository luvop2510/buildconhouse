"""Material Movement Register — one immutable row per movement event.

Single source of truth for the Tiles module's audit trail (Order Created,
Release, Move to Godown, Dispatch from Released, Dispatch from Godown,
Delivered). Every write endpoint in routes/tile_orders.py and the order-
placement automation in services/domain_outbox.py calls `record_movement`
inside the SAME transaction/session as its primary write — the register is
built from committed events, never reconstructed after the fact from
disparate collections (ready_batches / dispatches / chalans), matching the
user's explicit "build this once as the permanent audit log" instruction.
"""
from __future__ import annotations

from typing import Any, Optional

from db import db
from models_tile_orders import TileMaterialMovement, TileMovementType


async def record_movement(
    *,
    movement_type: TileMovementType,
    purchase_order_id: str,
    customer_name: str,
    brand_name: str,
    tile_name: str,
    boxes: float,
    quantity_unit: str = "Box",
    performed_by: str,
    performed_by_name: str,
    po_item_id: Optional[str] = None,
    customer_order_id: Optional[str] = None,
    floor_id: str = "first-floor",
    customer_id: Optional[str] = None,
    brand_id: Optional[str] = None,
    series: Optional[str] = None,
    finish: Optional[str] = None,
    size: Optional[str] = None,
    sku: Optional[str] = None,
    source: Optional[str] = None,
    destination: Optional[str] = None,
    dispatch_id: Optional[str] = None,
    dispatch_number: Optional[str] = None,
    chalan_id: Optional[str] = None,
    chalan_number: Optional[str] = None,
    session: Any = None,
) -> dict:
    movement = TileMaterialMovement(
        movement_type=movement_type, purchase_order_id=purchase_order_id, po_item_id=po_item_id,
        customer_order_id=customer_order_id, floor_id=floor_id, customer_id=customer_id,
        customer_name=customer_name, brand_id=brand_id, brand_name=brand_name, tile_name=tile_name,
        series=series, finish=finish, size=size, sku=sku, boxes=boxes, quantity_unit=quantity_unit, source=source, destination=destination,
        dispatch_id=dispatch_id, dispatch_number=dispatch_number, chalan_id=chalan_id, chalan_number=chalan_number,
        performed_by=performed_by, performed_by_name=performed_by_name,
    )
    doc = movement.model_dump()
    await db.material_movements.insert_one(doc, session=session)
    return doc
