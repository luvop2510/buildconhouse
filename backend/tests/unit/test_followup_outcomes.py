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
            "customer_name": "Client", "category": "sales", "assigned_to": "selected-worker", "assigned_to_name": "Selected worker", "due_at": "2026-01-01T00:00:00+00:00",
        }
        self.updated: dict | None = None
        self.inserted: list[dict] = []

    async def find_one(self, *_args, **_kwargs):
        return {**self.row, **(self.updated or {})}

    async def update_one(self, _query, patch, **_kwargs):
        self.updated = patch["$set"]

    async def insert_one(self, row):
        self.inserted.append(row)


class _UserCursor:
    def sort(self, *_args):
        return self

    async def to_list(self, _limit):
        return [{"id": uid, "full_name": name, "active": True, "role": "sales", "floor_ids": ["first-floor"]}
                for uid, name in [("selected-worker", "Selected worker"), ("receiving-salesperson", "Receiving salesperson")]]


class _Users:
    def find(self, *_args):
        return _UserCursor()

    async def find_one(self, *_args, **_kwargs):
        return None


def _install(monkeypatch):
    store = _Followups()
    monkeypatch.setattr(followups, "db", type("Db", (), {"followups": store, "users": _Users()})())
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
        "followup-1", FollowupCallOutcomePayload(outcome="pending", next_followup_at=due), _user(),
    ))
    assert store.updated["completed_outcome"] == "pending"
    assert store.inserted[0]["due_at"] == due.isoformat()
    assert store.inserted[0]["floor_id"] == "first-floor"


def test_transferred_customer_interest_belongs_to_recipient_without_winning(monkeypatch):
    store = _install(monkeypatch)
    store.row.update(assigned_to="receiving-salesperson", assigned_to_name="Receiving salesperson", notes="Historical note")
    asyncio.run(followups.log_call("followup-1", FollowupCallOutcomePayload(outcome="interested"), _user()))
    assert store.updated["assigned_to"] == "receiving-salesperson"
    assert store.updated["completed_outcome"] == "interested"
    assert not store.updated.get("auto_resolved")
    assert store.inserted[0]["assigned_to"] == "receiving-salesperson"
    assert store.inserted[0]["status"] == "open"
    assert "notes" not in store.updated
    assert store.inserted[0]["notes"] is None


def test_cannot_afford_loss_reason_records_lost_without_successor(monkeypatch):
    store = _install(monkeypatch)
    asyncio.run(followups.log_call("followup-1", FollowupCallOutcomePayload(outcome="lost", notes="  Cannot afford the service  "), _user()))
    assert store.updated["completed_outcome"] == "lost"
    assert store.updated["lost_reason"] == store.updated["notes"] == "Cannot afford the service"
    assert store.inserted == []


def test_rejected_customer_is_lost_with_required_reason(monkeypatch):
    store = _install(monkeypatch)
    asyncio.run(followups.log_call("followup-1", FollowupCallOutcomePayload(outcome="rejected", notes="We cannot work with the requested scope"), _user()))
    assert store.updated["completed_outcome"] == "lost"
    assert store.updated["notes"] == "We cannot work with the requested scope"
    assert store.inserted == []
