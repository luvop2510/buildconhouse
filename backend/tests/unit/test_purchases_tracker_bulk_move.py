from __future__ import annotations

import asyncio
import inspect
import json

import pytest
from fastapi import HTTPException

from models import UserPublic
from routes import purchases_tracker as tracker


def _user() -> UserPublic:
    return UserPublic(
        email="warehouse@forge.app",
        full_name="Warehouse",
        role="warehouse",
        floor_ids=["first-floor"],
        active_floor_id="first-floor",
    )


class _UpdateResult:
    def __init__(self, matched_count: int):
        self.matched_count = matched_count


def _make_item(
    item_id: str,
    *,
    brand_id: str,
    brand_name: str,
    supplier_id: str,
    supplier_name: str,
) -> dict:
    return {
        "id": item_id,
        "sku": f"SKU-{item_id}",
        "name": f"Item {item_id}",
        "qty": 5,
        "qty_received": 0,
        "stage": "order_in_company",
        "stage_history": [],
        "brand_id": brand_id,
        "brand_name": brand_name,
        "supplier_id": supplier_id,
        "supplier_name": supplier_name,
    }


class _FakePurchaseOrders:
    def __init__(self, docs: list[dict]):
        self.docs = docs

    @staticmethod
    def _flatten_query(query: dict) -> dict:
        if "$and" not in query:
            return dict(query)
        merged: dict = {}
        for part in query["$and"]:
            merged.update(part)
        return merged

    async def find_one(self, query, *_args, **_kwargs):
        query = self._flatten_query(query)
        item_id = query.get("items.id")
        po_id = query.get("id")
        floor_filter = query.get("floor_id")
        for doc in self.docs:
            if isinstance(floor_filter, dict) and "$in" in floor_filter:
                if doc.get("floor_id") not in floor_filter["$in"]:
                    continue
            if po_id is not None and doc.get("id") != po_id:
                continue
            if item_id is None or any(item.get("id") == item_id for item in doc.get("items", [])):
                return doc
        return None

    async def update_one(self, query, update):
        po_id = query.get("id")
        elem = query.get("items", {}).get("$elemMatch", {})
        for doc in self.docs:
            if doc.get("id") != po_id:
                continue
            for item in doc.get("items", []):
                if item.get("id") != elem.get("id") or item.get("stage") != elem.get("stage"):
                    continue
                for key, value in update.get("$set", {}).items():
                    if key.startswith("items.$."):
                        item[key.removeprefix("items.$.")] = value
                    elif key == "updated_at":
                        doc["updated_at"] = value
                for key, value in update.get("$push", {}).items():
                    if key == "items.$.stage_history":
                        item.setdefault("stage_history", []).append(value)
                return _UpdateResult(matched_count=1)
        return _UpdateResult(matched_count=0)


class _FakeDb:
    def __init__(self, docs: list[dict]):
        self.purchase_orders = _FakePurchaseOrders(docs)


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


@pytest.mark.parametrize("selected_count", [1, 5, 20])
def test_bulk_move_moves_every_selected_item_across_mixed_brand_and_supplier_items(monkeypatch, selected_count):
    all_items = [
        _make_item("item-01", brand_id="brand-1", brand_name="Grohe", supplier_id="sup-1", supplier_name="AquaFlow"),
        _make_item("item-02", brand_id="brand-2", brand_name="Kohler", supplier_id="sup-2", supplier_name="BathLine"),
        _make_item("item-03", brand_id="brand-1", brand_name="Grohe", supplier_id="sup-3", supplier_name="Ceramic Hub"),
        _make_item("item-04", brand_id="brand-3", brand_name="Jaquar", supplier_id="sup-1", supplier_name="AquaFlow"),
        _make_item("item-05", brand_id="brand-4", brand_name="TOTO", supplier_id="sup-2", supplier_name="BathLine"),
        _make_item("item-06", brand_id="brand-5", brand_name="Geberit", supplier_id="sup-4", supplier_name="Delta Sanitary"),
        _make_item("item-07", brand_id="brand-2", brand_name="Kohler", supplier_id="sup-5", supplier_name="Elite Ceramics"),
        _make_item("item-08", brand_id="brand-6", brand_name="Hansgrohe", supplier_id="sup-1", supplier_name="AquaFlow"),
        _make_item("item-09", brand_id="brand-3", brand_name="Jaquar", supplier_id="sup-4", supplier_name="Delta Sanitary"),
        _make_item("item-10", brand_id="brand-7", brand_name="Roca", supplier_id="sup-2", supplier_name="BathLine"),
        _make_item("item-11", brand_id="brand-8", brand_name="Parryware", supplier_id="sup-6", supplier_name="Flow Depot"),
        _make_item("item-12", brand_id="brand-5", brand_name="Geberit", supplier_id="sup-3", supplier_name="Ceramic Hub"),
        _make_item("item-13", brand_id="brand-9", brand_name="Vitra", supplier_id="sup-5", supplier_name="Elite Ceramics"),
        _make_item("item-14", brand_id="brand-6", brand_name="Hansgrohe", supplier_id="sup-6", supplier_name="Flow Depot"),
        _make_item("item-15", brand_id="brand-10", brand_name="Duravit", supplier_id="sup-2", supplier_name="BathLine"),
        _make_item("item-16", brand_id="brand-4", brand_name="TOTO", supplier_id="sup-4", supplier_name="Delta Sanitary"),
        _make_item("item-17", brand_id="brand-8", brand_name="Parryware", supplier_id="sup-1", supplier_name="AquaFlow"),
        _make_item("item-18", brand_id="brand-7", brand_name="Roca", supplier_id="sup-3", supplier_name="Ceramic Hub"),
        _make_item("item-19", brand_id="brand-9", brand_name="Vitra", supplier_id="sup-6", supplier_name="Flow Depot"),
        _make_item("item-20", brand_id="brand-10", brand_name="Duravit", supplier_id="sup-5", supplier_name="Elite Ceramics"),
        _make_item("item-21", brand_id="brand-11", brand_name="American Standard", supplier_id="sup-7", supplier_name="Pipe Centre"),
    ]
    docs = [
        {
            "id": "po-1",
            "customer_id": "cust-1",
            "floor_id": "first-floor",
            "items": all_items[:11],
        },
        {
            "id": "po-2",
            "customer_id": "cust-2",
            "floor_id": "first-floor",
            "items": all_items[11:],
        },
    ]
    monkeypatch.setattr(tracker, "db", _FakeDb(docs))

    selected_items = all_items[:selected_count]
    selected_ids = [item["id"] for item in selected_items]
    body = tracker.BulkMoveBody(item_ids=selected_ids, stage="in_box", note="move all")

    result = asyncio.run(tracker.bulk_move(body, user=_user()))

    assert result["count"] == len(selected_ids)
    assert result["succeeded"] == len(selected_ids)
    assert result["failed"] == 0
    assert [entry["item_id"] for entry in result["results"]] == selected_ids
    assert all(entry["ok"] is True for entry in result["results"])
    assert all(entry["to_stage"] == "in_box" for entry in result["results"])
    assert all("po_id" in entry for entry in result["results"])
    assert json.loads(json.dumps(result)) == result

    moved_items = {
        item["id"]: item
        for doc in docs
        for item in doc["items"]
        if item["id"] in selected_ids
    }
    assert list(moved_items) == selected_ids
    assert {moved_items[item_id]["brand_id"] for item_id in selected_ids} == {
        item["brand_id"] for item in selected_items
    }
    assert {moved_items[item_id]["supplier_id"] for item_id in selected_ids} == {
        item["supplier_id"] for item in selected_items
    }
    assert all(moved_items[item_id]["stage"] == "in_box" for item_id in selected_ids)


def test_bulk_move_returns_partial_success_contract(monkeypatch):
    attempted: list[str] = []

    async def _fake_apply(item_id: str, stage: str, user: UserPublic, note: str | None, qty=None):
        attempted.append(item_id)
        if item_id == "missing-item":
            raise HTTPException(status_code=404, detail="Item not found")
        if item_id == "stale-item":
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "concurrent_modification",
                    "message": "This item was modified concurrently — refresh and try again",
                    "item_id": item_id,
                    "current_stage": "company_billing",
                },
            )
        return {"po_id": f"po-{item_id}", "item_id": item_id, "to_stage": stage}

    monkeypatch.setattr(tracker, "_apply_stage_change", _fake_apply)

    item_ids = ["ok-1", "missing-item", "stale-item", "ok-2"]
    body = tracker.BulkMoveBody(item_ids=item_ids, stage="in_box", note="move mixed")

    result = asyncio.run(tracker.bulk_move(body, user=_user()))

    assert attempted == item_ids
    assert result["count"] == len(item_ids)
    assert result["succeeded"] == 2
    assert result["failed"] == 2
    assert result["succeeded"] + result["failed"] == len(result["results"])
    assert result["results"] == [
        {"item_id": "ok-1", "ok": True, "po_id": "po-ok-1", "to_stage": "in_box"},
        {"item_id": "missing-item", "ok": False, "error": "Item not found", "error_code": "not_found"},
        {
            "item_id": "stale-item",
            "ok": False,
            "error": "This item was modified concurrently — refresh and try again",
            "error_code": "conflict",
            "current_stage": "company_billing",
        },
        {"item_id": "ok-2", "ok": True, "po_id": "po-ok-2", "to_stage": "in_box"},
    ]


def test_bulk_move_requires_warehouse_permissions():
    depends = inspect.signature(tracker.bulk_move).parameters["user"].default.dependency

    with pytest.raises(Exception) as exc:
        asyncio.run(depends(user=UserPublic(email="worker@forge.app", full_name="Worker", role="worker")))

    assert getattr(exc.value, "status_code", None) == 403


def test_bulk_move_rejects_empty_selection_before_apply(monkeypatch):
    calls: list[str] = []

    async def _fake_apply(item_id: str, stage: str, user: UserPublic, note: str | None, qty=None):
        calls.append(item_id)
        return {"item_id": item_id}

    monkeypatch.setattr(tracker, "_apply_stage_change", _fake_apply)

    body = tracker.BulkMoveBody(item_ids=[], stage="in_box", note=None)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(tracker.bulk_move(body, user=_user()))

    assert exc.value.status_code == 400
    assert exc.value.detail == "No items selected"
    assert calls == []
