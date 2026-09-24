"""_handle_order_placed must create exactly one TileCustomerOrder for a
tiles quotation (regardless of brand count), link every created
PurchaseOrder to it via customer_order_id, and must NOT create one for a
standard (sanitaryware) quotation — can_place_order() in tiles_stage.py
returns True unconditionally for doc_type=="standard", so this handler
runs for both and the tiles-only behavior must be explicitly gated."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

import services.domain_outbox as outbox
import services.sequence as sequence
import services.tile_movement_log as tile_movement_log


class _FakeFind:
    def __init__(self, items):
        self._items = items

    async def to_list(self, n=None):
        return list(self._items)


class _FakeCollection:
    def __init__(self, seed=None):
        self.docs = list(seed or [])
        self.inserted: list[dict] = []

    def find(self, query=None, projection=None, session=None):
        return _FakeFind(self.docs)

    async def find_one(self, query=None, projection=None, session=None):
        query = query or {}
        for doc in self.docs:
            if all(doc.get(k) == v for k, v in query.items()):
                return dict(doc)
        return None

    async def insert_one(self, doc, session=None):
        self.inserted.append(doc)
        self.docs.append(doc)

    async def update_one(self, query, update, upsert=False, session=None):
        existing = None
        for doc in self.docs:
            if all(doc.get(k) == v for k, v in query.items()):
                existing = doc
                break
        if existing is None and upsert:
            new_doc = dict(update.get("$setOnInsert") or update.get("$set") or {})
            self.docs.append(new_doc)
            self.inserted.append(new_doc)
        elif existing is not None and "$set" in update:
            existing.update(update["$set"])


class _FakeCounters:
    def __init__(self):
        self.docs: dict = {}

    async def find_one(self, query, *_a, **_kw):
        return self.docs.get(query.get("_id"))

    async def find_one_and_update(self, query, update, **_kw):
        key = query["_id"]
        doc = self.docs.setdefault(key, {"_id": key, "seq": 0})
        doc["seq"] += update["$inc"]["seq"]
        return dict(doc)


class _FakeDb:
    def __init__(self, quotation: dict):
        self.quotations = _FakeCollection([quotation])
        self.products = _FakeCollection([
            {"id": "p-1", "brand_id": "b-qutone", "series": "Metropole"},
            {"id": "p-2", "brand_id": "b-dimore", "series": "Zentrum"},
        ])
        self.brands = _FakeCollection([
            {"id": "b-qutone", "name": "Qutone"}, {"id": "b-dimore", "name": "Dimore"},
        ])
        self.suppliers = _FakeCollection([
            {"id": "s-1", "brand_id": "b-qutone", "name": "Qutone Rajkot", "active": True},
            {"id": "s-2", "brand_id": "b-dimore", "name": "Dimore Rajkot", "active": True},
        ])
        self.customers = _FakeCollection([
            {"id": "cust-1", "name": "Nileshbhai Pokiya", "phone": "9909900000", "address": "123 Ring Road", "city": "Rajkot"},
        ])
        self.purchase_orders = _FakeCollection()
        self.customer_orders = _FakeCollection()
        self.payments = _FakeCollection()
        self.activity_events = _FakeCollection()
        self.followups = _FakeCollection()
        # services/tile_movement_log.py has its own module-level `db` too —
        # same gotcha as `sequence` below.
        self.material_movements = _FakeCollection()
        self.counters = _FakeCounters()
        # `next_number()` (services/sequence.py) imports its own module-level
        # `db` independently of domain_outbox's — monkeypatching outbox.db
        # alone does not cover it (see test_domain_outbox_payment_idempotency_key.py
        # for the same gotcha documented on an earlier task). Pre-seed the
        # counter docs so `next_number` never falls into `_seed_from_existing`,
        # which scans real collections this fake doesn't support iterating.
        year = datetime.now(timezone.utc).year
        for key in (f"purchase_order:FPO-{year}-", f"customer_order:TORD-{year}-"):
            self.counters.docs[key] = {"_id": key, "seq": 0}


def _tiles_quotation(**overrides) -> dict:
    base = {
        "id": "q-1", "number": "FQ-2026-0001", "doc_type": "tiles_quotation",
        "customer_id": "cust-1", "customer_name": "Nileshbhai Pokiya",
        "phone_snapshot": "9909900000", "address_snapshot": "123 Ring Road",
        "grand_total": 50000, "floor_id": "ground-floor",
        "items": [
            {"id": "li-1", "product_id": "p-1", "sku": "SKU-1", "name": "Glossy Ivory 600x600", "qty": 20, "unit_price": 1000, "size": "600X600", "pcs_per_box": "4"},
            {"id": "li-2", "product_id": "p-2", "sku": "SKU-2", "name": "Matte Grey 800x800", "qty": 10, "unit_price": 1500, "size": "800X800", "pcs_per_box": "2"},
        ],
    }
    base.update(overrides)
    return base


def _event(quotation_id: str) -> dict:
    return {
        "idempotency_key": f"order-placed:{quotation_id}", "actor_id": "u-sales", "actor_name": "Sales Rep",
        "payload": {"quotation_id": quotation_id},
    }


def test_tiles_quotation_creates_one_customer_order_linking_both_pos(monkeypatch):
    fake_db = _FakeDb(_tiles_quotation())
    monkeypatch.setattr(outbox, "db", fake_db)
    monkeypatch.setattr(sequence, "db", fake_db)
    monkeypatch.setattr(tile_movement_log, "db", fake_db)

    result = asyncio.run(outbox._handle_order_placed(_event("q-1"), session=None))

    assert len(fake_db.customer_orders.docs) == 1
    customer_order = fake_db.customer_orders.docs[0]
    assert customer_order["number"].startswith("TORD-")
    assert len(customer_order["brands"]) == 2
    po_ids = {b["purchase_order_id"] for b in customer_order["brands"]}
    assert po_ids == set(result["purchase_order_ids"])
    for po in fake_db.purchase_orders.docs:
        assert po["customer_order_id"] == customer_order["id"]
        assert po["items"][0]["series"] in {"Metropole", "Zentrum"}
        assert po["items"][0]["boxes_pending"] == po["items"][0]["qty"]


def test_standard_quotation_never_creates_customer_order(monkeypatch):
    fake_db = _FakeDb(_tiles_quotation(doc_type="standard"))
    monkeypatch.setattr(outbox, "db", fake_db)
    monkeypatch.setattr(sequence, "db", fake_db)
    monkeypatch.setattr(tile_movement_log, "db", fake_db)

    asyncio.run(outbox._handle_order_placed(_event("q-1"), session=None))

    assert fake_db.customer_orders.docs == []
    for po in fake_db.purchase_orders.docs:
        assert po["customer_order_id"] is None
        assert all(item["stage"] == "po_final" for item in po["items"])
        assert all(item["stage_history"][0]["to_stage"] == "po_final" for item in po["items"])


def test_sanitary_godown_line_creates_an_in_box_purchase_item(monkeypatch):
    quotation = _tiles_quotation(
        doc_type="standard",
        floor_id="first-floor",
        items=[{
            "id": "li-godown", "product_id": "p-1", "sku": "SKU-1", "name": "Glossy Ivory 600x600",
            "qty": 4, "unit_price": 1000, "godown_stock_id": "stock-1", "godown_allocation_id": "alloc-1",
            "godown_source_customer_name": "Original Customer", "godown_source_purchased_at": "2026-09-01T10:00:00+00:00",
            "godown_transferred_at": "2026-09-05T10:00:00+00:00",
        }],
    )
    fake_db = _FakeDb(quotation)
    monkeypatch.setattr(outbox, "db", fake_db)
    monkeypatch.setattr(sequence, "db", fake_db)
    monkeypatch.setattr(tile_movement_log, "db", fake_db)

    asyncio.run(outbox._handle_order_placed(_event("q-1"), session=None))

    assert len(fake_db.purchase_orders.docs) == 1
    po = fake_db.purchase_orders.docs[0]
    item = po["items"][0]
    assert po["supplier_id"] is None
    assert item["stage"] == "in_box"
    assert item["stage_history"][0]["to_stage"] == "in_box"
    assert item["godown_stock_id"] == "stock-1"
    assert item["godown_source_customer_name"] == "Original Customer"
    assert item["godown_source_purchased_at"] == "2026-09-01T10:00:00+00:00"


def test_retry_is_idempotent_and_does_not_duplicate_customer_order(monkeypatch):
    fake_db = _FakeDb(_tiles_quotation())
    monkeypatch.setattr(outbox, "db", fake_db)
    monkeypatch.setattr(sequence, "db", fake_db)
    monkeypatch.setattr(tile_movement_log, "db", fake_db)

    event = _event("q-1")
    asyncio.run(outbox._handle_order_placed(event, session=None))
    asyncio.run(outbox._handle_order_placed(event, session=None))

    assert len(fake_db.customer_orders.docs) == 1
    # Regression guard: the retry path rehydrates the existing
    # TileCustomerOrder rather than rebuilding it, and the brand loop
    # `continue`s early for every already-existing PO — so the totals must
    # still reflect the first (real) run, not be zeroed out by the second.
    assert fake_db.customer_orders.docs[0]["total_products"] == 2
    assert len(fake_db.customer_orders.docs[0]["brands"]) == 2
    assert len(fake_db.purchase_orders.docs) == 2
