"""P0 staff provisioning guardrails: profile roles and zero-floor deny-all."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from auth import (
    accessible_floor_ids,
    floor_for_write,
    floor_query,
    floor_scope_ids,
    normalize_staff_access,
)
from models import UserPublic
from models import TeamCreatePayload, TeamUpdatePayload
from routes import misc_routes


def _staff(*, floors: list[str], active: str | None = None) -> UserPublic:
    return UserPublic(
        id="staff-1", email="staff@example.com", full_name="Staff",
        role="sales", floor_ids=floors, active_floor_id=active,
    )


def test_zero_floor_staff_is_deny_all_and_never_defaults_to_sanitary():
    user = _staff(floors=[])

    assert accessible_floor_ids(user) == []
    assert floor_scope_ids(user) == []
    assert floor_query(user) == {"floor_id": {"$in": []}}
    with pytest.raises(HTTPException, match="No floor access"):
        floor_for_write(user)


def test_zero_floor_staff_cannot_bypass_with_an_active_floor_selection():
    user = _staff(floors=[], active="first-floor")

    assert floor_scope_ids(user) == []
    assert floor_query(user, {"id": "q-1"}) == {
        "$and": [{"floor_id": {"$in": []}}, {"id": "q-1"}],
    }


@pytest.mark.parametrize(
    ("profile", "input_role", "expected_role", "floor"),
    [
        ("ground_tile_quotations_followups", "worker", "sales", "ground-floor"),
        ("ground_payments_dispatches", "worker", "accounts", "ground-floor"),
        ("sanitary_quotations_followups", "worker", "sales", "first-floor"),
        ("sanitary_purchases", "worker", "purchase", "first-floor"),
    ],
)
def test_profiles_pin_their_floor_and_raise_role_to_the_required_minimum(profile, input_role, expected_role, floor):
    role, floors = normalize_staff_access(
        role=input_role, floor_ids=["second-floor"], access_profile=profile,
    )

    assert role == expected_role
    assert floors == [floor]


def test_non_manager_without_profile_must_receive_at_least_one_floor():
    with pytest.raises(HTTPException, match="Assign at least one floor"):
        normalize_staff_access(role="sales", floor_ids=[], access_profile=None)


def test_manager_may_remain_all_floor_without_an_explicit_assignment():
    assert normalize_staff_access(role="manager", floor_ids=[], access_profile=None) == ("manager", [])


def test_unknown_legacy_profile_fails_closed():
    user = _staff(floors=["ground-floor"])
    user.access_profile = "obsolete-profile"  # malformed persisted legacy row
    assert accessible_floor_ids(user) == []


def test_team_create_rejects_an_unassigned_non_manager_before_writing(monkeypatch):
    class Users:
        async def find_one(self, *_args, **_kwargs):
            return None

    monkeypatch.setattr(misc_routes, "db", SimpleNamespace(users=Users()))
    admin = UserPublic(email="owner@example.com", full_name="Owner", role="owner")
    body = TeamCreatePayload(
        email="new@example.com", full_name="New Staff", role="sales", password="sufficiently-long-password", floor_ids=[],
    )

    with pytest.raises(HTTPException, match="Assign at least one floor"):
        asyncio.run(misc_routes.create_team_member(body, admin))


def test_clearing_a_profile_preserves_valid_floor_access_and_revokes_stale_session(monkeypatch):
    before = {
        "id": "staff-1", "email": "staff@example.com", "full_name": "Staff", "role": "sales",
        "floor_ids": ["ground-floor"], "access_profile": "ground_tile_quotations_followups", "active": True,
    }
    stored = before.copy()

    class Users:
        async def find_one(self, *_args, **_kwargs):
            return stored.copy()

        async def count_documents(self, *_args, **_kwargs):
            return 1

        async def update_one(self, _query, update):
            stored.update(update["$set"])
            return SimpleNamespace(matched_count=1)

    revoked: list[str] = []
    events: list[str] = []

    async def revoke(_kind, user_id):
        revoked.append(user_id)

    async def log_event(**kwargs):
        events.append(kwargs["event_type"])

    monkeypatch.setattr(misc_routes, "db", SimpleNamespace(users=Users()))
    monkeypatch.setattr(misc_routes, "revoke_all_sessions", revoke)
    monkeypatch.setattr(misc_routes, "log_event", log_event)
    admin = UserPublic(email="owner@example.com", full_name="Owner", role="owner")

    result = asyncio.run(misc_routes.update_team_member("staff-1", TeamUpdatePayload(access_profile=None), admin))

    assert result["access_profile"] is None
    assert result["floor_ids"] == ["ground-floor"]
    assert revoked == ["staff-1"]
    assert events == ["user.access_profile_changed"]


def test_deactivating_staff_revokes_sessions(monkeypatch):
    stored = {
        "id": "staff-1", "email": "staff@example.com", "full_name": "Staff", "role": "worker",
        "floor_ids": ["second-floor"], "custom_access": True, "active": True,
    }

    class Users:
        async def find_one(self, *_args, **_kwargs):
            return stored.copy()

        async def update_one(self, _query, update):
            stored.update(update["$set"])
            return SimpleNamespace(matched_count=1)

    revoked: list[tuple[str, str]] = []
    async def revoke(kind, user_id):
        revoked.append((kind, user_id))
    async def log_event(**_kwargs):
        pass

    monkeypatch.setattr(misc_routes, "db", SimpleNamespace(users=Users()))
    monkeypatch.setattr(misc_routes, "revoke_all_sessions", revoke)
    monkeypatch.setattr(misc_routes, "invalidate_principal_cache", lambda *_args: None)
    monkeypatch.setattr(misc_routes, "log_event", log_event)
    admin = UserPublic(email="owner@example.com", full_name="Owner", role="owner")

    asyncio.run(misc_routes.update_team_member("staff-1", TeamUpdatePayload(active=False), admin))

    assert stored["active"] is False
    assert revoked == [("staff", "staff-1")]
