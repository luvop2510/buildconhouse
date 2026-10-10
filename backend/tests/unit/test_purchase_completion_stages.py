from __future__ import annotations

import pytest

from models import PURCHASE_STAGES
from routes import purchases_tracker as tracker
from services.purchase_stages import active_quantity, delivery_timestamp, normalized_stage


def test_five_final_stages_include_order_in_company_and_stop_at_dispatched():
    assert PURCHASE_STAGES == ("po_final", "order_in_company", "company_billing", "in_box", "dispatched")
    assert tuple(tracker.STAGE_LABELS) == PURCHASE_STAGES


@pytest.mark.parametrize("legacy, expected", [("dispatched", "dispatched"), ("delivered", "dispatched"), ("in_transit", "dispatched"), (None, "order_in_company")])
def test_legacy_stage_reads_use_final_five_stage_vocabulary(legacy, expected):
    assert normalized_stage({"stage": legacy}) == expected


def test_supplier_receipt_is_inbox_and_does_not_complete_customer():
    item = {"stage": "delivered", "stage_history": [{"note": "Auto-synced from PO receiving"}]}
    assert normalized_stage(item) == "in_box"


def test_actual_chalan_dispatch_completes_only_full_active_quantity():
    item = {"id": "i", "qty": 10, "godown_transferred_qty": 2, "stage": "in_box"}
    po = {"chalans": [{"stage": "dispatched", "items": [{"po_item_id": "i", "qty": 7}]}]}
    assert normalized_stage(item, po) == "in_box"
    po["chalans"].append({"stage": "dispatched", "items": [{"po_item_id": "i", "qty": 1}]})
    assert normalized_stage(item, po) == "dispatched"
    assert active_quantity(item) == 8


def test_delivery_time_uses_only_chalans_covering_the_product():
    item = {"id": "i", "last_moved_at": "2026-01-01"}
    po = {"chalans": [
        {"stage": "dispatched", "dispatched_at": "2026-10-01", "items": [{"po_item_id": "i", "qty": 1}]},
        {"stage": "dispatched", "dispatched_at": "2026-10-10", "items": [{"po_item_id": "other", "qty": 1}]},
    ]}
    assert delivery_timestamp(po, item) == "2026-10-01"


def test_status_reconciliation_ignores_cancelled_and_zero_quantity_lines():
    rows = [{"stage": "dispatched", "qty": 2}, {"stage": "in_box", "qty": 0}, {"stage": "po_final", "qty": 2, "cancelled": True}]
    assert tracker._derive_po_status_from_stages(rows, "ordered") == "fully_received"
    assert tracker._derive_po_status_from_stages([{**rows[0], "qty": 0}], "ordered") is None


@pytest.mark.parametrize("invalid", [float("nan"), float("inf"), float("-inf")])
def test_move_request_rejects_non_finite_quantities(invalid):
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        tracker.MoveBody(stage="dispatched", qty=invalid)


@pytest.mark.parametrize("invalid", [float("nan"), float("inf"), float("-inf")])
@pytest.mark.parametrize("source", ["request", "stored"])
def test_non_finite_move_or_stored_quantity_cannot_update_stage(monkeypatch, invalid, source):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from fastapi import HTTPException
    from models import UserPublic
    orders = SimpleNamespace(
        find_one=AsyncMock(return_value={"id": "p", "floor_id": "first-floor", "items": [{"id": "i", "stage": "in_box", "qty": invalid if source == "stored" else 2}]}),
        update_one=AsyncMock(),
    )
    monkeypatch.setattr(tracker, "db", SimpleNamespace(purchase_orders=orders))
    with pytest.raises(HTTPException) as error:
        asyncio.run(tracker._attempt_stage_change("i", "dispatched", UserPublic(email="warehouse@test.app", full_name="Warehouse", role="warehouse"), None, qty=invalid if source == "request" else 1))
    assert error.value.status_code == 400
    orders.update_one.assert_not_awaited()
