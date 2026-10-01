"""Outcome validation and rescheduling regression coverage for follow-ups."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from models import FollowupCallOutcomePayload, UserPublic
from routes import followup_routes as followups


def _user() -> UserPublic:
    return UserPublic(
        email="sales@forge.app", full_name="Sales", role="sales",
        floor_ids=["first-floor"], active_floor_id="first-floor",
    )


class _Followups:
    def __init__(self):
        self.row = {
            "id": "followup-1", "floor_id": "first-floor", "customer_id": "customer-1",
            "customer_name": "Client", "category": "sales", "due_at": "2026-01-01T00:00:00+00:00",
        }
        self.updated: dict | None = None
        self.inserted: list[dict] = []

    async def find_one(self, *_args, **_kwargs):
        return {**self.row, **(self.updated or {})}

    async def update_one(self, _query, patch, **_kwargs):
        self.updated = patch["$set"]

    async def insert_one(self, row):
        self.inserted.append(row)


def _install(monkeypatch):
    store = _Followups()
    monkeypatch.setattr(followups, "db", type("Db", (), {"followups": store})())
    return store


def test_lost_outcome_requires_a_reason(monkeypatch):
    _install(monkeypatch)
    with pytest.raises(Exception) as error:
        asyncio.run(followups.log_call("followup-1", FollowupCallOutcomePayload(outcome="lost"), _user()))
    assert getattr(error.value, "status_code", None) == 422


def test_lost_outcome_persists_reason(monkeypatch):
    store = _install(monkeypatch)
    asyncio.run(followups.log_call(
        "followup-1", FollowupCallOutcomePayload(outcome="lost", notes="Budget moved to another supplier"), _user(),
    ))
    assert store.updated["completed_outcome"] == "lost"
    assert store.updated["resolution_note"] == "Budget moved to another supplier"


def test_pending_outcome_creates_followup_on_requested_date(monkeypatch):
    store = _install(monkeypatch)
    due = datetime.now(timezone.utc) + timedelta(days=7)
    asyncio.run(followups.log_call(
        "followup-1", FollowupCallOutcomePayload(outcome="pending", notes="Customer requested a call next week", next_followup_at=due), _user(),
    ))
    assert store.updated["completed_outcome"] == "pending"
    assert store.inserted[0]["due_at"] == due.isoformat()
    assert store.inserted[0]["floor_id"] == "first-floor"
