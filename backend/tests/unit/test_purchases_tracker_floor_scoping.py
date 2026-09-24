"""Regression test: the Purchases Tracker read endpoints must never return
rows from a floor the caller isn't currently viewing. Root cause (2026-07-17
floor-isolation investigation): `_iter_items()` built its Mongo `$match`
with no floor filter at all, so every tracker view showed every floor's
purchase orders regardless of the selected floor."""
from __future__ import annotations

import asyncio

import pytest

from models import UserPublic
from routes import purchases_tracker as tracker


def _user(floor_id: str) -> UserPublic:
    return UserPublic(
        email="sales@forge.app", full_name="Sales", role="sales",
        floor_ids=["ground-floor", "first-floor"], active_floor_id=floor_id,
    )


class _FakeAggregateCursor:
    def __init__(self, rows: list[dict]):
        self._rows = rows

    async def to_list(self, _n):
        return self._rows


class _FakePurchaseOrders:
    """Captures the pipeline passed to aggregate() instead of simulating
    real Mongo aggregation semantics — the thing under test is whether the
    floor filter is present in the $match stage, not Mongo's engine."""

    def __init__(self):
        self.last_pipeline: list[dict] | None = None

    def aggregate(self, pipeline):
        self.last_pipeline = pipeline
        return _FakeAggregateCursor([])


class _FakeDb:
    def __init__(self, purchase_orders: _FakePurchaseOrders):
        self.purchase_orders = purchase_orders

    class _FakeSettings:
        async def find_one(self, *_args, **_kwargs):
            return None

    settings = _FakeSettings()


def test_iter_items_scopes_pipeline_to_the_active_floor(monkeypatch):
    fake_pos = _FakePurchaseOrders()
    monkeypatch.setattr(tracker, "db", _FakeDb(fake_pos))

    asyncio.run(tracker._iter_items(
        "stock", None, None, None, None, sla_days=7, limit=500,
        floor_ids=["ground-floor"],
    ))

    match_stage = fake_pos.last_pipeline[0]["$match"]
    assert match_stage.get("floor_id") == {"$in": ["ground-floor"]}


def test_iter_items_unscoped_when_floor_ids_is_none(monkeypatch):
    fake_pos = _FakePurchaseOrders()
    monkeypatch.setattr(tracker, "db", _FakeDb(fake_pos))

    asyncio.run(tracker._iter_items(
        "stock", None, None, None, None, sla_days=7, limit=500,
        floor_ids=None,
    ))

    match_stage = fake_pos.last_pipeline[0]["$match"]
    assert "floor_id" not in match_stage


@pytest.mark.parametrize(
    "route_func",
    [tracker.stage_catalog, tracker.brand_facets, tracker.customer_facets],
)
def test_facet_endpoints_scope_pipeline_to_the_active_floor(monkeypatch, route_func):
    fake_pos = _FakePurchaseOrders()
    monkeypatch.setattr(tracker, "db", _FakeDb(fake_pos))

    asyncio.run(route_func(user=_user("ground-floor")))

    match_stage = fake_pos.last_pipeline[0]["$match"]
    assert match_stage.get("floor_id") == {"$in": ["ground-floor"]}


def test_po_final_is_first_stage_and_legacy_stage_remains_readable(monkeypatch):
    fake_pos = _FakePurchaseOrders()
    monkeypatch.setattr(tracker, "db", _FakeDb(fake_pos))

    stages = asyncio.run(tracker.stage_catalog(user=_user("first-floor")))

    assert stages[0]["key"] == "po_final"
    assert stages[0]["label"] == "PO Final"
    assert "order_in_company" in {stage["key"] for stage in stages}
    assert "po_final" in tracker.EARLY_STAGES
    assert tracker._derive_po_status_from_stages([{"stage": "po_final"}], "draft") is None


def test_customer_workspace_scopes_every_query_to_the_active_floor(monkeypatch):
    from auth import floor_query

    class _Recorder:
        def __init__(self, find_one_result=None):
            self._find_one_result = find_one_result
            self.last_query: dict | None = None

        async def find_one(self, query, *_args, **_kwargs):
            self.last_query = query
            return dict(self._find_one_result) if self._find_one_result else None

        def find(self, query, *_args, **_kwargs):
            self.last_query = query
            return self

        def sort(self, *_args, **_kwargs):
            return self

        async def to_list(self, _n):
            return []

    class _Db:
        customers = _Recorder(find_one_result={"id": "cust-1", "name": "Test"})
        purchase_orders = _Recorder()
        purchase_shortages = _Recorder()
        quotations = _Recorder()
        payments = _Recorder()
        followups = _Recorder()
        settings = _Recorder()

    fake_db = _Db()
    monkeypatch.setattr(tracker, "db", fake_db)

    async def _fake_iter_items(*_args, **kwargs):
        assert kwargs.get("floor_ids") == ["ground-floor"]
        return []

    async def _fake_timeline_for(**_kwargs):
        return []

    monkeypatch.setattr(tracker, "_iter_items", _fake_iter_items)
    monkeypatch.setattr(tracker, "timeline_for", _fake_timeline_for)

    user = _user("ground-floor")
    asyncio.run(tracker.customer_workspace("cust-1", user=user))

    def _has_floor_constraint(query):
        """Check if a query (potentially wrapped in $and) has the floor constraint."""
        if "$and" in query:
            for clause in query["$and"]:
                if clause.get("floor_id") == {"$in": ["ground-floor"]}:
                    return True
        else:
            if query.get("floor_id") == {"$in": ["ground-floor"]}:
                return True
        return False

    assert _has_floor_constraint(fake_db.customers.last_query)
    assert _has_floor_constraint(fake_db.purchase_orders.last_query)
    assert _has_floor_constraint(fake_db.purchase_shortages.last_query)
    assert _has_floor_constraint(fake_db.quotations.last_query)
    assert _has_floor_constraint(fake_db.payments.last_query)
    assert _has_floor_constraint(fake_db.followups.last_query)


def test_dispatch_record_scopes_to_the_active_floor(monkeypatch):
    fake_pos = _FakePurchaseOrders()
    monkeypatch.setattr(tracker, "db", _FakeDb(fake_pos))

    asyncio.run(tracker.dispatch_record(limit=500, user=_user("ground-floor")))

    match_stage = fake_pos.last_pipeline[0]["$match"]
    assert match_stage.get("floor_id") == {"$in": ["ground-floor"]}


def test_export_xlsx_scopes_to_the_active_floor(monkeypatch):
    fake_pos = _FakePurchaseOrders()
    monkeypatch.setattr(tracker, "db", _FakeDb(fake_pos))

    asyncio.run(tracker.export_xlsx(view="stock", user=_user("ground-floor")))

    match_stage = fake_pos.last_pipeline[0]["$match"]
    assert match_stage.get("floor_id") == {"$in": ["ground-floor"]}


class _FakeShortages:
    def __init__(self):
        self.last_query: dict | None = None

    def find(self, query, *_args, **_kwargs):
        self.last_query = query
        return self

    def sort(self, *_args, **_kwargs):
        return self

    async def to_list(self, _n):
        return []


def test_list_shortages_scopes_to_the_active_floor(monkeypatch):
    fake_shortages = _FakeShortages()

    class _Db:
        purchase_shortages = fake_shortages

    monkeypatch.setattr(tracker, "db", _Db())

    asyncio.run(tracker.list_shortages(user=_user("ground-floor")))

    assert fake_shortages.last_query.get("floor_id") == {"$in": ["ground-floor"]}


class _FakeSinglePo:
    def __init__(self, po: dict | None):
        self._po = po

    async def find_one(self, *_args, **_kwargs):
        return dict(self._po) if self._po else None


def test_get_item_404s_when_item_is_on_a_different_floor(monkeypatch):
    class _Db:
        purchase_orders = _FakeSinglePo({"id": "po-1", "floor_id": "first-floor", "items": []})

    monkeypatch.setattr(tracker, "db", _Db())

    with pytest.raises(Exception) as exc:
        asyncio.run(tracker.get_item("item-1", user=_user("ground-floor")))
    assert getattr(exc.value, "status_code", None) == 404


def test_get_item_uses_the_purchase_order_floor_not_the_stale_active_floor(monkeypatch):
    """A shared-floor user can open a sanitary item after switching the UI
    header to Ground Floor; the item endpoint must not turn that into a 404."""
    class _RecordingPo:
        def __init__(self):
            self.query = None

        async def find_one(self, query, *_args, **_kwargs):
            self.query = query
            return {
                "id": "po-1", "floor_id": "first-floor", "status": "open",
                "created_at": "2026-08-01T00:00:00+00:00",
                "items": [{"id": "item-1", "stage": "in_box", "qty": 1, "name": "Basin"}],
            }

    class _Db:
        purchase_orders = _RecordingPo()

        class _Settings:
            async def find_one(self, *_args, **_kwargs):
                return None

        settings = _Settings()

    fake_db = _Db()
    monkeypatch.setattr(tracker, "db", fake_db)

    item = asyncio.run(tracker.get_item("item-1", user=_user("ground-floor")))

    assert item["item_id"] == "item-1"
    assert fake_db.purchase_orders.query == {"items.id": "item-1"}


def test_item_transfer_history_404s_when_item_is_on_a_different_floor(monkeypatch):
    class _Db:
        purchase_orders = _FakeSinglePo({"id": "po-1", "floor_id": "first-floor"})

    monkeypatch.setattr(tracker, "db", _Db())

    with pytest.raises(Exception) as exc:
        asyncio.run(tracker.item_transfer_history("item-1", user=_user("ground-floor")))
    assert getattr(exc.value, "status_code", None) == 404
