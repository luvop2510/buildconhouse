"""Account allocations cannot bypass the owner's team administration policy."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from access_profiles import PROFILE_MODULES, profile_allows_request
from models import UserPublic
from routes import access_grants_routes as routes
from services.access_grants import is_common_access_request


@pytest.mark.parametrize("role", ["admin", "manager", "sales", "purchase", "accounts", "warehouse", "worker"])
@pytest.mark.parametrize("custom", [False, True])
@pytest.mark.asyncio
async def test_nonowners_cannot_manage_allocations_even_with_custom_grants(monkeypatch, role, custom):
    actor = UserPublic(id="staff", email="staff@example.com", full_name="Staff", role=role, custom_access=custom)
    # No database surface is available: rejection must precede all account reads.
    monkeypatch.setattr(routes, "db", SimpleNamespace())
    allocation = routes.AccessGrantInput(resource="payments", floor_id="first-floor", actions=["view"])
    operations = [
        lambda: routes.list_grant_resources(actor),
        lambda: routes.list_access_grants("target", actor),
        lambda: routes.replace_access_grants("target", routes.DelegationInput(floor_ids=[], grants=[]), actor),
        lambda: routes.create_access_grant("target", allocation, actor),
        lambda: routes.delete_access_grant("target", "grant", actor),
    ]
    for operation in operations:
        with pytest.raises(HTTPException) as exc:
            await operation()
        assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_deleted_account_cannot_receive_new_allocations(monkeypatch):
    class Users:
        async def find_one(self, *_args):
            return {"id": "deleted", "role": "worker", "deleted_at": "2026-10-11T00:00:00Z"}
    monkeypatch.setattr(routes, "db", SimpleNamespace(users=Users()))
    with pytest.raises(HTTPException) as exc:
        await routes._target_user_or_404("deleted")
    assert exc.value.status_code == 404


def test_staff_password_changes_are_post_only_personal_account_exemption():
    for method in ["GET", "POST", "PUT", "PATCH", "DELETE"]:
        assert is_common_access_request(method, "/api/auth/change-password") is (method == "POST")
        for profile in PROFILE_MODULES:
            assert profile_allows_request(profile, method, "/api/auth/change-password") is (method == "POST")
