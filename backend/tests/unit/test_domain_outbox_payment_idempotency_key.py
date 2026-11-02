"""Regression test for a live production bug: placing a SECOND order ever
(via the OrderPlaced automation) crashed with a Mongo DuplicateKeyError and
rolled back both the Purchase Order(s) AND the Payment for that order.

Root cause: `_handle_order_placed` built its Payment via `Payment(...).dict()`
without ever setting `idempotency_key`, so pydantic's `.dict()` always
included an explicit `"idempotency_key": None` in the upserted document.
`payments.payment_idempotency_key` is a UNIQUE **sparse** index — sparse only
skips documents where the field is entirely ABSENT, not documents where it is
present-but-null. The first automation payment ever inserted therefore
permanently claimed the one legal `null` slot; every subsequent order-placed
payment (which also always carries an explicit null) collided against it and
raised `DuplicateKeyError`, aborting the whole transaction (so the Purchase
Orders inserted earlier in the same transaction were rolled back too) —
matching the reported symptom of "no error shown, no payment, no purchase
order" (the frontend saw a raw connection failure, not a clean 4xx/5xx, once
the transaction/session teardown itself failed).

`idempotency_key` is a real feature used by `POST /api/payments` (client-
supplied dedup key for manual "Record Payment" retries) — automation payments
dedupe via their own `automation_key` field instead, so they must never write
`idempotency_key` at all.
"""
from __future__ import annotations

import asyncio

import services.domain_outbox as domain_outbox
import services.notifications as notifications
import services.sequence as sequence


class _Counters:
    """Fake `db.counters` so `_next_po_number` never touches the real Atlas
    cluster from a unit test (it imports its own `db` independently of
    domain_outbox's, so patching domain_outbox.db alone doesn't cover it)."""

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


def _quotation() -> dict:
    return {
        "id": "q-1", "number": "FQ-2026-0001", "customer_id": "cust-1",
        "customer_name": "Test Customer", "project_name": None,
        "grand_total": 1800.0, "floor_id": "ground-floor",
        "items": [{
            "id": "line-1", "product_id": "prod-1", "sku": "SKU-1", "name": "Tile A",
            "image": None, "finish": None, "category_id": "cat-1", "room": None,
            "qty": 5.0, "unit_price": 360.0, "discount_pct": None,
        }],
    }


def _run_order_placed(monkeypatch):
    quotation = _quotation()

    class _FakeDb:
        quotations = _Recorder(find_one_result=quotation)
        products = _Recorder()
        brands = _Recorder()
        suppliers = _Recorder()
        settings = _Recorder()
        purchase_orders = _Recorder()
        payments = _Recorder()
        activity_events = _Recorder()
        customers = _Recorder()
        followups = _Recorder()
        notifications = _Recorder()

    fake_db = _FakeDb()
    monkeypatch.setattr(domain_outbox, "db", fake_db)
    monkeypatch.setattr(notifications, "db", fake_db)
    fake_db.counters = _Counters()
    monkeypatch.setattr(sequence, "db", fake_db)

    event = {
        "id": "evt-1", "idempotency_key": "order-placed:q-1",
        "payload": {"quotation_id": "q-1"},
        "actor_id": "user-1", "actor_name": "Sales",
    }
    asyncio.run(domain_outbox._handle_order_placed(event, session=None))
    return fake_db


def test_order_placed_payment_never_carries_a_null_idempotency_key(monkeypatch):
    fake_db = _run_order_placed(monkeypatch)

    assert fake_db.payments.upserts, "expected a pending Payment to be upserted"
    payment_doc = fake_db.payments.upserts[0]

    # The bug: this key was always present (as an explicit None), which
    # collides with the payments.payment_idempotency_key unique sparse index
    # on every order placed after the very first one ever recorded.
    assert "idempotency_key" not in payment_doc, (
        "OrderPlaced automation must never write an explicit idempotency_key "
        "(even null) — it dedupes via automation_key. A present-but-null "
        "idempotency_key collides with the unique sparse index on the second "
        "order ever placed."
    )
