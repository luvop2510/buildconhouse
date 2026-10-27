"""Optimistic-concurrency guard on Material Tracker stage moves
(BACKEND_AUDIT_2026-07-17.md Critical #4) — a lost race must be retried
transparently, and only surface a 409 (with enough state to refresh
intelligently) after retries are exhausted."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

import routes.purchases_tracker as tracker
from models import UserPublic


def _user() -> UserPublic:
    return UserPublic(email="warehouse@forge.app", full_name="Warehouse", role="warehouse")


class _UpdateResult:
    def __init__(self, matched_count: int):
        self.matched_count = matched_count


def _po_doc(item_id: str, *, qty: float, stage: str) -> dict:
    return {
        "id": "po-1",
        "customer_id": "cust-1",
        "items": [{
            "id": item_id, "sku": "SKU-1", "name": "Test Item", "qty": qty,
            "qty_received": 0, "stage": stage, "stage_history": [],
        }],
    }


class _FakePurchaseOrders:
    """Simulates the CAS-guarded stage update: `update_one` succeeds (matched)
    only when the query's $elemMatch condition actually matches the fake's
    current in-memory state — exactly like a real Mongo optimistic-lock."""

    def __init__(self, doc: dict, *, fail_first_n_updates: int = 0):
        self.doc = doc
        self._remaining_failures = fail_first_n_updates
        self.update_calls = 0

    async def find_one(self, *_args, **_kwargs):
        return dict(self.doc)

    async def update_one(self, query, update):
        self.update_calls += 1
        if self._remaining_failures > 0:
            self._remaining_failures -= 1
            return _UpdateResult(matched_count=0)
        elem = query.get("items", {}).get("$elemMatch", {})
        item = self.doc["items"][0]
        if elem and (elem.get("id") != item["id"] or elem.get("stage") != item["stage"]):
            return _UpdateResult(matched_count=0)
        if "$set" in update:
            for key, value in update["$set"].items():
                if key.startswith("items.$."):
                    item[key.removeprefix("items.$.")] = value
        return _UpdateResult(matched_count=1)


class _FakeDb:
    def __init__(self, purchase_orders: _FakePurchaseOrders):
        self.purchase_orders = purchase_orders


@pytest.fixture(autouse=True)
def _stub_side_effects(monkeypatch):
    async def _noop_sync(*_args, **_kwargs):
        return None

    async def _noop_log_event(*_args, **_kwargs):
        return None

    monkeypatch.setattr(tracker, "_sync_po_status_with_stages", _noop_sync)
    monkeypatch.setattr(tracker, "log_event", _noop_log_event)
    async def _no_loans(*_args, **_kwargs):
        return {"return_due_transfer_ids": []}
    monkeypatch.setattr(tracker, "mark_loans_due_for_replenishment", _no_loans)


def test_full_move_succeeds_immediately_when_uncontested(monkeypatch):
    item_id = "item-1"
    fake_pos = _FakePurchaseOrders(_po_doc(item_id, qty=5, stage="order_in_company"))
    monkeypatch.setattr(tracker, "db", _FakeDb(fake_pos))

    result = asyncio.run(tracker._apply_stage_change(item_id, "in_box", _user(), None))

    assert result["to_stage"] == "in_box"
    assert fake_pos.update_calls == 1


def test_full_move_retries_transparently_after_one_lost_race(monkeypatch):
    item_id = "item-1"
    fake_pos = _FakePurchaseOrders(
        _po_doc(item_id, qty=5, stage="order_in_company"), fail_first_n_updates=1,
    )
    monkeypatch.setattr(tracker, "db", _FakeDb(fake_pos))

    result = asyncio.run(tracker._apply_stage_change(item_id, "in_box", _user(), None))

    assert result["to_stage"] == "in_box"
    assert fake_pos.update_calls == 2  # first attempt lost the race, second succeeded


def test_full_move_raises_structured_409_after_exhausting_retries(monkeypatch):
    item_id = "item-1"
    fake_pos = _FakePurchaseOrders(
        _po_doc(item_id, qty=5, stage="order_in_company"), fail_first_n_updates=99,
    )
    monkeypatch.setattr(tracker, "db", _FakeDb(fake_pos))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(tracker._apply_stage_change(item_id, "in_box", _user(), None, max_attempts=3))

    assert exc.value.status_code == 409
    detail = exc.value.detail
    assert detail["error"] == "concurrent_modification"
    assert detail["item_id"] == item_id
    assert detail["current_qty"] == 5
    assert detail["current_stage"] == "order_in_company"
    assert fake_pos.update_calls == 3


@pytest.mark.parametrize('reservation', ['loaned_qty', 'loan_replenishment_promised_qty'])
def test_default_dispatch_splits_eighty_free_units_from_four_reserved(monkeypatch, reservation):
    doc = _po_doc('item-1', qty=84, stage='in_box')
    doc['items'][0][reservation] = 4
    if reservation == 'loan_replenishment_promised_qty':
        doc['items'][0]['loan_replenishment_for_customer_name'] = 'Lender'
    class Capture(_FakePurchaseOrders):
        async def update_one(self, query, update):
            self.guard, self.update = query, update
            return _UpdateResult(matched_count=1)
    pos = Capture(doc)
    monkeypatch.setattr(tracker, 'db', _FakeDb(pos))
    async def no_reconcile():
        pass
    monkeypatch.setattr(tracker, 'reconcile_followups_admitted', no_reconcile)
    result = asyncio.run(tracker._apply_stage_change('item-1', 'dispatched', _user(), None))
    assert result['qty_moved'] == 80
    assert result['qty_remaining'] == 4
    child = pos.update[0]['$set']['items']['$concatArrays'][1]['$literal'][0]
    assert child['qty'] == 80
    assert child['loaned_qty'] == 0
    assert child['loan_replenishment_promised_qty'] == 0
    assert child['loan_replenishment_for_customer_name'] is None
    assert child['customer_loan_history'] == []
    assert pos.guard['items']['$elemMatch'][reservation] == 4


def test_reserved_four_units_cannot_be_dispatched(monkeypatch):
    doc = _po_doc('item-1', qty=4, stage='in_box')
    doc['items'][0]['loan_replenishment_promised_qty'] = 4
    monkeypatch.setattr(tracker, 'db', _FakeDb(_FakePurchaseOrders(doc)))
    with pytest.raises(HTTPException) as error:
        asyncio.run(tracker._apply_stage_change('item-1', 'dispatched', _user(), None, qty=4))
    assert error.value.status_code == 409
