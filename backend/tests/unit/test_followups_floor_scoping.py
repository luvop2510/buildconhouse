"""Regression test: /followups/insights must scope every count to the
caller's active floor. It previously ran four raw, unscoped queries, so the
insights panel always showed global (in practice, 100% first-floor) numbers
regardless of which floor was selected."""
from __future__ import annotations
from unittest.mock import AsyncMock

import asyncio

import pytest

from models import UserPublic
from routes import followup_routes as followups


def _user(floor_id: str) -> UserPublic:
    return UserPublic(
        email="sales@forge.app", full_name="Sales", role="sales",
        floor_ids=["ground-floor", "first-floor"], active_floor_id=floor_id,
    )


class _Recorder:
    """Generic fake collection: records the filter passed to whichever
    method is called and returns a value shaped for that method."""

    def __init__(self, count_result: int = 0, find_result: list | None = None):
        self.count_result = count_result
        self.find_result = find_result or []
        self.last_count_filter: dict | None = None
        self.last_find_filter: dict | None = None

    async def count_documents(self, query):
        self.last_count_filter = query
        return self.count_result

    def find(self, query, *_args, **_kwargs):
        self.last_find_filter = query
        return self

    async def to_list(self, _n):
        return self.find_result


class _FakeDb:
    def __init__(self):
        self.activity_events = _Recorder()
        self.payments = _Recorder(find_result=[])
        self.quotations = _Recorder()
        self.followups = _Recorder()


def _floor_id_constraint(query: dict) -> dict | None:
    """floor_query(user, base) returns a bare {"floor_id": ...} dict only
    when base is empty — every real call site in insights() passes a
    non-empty base (e.g. {"event_type": ..., "created_at": rng}), which
    takes the $and-wrapping branch instead: {"$and": [{"floor_id": ...},
    base]}. This extracts the floor_id constraint either way, since a bare
    `.get("floor_id")` on the $and-wrapped form always returns None even on
    a correct implementation."""
    if "floor_id" in query:
        return query["floor_id"]
    for clause in query.get("$and", []):
        if "floor_id" in clause:
            return clause["floor_id"]
    return None


def test_insights_scopes_every_query_to_the_active_floor(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(followups, "db", fake_db)

    result = asyncio.run(followups.insights(user=_user("ground-floor")))

    expected = {"$in": ["ground-floor"]}
    assert _floor_id_constraint(fake_db.activity_events.last_count_filter) == expected
    assert fake_db.payments.last_find_filter is None
    assert result['payments_collected'] == 0
    assert _floor_id_constraint(fake_db.quotations.last_count_filter) == expected
    # followups.count_documents is called twice (completed_today, still_open) —
    # last_count_filter only captures the final call, which is enough to prove
    # the floor filter reaches this collection too.
    assert _floor_id_constraint(fake_db.followups.last_count_filter) == expected


class _FakeFollowups:
    def __init__(self, existing: dict):
        self._existing = existing
        self.inserted: list[dict] = []

    async def find_one(self, *_args, **_kwargs):
        return dict(self._existing)

    async def insert_one(self, doc):
        self.inserted.append(doc)

    async def update_one(self, *_args, **_kwargs):
        pass


def test_log_call_reschedule_inherits_source_followup_floor(monkeypatch):
    from models import FollowupCallOutcomePayload

    fake_followups = _FakeFollowups({
        "id": "f-1", "customer_id": "cust-1", "customer_name": "Test Customer",
        "assigned_to": "selected-worker",
        "floor_id": "ground-floor",
    })

    class _Db:
        followups = fake_followups
        users = type("Users", (), {"find_one": AsyncMock(return_value=None)})()

    monkeypatch.setattr(followups, "db", _Db())

    monkeypatch.setattr(followups.lead_scope, "validate_assignments", AsyncMock(return_value=[{"floor_id": "ground-floor", "user_id": "selected-worker", "user_name": "Selected worker"}]))
    asyncio.run(followups.log_call(
        "f-1", FollowupCallOutcomePayload(outcome="call_back"), user=_user("ground-floor"),
    ))

    assert fake_followups.inserted[0]["floor_id"] == "ground-floor"


def test_rule_counts_scopes_to_the_active_floor(monkeypatch):
    class _Recorder:
        def __init__(self):
            self.last_pipeline = None

        def aggregate(self, pipeline):
            self.last_pipeline = pipeline
            return self

        async def to_list(self, _n):
            return []

    class _FakeDb:
        followups = _Recorder()

    fake_db = _FakeDb()
    monkeypatch.setattr(followups, "db", fake_db)

    asyncio.run(followups._rule_counts(_user("ground-floor")))

    match_stage = fake_db.followups.last_pipeline[0]["$match"]
    # floor_query wraps in $and when base is non-empty (base here is
    # {"status": {"$in": [...]}}) — check the floor constraint is present
    # somewhere in the query, not just at the top level.
    if "floor_id" in match_stage:
        floor_constraint = match_stage["floor_id"]
    else:
        floor_constraint = next(c["floor_id"] for c in match_stage.get("$and", []) if "floor_id" in c)
    assert floor_constraint == {"$in": ["ground-floor"]}


def test_waking_expired_snoozes_is_scoped_to_the_callers_floor(monkeypatch):
    class _Recorder:
        def __init__(self):
            self.query = None

        async def update_many(self, query, _update):
            self.query = query

    class _Db:
        followups = _Recorder()

    fake_db = _Db()
    monkeypatch.setattr(followups, "db", fake_db)

    asyncio.run(followups._wake_snoozed(_user("ground-floor")))

    assert _floor_id_constraint(fake_db.followups.query) == {"$in": ["ground-floor"]}


def test_paged_followups_filters_and_bounds_the_database_pipeline(monkeypatch):
    class _Followups:
        def __init__(self):
            self.pipeline = None

        async def update_many(self, *_args, **_kwargs):
            pass

        def aggregate(self, pipeline):
            self.pipeline = pipeline
            return self

        async def to_list(self, _limit):
            return [
                {"id": f"f-{index}", "status": "open", "due_at": "2099-01-01T00:00:00+00:00", "priority_level": "high"}
                for index in range(26)
            ]

    class _Db:
        followups = _Followups()

    fake_db = _Db()
    monkeypatch.setattr(followups, "db", fake_db)

    result = asyncio.run(followups.list_followups_page(
        q="Acme", priority="high", category="sales", rule_type="selection_waiting",
        page=2, page_size=25, user=_user("ground-floor"),
    ))

    match = fake_db.followups.pipeline[0]["$match"]
    assert _floor_id_constraint(match) == {"$in": ["ground-floor"]}
    assert fake_db.followups.pipeline[2] == {"$sort": {
        "_inbox_overdue": 1, "_inbox_unresolved": 1, "_inbox_mine": 1,
        "priority_score": -1, "due_at": 1, "id": 1,
    }}
    assert fake_db.followups.pipeline[3] == {"$skip": 25}
    assert fake_db.followups.pipeline[4] == {"$limit": 26}
    assert result["page"] == 2
    assert result["page_size"] == 25
    assert result["has_more"] is True
    assert len(result["items"]) == 25
    assert all(row["bucket"] == "later" for row in result["items"])


class _DetailCollection:
    """Small Motor-shaped fake that records every floor-sensitive read."""

    def __init__(self, one: dict | None = None, rows: list[dict] | None = None):
        self.one = one
        self.rows = rows or []
        self.queries: list[dict] = []

    async def find_one(self, query, *_args, **_kwargs):
        self.queries.append(query)
        return dict(self.one) if self.one else None

    def find(self, query, *_args, **_kwargs):
        self.queries.append(query)
        return self

    def sort(self, *_args, **_kwargs):
        return self

    async def to_list(self, _limit):
        return list(self.rows)


def test_followup_detail_scopes_every_related_record_to_followups_floor(monkeypatch):
    """A same-customer record on another floor must never enter the panel."""
    followup = {"id": "f-ground", "customer_id": "customer-1", "floor_id": "ground-floor",
                "status": "open", "priority_level": "medium"}

    class _Db:
        followups = _DetailCollection(one=followup)
        customers = _DetailCollection(one={"id": "customer-1", "floor_id": "ground-floor"})
        quotations = _DetailCollection()
        payments = _DetailCollection()
        purchase_orders = _DetailCollection()

    fake_db = _Db()
    monkeypatch.setattr(followups, "db", fake_db)
    from routes import payment_routes
    monkeypatch.setattr(payment_routes, "db", fake_db)
    captured_timeline: dict = {}

    async def fake_timeline_for(**kwargs):
        captured_timeline.update(kwargs)
        return []

    monkeypatch.setattr(followups, "timeline_for", fake_timeline_for)

    detail = asyncio.run(followups.get_detail("f-ground", user=_user("ground-floor")))

    assert detail["customer"]["floor_id"] == "ground-floor"
    for collection in (fake_db.customers, fake_db.quotations):
        assert collection.queries[-1]["floor_id"] == "ground-floor"
    assert fake_db.quotations.queries[-1]["status"] == {"$in": ["draft", "sent", "pending_approval", "approved", "selection"]}
    assert fake_db.payments.queries == fake_db.purchase_orders.queries == []
    assert detail['payments'] == detail['purchases'] == []
    assert captured_timeline['entity_type'] == 'followup' and captured_timeline['entity_id'] == 'f-ground'
    assert captured_timeline["floor_ids"] == ["ground-floor"]


@pytest.mark.parametrize(("allowed_floor", "target_floor"), [
    ("ground-floor", "first-floor"),
    ("first-floor", "ground-floor"),
])
def test_followup_detail_denies_the_other_floor(monkeypatch, allowed_floor, target_floor):
    """Both business units get the same non-enumerating 404 boundary."""
    class _Db:
        followups = _DetailCollection(one={
            "id": "other-floor-followup", "customer_id": "c1", "floor_id": target_floor,
        })

    monkeypatch.setattr(followups, "db", _Db())
    user = UserPublic(email="staff@forge.app", full_name="Staff", role="sales",
                      floor_ids=[allowed_floor], active_floor_id=allowed_floor)

    with pytest.raises(Exception) as exc:
        asyncio.run(followups.get_detail("other-floor-followup", user=user))

    assert getattr(exc.value, "status_code", None) == 404
