from __future__ import annotations

from models import PurchaseOrder, PurchaseOrderItem


def test_purchase_order_item_tile_fields_default():
    item = PurchaseOrderItem(product_id="p-1", sku="SKU-1", name="Glossy Ivory 600x600", qty=20)
    assert item.stage == "po_final"
    assert item.loaned_qty == 0
    assert item.loan_transfer_id is None
    assert item.borrowed_from_customer_id is None
    assert item.return_due_on_replenishment is False
    assert item.series is None
    assert item.size is None
    assert item.pieces_per_box is None
    assert item.boxes_ready == 0
    assert item.boxes_dispatched == 0
    assert item.boxes_pending == 0
    assert item.current_location == "Pending"
    assert item.overall_status == "Pending"


def test_purchase_order_tile_rollup_fields_default():
    po = PurchaseOrder(
        number="FPO-2026-0001", customer_id="cust-1", customer_name="Nileshbhai Pokiya",
        created_by="u-1", created_by_name="Sales Rep", floor_id="first-floor",
    )
    assert po.customer_order_id is None
    assert po.ready_boxes == 0
    assert po.pending_boxes == 0
    assert po.dispatched_boxes == 0
    assert po.overall_status == "Pending"
    assert po.completion_percentage == 0
    assert po.last_supplier_activity_at is None


def test_activity_entity_accepts_tile_customer_order():
    from models import ActivityEvent

    event = ActivityEvent(
        event_type="customer_order.created", entity_type="tile_customer_order", entity_id="co-1",
    )
    assert event.entity_type == "tile_customer_order"
