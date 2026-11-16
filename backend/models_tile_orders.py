"""Tile Orders logistics — CustomerOrder aggregation + ReadyBatch/Dispatch/
Chalan as first-class collections. Kept separate from models.py (already
740+ lines) and prefixed `Tile` to avoid colliding with the existing
Chalan/ChalanLineItem classes still used by the old embedded system on
PurchaseOrder.chalans (left in place, unread by any code in this module —
see the design doc's Migration section).

TileChalan is immutable once created: no route in routes/tile_orders.py
ever issues a PATCH/PUT against the chalans collection. A correction always
means a new TileDispatch + new TileChalan, never editing an existing one.
"""
from __future__ import annotations

from typing import Literal, Optional
from uuid import uuid4

from pydantic import BaseModel, Field

from models import TimestampedModel, now_iso

TileOverallStatus = Literal["Pending", "Ready", "Partially Dispatched", "Dispatched", "Delivered"]
TileLocation = Literal["Pending", "Ready", "Dispatched", "Godown", "Delivered"]


class TileCustomerOrderBrand(BaseModel):
    brand_id: Optional[str] = None
    brand_name: str
    supplier_id: Optional[str] = None
    supplier_name: str
    purchase_order_id: str
    status: TileOverallStatus = "Pending"
    # This PO's own cumulative dispatched-box count — kept in sync by
    # routes/tile_orders.py's _sync_customer_order_brand_status alongside
    # `status`. Summed across every brand entry, this is the numerator
    # completion_percentage() uses against the order's (immutable,
    # set-once-at-placement) total_boxes — see TileCustomerOrder.completion_percentage.
    boxes_dispatched: float = 0


class TileCustomerOrderDashboardSummary(BaseModel):
    """Cached read-model for the Customer tab, refreshed transactionally on
    every child write. `waiting_days` is deliberately NOT part of this cache
    — it depends on "today," not on stored order state, so it is always
    computed live by tile_order_status.waiting_days()."""
    completion_percentage: float = 0
    overall_status: TileOverallStatus = "Pending"
    supplier_statuses: list[dict] = []  # [{supplier_name, status}]


class TileCustomerOrder(TimestampedModel):
    number: str                    # "TORD-2026-0001"
    version: int = 0                # optimistic-locking counter — incremented
                                     # on every aggregation update; guards
                                     # against two sibling POs racing to
                                     # update the same rollup
    quotation_id: str
    quotation_number: str
    customer_id: str
    customer_name: str
    customer_phone: str
    # Immutable delivery snapshot captured at placement time.
    delivery_name: str
    delivery_phone: str
    delivery_address: str
    delivery_city: str
    delivery_pincode: str
    delivery_state: str
    floor_id: str
    created_by: str
    created_by_name: str
    brands: list[TileCustomerOrderBrand] = []
    total_products: int = 0
    total_boxes: float = 0
    total_value: float = 0
    overall_status: TileOverallStatus = "Pending"
    completion_percentage: float = 0
    dashboard_summary: TileCustomerOrderDashboardSummary
    last_activity: Optional[str] = None
    last_activity_at: Optional[str] = None
    is_deleted: bool = False
    deleted_at: Optional[str] = None
    deleted_by: Optional[str] = None


class TileReadyBatch(TimestampedModel):
    batch_number: str          # "RB-2026-0001"
    purchase_order_id: str
    po_item_id: str
    customer_order_id: str
    floor_id: str
    supplier_id: Optional[str] = None
    supplier_name: str
    customer_id: str
    customer_name: str
    tile_name: str
    series: Optional[str] = None
    finish: Optional[str] = None
    size: Optional[str] = None
    sku: Optional[str] = None
    quantity_unit: Literal["Box", "Pieces"] = "Box"
    qty: float
    remaining_qty: float       # decrements as Dispatches consume it
    created_by: str
    created_by_name: str
    auto_created: bool = False  # true for behind-the-scenes batches from direct dispatch
    is_deleted: bool = False
    deleted_at: Optional[str] = None
    deleted_by: Optional[str] = None


class TileDispatchLineConsumed(BaseModel):
    ready_batch_id: str
    po_item_id: str
    qty: float


class TileDispatchAttachment(BaseModel):
    # No UI this pass — LR copies / transport receipts / vehicle photos /
    # POD can attach later without a migration.
    type: str
    url: str
    uploaded_by: str
    uploaded_at: str = Field(default_factory=now_iso)


class TileDispatch(TimestampedModel):
    dispatch_number: str        # "DSP-2026-0001"
    purchase_order_id: str
    customer_order_id: str
    floor_id: str
    supplier_id: Optional[str] = None
    supplier_name: str
    customer_id: str
    customer_name: str
    ready_batches_consumed: list[TileDispatchLineConsumed]
    # Tile Orders workflow redesign (2026-08): which BuildCon-side pool this
    # dispatch was raised from — "released" (straight from what the brand
    # released, never touched Godown) or "godown" (pulled out of BuildCon's
    # own warehouse stock). Surfaced on the Material Movement Register as
    # the "Source" column. Defaults to "released" for any pre-redesign rows.
    source: Literal["released", "godown"] = "released"
    destination_type: Literal["Customer", "Godown"]
    destination_name: str
    destination_address: str
    destination_city: str
    dispatch_date: str
    dispatch_time: str
    created_by: str
    created_by_name: str
    chalan_id: str              # 1:1, always set — Chalan is generated in the same transaction
    # Charged at the point material is dispatched.  This is deliberately a
    # dispatch-level value: one order can be delivered in several loads.
    labor_cost: float = Field(default=0, ge=0)
    godown_received_at: Optional[str] = None
    godown_received_by: Optional[str] = None
    godown_received_by_name: Optional[str] = None
    delivered_at: Optional[str] = None    # future — modeled now, no action/UI this pass
    delivered_by: Optional[str] = None
    delivered_by_name: Optional[str] = None
    attachments: list[TileDispatchAttachment] = []
    inventory_transaction_id: Optional[str] = None   # unused today — future inventory-module hook
    is_deleted: bool = False
    deleted_at: Optional[str] = None
    deleted_by: Optional[str] = None


class TileChalanItem(BaseModel):
    po_item_id: str
    tile_name: str
    series: Optional[str] = None
    finish: Optional[str] = None
    size: Optional[str] = None
    sku: Optional[str] = None
    boxes: float
    pieces_per_box: Optional[str] = None
    quantity_unit: Literal["Box", "Pieces"] = "Box"
    quantity: float


class TileChalan(TimestampedModel):
    number: str                 # "CH-0001" — same counter key as the old embedded system
    dispatch_id: str            # 1:1
    purchase_order_id: str
    customer_order_id: str
    floor_id: str
    supplier_name: str
    supplier_contact: Optional[str] = None
    supplier_address: Optional[str] = None
    customer_name: str
    customer_phone: str
    delivery_address: str
    delivery_city: str
    reference_number: Optional[str] = None
    items: list[TileChalanItem]      # only this dispatch's quantities
    # Immutable snapshot of the dispatch charge, printed below the items.
    labor_cost: float = Field(default=0, ge=0)
    receiver_name: Optional[str] = None
    sender_name: Optional[str] = None
    vehicle_number: Optional[str] = None
    driver_name: Optional[str] = None
    driver_mobile: Optional[str] = None
    created_by: str
    created_by_name: str
    generated_at: str
    generated_by_name: str
    system_version: str = "BuildCon ERP v2"
    is_deleted: bool = False
    deleted_at: Optional[str] = None
    deleted_by: Optional[str] = None


# ---------- Material Movement Register (Tile Orders workflow redesign, 2026-08) ----------
# Single source of truth for the "Material Movement Register" screen (see
# docs — replaces the old "Dispatch List"). One immutable row is written by
# services/tile_movement_log.py inside the SAME transaction as every
# primary write below, so the register is built from committed events, not
# reconstructed after the fact from disparate collections.
TileMovementType = Literal[
    "order_created", "release", "move_to_godown",
    "dispatch_from_released", "dispatch_from_godown", "delivered",
]


class TileMaterialMovement(TimestampedModel):
    movement_type: TileMovementType
    purchase_order_id: str
    po_item_id: Optional[str] = None
    customer_order_id: Optional[str] = None
    floor_id: str
    customer_id: Optional[str] = None
    customer_name: str
    brand_id: Optional[str] = None
    brand_name: str
    tile_name: str
    series: Optional[str] = None
    finish: Optional[str] = None
    size: Optional[str] = None
    sku: Optional[str] = None
    boxes: float
    quantity_unit: Literal["Box", "Pieces"] = "Box"
    source: Optional[str] = None        # e.g. "Released", "Godown" — where the boxes came from
    destination: Optional[str] = None   # e.g. "BuildCon Godown", or the customer delivery name/address
    dispatch_id: Optional[str] = None
    dispatch_number: Optional[str] = None
    chalan_id: Optional[str] = None
    chalan_number: Optional[str] = None
    performed_by: str
    performed_by_name: str
    is_deleted: bool = False
