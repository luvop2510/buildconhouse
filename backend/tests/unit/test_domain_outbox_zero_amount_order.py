"""Regression test for a second live production bug found while verifying
the idempotency_key fix: placing an order on a ₹0 quotation (a Selection
promoted to Quotation with nothing priced yet, a free-sample order, etc.)
dead-lettered the OrderPlaced event after 8 retries — permanently stuck,
zero Purchase Orders, zero Payments.

Root cause: `Payment.amount` is `Field(gt=0)`, but `_handle_order_placed`
always tried to build a Payment for `grand_total`, including when that's
0.0. Building `Payment(amount=0.0, ...)` raises a pydantic ValidationError,
which aborts the whole Mongo transaction — rolling back the Purchase Order(s)
inserted earlier in the same transaction too.

A ₹0 order has nothing outstanding to collect, so the fix is to skip
creating a Payment entirely rather than trying to represent "no payment" as
an invalid zero-amount one — matching the product requirement that a ₹0
Selection/Quotation must never appear in Payments.
"""
from __future__ import annotations

import asyncio

import services.domain_outbox as domain_outbox
import services.notifications as notifications
import services.sequence as sequence


class _Counters:
    async def find_one(self, *_args, **_kwargs):
        return {"_id": "already-seeded"}

    async def find_one_and_update(self, *_args, **_kwargs):
        return {"seq": 1}


class _Recorder:
    def __init__(self, find_one_result=None):
        self._find_one_result = find_one_result
        self.inserted: list[dict] = []
        self.upserts: list[dict] = []

    async def find_one(self, *_args, **_kwargs):
        return self._find_one_result

    def find(self, *_args, **_kwargs):
        return self

    async def to_list(self, _n):
        return []

    async def insert_one(self, doc, **_kwargs):
        self.inserted.append(doc)

    async def update_one(self, _query, update, *, upsert=False, **_kwargs):
        if upsert and "$setOnInsert" in update:
            self.upserts.append(update["$setOnInsert"])


def _zero_total_quotation() -> dict:
    return {
        "id": "q-zero", "number": "FQ-2026-0080", "customer_id": "cust-1",
        "customer_name": "Test Customer", "project_name": None,
        "grand_total": 0.0, "floor_id": "ground-floor",
        "items": [{
            "id": "line-1", "product_id": "prod-1", "sku": "SKU-1", "name": "Tile A",
            "image": None, "finish": None, "category_id": "cat-1", "room": None,
            "qty": 5.0, "unit_price": 0.0, "discount_pct": None,
        }],
    }


def test_order_placed_skips_payment_for_zero_total_without_crashing(monkeypatch):
    quotation = _zero_total_quotation()

    class _FakeDb:
        quotations = _Recorder(find_one_result=quotation)
        products = _Recorder()
        brands = _Recorder()
        suppliers = _Recorder()
        purchase_orders = _Recorder()
        payments = _Recorder()
        activity_events = _Recorder()
        customers = _Recorder()
        followups = _Recorder()
        notifications = _Recorder()
        settings = _Recorder()

    fake_db = _FakeDb()
    monkeypatch.setattr(domain_outbox, "db", fake_db)
    monkeypatch.setattr(notifications, "db", fake_db)
    fake_db.counters = _Counters()
    monkeypatch.setattr(sequence, "db", fake_db)

    event = {
        "id": "evt-1", "idempotency_key": "order-placed:q-zero",
        "payload": {"quotation_id": "q-zero"},
        "actor_id": "user-1", "actor_name": "Sales",
    }

    # Must not raise (the bug: pydantic ValidationError on Payment.amount=0).
    result = asyncio.run(domain_outbox._handle_order_placed(event, session=None))

    assert fake_db.purchase_orders.inserted, "a ₹0 order still generates its Purchase Order(s)"
    assert not fake_db.payments.upserts, "a ₹0 order must never create a Payment record"
    assert result["payment_amount"] == 0.0
