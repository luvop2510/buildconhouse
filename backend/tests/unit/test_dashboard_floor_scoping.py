"""Regression test: /dashboard/stats' followups_due counter must respect the
active floor, not just assigned_to. (The main quotations/customers queries in
this endpoint were already correctly scoped — this covers the one field that
wasn't.)"""
from __future__ import annotations

import asyncio

import pytest

from auth import floor_query
from models import UserPublic
from routes import dashboard_routes
from services.analytics import cache


@pytest.fixture(autouse=True)
def _reset_dashboard_cache():
    cache.reset_memory_state()
    yield
    cache.reset_memory_state()


def _user(floor_id: str) -> UserPublic:
    return UserPublic(
        email="sales@forge.app", full_name="Sales", role="sales", id="user-1",
        floor_ids=["ground-floor", "first-floor"], active_floor_id=floor_id,
    )


class _Recorder:
    def __init__(self):
        self.last_find_filter: dict | None = None
        self.last_count_filter: dict | None = None
        self.last_aggregate_pipeline: list[dict] | None = None

    def find(self, query, *_args, **_kwargs):
        self.last_find_filter = query
        return self

    def aggregate(self, pipeline):
        self.last_aggregate_pipeline = pipeline
        return self

    async def to_list(self, _n):
        return [{}] if self.last_aggregate_pipeline is not None else []

    async def count_documents(self, query):
        self.last_count_filter = query
        return 0


class _FakeDb:
    def __init__(self):
        self.quotations = _Recorder()
        self.customers = _Recorder()
        self.products = _Recorder()
        self.followups = _Recorder()


def _floor_id_constraint(query: dict) -> dict | None:
    """floor_query(user, base) $and-wraps its floor constraint whenever
    base is non-empty (which it is here — {"status": ..., "due_at": ...,
    "assigned_to": ...}) — a bare `.get("floor_id")` would incorrectly
    return None even on a correct implementation. Extracts the constraint
    from either the bare-dict (empty base) or $and-wrapped (non-empty
    base) shape."""
    if "floor_id" in query:
        return query["floor_id"]
    for clause in query.get("$and", []):
        if "floor_id" in clause:
            return clause["floor_id"]
    return None


def test_followups_due_scopes_to_the_active_floor(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(dashboard_routes, "db", fake_db)

    asyncio.run(dashboard_routes.dashboard_stats(user=_user("ground-floor")))

    query = fake_db.followups.last_count_filter
    assert _floor_id_constraint(query) == {"$in": ["ground-floor"]}
    # "assigned_to" lives in the non-floor_id clause of the $and-wrapped
    # query (base is non-empty here) — not at the query's top level.
    base_clause = next(c for c in query["$and"] if "floor_id" not in c)
    assert base_clause.get("assigned_to") == "user-1"


def test_product_count_scopes_to_the_active_floor(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(dashboard_routes, "db", fake_db)

    asyncio.run(dashboard_routes.dashboard_stats(user=_user("ground-floor")))

    query = fake_db.products.last_count_filter
    assert _floor_id_constraint(query) == {"$in": ["ground-floor"]}
    # "active" lives in the non-floor_id clause of the $and-wrapped query
    # (base is non-empty here) — not at the query's top level.
    base_clause = next(c for c in query["$and"] if "floor_id" not in c)
    assert base_clause.get("active") is True


def test_monthly_revenue_uses_ordered_at_for_current_orders_and_keeps_legacy_history(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(dashboard_routes, "db", fake_db)

    asyncio.run(dashboard_routes.dashboard_stats(user=_user("ground-floor")))

    facets = fake_db.quotations.last_aggregate_pipeline[1]["$facet"]
    match = facets["revenue_month"][0]["$match"]["$or"]
    assert match[0]["status"] == "ordered"
    assert "ordered_at" in match[0]
    assert "updated_at" not in match[0]
    assert match[1]["status"] == "won"
    assert "updated_at" in match[1]


def test_top_products_excludes_unconfirmed_quotations(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(dashboard_routes, "db", fake_db)

    asyncio.run(dashboard_routes.dashboard_stats(user=_user("ground-floor")))

    facets = fake_db.quotations.last_aggregate_pipeline[1]["$facet"]
    assert facets["top_products"][0] == {"$match": {"status": {"$in": ["ordered", "won"]}}}
    group = facets["top_products"][2]["$group"]
    assert group["revenue"]["$sum"] == {
        "$ifNull": ["$items.net_amount", {"$multiply": ["$items.qty", "$items.unit_price"]}],
    }


def test_dashboard_cache_does_not_share_assigned_counts_between_staff(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(dashboard_routes, "db", fake_db)
    counts = []

    async def count_assigned(query):
        base = next(clause for clause in query["$and"] if "assigned_to" in clause)
        counts.append(base["assigned_to"])
        return 2 if base["assigned_to"] == "user-1" else 7

    monkeypatch.setattr(fake_db.followups, "count_documents", count_assigned)

    async def check():
        first = _user("ground-floor")
        second = first.model_copy(update={"id": "user-2"})
        assert (await dashboard_routes.dashboard_stats(user=first))["followups_due"] == 2
        assert (await dashboard_routes.dashboard_stats(user=second))["followups_due"] == 7
        assert (await dashboard_routes.dashboard_stats(user=first))["followups_due"] == 2
        assert counts == ["user-1", "user-2"]

    asyncio.run(check())
