"""Regression test: automated records created by the quotation-placed
automation must inherit floor_id from the source quotation, not silently
default to first-floor. Root cause: `_handle_order_placed` built
PurchaseOrder/Payment without ever reading `quotation.get("floor_id")`."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import services.domain_outbox as domain_outbox
import services.notifications as notifications
import services.sequence as sequence


class _CountersRecorder:
    """Fakes services.sequence.next_number's db.counters calls. next_number
    imports its own module-level `db` (services/sequence.py: `from db import
    db`), so patching domain_outbox's `db` reference alone does not cover
    it — it must be pointed at this same fake db separately (see
    test_domain_outbox_tile_customer_order.py for the established pattern).
    """

    def __init__(self):
        self.docs: dict = {}

    async def find_one(self, query, *_a, **_kw):
        return self.docs.get(query.get("_id"))

    async def find_one_and_update(self, query, update, **_kw):
        key = query["_id"]
        doc = self.docs.setdefault(key, {"_id": key, "seq": 0})
        doc["seq"] += update["$inc"]["seq"]
        return dict(doc)


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


def _quotation(floor_id: str) -> dict:
    return {
        "id": "q-1", "number": "FQ-2026-0001", "customer_id": "cust-1",
        "customer_name": "Test Customer", "project_name": None,
        "grand_total": 1000.0, "floor_id": floor_id,
        "items": [{
            "id": "line-1", "product_id": "prod-1", "sku": "SKU-1", "name": "Tile A",
            "image": None, "finish": None, "category_id": "cat-1", "room": None,
            "qty": 10.0, "unit_price": 100.0, "discount_pct": None,
        }],
    }


def test_order_placed_purchase_order_and_payment_inherit_quotation_floor(monkeypatch):
    quotation = _quotation("ground-floor")

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
        counters = _CountersRecorder()

    fake_db = _FakeDb()
    monkeypatch.setattr(domain_outbox, "db", fake_db)
    # notify() imports its own `db` from services.notifications rather than
    # going through domain_outbox's, so it isn't covered by the patch above.
    # _handle_order_placed doesn't call notify() today, but pin this so a
    # future refactor that does can't slip through onto the real Atlas
    # cluster undetected.
    monkeypatch.setattr(notifications, "db", fake_db)
    # _handle_order_placed allocates a PO number via services.sequence.next_number,
    # which imports its own module-level `db` independently of domain_outbox's —
    # must be patched separately or this hits the real database (see
    # backend/tests/unit/conftest.py's _guard_services_sequence_db, which now
    # catches exactly this class of oversight suite-wide).
    monkeypatch.setattr(sequence, "db", fake_db)
    # Pre-seed the counter doc so next_number never falls into
    # _seed_from_existing, which scans real collections via `db[collection]`
    # subscripting that this fake db does not implement.
    year = datetime.now(timezone.utc).year
    fake_db.counters.docs[f"purchase_order:FPO-{year}-"] = {"_id": f"purchase_order:FPO-{year}-", "seq": 0}

    event = {
        "id": "evt-1", "idempotency_key": "order-placed:q-1",
        "payload": {"quotation_id": "q-1"},
        "actor_id": "user-1", "actor_name": "Sales",
    }
    asyncio.run(domain_outbox._handle_order_placed(event, session=None))

    assert fake_db.purchase_orders.inserted, "expected at least one PurchaseOrder to be inserted"
    for po in fake_db.purchase_orders.inserted:
        assert po["floor_id"] == "ground-floor"
    assert fake_db.payments.upserts, "expected a pending Payment to be upserted"
    assert fake_db.payments.upserts[0]["floor_id"] == "ground-floor"
    assert not fake_db.notifications.inserted, "test must never write to the real db.notifications"


def test_upsert_followup_inherits_quotation_floor(monkeypatch):
    class _FakeDb:
        customers = _Recorder(find_one_result={"phone": "555", "tier": "retail"})
        followups = _Recorder()

    fake_db = _FakeDb()
    monkeypatch.setattr(domain_outbox, "db", fake_db)

    asyncio.run(domain_outbox._upsert_followup(
        key="k1", quotation=_quotation("ground-floor"), reason="test", category="quotation", session=None,
    ))

    assert fake_db.followups.upserts[0]["floor_id"] == "ground-floor"
