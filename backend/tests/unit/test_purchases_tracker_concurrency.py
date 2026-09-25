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
