"""Destructive customer permission is fresh, explicit and department scoped."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from types import SimpleNamespace

import httpx
from fastapi import FastAPI, HTTPException
import pytest
from starlette.requests import Request
from starlette.responses import Response

import auth
from models import UserPublic
from routes import customer_routes, permissions_routes
from services import customer_delete_access as access


def actor(role="worker", **changes):
    return UserPublic(**{"id": "delete-worker", "email": "delete@example.invalid", "full_name": "Delete QA",
        "role": role, "floor_ids": ["first-floor", "ground-floor"], "active_floor_id": "ground-floor", **changes})


class Cursor:
    def __init__(self, docs):
        self.docs = docs

    async def to_list(self, _limit):
        return deepcopy(self.docs)


class Collection:
    def __init__(self, docs=()):
        self.docs = list(docs)

    async def find_one(self, query, *_args, **_kwargs):
        return next((deepcopy(row) for row in self.docs if all(row.get(key) == value for key, value in query.items())), None)

    def find(self, query, *_args, **_kwargs):
        return Cursor([row for row in self.docs if all(row.get(key) == value for key, value in query.items())])


def database(user, *, overrides=None, grants=()):
    return SimpleNamespace(users=Collection([user.model_dump()]), access_grants=Collection(grants), customers=Collection(),
        settings=Collection([{"key": "permission_matrix", "overrides": overrides or {}}]))


def grant(**changes):
    return {"id": "delete-grant", "user_id": "delete-worker", "resource": "customer_delete",
        "actions": ["view", "delete"], "floor_id": "ground-floor", "expires_at": None, **changes}


def denied(db, user, floor="ground-floor"):
    with pytest.raises(HTTPException) as error:
        asyncio.run(access.require_customer_delete(db, user, floor))
    assert error.value.status_code == 403


@pytest.mark.parametrize("role", ["worker", "warehouse", "sales", "manager", "admin"])
def test_no_nonowner_role_inherits_customer_delete_by_rank(role):
    user = actor(role)
    denied(database(user), user)


def test_owner_has_explicit_department_delete_without_ordinary_floor_assignments():
    user = actor("owner", floor_ids=[])
    db = database(user)
    for floor in ["first-floor", "ground-floor", "second-floor", "third-floor"]:
        asyncio.run(access.require_customer_delete(db, user, floor))
    denied(db, user, None)
    denied(db, user, "all")


@pytest.mark.parametrize("custom_access", [False, True])
def test_precise_account_grant_is_floor_scoped_and_does_not_need_role_permission(custom_access):
    user = actor(custom_access=custom_access)
    db = database(user, grants=[grant()])
    asyncio.run(access.require_customer_delete(db, user, "ground-floor"))
    denied(db, user, "first-floor")
    db.access_grants.docs = []
    denied(db, user)


@pytest.mark.parametrize("changes", [
    {"actions": ["view"]}, {"resource": "customers"}, {"user_id": "other-worker"}, {"floor_id": "first-floor"},
    {"expires_at": "2000-01-01T00:00:00+00:00"}, {"expires_at": "not-a-date"}, {"actions": ["*"]},
])
def test_page_access_expired_wrong_floor_and_invalid_grants_never_allow_delete(changes):
    user = actor("admin", custom_access=True)
    denied(database(user, grants=[grant(**changes)]), user)


def test_role_permission_requires_exact_true_and_cannot_widen_custom_accounts():
    user = actor("manager")
    db = database(user, overrides={"manager": {"delete-customers": True}})
    asyncio.run(access.require_customer_delete(db, user, "first-floor"))
    for value in [False, "true", 1, None]:
        db.settings.docs[0]["overrides"]["manager"]["delete-customers"] = value
        denied(db, user)
    db.settings.docs[0]["overrides"]["manager"]["delete-customers"] = True
    db.users.docs[0]["custom_access"] = True
    denied(db, user)
    assert user.custom_access is True, "The subsequent graph/stage checks see the fresh custom-account policy"
    db.access_grants.docs = [grant()]
    asyncio.run(access.require_customer_delete(db, user, "ground-floor"))


def test_cached_principal_cannot_keep_revoked_role_floor_profile_or_account_permission():
    user = actor("manager")
    db = database(user, overrides={"manager": {"delete-customers": True}})
    asyncio.run(access.require_customer_delete(db, user, "ground-floor"))
    db.users.docs[0]["role"] = "worker"
    denied(db, user)
    assert user.role == "worker"
    db.access_grants.docs = [grant()]
    asyncio.run(access.require_customer_delete(db, user, "ground-floor"))
    db.users.docs[0]["floor_ids"] = ["first-floor"]
    denied(db, user)
    db.users.docs[0]["floor_ids"] = ["ground-floor", "first-floor"]
    db.users.docs[0]["access_profile"] = "sanitary_quotations_followups"
    denied(db, user)
    db.users.docs[0]["access_profile"] = None
    db.users.docs[0]["delegation_grants"] = []
    denied(db, user)


@pytest.mark.parametrize("role", ["owner", "manager", "worker"])
@pytest.mark.parametrize("changes", [{"active": False}, {"deleted_at": "2026-11-16"}, {"is_deleted": True}, None])
def test_disabled_deleted_and_missing_accounts_are_denied_even_with_cached_owner(role, changes):
    user = actor(role)
    db = database(user, grants=[grant()], overrides={"manager": {"delete-customers": True}})
    if changes is None:
        db.users.docs.clear()
    else:
        db.users.docs[0].update(changes)
    denied(db, user)


def test_cached_owner_demotion_does_not_bypass_fresh_permission():
    user = actor("owner")
    db = database(user)
    db.users.docs[0]["role"] = "worker"
    denied(db, user)
    assert user.role == "worker"


def test_fresh_fields_do_not_discard_request_floor_restrictions():
    user = actor()
    db = database(user, grants=[grant()])
    object.__setattr__(user, "_module_floor_ids", ["first-floor"])
    denied(db, user)
    assert user.active_floor_id == "ground-floor"


def test_permission_status_is_fresh_no_store_and_default_matrix_has_delete_off(monkeypatch):
    user = actor("admin")
    db = database(user)
    monkeypatch.setattr(permissions_routes, "db", db)
    response = Response()
    assert asyncio.run(permissions_routes.customer_deletion_access(response, user)) == {"allowed": False}
    assert response.headers["Cache-Control"] == "no-store"
    db.access_grants.docs = [grant()]
    assert asyncio.run(permissions_routes.customer_deletion_access(Response(), user)) == {"allowed": True}
    db.access_grants.docs.clear()
    assert asyncio.run(permissions_routes.customer_deletion_access(Response(), user)) == {"allowed": False}
    matrix = asyncio.run(permissions_routes.get_permission_matrix(user))["matrix"]
    assert all(row["delete-customers"] is (role == "owner") for role, row in matrix.items())


def test_api_preview_and_delete_deny_undelegated_admin_and_require_confirmation(monkeypatch):
    async def run():
        user = actor("admin")
        db = database(user)
        monkeypatch.setattr(customer_routes, "db", db)
        app = FastAPI()
        app.dependency_overrides[auth.get_current_user] = lambda: user
        app.include_router(customer_routes.router, prefix="/api")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-qa") as http:
            assert (await http.get("/api/customers/customer-one/deletion-preview")).status_code == 403
            assert (await http.delete("/api/customers/customer-one?confirmation=forged")).status_code == 403
            db.access_grants.docs = [grant()]
            missing = await http.delete("/api/customers/customer-one")
            assert missing.status_code == 409
            assert "Review" in missing.json()["detail"]
    asyncio.run(run())


def test_generic_deletion_api_cannot_preview_or_remove_customer_from_another_floor(monkeypatch):
    async def run():
        user = actor()
        db = database(user, grants=[grant()])
        async def foreign_customer(*_args, **_kwargs):
            return {"id": "customer-one", "floor_id": "first-floor"}
        monkeypatch.setattr(customer_routes, "db", db)
        monkeypatch.setattr(customer_routes, "get_floor_scoped_or_404", foreign_customer)
        app = FastAPI()
        app.dependency_overrides[auth.get_current_user] = lambda: user
        app.include_router(customer_routes.router, prefix="/api")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-qa") as http:
            assert (await http.get("/api/customers/customer-one/deletion-preview")).status_code == 404
            assert (await http.delete("/api/customers/customer-one?confirmation=reviewed")).status_code == 404
    asyncio.run(run())


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/customers/customer-one/deletion-preview"),
    ("DELETE", "/api/customers/customer-one"),
    ("GET", "/api/kitchen-customer-deletion/project-one"),
    ("DELETE", "/api/kitchen-customer-deletion/project-one"),
])
def test_direct_auth_dependency_requires_explicit_delete_instead_of_page_access(monkeypatch, method, path):
    user = actor(custom_access=True)
    db = database(user, grants=[grant(resource="customers", actions=["view", "delete"])])
    monkeypatch.setattr(auth, "db", db)
    request = Request({"type": "http", "method": method, "path": path, "headers": [], "query_string": b""})
    with pytest.raises(HTTPException) as error:
        asyncio.run(auth.authorize_staff_request(user, request))
    assert error.value.status_code == 403
