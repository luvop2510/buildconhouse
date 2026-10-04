"""Chalan generation endpoint — validates release quantities against what's
actually remaining, writes the chalan onto the PO, and notifies the order's
creator/assignee (never the customer directly — see design doc)."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from io import BytesIO

import pytest
from pypdf import PdfReader

from models import UserPublic
from pdf_chalan import build_chalan_pdf
from routes import purchases_tracker as tracker
from services import sequence as sequence_service


def _user() -> UserPublic:
    return UserPublic(
        email="wh@forge.app", full_name="Warehouse Rep", role="warehouse",
        floor_ids=["first-floor"], active_floor_id="first-floor",
    )


def _po(**overrides) -> dict:
    base = {
        "id": "po-1", "number": "FPO-0001", "customer_id": "cust-1",
        "customer_name": "Nileshbhai Pokiya", "created_by": "u-sales", "assigned_to": None,
        "floor_id": "first-floor",
        "items": [{"id": "item-1", "name": "Glossy Ivory 600x600", "finish": "600X600", "qty": 40}],
        "chalans": [],
    }
    base.update(overrides)
    return base


class _FakeUpdateResult:
    """Mirrors the one field (`matched_count`) generate_chalan's optimistic-
    concurrency check reads off pymongo's real UpdateResult."""

    def __init__(self, matched_count: int, modified_count: int | None = None):
        self.matched_count = matched_count
        self.modified_count = matched_count if modified_count is None else modified_count


class _AsyncContext:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


class _FakeSession(_AsyncContext):
    def start_transaction(self):
        return _AsyncContext()


class _FakeClient:
    async def start_session(self):
        return _FakeSession()


class _FakeEvents:
    def __init__(self):
        self.rows: list[dict] = []

    async def find_one(self, query, *_args, **_kwargs):
        return next((deepcopy(row) for row in self.rows if all(row.get(k) == v for k, v in query.items())), None)

    async def insert_one(self, row, **_kwargs):
        self.rows.append(deepcopy(row))


class _FakePOs:
    def __init__(self, po: dict | None, *, synchronize_initial_reads: int = 0):
        self._po = deepcopy(po)
        self.pushed_chalan: dict | None = None
        self.update_calls = 0
        self.update_queries: list[dict] = []
        self.find_queries: list[dict] = []
        self._synchronize_initial_reads = synchronize_initial_reads
        self._initial_reads = 0
        self._initial_read_barrier = asyncio.Event()
        self.replace_items_before_update: list[dict] | None = None

    @staticmethod
    def _clauses(query: dict):
        for clause in query.get("$and", [query]):
            yield clause

    def _matches_floor(self, query: dict) -> bool:
        floor_clause = next((c["floor_id"] for c in self._clauses(query) if "floor_id" in c), None)
        return floor_clause == {"$in": [self._po.get("floor_id")]} if floor_clause else True

    async def find_one(self, query, *_args, **_kwargs):
        self.find_queries.append(deepcopy(query))
        if self._po is None:
            return None
        if not self._matches_floor(query):
            return None
        snapshot = deepcopy(self._po)
        if self._initial_reads < self._synchronize_initial_reads:
            self._initial_reads += 1
            if self._initial_reads == self._synchronize_initial_reads:
                self._initial_read_barrier.set()
            await self._initial_read_barrier.wait()
        return snapshot

    async def update_one(self, query, update, **_kwargs):
        self.update_calls += 1
        self.update_queries.append(deepcopy(query))
        if self.replace_items_before_update is not None:
            self._po["items"] = deepcopy(self.replace_items_before_update)
            self.replace_items_before_update = None
        if self._po is None or not self._matches_floor(query):
            return _FakeUpdateResult(matched_count=0)
        clauses = list(self._clauses(query))
        expected_items = next((clause["items"] for clause in clauses if "items" in clause), None)
        if expected_items is not None and self._po.get("items") != expected_items:
            return _FakeUpdateResult(matched_count=0)

        expected_size = None
        for clause in self._clauses(query):
            if "$or" in clause:
                for option in clause["$or"]:
                    if isinstance(option.get("chalans"), dict) and "$size" in option["chalans"]:
                        expected_size = option["chalans"]["$size"]
            elif isinstance(clause.get("chalans"), dict) and "$size" in clause["chalans"]:
                expected_size = clause["chalans"]["$size"]
        if expected_size is not None and len(self._po.get("chalans", [])) != expected_size:
            return _FakeUpdateResult(matched_count=0)

        self.pushed_chalan = deepcopy(update["$push"]["chalans"])
        self._po.setdefault("chalans", []).append(self.pushed_chalan)
        return _FakeUpdateResult(matched_count=1)


class _FakeDb:
    def __init__(self, po: dict | None):
        self.purchase_orders = _FakePOs(po)
        self.event_outbox = _FakeEvents()


@pytest.fixture(autouse=True)
def _durable_outbox_harness(monkeypatch):
    monkeypatch.setattr(tracker, "client", _FakeClient())

    async def _enqueue(*, event_type, idempotency_key, payload, actor, session):
        event = {
            "id": f"event-{len(tracker.db.event_outbox.rows) + 1}",
            "event_type": event_type,
            "idempotency_key": idempotency_key,
            "payload": deepcopy(payload),
            "actor_id": actor.id,
            "actor_name": actor.full_name,
            "status": "pending",
        }
        await tracker.db.event_outbox.insert_one(event, session=session)
        return event

    async def _dispatch(_event_id):
        return {}

    monkeypatch.setattr(tracker, "enqueue_after_primary_commit", _enqueue)
    monkeypatch.setattr(tracker, "dispatch_event", _dispatch)


async def _noop_log_event(**_kwargs):
    return None


async def _fake_next_number(*_args, **_kwargs):
    return "CH-0001"


class _FakeCounters:
    """Backs services.sequence.next_number's `db.counters` calls with an
    already-seeded counter doc, so _seed_from_existing's collection scan
    never runs."""

    def __init__(self):
        self.doc = {"_id": "chalan:CH-", "seq": 0}

    async def find_one(self, query, *_a, **_kw):
        return dict(self.doc) if query.get("_id") == self.doc["_id"] else None

    async def find_one_and_update(self, _query, update, **_kw):
        self.doc["seq"] += update["$inc"]["seq"]
        return dict(self.doc)


class _FakeSequenceDb:
    def __init__(self):
        self.counters = _FakeCounters()


def test_generate_chalan_happy_path(monkeypatch):
    fake_db = _FakeDb(_po())
    monkeypatch.setattr(tracker, "db", fake_db)
    monkeypatch.setattr(tracker, "log_event", _noop_log_event)
    monkeypatch.setattr(tracker, "next_number", _fake_next_number)

    body = tracker.GenerateChalanBody(
        items=[tracker.ChalanItemInput(po_item_id="item-1", qty=15)],
        receiver_name="Nileshbhai Pokiya", sender_name="Kajaria Rep",
    )
    result = asyncio.run(tracker.generate_chalan("po-1", body, user=_user()))

    assert result["chalan"]["number"] == "CH-0001"
    assert result["chalan"]["items"][0]["qty"] == 15
    assert result["stage"] == "order"  # only 15 of 40 released — not fully released yet
    assert fake_db.purchase_orders.update_calls == 1


def test_generate_chalan_supports_multiple_items_and_complete_release(monkeypatch):
    fake_db = _FakeDb(_po(items=[
        {"id": "item-1", "name": "Basin", "finish": "Gloss", "qty": 2},
        {"id": "item-2", "name": "Mixer", "finish": "Chrome", "qty": 3},
    ]))
    monkeypatch.setattr(tracker, "db", fake_db)
    monkeypatch.setattr(tracker, "log_event", _noop_log_event)
    monkeypatch.setattr(tracker, "next_number", _fake_next_number)

    result = asyncio.run(tracker.generate_chalan(
        "po-1",
        tracker.GenerateChalanBody(items=[
            tracker.ChalanItemInput(po_item_id="item-1", qty=2),
            tracker.ChalanItemInput(po_item_id="item-2", qty=3),
        ]),
        user=_user(),
    ))

    assert [(line["po_item_id"], line["qty"]) for line in result["chalan"]["items"]] == [
        ("item-1", 2), ("item-2", 3),
    ]
    assert result["stage"] == "material_released"


def test_generate_chalan_partial_then_complete_never_exceeds_ordered_qty(monkeypatch):
    fake_db = _FakeDb(_po(items=[{"id": "item-1", "name": "Basin", "qty": 10}]))
    monkeypatch.setattr(tracker, "db", fake_db)
    monkeypatch.setattr(tracker, "log_event", _noop_log_event)
    numbers = iter(["CH-0001", "CH-0002"])

    async def _next(*_args, **_kwargs):
        return next(numbers)

    monkeypatch.setattr(tracker, "next_number", _next)

    partial = asyncio.run(tracker.generate_chalan(
        "po-1", tracker.GenerateChalanBody(items=[tracker.ChalanItemInput(po_item_id="item-1", qty=4)]),
        user=_user(),
    ))
    complete = asyncio.run(tracker.generate_chalan(
        "po-1", tracker.GenerateChalanBody(items=[tracker.ChalanItemInput(po_item_id="item-1", qty=6)]),
        user=_user(),
    ))

    released = sum(c["items"][0]["qty"] for c in fake_db.purchase_orders._po["chalans"])
    assert partial["stage"] == "order"
    assert complete["stage"] == "material_released"
    assert released == 10


def test_generate_chalan_allows_later_equal_sized_release_without_client_key(monkeypatch):
    fake_db = _FakeDb(_po(items=[{"id": "item-1", "name": "Basin", "qty": 8}]))
    monkeypatch.setattr(tracker, "db", fake_db)
    numbers = iter(["CH-0001", "CH-0002"])

    async def _next(*_args, **_kwargs):
        return next(numbers)

    monkeypatch.setattr(tracker, "next_number", _next)
    body = tracker.GenerateChalanBody(items=[tracker.ChalanItemInput(po_item_id="item-1", qty=4)])

    first = asyncio.run(tracker.generate_chalan("po-1", body, user=_user()))
    second = asyncio.run(tracker.generate_chalan("po-1", body, user=_user()))

    assert first["idempotent"] is False
    assert second["idempotent"] is False
    assert first["chalan"]["id"] != second["chalan"]["id"]
    assert [chalan["number"] for chalan in fake_db.purchase_orders._po["chalans"]] == ["CH-0001", "CH-0002"]
    assert sum(chalan["items"][0]["qty"] for chalan in fake_db.purchase_orders._po["chalans"]) == 8


def test_generated_chalan_persists_po_snapshot_and_renders_it_to_pdf(monkeypatch):
    fake_db = _FakeDb(_po(
        brand_name="PO fallback brand",
        supplier_name="Jaqu Distribution",
        items=[{
            "id": "item-1",
            "name": "Artize Tailwater Basin",
            "brand_name": "Artize",
            "size": "620 x 420 x 150 mm",
            "finish": "Matte Black",
            "qty": 2,
            "quantity_unit": "Pieces",
            "unit_cost": 4321.25,
        }],
    ))
    monkeypatch.setattr(tracker, "db", fake_db)
    monkeypatch.setattr(tracker, "next_number", _fake_next_number)
    body = tracker.GenerateChalanBody(
        items=[tracker.ChalanItemInput(po_item_id="item-1", qty=2)],
        transport="Patel Logistics - insured delivery",
        remarks="Keep upright and call before unloading.",
    )

    asyncio.run(tracker.generate_chalan("po-1", body, user=_user()))
    persisted = fake_db.purchase_orders._po["chalans"][0]
    line = persisted["items"][0]

    assert line == {
        "po_item_id": "item-1",
        "name": "Artize Tailwater Basin",
        "brand_name": "Artize",
        "size": "620 x 420 x 150 mm",
        "finish": "Matte Black",
        "qty": 2.0,
        "unit": "Pieces",
        "rate": 4321.25,
    }
    assert persisted["transport"] == "Patel Logistics - insured delivery"
    assert persisted["remarks"] == "Keep upright and call before unloading."

    pdf = build_chalan_pdf(persisted, fake_db.purchase_orders._po, {})
    text = " ".join(
        " ".join(page.extract_text() or "" for page in PdfReader(BytesIO(pdf)).pages).split()
    )
    for expected in (
        "Artize", "Artize Tailwater Basin", "620 x 420 x 150 mm", "Matte Black",
        "Piece", "4,321.25", "8,642.50", "Patel Logistics - insured delivery",
        "Keep upright and call before unloading.",
    ):
        assert expected in text


def test_generate_chalan_replayed_partial_request_returns_existing_without_duplicate_outbox(monkeypatch):
    fake_db = _FakeDb(_po(
        assigned_to="u-manager",
        items=[{"id": "item-1", "name": "Basin", "qty": 10}],
    ))
    monkeypatch.setattr(tracker, "db", fake_db)
    monkeypatch.setattr(tracker, "next_number", _fake_next_number)
    body = tracker.GenerateChalanBody(
        items=[tracker.ChalanItemInput(po_item_id="item-1", qty=4)],
        idempotency_key="release-request-1",
    )

    first = asyncio.run(tracker.generate_chalan("po-1", body, user=_user()))
    replay = asyncio.run(tracker.generate_chalan("po-1", body, user=_user()))

    assert first["chalan"]["id"] == replay["chalan"]["id"]
    assert replay["idempotent"] is True
    assert fake_db.purchase_orders.update_calls == 1
    assert len(fake_db.purchase_orders._po["chalans"]) == 1
    assert len(fake_db.event_outbox.rows) == 1
    assert len(fake_db.event_outbox.rows[0]["payload"]["notifications"]) == 2


def test_generate_chalan_concurrent_partial_replay_without_client_key_is_idempotent(monkeypatch):
    fake_db = _FakeDb(_po(items=[{"id": "item-1", "name": "Basin", "qty": 10}]))
    fake_db.purchase_orders._synchronize_initial_reads = 2
    monkeypatch.setattr(tracker, "db", fake_db)
    monkeypatch.setattr(tracker, "next_number", _fake_next_number)
    body = tracker.GenerateChalanBody(
        items=[tracker.ChalanItemInput(po_item_id="item-1", qty=4)],
        reference_number="supplier-release-1",
    )

    async def _race():
        return await asyncio.gather(
            tracker.generate_chalan("po-1", body, user=_user()),
            tracker.generate_chalan("po-1", body, user=_user()),
        )

    results = asyncio.run(_race())

    assert {result["idempotent"] for result in results} == {False, True}
    assert results[0]["chalan"]["id"] == results[1]["chalan"]["id"]
    assert len(fake_db.purchase_orders._po["chalans"]) == 1
    assert len(fake_db.event_outbox.rows) == 1
    assert fake_db.event_outbox.rows[0]["idempotency_key"].startswith(
        "purchase-chalan:po-1:generate:derived:"
    )


def test_generate_chalan_concurrent_release_allows_one_winner_without_over_release(monkeypatch):
    fake_db = _FakeDb(
        _po(items=[{"id": "item-1", "name": "Basin", "qty": 10}]),
    )
    fake_db.purchase_orders._synchronize_initial_reads = 2
    monkeypatch.setattr(tracker, "db", fake_db)
    monkeypatch.setattr(tracker, "log_event", _noop_log_event)
    number = 0

    async def _next(*_args, **_kwargs):
        nonlocal number
        number += 1
        return f"CH-{number:04d}"

    monkeypatch.setattr(tracker, "next_number", _next)
    first_body = tracker.GenerateChalanBody(
        items=[tracker.ChalanItemInput(po_item_id="item-1", qty=7)], idempotency_key="request-a",
    )
    second_body = tracker.GenerateChalanBody(
        items=[tracker.ChalanItemInput(po_item_id="item-1", qty=7)], idempotency_key="request-b",
    )

    async def _race():
        return await asyncio.gather(
            tracker.generate_chalan("po-1", first_body, user=_user()),
            tracker.generate_chalan("po-1", second_body, user=_user()),
            return_exceptions=True,
        )

    results = asyncio.run(_race())
    successes = [result for result in results if isinstance(result, dict)]
    conflicts = [result for result in results if getattr(result, "status_code", None) == 409]
    released = sum(line["qty"] for c in fake_db.purchase_orders._po["chalans"] for line in c["items"])

    assert len(successes) == 1
    assert len(conflicts) == 1
    assert released == 7
    assert released <= fake_db.purchase_orders._po["items"][0]["qty"]


def test_generate_chalan_scopes_cas_fresh_read_and_event_to_source_floor(monkeypatch):
    fake_db = _FakeDb(_po())
    monkeypatch.setattr(tracker, "db", fake_db)
    monkeypatch.setattr(tracker, "next_number", _fake_next_number)
    asyncio.run(tracker.generate_chalan(
        "po-1", tracker.GenerateChalanBody(items=[tracker.ChalanItemInput(po_item_id="item-1", qty=1)]),
        user=_user(),
    ))

    update_query = fake_db.purchase_orders.update_queries[0]
    assert {"floor_id": {"$in": ["first-floor"]}} in update_query["$and"]
    assert {"floor_id": {"$in": ["first-floor"]}} in fake_db.purchase_orders.find_queries[-1]["$and"]
    payload = fake_db.event_outbox.rows[0]["payload"]
    assert payload["floor_id"] == "first-floor"
    assert payload["po_id"] == "po-1"
    assert payload["customer_id"] == "cust-1"


def test_generate_chalan_rejects_concurrent_item_quantity_replacement(monkeypatch):
    fake_db = _FakeDb(_po(items=[{"id": "item-1", "name": "Basin", "qty": 10}]))
    fake_db.purchase_orders.replace_items_before_update = [
        {"id": "item-1", "name": "Basin", "qty": 3},
    ]
    monkeypatch.setattr(tracker, "db", fake_db)
    monkeypatch.setattr(tracker, "next_number", _fake_next_number)

    with pytest.raises(Exception) as exc:
        asyncio.run(tracker.generate_chalan(
            "po-1",
            tracker.GenerateChalanBody(
                items=[tracker.ChalanItemInput(po_item_id="item-1", qty=7)],
                idempotency_key="stale-items",
            ),
            user=_user(),
        ))

    assert getattr(exc.value, "status_code", None) == 409
    assert fake_db.purchase_orders._po["chalans"] == []
    assert fake_db.event_outbox.rows == []


def test_generate_chalan_number_uses_hyphenated_prefix(monkeypatch):
    """Regression: services.sequence.next_number concatenates prefix+seq
    with no separator — every other caller in this codebase passes the
    hyphen IN the prefix (e.g. "FPO-2026-"). generate_chalan must do the
    same so the printed Chalan number reads "CH-0001", not "CH0001". Runs
    the REAL next_number (not the tracker.next_number mock used elsewhere
    in this file), so a wrong prefix argument can't hide behind a mock
    that always returns a fixed string regardless of what it was called
    with — which is exactly how this bug shipped undetected the first time."""
    fake_db = _FakeDb(_po())
    monkeypatch.setattr(tracker, "db", fake_db)
    monkeypatch.setattr(tracker, "log_event", _noop_log_event)
    monkeypatch.setattr(sequence_service, "db", _FakeSequenceDb())

    body = tracker.GenerateChalanBody(items=[tracker.ChalanItemInput(po_item_id="item-1", qty=15)])
    result = asyncio.run(tracker.generate_chalan("po-1", body, user=_user()))

    assert result["chalan"]["number"] == "CH-0001"


def test_generate_chalan_rejects_over_release(monkeypatch):
    fake_db = _FakeDb(_po())
    monkeypatch.setattr(tracker, "db", fake_db)
    monkeypatch.setattr(tracker, "next_number", _fake_next_number)

    body = tracker.GenerateChalanBody(items=[tracker.ChalanItemInput(po_item_id="item-1", qty=999)])
    with pytest.raises(Exception) as exc:
        asyncio.run(tracker.generate_chalan("po-1", body, user=_user()))
    assert getattr(exc.value, "status_code", None) == 400


def test_generate_chalan_404s_when_po_not_found(monkeypatch):
    fake_db = _FakeDb(None)
    monkeypatch.setattr(tracker, "db", fake_db)

    body = tracker.GenerateChalanBody(items=[tracker.ChalanItemInput(po_item_id="item-1", qty=1)])
    with pytest.raises(Exception) as exc:
        asyncio.run(tracker.generate_chalan("po-1", body, user=_user()))
    assert getattr(exc.value, "status_code", None) == 404
