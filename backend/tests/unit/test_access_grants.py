from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from starlette.requests import Request
from starlette.responses import Response
from fastapi import HTTPException

from auth import require_min_role, require_roles
from models import UserPublic
from services.access_grants import (
    action_for_http_method, build_grant, grant_allows, grants_allow,
    is_expired, normalized_actions, resource_candidates_for_api_path, resource_for_api_path,
)


NOW = datetime(2026, 9, 1, tzinfo=timezone.utc)


def payment_view_grant(**overrides):
    grant = {
        "id": "g-1", "user_id": "worker-1", "resource": "payments",
        "actions": ["view"], "floor_id": "ground-floor", "expires_at": None,
    }
    grant.update(overrides)
    return grant


def test_get_only_payment_grant_allows_only_view_on_its_floor():
    grant = payment_view_grant()
    assert grant_allows(grant, user_id="worker-1", resource="payments", action="view", floor_id="ground-floor", now=NOW)
    assert not grant_allows(grant, user_id="worker-1", resource="payments", action="create", floor_id="ground-floor", now=NOW)
    assert not grant_allows(grant, user_id="worker-1", resource="payments", action="update", floor_id="ground-floor", now=NOW)
    assert not grant_allows(grant, user_id="worker-1", resource="payments", action="delete", floor_id="ground-floor", now=NOW)
    assert not grant_allows(grant, user_id="worker-1", resource="payments", action="export", floor_id="ground-floor", now=NOW)
    assert not grant_allows(grant, user_id="worker-1", resource="payments", action="view", floor_id="first-floor", now=NOW)


def test_invalid_and_expired_grants_fail_closed():
    assert not grants_allow([payment_view_grant(actions=["*"])], user_id="worker-1", resource="payments", action="view", floor_id="ground-floor", now=NOW)
    assert not grants_allow([payment_view_grant(resource="typo")], user_id="worker-1", resource="payments", action="view", floor_id="ground-floor", now=NOW)
    assert not grants_allow([payment_view_grant(expires_at="not-a-date")], user_id="worker-1", resource="payments", action="view", floor_id="ground-floor", now=NOW)
    assert not grants_allow([payment_view_grant(expires_at=(NOW - timedelta(seconds=1)).isoformat())], user_id="worker-1", resource="payments", action="view", floor_id="ground-floor", now=NOW)


def test_global_resource_grant_covers_all_floors_but_not_other_resources_or_users():
    grant = payment_view_grant(floor_id=None, actions=["view", "export"])
    assert grants_allow([grant], user_id="worker-1", resource="payments", action="export", floor_id="second-floor", now=NOW)
    assert not grants_allow([grant], user_id="worker-1", resource="catalog", action="view", floor_id="second-floor", now=NOW)
    assert not grants_allow([grant], user_id="worker-2", resource="payments", action="view", floor_id="second-floor", now=NOW)


def test_method_mapping_and_action_validation_are_explicit():
    assert action_for_http_method("GET") == "view"
    assert action_for_http_method("PATCH") == "update"
    assert action_for_http_method("OPTIONS") is None
    assert normalized_actions(["view", "view", "export"]) == ["view", "export"]
    assert normalized_actions([]) is None
    assert normalized_actions(["view", "anything"]) is None
    assert resource_for_api_path("/api/godown-stock") == "godown_stock"
    assert resource_for_api_path("/api/godown-stock/intakes") == "godown_stock"
    assert resource_candidates_for_api_path("/api/quotations", "ground-floor") == ("quotations", "tiles")
    assert resource_candidates_for_api_path("/api/quotations", "first-floor") == ("quotations",)


def test_build_grant_has_audit_fields_and_rejects_non_future_expiry():
    future = datetime.now(timezone.utc) + timedelta(days=1)
    grant = build_grant(
        user_id="worker-1", resource="payments", actions=["view"], floor_id="ground-floor",
        expires_at=future.isoformat(), actor_id="owner-1", actor_name="Owner",
    )
    assert grant["created_by"] == "owner-1"
    assert grant["updated_by_name"] == "Owner"
    assert grant["actions"] == ["view"]
    with pytest.raises(ValueError):
        build_grant(
            user_id="worker-1", resource="payments", actions=["view"], floor_id=None,
            expires_at=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat(), actor_id="owner-1", actor_name="Owner",
        )


def test_expiry_rejects_naive_timestamps():
    assert is_expired("2026-09-02T00:00:00", now=NOW)


@pytest.mark.asyncio
async def test_custom_access_middleware_allows_only_granted_floor_and_action(monkeypatch):
    """A direct API request cannot bypass the UI's read-only payment grant."""
    import server

    async def grants(*_args, **_kwargs):
        return [payment_view_grant()]

    monkeypatch.setattr(server, "decode_token", lambda _token: {
        "kind": "staff", "sub": "worker-1", "custom_access": True, "access_profile": None,
    })
    import auth
    async def principal(*_args, **_kwargs):
        return {"id": "worker-1", "email": "worker@example.com", "full_name": "Worker", "role": "worker",
                "floor_ids": ["ground-floor", "first-floor"], "custom_access": True}
    monkeypatch.setattr(auth, "decode_token", server.decode_token)
    monkeypatch.setattr(auth, "_load_active_principal", principal)
    monkeypatch.setattr(auth, "grants_for_user", grants)

    async def next_handler(_request):
        return Response(status_code=204)

    def request(method: str, floor: str) -> Request:
        return Request({
            "type": "http", "method": method, "path": "/api/payments/orders",
            "headers": [(b"authorization", b"Bearer test"), (b"x-floor-id", floor.encode())],
            "query_string": b"", "scheme": "http", "server": ("test", 80),
        })

    assert (await server.enforce_access_profile(request("GET", "ground-floor"), next_handler)).status_code == 204
    assert (await server.enforce_access_profile(request("PATCH", "ground-floor"), next_handler)).status_code == 403
    assert (await server.enforce_access_profile(request("GET", "first-floor"), next_handler)).status_code == 403


@pytest.mark.asyncio
async def test_custom_access_can_use_only_the_action_already_allowed_by_middleware():
    """A precise custom allocation may override the broad base-role gate.

    The preceding middleware test proves that the request is still limited to
    its explicitly granted resource/action/floor before either dependency is
    reached.
    """
    worker = UserPublic(email="worker@example.com", full_name="Worker", role="worker", custom_access=True)
    assert await require_min_role("admin")(worker) is worker
    assert await require_roles("owner", "admin")(worker) is worker

    standard_worker = UserPublic(email="standard@example.com", full_name="Standard Worker", role="worker")
    with pytest.raises(HTTPException):
        await require_min_role("admin")(standard_worker)
