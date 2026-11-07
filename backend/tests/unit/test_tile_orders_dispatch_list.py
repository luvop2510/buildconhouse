from __future__ import annotations

import asyncio
import re
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth import get_current_user

from models import UserPublic
from routes import tile_orders as router_module


def _user() -> UserPublic:
    return UserPublic(email="sales@forge.app", full_name="Sales Rep", role="sales", floor_ids=["ground-floor"], active_floor_id="ground-floor")


class _FakeFind:
    def __init__(self, items): self._items = items
    async def to_list(self, n=None): return list(self._items)


class _FakeCollection:
    def __init__(self, docs): self.docs = docs
    def find(self, query=None, projection=None, session=None): return _FakeFind(self.docs)
    async def find_one(self, query=None, projection=None, session=None):
        for doc in self.docs:
            if all(doc.get(k) == v for k, v in (query or {}).items() if not k.startswith("$")):
                return dict(doc)
        return None


class _FakeDb:
    def __init__(self, dispatches=None, chalans=None, ready_batches=None, purchase_orders=None):
        self.dispatches = _FakeCollection(dispatches or [])
        self.chalans = _FakeCollection(chalans or [])
        self.ready_batches = _FakeCollection(ready_batches or [])
        self.purchase_orders = _FakeCollection(purchase_orders or [])


def _dispatch(**overrides):
    base = {
        "id": "d-1", "dispatch_number": "DSP-2026-0001", "chalan_id": "ch-1", "purchase_order_id": "po-1",
        "customer_name": "Nileshbhai Pokiya",
        "supplier_name": "Qutone Rajkot", "supplier_id": "s-1", "customer_id": "cust-1", "dispatch_date": "2026-07-29",
        "destination_type": "Customer", "destination_name": "Nileshbhai Pokiya", "godown_received_at": None,
        "delivered_at": None, "is_deleted": False,
    }
    base.update(overrides)
    return base


def _chalan(**overrides):
    base = {
        "id": "ch-1", "number": "CH-0001", "dispatch_id": "d-1",
        "items": [{"po_item_id": "item-1", "tile_name": "Glossy Ivory 600x600", "size": "600X600", "boxes": 5, "quantity": 5}],
    }
    base.update(overrides)
    return base


def test_dispatch_list_flattens_chalan_lines(monkeypatch):
    fake_db = _FakeDb(dispatches=[_dispatch()], chalans=[_chalan()])
    monkeypatch.setattr(router_module, "db", fake_db)

    result = asyncio.run(router_module.list_dispatches(user=_user()))

    assert result["total"] == 1
    row = result["rows"][0]
    assert row["dispatch_number"] == "DSP-2026-0001"
    assert row["chalan_number"] == "CH-0001"
    assert row["tile_name"] == "Glossy Ivory 600x600"
    assert row["boxes"] == 5
    assert row["status"] == "Dispatched"


def test_dispatch_list_filters_by_brand(monkeypatch):
    fake_db = _FakeDb(
        dispatches=[
            _dispatch(id="d-1", purchase_order_id="po-1"),
            _dispatch(id="d-2", purchase_order_id="po-2", chalan_id="ch-2"),
        ],
        chalans=[_chalan(id="ch-1", dispatch_id="d-1"), _chalan(id="ch-2", dispatch_id="d-2")],
        purchase_orders=[
            {"id": "po-1", "brand_id": "brand-a", "brand_name": "Brand A"},
            {"id": "po-2", "brand_id": "brand-b", "brand_name": "Brand B"},
        ],
    )
    monkeypatch.setattr(router_module, "db", fake_db)

    result = asyncio.run(router_module.list_dispatches(brand_id="brand-a", user=_user()))

    assert result["total"] == 1
    assert result["rows"][0]["brand_name"] == "Brand A"


def test_dispatch_list_returns_no_rows_for_unknown_brand(monkeypatch):
    # TileDispatch has no brand_id field — brand lives on the PurchaseOrder
    # (PurchaseOrder.brand_id), reached via dispatch["purchase_order_id"].
    # Two dispatches on two different purchase orders with different
    # brand_id values; filtering by one brand must return only its dispatch.
    fake_db = _FakeDb(
        dispatches=[
            _dispatch(id="d-1", purchase_order_id="po-1", chalan_id="ch-1"),
            _dispatch(id="d-2", dispatch_number="DSP-2026-0002", purchase_order_id="po-2", chalan_id="ch-2"),
        ],
        chalans=[_chalan(id="ch-1", dispatch_id="d-1"), _chalan(id="ch-2", dispatch_id="d-2")],
        purchase_orders=[
            {"id": "po-1", "brand_id": "brand-a"},
            {"id": "po-2", "brand_id": "brand-b"},
        ],
    )
    monkeypatch.setattr(router_module, "db", fake_db)

    result = asyncio.run(router_module.list_dispatches(brand_id="unknown-brand", user=_user()))

    assert result["total"] == 0
    assert result["rows"] == []


def test_item_history_merges_ready_and_dispatch_events(monkeypatch):
    fake_db = _FakeDb(
        ready_batches=[{"id": "rb-1", "po_item_id": "item-1", "batch_number": "RB-2026-0001", "qty": 8, "created_at": "2026-07-27T10:00:00+00:00"}],
        dispatches=[_dispatch(ready_batches_consumed=[{"po_item_id": "item-1", "ready_batch_id": "rb-1", "qty": 5}], created_at="2026-07-28T10:00:00+00:00")],
    )
    monkeypatch.setattr(router_module, "db", fake_db)

    result = asyncio.run(router_module.item_history("item-1", user=_user()))

    kinds = [e["kind"] for e in result["events"]]
    assert kinds == ["dispatch", "ready_batch"]  # newest first

def test_dispatch_number_is_bounded_literal_search(monkeypatch):
    fake_db = _FakeDb()
    aggregate = Mock(return_value=_FakeFind([]))
    fake_db.dispatches.aggregate = aggregate
    monkeypatch.setattr(router_module, "db", fake_db)
    term = "[.*](a+)+$" * 10
    asyncio.run(router_module.list_dispatches(dispatch_number=term, user=_user()))
    pipeline = aggregate.call_args.args[0]
    assert pipeline[0]["$match"]["$and"][1]["dispatch_number"] == {
        "$regex": re.escape(term[:80]), "$options": "i",
    }


@pytest.mark.parametrize("query", ["page=0", "page_size=0", "page_size=201", "page=100000000000000000000"])
def test_invalid_paging_never_reaches_dispatch_query(query, monkeypatch):
    app = FastAPI()
    app.include_router(router_module.router)
    app.dependency_overrides[get_current_user] = _user
    monkeypatch.setattr(router_module, "db", object())
    assert TestClient(app).get(f"/tile-orders/dispatches?{query}").status_code == 422
