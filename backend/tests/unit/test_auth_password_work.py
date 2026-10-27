"""Password work must preserve API responsiveness and conditional credentials."""
from types import SimpleNamespace
import threading

from fastapi import HTTPException
import pytest
from starlette.requests import Request

from routes import auth_routes
from routes import customer_routes, misc_routes
from models import CustomerCreate, TeamCreatePayload, TeamPasswordResetPayload, UserPublic


@pytest.fixture
def setup(monkeypatch):
    class Collection:
        async def find_one(self, *_args):
            return {"id": "member", "password_hash": "old-hash"}

        async def update_one(self, query, update):
            return SimpleNamespace(matched_count=1)

    async def noop(*_args, **_kwargs):
        pass

    monkeypatch.setattr(auth_routes, "db", SimpleNamespace(users=Collection(), customers=Collection()))
    for name in ("reserve_login_attempt", "clear_login_attempts", "_revoke_other_sessions", "log_event"):
        monkeypatch.setattr(auth_routes, name, noop)
    return Request({"type": "http", "client": ("203.0.113.1", 1234), "headers": []})


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["staff_login", "customer_login", "staff_change_password", "customer_change_password", "_mfa_password"])
async def test_password_comparisons_leave_the_event_loop(setup, monkeypatch, operation):
    threads = []

    def compare(*_args):
        threads.append(threading.get_ident())
        return False

    monkeypatch.setattr(auth_routes, "verify_password", compare)
    body = SimpleNamespace(email="member@example.com", password="ordinary-guess", current_password="ordinary-guess")
    arguments = [body, setup]
    if operation not in ("staff_login", "customer_login"):
        arguments.append(SimpleNamespace(id="member"))
    with pytest.raises(HTTPException) as error:
        await getattr(auth_routes, operation)(*arguments)
    assert error.value.status_code == 401
    assert len(threads) == 1 and threads[0] != threading.get_ident()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["staff", "customer"])
async def test_password_hashing_leaves_the_event_loop(setup, monkeypatch, kind):
    threads = []

    def hash_password(*_args):
        threads.append(threading.get_ident())
        return "new-hash"

    monkeypatch.setattr(auth_routes, "verify_password", lambda *_args: True)
    monkeypatch.setattr(auth_routes, "hash_password", hash_password)
    body = SimpleNamespace(current_password="previous-password", new_password="replacement-password")
    result = await getattr(auth_routes, f"{kind}_change_password")(
        body, setup, SimpleNamespace(id="member"), None)
    assert result == {"changed": True}
    assert len(threads) == 1 and threads[0] != threading.get_ident()


@pytest.mark.asyncio
async def test_customer_password_change_does_not_overwrite_concurrent_reset(setup, monkeypatch):
    updates = []

    async def changed(query, update):
        updates.append(query)
        # A concurrent reset changed the password since the initial proof.
        return SimpleNamespace(matched_count=int(query.get("password_hash") != "old-hash"))

    monkeypatch.setattr(auth_routes.db.customers, "update_one", changed)
    monkeypatch.setattr(auth_routes, "verify_password", lambda *_args: True)
    monkeypatch.setattr(auth_routes, "hash_password", lambda *_args: "new-hash")
    body = SimpleNamespace(current_password="previous-password", new_password="replacement-password")
    with pytest.raises(HTTPException) as error:
        await auth_routes.customer_change_password(body, setup, SimpleNamespace(id="member"), None)
    assert error.value.status_code == 409
    assert updates == [{"id": "member", "password_hash": "old-hash"}]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["customer_create", "customer_invite", "team_create", "team_reset"])
async def test_account_administration_password_work_leaves_the_event_loop(monkeypatch, operation):
    threads = []

    class WorkReached(Exception):
        pass

    def hash_password(_password):
        threads.append(threading.get_ident())
        raise WorkReached()

    class Collection:
        async def find_one(self, query, *_args):
            # The real customer read includes the concrete floor predicate.
            # Match the id inside that conjunction without removing scoping.
            if query.get("id") == "member" or any(part.get("id") == "member" for part in query.get("$and", [])):
                return {"id": "member", "email": "member@example.com", "portal_enabled": True, "role": "sales"}
            return None

        async def update_one(self, *_args):
            raise AssertionError("Password hashing must run before the credential write")

    database = SimpleNamespace(users=Collection(), customers=Collection())
    for module in (customer_routes, misc_routes):
        monkeypatch.setattr(module, "db", database)
        monkeypatch.setattr(module, "hash_password", hash_password)
    owner = UserPublic(id="owner", full_name="Owner", role="owner")
    if operation == "customer_create":
        call = customer_routes.create_customer(CustomerCreate(name="Customer", password="secret-password"), owner)
    elif operation == "customer_invite":
        call = customer_routes._issue_temp_password("member", kind="customer_invite", user=owner)
    elif operation == "team_create":
        call = misc_routes.create_team_member(TeamCreatePayload(email="new@example.com", full_name="New", role="sales", floor_ids=["first-floor"], password="secret-password"), owner)
    else:
        call = misc_routes.reset_team_member_password("member", owner, TeamPasswordResetPayload(new_password="secret-password"))
    with pytest.raises(WorkReached):
        await call
    assert len(threads) == 1 and threads[0] != threading.get_ident()


@pytest.mark.asyncio
async def test_periodic_demo_credential_check_leaves_the_event_loop(monkeypatch):
    import bootstrap
    threads = []

    class Collection:
        def find(self, *_args):
            return self

        async def to_list(self, _limit):
            return [{"email": "owner@example.test", "password_hash": "old-hash"}]

    def compare(*_args):
        threads.append(threading.get_ident())
        return True

    monkeypatch.setattr(bootstrap.bcrypt, "checkpw", compare)
    assert await bootstrap._check_demo_accounts(SimpleNamespace(users=Collection())) == ["owner@example.test"]
    assert len(threads) == 1 and threads[0] != threading.get_ident()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["staff", "customer"])
@pytest.mark.parametrize("change", ["password_reset", "disabled", "deleted", "permissions"])
async def test_login_rechecks_identity_after_held_password_proof(monkeypatch, kind, change):
    import asyncio
    from copy import deepcopy

    started, release = threading.Event(), threading.Event()
    principal = {"id": "principal", "password_hash": "proved-hash", "email": "member@example.com",
                 "full_name": "Member", "name": "Customer", "role": "sales", "active": True,
                 "portal_enabled": True, "floor_ids": ["first-floor"], "floor_id": "first-floor"}
    sessions, tokens = [], []

    class Principals:
        async def find_one(self, query, *_args):
            return deepcopy(principal) if all(principal.get(key) == value for key, value in query.items()) else None

    class Sessions:
        async def update_one(self, query, update):
            for row in sessions:
                if all(row.get(key) == value for key, value in query.items()):
                    row.update(update["$set"])
            return SimpleNamespace(matched_count=1)

    def compare(_password, password_hash):
        assert password_hash == "proved-hash"
        started.set()
        assert release.wait(5), "test did not release held password proof"
        return True

    async def create_session(user_type, user_id, _request, **_kwargs):
        sessions.append({"id": "issued", "user_type": user_type, "user_id": user_id, "revoked": False})
        return "issued"

    def create_token(_user_id, user_type, claims):
        tokens.append({"kind": user_type, **claims})
        return "inert-test-token"

    async def noop(*_args, **_kwargs): pass

    monkeypatch.setattr(auth_routes, "db", SimpleNamespace(users=Principals(), customers=Principals(), user_sessions=Sessions()))
    monkeypatch.setattr(auth_routes, "verify_password", compare)
    monkeypatch.setattr(auth_routes, "create_session", create_session)
    monkeypatch.setattr(auth_routes, "create_token", create_token)
    for name in ("reserve_login_attempt", "clear_login_attempts", "log_event"):
        monkeypatch.setattr(auth_routes, name, noop)
    body = SimpleNamespace(email="member@example.com", password="old-ordinary-password", mfa_code=None, recovery_code=None)
    request = Request({"type": "http", "client": ("203.0.113.1", 1234), "headers": []})
    login = asyncio.create_task(getattr(auth_routes, f"{kind}_login")(body, request))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        if change == "password_reset":
            principal["password_hash"] = "reset-hash"
            # A completed reset revokes the sessions that exist at that instant.
            for session in sessions: session["revoked"] = True
        elif change == "disabled":
            principal["active" if kind == "staff" else "portal_enabled"] = False
        elif change == "deleted":
            principal["deleted_at"] = "2026-10-16T00:00:00Z"
        else:
            principal.update(role="worker", floor_ids=["ground-floor"], floor_id="ground-floor")
    finally:
        release.set()
    if change == "permissions":
        response = await login
        assert len(tokens) == 1 and sessions[0]["revoked"] is False
        if kind == "staff":
            assert response.user.role == "worker" and response.user.floor_ids == ["ground-floor"]
            assert tokens[0]["role"] == "worker"
        else:
            assert response.customer.floor_id == "ground-floor"
    else:
        with pytest.raises(HTTPException) as error:
            await login
        assert error.value.status_code in {401, 403}
        assert tokens == []
        assert len(sessions) == 1 and sessions[0]["revoked"] is True


@pytest.mark.asyncio
async def test_staff_login_rejects_changed_mfa_after_factor_consumption(monkeypatch):
    from copy import deepcopy
    principal = {"id": "principal", "password_hash": "proved-hash", "email": "member@example.com",
                 "full_name": "Member", "role": "sales", "active": True,
                 "mfa_enabled": True, "mfa_version": 1}
    writes = []
    class Principals:
        async def find_one(self, *_args): return deepcopy(principal)
    class Sessions:
        async def update_one(self, query, update): writes.append((query, update))
    async def consume(*_args): principal["mfa_version"] = 2
    async def create(*_args, **_kwargs): return "issued"
    async def noop(*_args, **_kwargs): pass
    monkeypatch.setattr(auth_routes, "db", SimpleNamespace(users=Principals(), user_sessions=Sessions()))
    monkeypatch.setattr(auth_routes, "verify_password", lambda *_args: True)
    monkeypatch.setattr(auth_routes.mfa, "consume_factor", consume)
    monkeypatch.setattr(auth_routes, "create_session", create)
    for name in ("reserve_login_attempt", "clear_login_attempts", "log_event"):
        monkeypatch.setattr(auth_routes, name, noop)
    monkeypatch.setattr(auth_routes, "create_token", lambda *_args: pytest.fail("Stale MFA proof cannot issue a token"))
    body = SimpleNamespace(email="member@example.com", password="ordinary-password", mfa_code="123456", recovery_code=None)
    request = Request({"type": "http", "client": ("203.0.113.1", 1234), "headers": []})
    with pytest.raises(HTTPException) as error:
        await auth_routes.staff_login(body, request)
    assert error.value.status_code == 401
    assert writes[-1] == ({"id": "issued", "user_type": "staff", "user_id": "principal"}, {"$set": {"revoked": True}})
