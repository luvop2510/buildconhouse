"""Defaults/shape for the new Tile Orders collections. Real DB writes are
covered by the route tests in later tasks — this just locks the schema."""
from __future__ import annotations

from models_tile_orders import (
    TileChalan, TileChalanItem, TileCustomerOrder, TileCustomerOrderBrand,
    TileCustomerOrderDashboardSummary, TileDispatch, TileReadyBatch,
)


def _customer_order(**overrides) -> TileCustomerOrder:
    base = dict(
        number="TORD-2026-0001", quotation_id="q-1", quotation_number="FQ-2026-0001",
        customer_id="cust-1", customer_name="Nileshbhai Pokiya", customer_phone="9909900000",
        delivery_name="Nileshbhai Pokiya", delivery_phone="9909900000",
        delivery_address="123 Ring Road", delivery_city="Rajkot", delivery_pincode="360005",
        delivery_state="Gujarat", floor_id="ground-floor",
        created_by="u-1", created_by_name="Sales Rep",
        dashboard_summary=TileCustomerOrderDashboardSummary(
            completion_percentage=0, overall_status="Pending", supplier_statuses=[],
        ),
    )
    base.update(overrides)
    return TileCustomerOrder(**base)


def test_customer_order_defaults():
    order = _customer_order()
    assert order.version == 0
    assert order.is_deleted is False
    assert order.overall_status == "Pending"
    assert order.brands == []
    assert order.total_boxes == 0


def test_customer_order_brand_carries_status():
    brand = TileCustomerOrderBrand(
        brand_id="b-1", brand_name="Qutone", supplier_id="s-1", supplier_name="Qutone Rajkot",
        purchase_order_id="po-1", status="Ready",
    )
    order = _customer_order(brands=[brand])
    assert order.brands[0].status == "Ready"


def test_ready_batch_defaults():
    batch = TileReadyBatch(
        batch_number="RB-2026-0001", purchase_order_id="po-1", po_item_id="item-1",
        customer_order_id="co-1", supplier_id="s-1", supplier_name="Qutone Rajkot",
        customer_id="cust-1", customer_name="Nileshbhai Pokiya", tile_name="Glossy Ivory 600x600",
        qty=8, remaining_qty=8, created_by="u-1", created_by_name="Warehouse Rep",
        floor_id="ground-floor",
    )
    assert batch.auto_created is False
    assert batch.is_deleted is False


def test_dispatch_defaults_and_chalan_link():
    dispatch = TileDispatch(
        dispatch_number="DSP-2026-0001", purchase_order_id="po-1", customer_order_id="co-1",
        supplier_id="s-1", supplier_name="Qutone Rajkot", customer_id="cust-1",
        customer_name="Nileshbhai Pokiya", ready_batches_consumed=[],
        destination_type="Customer", destination_name="Nileshbhai Pokiya",
        destination_address="123 Ring Road", destination_city="Rajkot",
        dispatch_date="2026-07-29", dispatch_time="14:23",
        created_by="u-1", created_by_name="Warehouse Rep", chalan_id="ch-1",
        floor_id="ground-floor",
    )
    assert dispatch.attachments == []
    assert dispatch.inventory_transaction_id is None
    assert dispatch.godown_received_at is None


def test_chalan_is_a_plain_dict_after_serialization_and_has_no_update_hook():
    chalan = TileChalan(
        number="CH-0001", dispatch_id="d-1", purchase_order_id="po-1", customer_order_id="co-1",
        supplier_name="Qutone Rajkot", customer_name="Nileshbhai Pokiya", customer_phone="9909900000",
        delivery_address="123 Ring Road", delivery_city="Rajkot",
        items=[TileChalanItem(po_item_id="item-1", tile_name="Glossy Ivory 600x600", boxes=8, quantity=8)],
        created_by="u-1", created_by_name="Warehouse Rep",
        generated_at="2026-07-29T14:23:00+00:00", generated_by_name="Warehouse Rep",
        floor_id="ground-floor",
    )
    data = chalan.model_dump()
    assert "update" not in data  # no mutable-state field snuck in
    assert data["system_version"] == "BuildCon ERP v2"
