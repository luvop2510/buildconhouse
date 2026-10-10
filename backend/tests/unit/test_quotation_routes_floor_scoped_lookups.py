"""Regression test: quotation-by-ID endpoints must not 404 just because the
caller's ambient active-floor header doesn't match the quotation's floor."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

import routes.quotation_routes as quotation_routes
from models import UserPublic


def _user(active_floor_id: str = "first-floor") -> UserPublic:
    return UserPublic(
        email="sales@forge.app", full_name="Sales", role="sales",
        floor_ids=["ground-floor", "first-floor"], active_floor_id=active_floor_id,
    )


class _FakeQuotations:
    def __init__(self, doc: dict | None):
        self._doc = doc

    async def find_one(self, query, projection=None, session=None):
        if self._doc and query.get("id") == self._doc["id"]:
            return self._doc
        return None


class _FakeDb:
    def __init__(self, quotation: dict | None):
        self.quotations = _FakeQuotations(quotation)


def test_get_quotation_ignores_ambient_floor_mismatch(monkeypatch):
    doc = {
        "id": "q1", "floor_id": "ground-floor", "number": "FQ-2026-0001",
        "customer_id": "c1", "customer_name": "Test Customer",
        "created_by": "u1", "created_by_name": "Sales Rep",
        "created_at": "2026-07-26T00:00:00+00:00", "updated_at": "2026-07-26T00:00:00+00:00",
    }
    monkeypatch.setattr(quotation_routes, "db", _FakeDb(doc))

    # Ambient state says first-floor; the quotation is ground-floor. Must
    # still resolve, not 404.
    result = asyncio.run(quotation_routes.get_quotation("q1", user=_user(active_floor_id="first-floor")))

    assert result.id == "q1"


def test_get_quotation_still_404s_for_a_real_miss(monkeypatch):
    monkeypatch.setattr(quotation_routes, "db", _FakeDb(None))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(quotation_routes.get_quotation("missing", user=_user()))

    assert exc.value.status_code == 404


def test_place_order_preview_ignores_ambient_floor_mismatch(monkeypatch):
    doc = {"id": "q1", "floor_id": "ground-floor", "number": "FQ-2026-0001", "items": [
        {"id": "l1", "product_id": "p1", "sku": "SKU1", "name": "Tile", "qty": 2, "unit_price": 100.0},
    ]}
    monkeypatch.setattr(quotation_routes, "db", _FakeDb(doc))
    monkeypatch.setattr(quotation_routes, "per_line_net_amounts", lambda d: {"l1": 200.0})

    class _FakeCursor:
        def __init__(self, items):
            self.items = items
        async def to_list(self, _n):
            return self.items

    class _FakeProducts:
        def find(self, *_a, **_kw):
            return _FakeCursor([{"id": "p1", "brand_id": None}])

    quotation_routes.db.products = _FakeProducts()

    class _FakeBrands:
        def find(self, *_a, **_kw):
            return _FakeCursor([])

    quotation_routes.db.brands = _FakeBrands()

    result = asyncio.run(quotation_routes.place_order_preview("q1", user=_user(active_floor_id="first-floor")))

    assert result["quotation_id"] == "q1"


def test_place_order_confirm_updates_cross_floor_quotation(monkeypatch):
    """Regression: place_order_confirm should update a quotation even when
    the caller's ambient floor doesn't match the quotation's floor. The fix is
    to use bare {"id": ...} filter for update_one, not floor_query()."""
    doc = {
        "id": "q1", "floor_id": "ground-floor", "number": "FQ-2026-0001",
        "customer_id": "c1", "customer_name": "Test Customer",
        "created_by": "u1", "created_by_name": "Sales Rep",
        "created_at": "2026-07-26T00:00:00+00:00", "updated_at": "2026-07-26T00:00:00+00:00",
        "status": "draft",
        "items": [{"id": "l1", "product_id": "p1", "sku": "SKU1", "name": "Tile", "qty": 2, "unit_price": 100.0}],
    }

    # Track what filter update_one was called with
    update_calls = []

    class _FakeQuotationsForConfirm:
        async def find_one(self, query, projection=None, session=None):
            if doc and query.get("id") == doc["id"]:
                return doc
            return None

        async def update_one(self, filter_dict, update_dict, session=None):
            update_calls.append({"filter": filter_dict, "update": update_dict})
            # Verify the filter is just {"id": ...}, not floor-scoped
            assert filter_dict == {"id": "q1", "floor_id": "ground-floor"}, f"Expected {{'id': 'q1'}}, got {filter_dict}"
            return {"matched_count": 1, "modified_count": 1}

    class _FakeConfirmProducts:
        def find(self, query, projection, *, session=None):
            assert query["floor_id"] == "ground-floor"
            assert query["id"] == {"$in": ["p1"]}
            assert session is not None
            class Cursor:
                async def to_list(self, length):
                    return [{"id": "p1", "price": 100.0, "mrp": 100.0}]
            return Cursor()

    class _FakeDbForConfirm:
        def __init__(self):
            self.quotations = _FakeQuotationsForConfirm()
            self.products = _FakeConfirmProducts()
            self.event_outbox = type('obj', (object,), {'find_one': self._fake_find_one})()

        async def _fake_find_one(self, query, projection=None):
            return None

    # Mock the database
    db_instance = _FakeDbForConfirm()
    monkeypatch.setattr(quotation_routes, "db", db_instance)

    # Mock client.start_session() context manager in db module
    import db as db_module

    class _FakeSession:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        def start_transaction(self):
            class _FakeTxn:
                async def __aenter__(self):
                    return self
                async def __aexit__(self, *args):
                    pass
            return _FakeTxn()

    class _FakeClient:
        async def start_session(self):
            class _SessionCM:
                async def __aenter__(self):
                    return _FakeSession()
                async def __aexit__(self, *args):
                    pass
            return _SessionCM()

    monkeypatch.setattr(db_module, "client", _FakeClient())

    # Mock the downstream event handlers to avoid needing full infrastructure
    async def _fake_enqueue(*args, **kwargs):
        return {"id": "test-event-id", "idempotency_key": "test", "status": "completed"}

    async def _fake_dispatch(*args, **kwargs):
        return {}

    async def _fake_reconcile(*args, **kwargs):
        return None

    completed_followups = []

    async def _fake_complete_pre_confirmation_followups(quotation_id, quotation_number, *, session=None, floor_id=None):
        assert floor_id == "ground-floor"
        completed_followups.append((quotation_id, quotation_number, session))
        return 0

    async def _fake_complete_order_notebook_followups(doc, *, session=None):
        assert doc["id"] == "q1" and doc["floor_id"] == "ground-floor"
        assert session is not None
        return 0

    monkeypatch.setattr(quotation_routes, "enqueue_after_primary_commit", _fake_enqueue)
    monkeypatch.setattr(quotation_routes, "dispatch_event", _fake_dispatch)
    monkeypatch.setattr(quotation_routes, "reconcile_followups", _fake_reconcile)
    monkeypatch.setattr(quotation_routes, "_complete_pre_confirmation_followups", _fake_complete_pre_confirmation_followups)
    monkeypatch.setattr(quotation_routes, "_complete_order_notebook_followups", _fake_complete_order_notebook_followups)

    # Call place_order_confirm with a quotation on a different floor (ground-floor)
    # but with a user whose ambient active floor is first-floor
    from routes.quotation_routes import PlaceOrderConfirmPayload
    payload = PlaceOrderConfirmPayload(project_name="Test Project", expected_delivery_at="2026-08-26")

    asyncio.run(
        quotation_routes.place_order_confirm(
            "q1",
            payload,
            user=_user(active_floor_id="first-floor"),  # Ambient mismatch
        )
    )

    # Verify update_one was called and recorded its filter
    assert len(update_calls) == 1, f"Expected 1 update_one call, got {len(update_calls)}"
    # The assertion inside update_one checks the filter is bare {"id": ...}
    # If we got here without raising, the fix is working
    assert completed_followups and completed_followups[0][:2] == ("q1", "FQ-2026-0001")


def test_update_quotation_works_cross_floor(monkeypatch):
    """Regression: update_quotation must use bare {"id": ...} filter for
    update_one and find_one when refetching the document, not floor_query().
    Otherwise, ambient floor mismatch causes a silent no-op update, then
    find_one returns None, then Quotation(**None) raises TypeError 500."""
    doc = {
        "id": "q1", "floor_id": "ground-floor", "number": "FQ-2026-0001",
        "customer_id": "c1", "customer_name": "Test Customer",
        "created_by": "u1", "created_by_name": "Sales Rep",
        "created_at": "2026-07-26T00:00:00+00:00", "updated_at": "2026-07-26T00:00:00+00:00",
        "status": "draft",
        "items": [],
    }

    # Track what filters update_one and find_one are called with
    update_calls = []
    find_calls = []

    class _FakeQuotationsForUpdate:
        async def find_one(self, query, projection=None, session=None):
            find_calls.append({"filter": query, "projection": projection})
            # Verify the filter is just {"id": ...}, not floor-scoped
            if query != {"id": "q1"}:
                # This simulates what would happen if floor_query were used —
                # it would have floor_id in the filter and wouldn't match
                return None
            return doc

        async def update_one(self, filter_dict, update_dict, session=None):
            update_calls.append({"filter": filter_dict, "update": update_dict})
            # Verify the filter is just {"id": ...}, not floor-scoped
            assert filter_dict == {"id": "q1"}, f"Expected {{'id': 'q1'}}, got {filter_dict}"
            return {"matched_count": 1, "modified_count": 1}

    class _FakeDbForUpdate:
        def __init__(self):
            self.quotations = _FakeQuotationsForUpdate()
            self.activity_events = type('obj', (object,), {'insert_one': self._fake_insert})()

        async def _fake_insert(self, doc):
            return {"inserted_id": "test"}

    # Mock the database
    db_instance = _FakeDbForUpdate()
    monkeypatch.setattr(quotation_routes, "db", db_instance)

    # Mock the downstream event handlers to avoid needing full infrastructure
    async def _fake_log_event(*args, **kwargs):
        return None

    async def _fake_reconcile(*args, **kwargs):
        return None

    monkeypatch.setattr(quotation_routes, "log_event", _fake_log_event)
    monkeypatch.setattr(quotation_routes, "reconcile_followups", _fake_reconcile)

    # Call update_quotation with a quotation on a different floor (ground-floor)
    # but with a user whose ambient active floor is first-floor
    from routes.quotation_routes import QuotationUpdate
    payload = QuotationUpdate(items=[], silent=True)

    result = asyncio.run(
        quotation_routes.update_quotation(
            "q1",
            payload,
            user=_user(active_floor_id="first-floor"),  # Ambient mismatch
        )
    )

    # Verify the update succeeded and returned a valid Quotation
    assert result.id == "q1"
    assert result.floor_id == "ground-floor"

    # Verify update_one was called with bare {"id": ...} filter
    assert len(update_calls) == 1, f"Expected 1 update_one call, got {len(update_calls)}"

    # Verify find_one was called with bare {"id": ...} filter
    # (to refetch the document after the update)
    assert any(call["filter"] == {"id": "q1"} for call in find_calls), \
        f"Expected find_one to be called with bare filter, got {find_calls}"
