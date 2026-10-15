"""Regression test: the manager-only assignment tracking view (GET
/followups/assignments) must (a) reject anyone below the manager role and
(b) shape/sort rows correctly — see
docs/superpowers/specs/2026-07-27-followups-revamp-design.md."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from auth import require_min_role
from models import UserPublic, now_iso
from routes import followup_routes as followups


def _user(role: str, active_floor_id: str = "first-floor") -> UserPublic:
    # A concrete `active_floor_id` mirrors production: the shell always pins
    # one immediately after login (frontend/src/state/auth.tsx,
    # use-floor-access.ts), including for owner/manager. See
    # backend/auth.py::_resolve_floor_scope for what an unset active floor
    # now resolves to for an all-floors role.
    return UserPublic(email="u@forge.app", full_name="U", role=role,
                       floor_ids=["ground-floor", "first-floor"], active_floor_id=active_floor_id)


def test_sales_role_is_rejected():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(require_min_role("manager")(user=_user("sales")))
    assert exc.value.status_code == 403


def test_manager_role_is_allowed():
    user = asyncio.run(require_min_role("manager")(user=_user("manager")))
    assert user.role == "manager"


def _days_ago(n: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=n)).isoformat()


class _FakeFollowups:
    """Emulates just enough of Motor's find().to_list() to prove the
    endpoint's status filter works — real filtering happens in Mongo, this
    fake does the equivalent in Python so the test doesn't need a live DB.
    `list_assignments` calls floor_query(user, base), which always $and-wraps
    a non-empty base with the caller's resolved floor_id scope (see
    backend/auth.py::floor_query/_resolve_floor_scope), so the query here is
    always `{"$and": [{"floor_id": ...}, base]}` rather than a flat dict."""

    def __init__(self, docs):
        self._docs = docs

    def find(self, query, _proj=None):
        merged: dict = {}
        for clause in query.get("$and", [query]):
            merged.update(clause)
        allowed_statuses = set(merged.get("status", {}).get("$in", []))
        allowed_floors = merged.get("floor_id", {}).get("$in")
        self._filtered = [
            d for d in self._docs
            if d["status"] in allowed_statuses
            and (allowed_floors is None or d.get("floor_id") in allowed_floors)
        ]
        return self

    async def to_list(self, _n):
        return self._filtered


class _FakeUsers:
    def find(self, *_args, **_kwargs):
        return self

    async def to_list(self, _n):
        return []


def test_shapes_and_sorts_rows_oldest_open_first(monkeypatch):
    docs = [
        {"id": "f-done", "assigned_to": "u1", "assigned_to_name": "A", "customer_name": "C1",
         "reason": "R1", "category": "sales", "status": "done", "due_at": now_iso(),
         "created_at": _days_ago(10), "floor_id": "first-floor"},
        {"id": "f-open-recent", "assigned_to": "u1", "assigned_to_name": "A", "customer_name": "C2",
         "reason": "R2", "category": "sales", "status": "open", "due_at": now_iso(),
         "created_at": _days_ago(1), "floor_id": "first-floor"},
        {"id": "f-open-old", "assigned_to": "u1", "assigned_to_name": "A", "customer_name": "C3",
         "reason": "R3", "category": "sales", "status": "open", "due_at": now_iso(),
         "created_at": _days_ago(5), "floor_id": "first-floor"},
    ]

    class _Db:
        followups = _FakeFollowups(docs)
        users = _FakeUsers()

    monkeypatch.setattr(followups, "db", _Db())

    rows = asyncio.run(followups.list_assignments(include_completed=True, user=_user("manager")))

    assert [r["id"] for r in rows] == ["f-open-old", "f-open-recent", "f-done"]
    assert rows[0]["days_pending"] == 5


def test_excludes_completed_by_default(monkeypatch):
    docs = [
        {"id": "f-done", "assigned_to": "u1", "assigned_to_name": "A", "customer_name": "C1",
         "reason": "R1", "category": "sales", "status": "done", "due_at": now_iso(),
         "created_at": _days_ago(10), "floor_id": "first-floor"},
    ]

    class _Db:
        followups = _FakeFollowups(docs)
        users = _FakeUsers()

    monkeypatch.setattr(followups, "db", _Db())

    rows = asyncio.run(followups.list_assignments(include_completed=False, user=_user("manager")))
    assert rows == []
