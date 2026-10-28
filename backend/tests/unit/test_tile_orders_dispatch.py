# backend/tests/unit/test_tile_orders_dispatch.py
from __future__ import annotations

import asyncio

import pytest

from models import UserPublic
from routes import tile_orders as router_module


def _user() -> UserPublic:
    return UserPublic(email="wh@forge.app", full_name="Warehouse Rep", role="warehouse", floor_ids=["ground-floor"], active_floor_id="ground-floor")


def _po(**overrides) -> dict:
    base = {
        "id": "po-1", "number": "FPO-2026-0001", "customer_id": "cust-1", "customer_name": "Nileshbhai Pokiya",
        "customer_order_id": "co-1", "supplier_id": "s-1", "supplier_name": "Qutone Rajkot",
        "items": [{
            "id": "item-1", "name": "Glossy Ivory 600x600", "series": "Metropole", "finish": None,
            "size": "600X600", "sku": "SKU-1", "pieces_per_box": "4", "qty": 20,
            "boxes_ready": 12, "boxes_dispatched": 0, "boxes_pending": 8,
            "overall_status": "Ready", "current_location": "Ready",
        }],
    }
    base.update(overrides)
    return base


def _ready_batch(**overrides) -> dict:
    base = {
        "id": "rb-1", "batch_number": "RB-2026-0001", "purchase_order_id": "po-1", "po_item_id": "item-1",
        "qty": 12, "remaining_qty": 12, "auto_created": False, "floor_id": "ground-floor", "is_deleted": False,
    }
    base.update(overrides)
    return base


class _FakeSession:
    async def __aenter__(self): return self
    async def __aexit__(self, *exc): return False
    def start_transaction(self): return self


class _FakeClient:
    async def start_session(self): return _FakeSession()


class _FakePOs:
    def __init__(self, po):
        self.po = po

    async def find_one(self, query, *_a, session=None, **_kw):
        return dict(self.po) if self.po else None

    async def update_one(self, query, update, session=None, **_kw):
        self.po.update(update["$set"])
        class _R: matched_count = 1
        return _R()


class _FakeReadyBatches:
    def __init__(self, batches):
        self.docs = {b["id"]: dict(b) for b in batches}
        self.inserted: list[dict] = []
        self.reads = []
        self.bulk_calls = []

    def find(self, query, projection, *, session=None):
        self.reads.append((query, projection, session))
        rows = [dict(doc) for doc in reversed(list(self.docs.values()))
                if doc['id'] in query['id']['$in'] and doc.get('floor_id') == query['floor_id']
                and doc.get('is_deleted') == query['is_deleted']]
        class Cursor:
            async def to_list(self, limit): return rows[:limit]
        return Cursor()

    async def bulk_write(self, operations, *, ordered, session):
        from pymongo import InsertOne
        self.bulk_calls.append((operations, ordered, session))
        matched = 0
        for operation in operations:
            if isinstance(operation, InsertOne):
                await self.insert_one(operation._doc, session=session)
            else:
                query = operation._filter
                doc = self.docs.get(query['id'])
                if (doc and doc.get('floor_id') == query['floor_id'] and not doc.get('is_deleted')
                        and doc['remaining_qty'] >= query['remaining_qty']['$gte']):
                    await self.update_one(query, operation._doc, session=session)
                    matched += 1
        from types import SimpleNamespace
        return SimpleNamespace(matched_count=matched)

    async def find_one(self, query, *_a, session=None, **_kw):
        for doc in self.docs.values():
            if doc.get("id") == query.get("id"):
                return dict(doc)
        return None

    async def insert_one(self, doc, session=None):
        self.docs[doc["id"]] = doc
        self.inserted.append(doc)

    async def update_one(self, query, update, session=None, **_kw):
        doc = self.docs[query["id"]]
        if "$set" in update:
            doc.update(update["$set"])
        if "$inc" in update:
            for field, delta in update["$inc"].items():
                doc[field] = float(doc.get(field) or 0) + delta
        class _R: matched_count = 1
        return _R()


class _FakeDispatches:
    def __init__(self):
        self.inserted: list[dict] = []

    async def insert_one(self, doc, session=None):
        self.inserted.append(doc)


class _FakeChalans:
    def __init__(self):
        self.inserted: list[dict] = []

    async def insert_one(self, doc, session=None):
        self.inserted.append(doc)


class _FakeCustomerOrders:
    def __init__(self, co):
        self.co = co

    async def find_one(self, query, *_a, session=None, **_kw):
        return dict(self.co) if self.co else None

    async def update_one(self, query, update, session=None, **_kw):
        self.co.update(update["$set"])
        class _R: matched_count = 1
        return _R()


class _FakeDb:
    def __init__(self, po, ready_batches, co):
        self.purchase_orders = _FakePOs(po)
        self.ready_batches = _FakeReadyBatches(ready_batches)
        self.dispatches = _FakeDispatches()
        self.chalans = _FakeChalans()
        self.customer_orders = _FakeCustomerOrders(co)


def _customer_order():
    return {"id": "co-1", "version": 0, "total_boxes": 20, "brands": [{
        "brand_id": "b-1", "brand_name": "Qutone", "supplier_id": "s-1", "supplier_name": "Qutone Rajkot",
        "purchase_order_id": "po-1", "status": "Ready",
    }]}


_DESTINATION = dict(destination_type="Customer", destination_name="Nileshbhai Pokiya", destination_address="123 Ring Road", destination_city="Rajkot")


async def _fake_next_number(kind, *_a, **_kw):
    return "DSP-2026-0001" if kind == "dispatch" else ("RB-2026-0002" if kind == "ready_batch" else "CH-0001")


async def _noop_log_event(**_kwargs):
    return None


def test_preview_never_mutates_state(monkeypatch):
    fake_db = _FakeDb(_po(), [_ready_batch()], _customer_order())
    monkeypatch.setattr(router_module, "db", fake_db)

    body = router_module.DispatchBody(
        items=[router_module.DispatchLineInput(po_item_id="item-1", ready_batch_id="rb-1", qty=5)], **_DESTINATION,
    )
    result = asyncio.run(router_module.preview_dispatch("po-1", body, user=_user()))

    assert result["items"][0]["qty"] == 5
    assert fake_db.dispatches.inserted == []
    assert fake_db.chalans.inserted == []
    assert fake_db.ready_batches.docs["rb-1"]["remaining_qty"] == 12  # untouched


def test_dispatch_from_existing_ready_batch(monkeypatch):
    fake_db = _FakeDb(_po(), [_ready_batch()], _customer_order())
    monkeypatch.setattr(router_module, "db", fake_db)
    monkeypatch.setattr(router_module, "client", _FakeClient())
    monkeypatch.setattr(router_module, "next_number", _fake_next_number)
    monkeypatch.setattr(router_module, "log_event", _noop_log_event)

    body = router_module.DispatchBody(
        items=[router_module.DispatchLineInput(po_item_id="item-1", ready_batch_id="rb-1", qty=5)], **_DESTINATION,
    )
    result = asyncio.run(router_module.commit_dispatch("po-1", body, user=_user()))

    assert result["dispatch"]["dispatch_number"] == "DSP-2026-0001"
    assert result["chalan"]["number"] == "CH-0001"
    assert result["chalan"]["items"][0]["quantity"] == 5   # only the dispatched qty, not the whole order
    assert result["chalan"]["dispatch_id"] == result["dispatch"]["id"]
    assert result["dispatch"]["chalan_id"] == result["chalan"]["id"]
    assert fake_db.ready_batches.docs["rb-1"]["remaining_qty"] == 7
    item = fake_db.purchase_orders.po["items"][0]
    assert item["boxes_ready"] == 7
    assert item["boxes_dispatched"] == 5
    assert item["boxes_pending"] == 8
    assert item["overall_status"] == "Partially Dispatched"
    # Important-finding regression: CustomerOrder.completion_percentage must
    # be recomputed on every dispatch (5 dispatched / 20 total_boxes = 25%),
    # not permanently stuck at its creation-time 0 — the same class of bug
    # Task 9 already fixed once for supplier_analytics.
    assert fake_db.customer_orders.co["completion_percentage"] == 25.0
    assert fake_db.customer_orders.co["dashboard_summary"]["completion_percentage"] == 25.0


def test_dispatch_persists_labor_cost_on_dispatch_and_chalan(monkeypatch):
    fake_db = _FakeDb(_po(), [_ready_batch()], _customer_order())
    monkeypatch.setattr(router_module, "db", fake_db)
    monkeypatch.setattr(router_module, "client", _FakeClient())
    monkeypatch.setattr(router_module, "next_number", _fake_next_number)
    monkeypatch.setattr(router_module, "log_event", _noop_log_event)

    body = router_module.DispatchBody(
        items=[router_module.DispatchLineInput(po_item_id="item-1", ready_batch_id="rb-1", qty=5)],
        labor_cost=450, **_DESTINATION,
    )
    result = asyncio.run(router_module.commit_dispatch("po-1", body, user=_user()))

    assert result["dispatch"]["labor_cost"] == 450
    assert result["chalan"]["labor_cost"] == 450


def test_direct_dispatch_from_pending_auto_creates_ready_batch(monkeypatch):
    fake_db = _FakeDb(_po(), [], _customer_order())
    monkeypatch.setattr(router_module, "db", fake_db)
    monkeypatch.setattr(router_module, "client", _FakeClient())
    monkeypatch.setattr(router_module, "next_number", _fake_next_number)
    monkeypatch.setattr(router_module, "log_event", _noop_log_event)

    body = router_module.DispatchBody(
        items=[router_module.DispatchLineInput(po_item_id="item-1", ready_batch_id=None, qty=3)], **_DESTINATION,
    )
    result = asyncio.run(router_module.commit_dispatch("po-1", body, user=_user()))

    auto_batch = [b for b in fake_db.ready_batches.inserted if b["auto_created"]][0]
    assert auto_batch["qty"] == 3
    assert auto_batch["remaining_qty"] == 0
    item = fake_db.purchase_orders.po["items"][0]
    assert item["boxes_pending"] == 5      # 8 - 3
    assert item["boxes_dispatched"] == 3
    assert item["boxes_ready"] == 12       # untouched — this dispatch came from pending, not from the existing batch
    assert result["dispatch"]["ready_batches_consumed"][0]["ready_batch_id"] == auto_batch["id"]
    assert result["chalan"]["dispatch_id"] == result["dispatch"]["id"]
    assert result["dispatch"]["chalan_id"] == result["chalan"]["id"]


def test_dispatch_rejects_over_consuming_a_batch(monkeypatch):
    fake_db = _FakeDb(_po(), [_ready_batch(remaining_qty=2)], _customer_order())
    monkeypatch.setattr(router_module, "db", fake_db)
    monkeypatch.setattr(router_module, "client", _FakeClient())

    body = router_module.DispatchBody(
        items=[router_module.DispatchLineInput(po_item_id="item-1", ready_batch_id="rb-1", qty=5)], **_DESTINATION,
    )
    with pytest.raises(Exception) as exc:
        asyncio.run(router_module.commit_dispatch("po-1", body, user=_user()))
    assert getattr(exc.value, "status_code", None) == 400


def test_dispatch_rejects_over_consuming_pending_directly(monkeypatch):
    """Mirrors test_dispatch_rejects_over_consuming_a_batch, but for a single
    line drawn straight from Pending (no ready_batch_id) that requests more
    than boxes_pending."""
    fake_db = _FakeDb(_po(), [], _customer_order())   # boxes_pending == 8
    monkeypatch.setattr(router_module, "db", fake_db)
    monkeypatch.setattr(router_module, "client", _FakeClient())

    body = router_module.DispatchBody(
        items=[router_module.DispatchLineInput(po_item_id="item-1", ready_batch_id=None, qty=10)], **_DESTINATION,
    )
    with pytest.raises(Exception) as exc:
        asyncio.run(router_module.commit_dispatch("po-1", body, user=_user()))
    assert getattr(exc.value, "status_code", None) == 400


def test_dispatch_rejects_duplicate_lines_against_same_batch(monkeypatch):
    """Finding 1(b) regression: two lines in ONE request both draw from the
    SAME ready_batch_id. Each line's qty individually fits under the batch's
    remaining_qty, but validated independently against the same stale
    pre-mutation snapshot they'd both pass — and if committed, the second
    line's update would silently overwrite the first's decrement (double-
    spend). Must be rejected at resolution time instead."""
    fake_db = _FakeDb(_po(), [_ready_batch(remaining_qty=12)], _customer_order())
    monkeypatch.setattr(router_module, "db", fake_db)
    monkeypatch.setattr(router_module, "client", _FakeClient())

    body = router_module.DispatchBody(
        items=[
            router_module.DispatchLineInput(po_item_id="item-1", ready_batch_id="rb-1", qty=8),
            router_module.DispatchLineInput(po_item_id="item-1", ready_batch_id="rb-1", qty=8),
        ],
        **_DESTINATION,
    )
    with pytest.raises(Exception) as exc:
        asyncio.run(router_module.commit_dispatch("po-1", body, user=_user()))
    assert getattr(exc.value, "status_code", None) == 400
    # Nothing must have been mutated by the failed attempt.
    assert fake_db.ready_batches.docs["rb-1"]["remaining_qty"] == 12


def test_dispatch_mixed_sources_in_one_request(monkeypatch):
    """One item, two lines in ONE request: 5 boxes from an existing Ready
    Batch (remaining_qty=12) and 3 boxes straight from Pending (8 pending).
    After commit: boxes_ready == 7 (12 - 5), boxes_dispatched == 8 (5 + 3),
    boxes_pending == 5 (8 - 3) — sums back to the item's qty of 20."""
    fake_db = _FakeDb(_po(), [_ready_batch(remaining_qty=12)], _customer_order())
    monkeypatch.setattr(router_module, "db", fake_db)
    monkeypatch.setattr(router_module, "client", _FakeClient())
    monkeypatch.setattr(router_module, "next_number", _fake_next_number)
    monkeypatch.setattr(router_module, "log_event", _noop_log_event)

    body = router_module.DispatchBody(
        items=[
            router_module.DispatchLineInput(po_item_id="item-1", ready_batch_id="rb-1", qty=5),
            router_module.DispatchLineInput(po_item_id="item-1", ready_batch_id=None, qty=3),
        ],
        **_DESTINATION,
    )
    result = asyncio.run(router_module.commit_dispatch("po-1", body, user=_user()))

    item = fake_db.purchase_orders.po["items"][0]
    assert item["boxes_ready"] == 7
    assert item["boxes_dispatched"] == 8
    assert item["boxes_pending"] == 5
    assert item["boxes_ready"] + item["boxes_dispatched"] + item["boxes_pending"] == item["qty"]
    assert result["chalan"]["dispatch_id"] == result["dispatch"]["id"]
    assert result["dispatch"]["chalan_id"] == result["chalan"]["id"]


@pytest.mark.parametrize('count,reads', [(1, 1), (100, 1), (501, 2), (1001, 3)])
def test_dispatch_reads_batches_in_chunks_in_the_same_transaction(monkeypatch, count, reads):
    batches = [_ready_batch(id=f'rb-{i}') for i in range(count)]
    fake_db = _FakeDb(_po(), batches, _customer_order())
    monkeypatch.setattr(router_module, 'db', fake_db)
    session = object()
    body = router_module.DispatchBody(items=[router_module.DispatchLineInput(
        po_item_id='item-1', ready_batch_id=batch['id'], qty=1) for batch in batches], **_DESTINATION)
    resolved, warnings = asyncio.run(router_module._resolve_dispatch_lines(_po(), body, session=session))
    assert [row['batch']['id'] for row in resolved] == [batch['id'] for batch in batches]
    assert len(fake_db.ready_batches.reads) == reads
    for query, projection, captured_session in fake_db.ready_batches.reads:
        assert captured_session is session
        assert query['floor_id'] == 'ground-floor' and query['is_deleted'] is False
        assert len(query['id']['$in']) <= 500
    assert warnings == []


@pytest.mark.parametrize('override', [{'floor_id': 'first-floor'}, {'is_deleted': True}, {'po_item_id': 'other-item'}])
def test_dispatch_batching_rejects_wrong_scope_deleted_or_wrong_item(monkeypatch, override):
    fake_db = _FakeDb(_po(), [_ready_batch(**override)], _customer_order())
    monkeypatch.setattr(router_module, 'db', fake_db)
    body = router_module.DispatchBody(items=[router_module.DispatchLineInput(po_item_id='item-1', ready_batch_id='rb-1', qty=1)], **_DESTINATION)
    with pytest.raises(router_module.HTTPException) as error:
        asyncio.run(router_module._resolve_dispatch_lines(_po(), body))
    assert error.value.status_code == 400


def test_pending_only_dispatch_makes_no_batch_read(monkeypatch):
    fake_db = _FakeDb(_po(), [], _customer_order())
    monkeypatch.setattr(router_module, 'db', fake_db)
    body = router_module.DispatchBody(items=[router_module.DispatchLineInput(po_item_id='item-1', qty=1)], **_DESTINATION)
    asyncio.run(router_module._resolve_dispatch_lines(_po(), body))
    assert fake_db.ready_batches.reads == []


@pytest.mark.parametrize('count,expected_chunks', [(0, 0), (100, 1), (501, 2), (1001, 3)])
def test_dispatch_bulk_writes_are_chunked_and_keep_the_transaction(monkeypatch, count, expected_chunks):
    from pymongo import UpdateOne
    fake_db = _FakeDb(_po(), [_ready_batch(id=f'rb-{i}') for i in range(count)], _customer_order())
    monkeypatch.setattr(router_module, 'db', fake_db)
    session = object()
    operations = [UpdateOne({'id': f'rb-{i}', 'floor_id': 'ground-floor', 'is_deleted': False,
        'remaining_qty': {'$gte': 1}}, {'$inc': {'remaining_qty': -1}}) for i in range(count)]
    asyncio.run(router_module._write_dispatch_batches(operations, session=session))
    assert len(fake_db.ready_batches.bulk_calls) == expected_chunks
    for chunk, ordered, captured in fake_db.ready_batches.bulk_calls:
        assert ordered and captured is session and len(chunk) <= 500
    assert all(batch['remaining_qty'] == 11 for batch in fake_db.ready_batches.docs.values())


def test_dispatch_bulk_conflict_aborts_before_emitting_dispatch_or_chalan(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    fake_db = _FakeDb(_po(), [_ready_batch()], _customer_order())
    fake_db.ready_batches.bulk_write = AsyncMock(return_value=SimpleNamespace(matched_count=0))
    monkeypatch.setattr(router_module, 'db', fake_db)
    monkeypatch.setattr(router_module, 'client', _FakeClient())
    body = router_module.DispatchBody(items=[router_module.DispatchLineInput(po_item_id='item-1', ready_batch_id='rb-1', qty=1)], **_DESTINATION)
    with pytest.raises(router_module.HTTPException) as error:
        asyncio.run(router_module.commit_dispatch('po-1', body, user=_user()))
    assert error.value.status_code == 409
    assert fake_db.dispatches.inserted == [] and fake_db.chalans.inserted == []
