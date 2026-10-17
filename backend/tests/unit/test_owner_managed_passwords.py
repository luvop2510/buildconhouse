"""Owner-managed staff credentials, legacy login compatibility and account removal."""
from copy import deepcopy
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from starlette.requests import Request

import auth
from models import ChangePasswordPayload, LoginPayload, TeamCreatePayload, TeamPasswordResetPayload, TeamUpdatePayload, UserPublic
from routes import auth_routes, misc_routes
from services.invite_service import ManualInviteService


PASSWORD = "Owner-selected-secret-2026"
NEW_PASSWORD = "Replacement-secret-2026"


def principal(role="owner", **kwargs):
    return UserPublic(id="actor", email="actor@example.com", full_name="Actor", role=role, **kwargs)


def member(**kwargs):
    return {"id": "member", "email": "member@example.com", "full_name": "Member", "role": "sales",
            "floor_ids": ["ground-floor"], "active": True, "password_hash": f"hash:{PASSWORD}", **kwargs}


class Users:
    def __init__(self, doc=None):
        self.docs = [deepcopy(doc)] if doc else []
        self.updates = []

    @staticmethod
    def matches(doc, query):
        return all((doc.get(key) != value["$ne"] if isinstance(value, dict) and "$ne" in value else
                    (key in doc) == value["$exists"] if isinstance(value, dict) and "$exists" in value else
                    doc.get(key) == value) for key, value in query.items())

    async def find_one(self, query, *_args):
        return next((deepcopy(doc) for doc in self.docs if self.matches(doc, query)), None)

    async def insert_one(self, doc):
        self.docs.append(deepcopy(doc))

    async def update_one(self, query, update):
        self.updates.append((deepcopy(query), deepcopy(update)))
        for doc in self.docs:
            if self.matches(doc, query):
                doc.update(deepcopy(update["$set"]))
                return SimpleNamespace(matched_count=1)
        return SimpleNamespace(matched_count=0)

    async def count_documents(self, query):
        return sum(self.matches(doc, query) for doc in self.docs)

    def find(self, query, *_args):
        docs = [deepcopy(doc) for doc in self.docs if self.matches(doc, query)]
        class Cursor:
            def sort(self, *_args):
                return self
            async def to_list(self, _limit):
                return [{key: value for key, value in doc.items() if key not in {"_id", "password_hash"}} for doc in docs]
        return Cursor()


@pytest.fixture
def setup(monkeypatch):
    users = Users(member())
    database = SimpleNamespace(users=users)
    events, revoked, reservations, issued_sessions = [], [], [], []
    async def log(**kwargs):
        events.append(kwargs)
    async def revoke(kind, subject):
        revoked.append((kind, subject))
    async def reserve(ip, identifier):
        reservations.append(identifier)
    async def clear(*_args):
        return None
    async def session(kind, subject, *_args, **_kwargs):
        issued_sessions.append((kind, subject))
        return "session-1"
    for routes in (misc_routes, auth_routes):
        monkeypatch.setattr(routes, "db", database)
        monkeypatch.setattr(routes, "log_event", log)
        monkeypatch.setattr(routes, "hash_password", lambda pw: f"hash:{pw}")
        monkeypatch.setattr(routes, "reserve_login_attempt", reserve)
        monkeypatch.setattr(routes, "clear_login_attempts", clear)
    monkeypatch.setattr(misc_routes, "revoke_all_sessions", revoke)
    monkeypatch.setattr(misc_routes, "get_invite_service", lambda: ManualInviteService())
    monkeypatch.setattr(auth_routes, "reserve_login_attempt", reserve)
    monkeypatch.setattr(auth_routes, "clear_login_attempts", clear)
    monkeypatch.setattr(auth_routes, "create_session", session)
    monkeypatch.setattr(auth_routes, "verify_password", lambda pw, encoded: encoded == f"hash:{pw}")
    return SimpleNamespace(users=users, events=events, revoked=revoked, reservations=reservations,
                           issued_sessions=issued_sessions)


def request(path="/api/auth/login", method="POST"):
    return Request({"type": "http", "method": method, "path": path, "headers": []})


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["admin", "manager", "sales", "purchase", "warehouse", "accounts", "worker"])
@pytest.mark.parametrize("custom", [False, True])
async def test_nonowners_cannot_manage_other_staff(setup, role, custom):
    user = principal(role, custom_access=custom)
    create = TeamCreatePayload(email="new@example.com", full_name="New", role="sales", floor_ids=["ground-floor"], password=PASSWORD)
    calls = [
        misc_routes.list_team(user),
        misc_routes.create_team_member(create, user),
        misc_routes.update_team_member("member", TeamUpdatePayload(full_name="Changed"), user),
        misc_routes.reset_team_member_password("member", user, TeamPasswordResetPayload(new_password=NEW_PASSWORD)),
        misc_routes.delete_team_member("member", user),
    ]
    for call in calls:
        with pytest.raises(HTTPException) as error:
            await call
        assert error.value.status_code == 403
    assert setup.users.updates == []
    assert setup.revoked == [] and setup.reservations == []


@pytest.mark.asyncio
@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/team", None),
    ("POST", "/api/team", {"email": "new@example.com", "full_name": "New", "role": "sales", "password": PASSWORD}),
    ("PATCH", "/api/team/member", {"full_name": "Changed"}),
    ("POST", "/api/team/member/reset-password", {"new_password": NEW_PASSWORD}),
    ("POST", "/api/team/member/password", None),
    ("DELETE", "/api/team/member", None),
])
async def test_http_dependencies_reject_custom_admin_management(setup, method, path, body):
    app = FastAPI()
    app.include_router(misc_routes.router, prefix="/api")
    app.include_router(auth_routes.router, prefix="/api")
    app.dependency_overrides[auth.get_current_user] = lambda: principal("admin", custom_access=True)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        result = await client.request(method, path, json=body)
    assert result.status_code == 403
    assert setup.users.updates == []


@pytest.mark.asyncio
async def test_created_member_uses_permanent_account_specific_credentials(setup):
    created = await misc_routes.create_team_member(TeamCreatePayload(email="new@example.com", login_id=" New   Staff ", full_name="New", role="sales", floor_ids=["ground-floor"], password=PASSWORD), principal())
    assert created["must_change_password"] is False
    assert created["temp_password_expires_at"] is None
    assert created["login_id"] == "New Staff" and created["login_id_key"] == "new staff"
    assert "password_hash" not in created
    response = await auth_routes.staff_login(LoginPayload(email=" NEW STAFF ", password=PASSWORD), request())
    assert response.user.id == created["id"]
    assert "password_encrypted" not in response.model_dump()["user"]
    assert "password_hash" not in response.model_dump()["user"]
    assert response.user.must_change_password is False
    assert setup.issued_sessions == [("staff", created["id"])]
    with pytest.raises(HTTPException) as error:
        await auth_routes.staff_login(LoginPayload(email="unknown@example.com", password=PASSWORD), request())
    assert error.value.status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["sales", "owner"])
async def test_legacy_staff_and_jk_owner_expiry_does_not_block_login(setup, role):
    setup.users.docs = [member(role=role, login_id_key="jk patel", login_id="JK PATEL", must_change_password=True, temp_password_expires_at="2000-01-01T00:00:00+00:00",
                              access_profile="obsolete-owner-profile" if role == "owner" else None)]
    response = await auth_routes.staff_login(LoginPayload(email="jk patel", password=PASSWORD), request())
    assert response.user.must_change_password is False
    assert response.user.temp_password_expires_at is None
    auth._enforce_password_change(setup.users.docs[0], request("/api/quotations"), kind="staff")


@pytest.mark.asyncio
async def test_existing_staff_session_normalizes_legacy_me_flags(monkeypatch):
    async def load(*_args, **_kwargs):
        return member(must_change_password=True, temp_password_expires_at="2000-01-01T00:00:00+00:00")
    monkeypatch.setattr(auth, "_load_active_principal", load)
    token = auth.create_token("member", "staff", {"session_id": "legacy-session"})
    user = await auth.get_current_user(request=request("/api/auth/me", "GET"), authorization=f"Bearer {token}", x_floor_id=None, dl=None)
    assert user.must_change_password is False and user.temp_password_expires_at is None


@pytest.mark.asyncio
@pytest.mark.parametrize("supplied", [True, False])
async def test_owner_reset_revokes_only_target_and_keeps_credential_permanent(setup, monkeypatch, supplied):
    monkeypatch.setattr(misc_routes, "generate_temp_password", lambda: NEW_PASSWORD)
    body = TeamPasswordResetPayload(new_password=NEW_PASSWORD) if supplied else None
    result = await misc_routes.reset_team_member_password("member", principal(), body)
    assert setup.revoked == [("staff", "member")]
    assert setup.users.docs[0]["password_hash"] == f"hash:{NEW_PASSWORD}"
    assert setup.users.docs[0]["must_change_password"] is False
    assert setup.users.docs[0]["temp_password_expires_at"] is None
    assert result["password"] == NEW_PASSWORD == result["temporary_password"]
    assert result["expires_at"] is None and "member can also change" in result["message"]
    assert "72 hours" not in result["message"]
    with pytest.raises(HTTPException):
        await auth_routes.staff_login(LoginPayload(email="member@example.com", password=PASSWORD), request())
    assert (await auth_routes.staff_login(LoginPayload(email="member@example.com", password=NEW_PASSWORD), request())).user.id == "member"


@pytest.mark.asyncio
async def test_owner_self_change_requires_current_password_and_revokes_other_sessions(setup, monkeypatch):
    setup.users.docs = [member(id="actor", role="owner")]
    revoked = []
    async def revoke(kind, subject, authorization):
        revoked.append((kind, subject, authorization))
    monkeypatch.setattr(auth_routes, "_revoke_other_sessions", revoke)
    with pytest.raises(HTTPException) as error:
        await auth_routes.staff_change_password(ChangePasswordPayload(current_password="incorrect", new_password=NEW_PASSWORD), request(), principal(), "Bearer owner-session")
    assert error.value.status_code == 401 and setup.users.updates == []
    result = await auth_routes.staff_change_password(ChangePasswordPayload(current_password=PASSWORD, new_password=NEW_PASSWORD), request(), principal(), "Bearer owner-session")
    assert result == {"changed": True}
    assert revoked == [("staff", "actor", "Bearer owner-session")]


@pytest.mark.asyncio
async def test_owner_delete_retains_history_identity_but_removes_login_and_grants(setup):
    setup.users.docs[0].update(custom_access=True, delegation_grants=[{"resource": "payments"}])
    assert await misc_routes.delete_team_member("member", principal()) == {"deleted": True}
    stored = setup.users.docs[0]
    assert stored["id"] == "member" and stored["full_name"] == "Member"
    assert stored["active"] is False and stored["deleted_at"]
    assert stored["delegation_grants"] == [] and stored["custom_access"] is False
    assert setup.revoked == [("staff", "member")]
    assert await misc_routes.list_team(principal()) == []
    with pytest.raises(HTTPException) as error:
        await auth_routes.staff_login(LoginPayload(email="member@example.com", password=PASSWORD), request())
    assert error.value.status_code == 403
    for call in [misc_routes.reset_team_member_password("member", principal()), misc_routes.update_team_member("member", TeamUpdatePayload(active=True), principal())]:
        with pytest.raises(HTTPException) as error:
            await call
        assert error.value.status_code == 404
    # Historical identities retain their address; recreate cannot take it over.
    with pytest.raises(HTTPException) as error:
        await misc_routes.create_team_member(TeamCreatePayload(email="member@example.com", full_name="Replacement", role="sales", floor_ids=["ground-floor"], password=PASSWORD), principal())
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_owner_cannot_delete_self_or_last_owner(setup):
    with pytest.raises(HTTPException) as error:
        await misc_routes.delete_team_member("actor", principal())
    assert error.value.status_code == 400
    setup.users.docs = [member(role="owner")]
    with pytest.raises(HTTPException) as error:
        await misc_routes.delete_team_member("member", principal())
    assert error.value.status_code == 400
    assert setup.users.updates == []


@pytest.mark.asyncio
async def test_username_uniqueness_and_clear_are_account_specific(setup):
    setup.users.docs[0].update(login_id="JK PATEL", login_id_key="jk patel")
    with pytest.raises(HTTPException) as error:
        await misc_routes.create_team_member(TeamCreatePayload(email="new@example.com", login_id=" ＪＫ   ＰＡＴＥＬ ", full_name="New", role="sales", floor_ids=["ground-floor"], password=PASSWORD), principal())
    assert error.value.status_code == 409
    result = await misc_routes.update_team_member("member", TeamUpdatePayload(login_id=" jk  patel "), principal())
    assert result["login_id_key"] == "jk patel"
    result = await misc_routes.update_team_member("member", TeamUpdatePayload(login_id=None), principal())
    assert result["login_id"] is None and result["login_id_key"] is None


@pytest.mark.asyncio
async def test_owner_keeps_all_functions_despite_legacy_restricted_fields():
    owner = principal(custom_access=True, access_profile="ground_payments_dispatches", floor_ids=["ground-floor"])
    object.__setattr__(owner, "_custom_grant_floor_ids", [])
    assert auth.accessible_floor_ids(owner) is None
    assert await auth.authorize_staff_request(owner, request("/api/team")) is owner
    effective = auth.apply_effective_floor_ids(owner)
    assert effective.custom_access is False and effective.access_profile is None and effective.floor_ids == []


def test_customer_temporary_password_policy_is_preserved():
    with pytest.raises(HTTPException) as error:
        auth._enforce_password_change({"must_change_password": True}, request("/api/portal/quotations"), kind="customer")
    assert error.value.detail == "password_change_required"


@pytest.mark.asyncio
async def test_disabling_member_revokes_all_sessions_before_reenable(setup):
    await misc_routes.update_team_member("member", TeamUpdatePayload(active=False), principal())
    assert setup.users.docs[0]["active"] is False
    assert setup.revoked == [("staff", "member")]
    await misc_routes.update_team_member("member", TeamUpdatePayload(active=True), principal())
    assert setup.revoked == [("staff", "member"), ("staff", "member")]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["delete", "disable", "demote"])
async def test_concurrent_owners_cannot_remove_each_other(setup, operation):
    import asyncio
    setup.users.docs = [member(id="owner-a", role="owner"), member(id="owner-b", role="owner")]
    def call(actor, target):
        owner = principal().model_copy(update={"id": actor})
        if operation == "delete":
            return misc_routes.delete_team_member(target, owner)
        patch = TeamUpdatePayload(active=False) if operation == "disable" else TeamUpdatePayload(role="sales")
        return misc_routes.update_team_member(target, patch, owner)
    results = await asyncio.gather(call("owner-a", "owner-b"), call("owner-b", "owner-a"), return_exceptions=True)
    assert all(isinstance(result, HTTPException) and result.status_code == 400 for result in results)
    assert all(doc["role"] == "owner" and doc["active"] for doc in setup.users.docs)
    assert setup.users.updates == [] and setup.revoked == []


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["delete", "disable", "demote", "password"])
async def test_conditional_account_write_rejects_concurrent_promotion(setup, monkeypatch, operation):
    original = setup.users.update_one
    async def concurrently_promote(query, update):
        setup.users.docs[0]["role"] = "owner"
        return await original(query, update)
    monkeypatch.setattr(setup.users, "update_one", concurrently_promote)
    if operation == "delete":
        call = misc_routes.delete_team_member("member", principal())
    elif operation == "password":
        call = misc_routes.reset_team_member_password("member", principal(), TeamPasswordResetPayload(new_password=NEW_PASSWORD))
    else:
        patch = TeamUpdatePayload(active=False) if operation == "disable" else TeamUpdatePayload(role="worker")
        call = misc_routes.update_team_member("member", patch, principal())
    with pytest.raises(HTTPException) as error:
        await call
    assert error.value.status_code == 409
    assert setup.users.docs[0]["role"] == "owner" and setup.users.docs[0]["active"]
    assert not setup.users.docs[0].get("deleted_at")
    assert setup.users.docs[0]["password_hash"] == f"hash:{PASSWORD}"
    assert setup.revoked == []


@pytest.mark.asyncio
async def test_inactive_owner_can_be_removed_without_affecting_active_owner(setup):
    setup.users.docs[0].update(role="owner", active=False)
    assert await misc_routes.delete_team_member("member", principal()) == {"deleted": True}


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["create", "update"])
async def test_username_index_race_returns_conflict(setup, monkeypatch, operation):
    from pymongo.errors import DuplicateKeyError
    async def collision(*_args):
        raise DuplicateKeyError("unique username")
    if operation == "create":
        monkeypatch.setattr(setup.users, "insert_one", collision)
        call = misc_routes.create_team_member(TeamCreatePayload(email="new@example.com", full_name="New", role="sales", floor_ids=["ground-floor"], password=PASSWORD, login_id="new-id"), principal())
    else:
        monkeypatch.setattr(setup.users, "update_one", collision)
        call = misc_routes.update_team_member("member", TeamUpdatePayload(login_id="new-id"), principal())
    with pytest.raises(HTTPException) as error:
        await call
    assert error.value.status_code == 409
    assert setup.revoked == []


@pytest.mark.asyncio
async def test_owner_reset_stores_bcrypt_hash_and_encrypted_copy_only_for_selected_account(setup, monkeypatch):
    setup.users.docs.append(member(id="other", email="other@example.com"))
    monkeypatch.setattr(misc_routes, "hash_password", auth.hash_password)
    await misc_routes.reset_team_member_password("member", principal(), TeamPasswordResetPayload(new_password=NEW_PASSWORD))
    selected, other = setup.users.docs
    assert selected["password_hash"] != NEW_PASSWORD
    assert auth.verify_password(NEW_PASSWORD, selected["password_hash"])
    assert not auth.verify_password(PASSWORD, selected["password_hash"])
    assert other["password_hash"] == f"hash:{PASSWORD}"
    assert setup.revoked == [("staff", "member")]


@pytest.mark.asyncio
async def test_owner_http_reset_accepts_selected_password_and_delete(setup):
    app = FastAPI()
    app.include_router(misc_routes.router, prefix="/api")
    app.dependency_overrides[auth.get_current_user] = lambda: principal()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/team/member/reset-password", json={"new_password": NEW_PASSWORD})
        assert response.status_code == 200
        assert response.json()["password"] == NEW_PASSWORD and response.json()["expires_at"] is None
        response = await client.delete("/api/team/member")
        assert response.status_code == 200 and response.json() == {"deleted": True}
    assert setup.revoked == [("staff", "member"), ("staff", "member")]


@pytest.mark.asyncio
async def test_empty_reset_request_still_generates_permanent_password(setup, monkeypatch):
    monkeypatch.setattr(misc_routes, "generate_temp_password", lambda: NEW_PASSWORD)
    app = FastAPI()
    app.include_router(misc_routes.router, prefix="/api")
    app.dependency_overrides[auth.get_current_user] = lambda: principal()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/team/member/reset-password")
    assert response.status_code == 200 and response.json()["password"] == NEW_PASSWORD


@pytest.mark.asyncio
async def test_owner_reset_invalidates_only_target_principal_cache(monkeypatch):
    calls = []
    class Sessions:
        async def update_many(self, query, update):
            calls.append((query, update))
            return SimpleNamespace(modified_count=3)
    monkeypatch.setattr(auth, "db", SimpleNamespace(user_sessions=Sessions()))
    monkeypatch.setattr(auth, "_principal_cache", {})
    auth._cache_principal("staff", "member", "session-one", member())
    auth._cache_principal("staff", "member", "session-two", member())
    auth._cache_principal("staff", "other", "session-other", member(id="other"))
    assert await auth.revoke_all_sessions("staff", "member") == 3
    assert auth._cached_principal("staff", "member", "session-one") is None
    assert auth._cached_principal("staff", "member", "session-two") is None
    assert auth._cached_principal("staff", "other", "session-other") is not None
    assert calls == [({"user_type": "staff", "user_id": "member", "revoked": {"$ne": True}}, {"$set": {"revoked": True}})]


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["owner", "admin", "manager", "sales", "purchase", "warehouse", "accounts", "worker"])
async def test_every_staff_role_can_change_own_password(setup, monkeypatch, role):
    from services.team_credentials import decrypt_password
    setup.users.docs = [member(id="actor", role=role)]
    revoked = []
    async def revoke(*args):
        revoked.append(args)
    monkeypatch.setattr(auth_routes, "_revoke_other_sessions", revoke)
    result = await auth_routes.staff_change_password(
        ChangePasswordPayload(current_password=PASSWORD, new_password=NEW_PASSWORD, confirm_password=NEW_PASSWORD),
        request(), principal(role), "Bearer own-session")
    assert result == {"changed": True}
    stored = setup.users.docs[0]
    assert stored["password_hash"] == f"hash:{NEW_PASSWORD}"
    assert decrypt_password(stored["password_encrypted"], "actor") == NEW_PASSWORD
    assert PASSWORD not in stored["password_encrypted"] and NEW_PASSWORD not in stored["password_encrypted"]
    assert revoked == [("staff", "actor", "Bearer own-session")]
    assert setup.events[-1]["event_type"] == "user.password_changed"
    assert NEW_PASSWORD not in repr(setup.events)


@pytest.mark.asyncio
async def test_owner_reveal_is_explicit_audited_and_excluded_from_other_reads(setup):
    from starlette.responses import Response
    from services.team_credentials import encrypt_password
    setup.users.docs[0]["password_encrypted"] = encrypt_password(PASSWORD, "member")
    response = Response()
    result = await misc_routes.view_team_member_password("member", response, request(), principal())
    assert result == {"password": PASSWORD, "reset_required": False}
    assert response.headers["Cache-Control"] == "no-store"
    listed = await misc_routes.list_team(principal())
    assert "password_encrypted" not in listed[0] and "password_hash" not in listed[0]
    assert setup.events[-1]["event_type"] == "user.password_viewed"
    assert PASSWORD not in repr(setup.events)


@pytest.mark.asyncio
async def test_owner_reveal_legacy_requires_reset_and_rejects_nonowner(setup):
    from starlette.responses import Response
    assert await misc_routes.view_team_member_password("member", Response(), request(), principal()) == {"password": None, "reset_required": True}
    with pytest.raises(HTTPException) as error:
        await misc_routes.view_team_member_password("member", Response(), request(), principal("admin", custom_access=True))
    assert error.value.status_code == 403
    await misc_routes.reset_team_member_password("member", principal(), TeamPasswordResetPayload(new_password=NEW_PASSWORD, confirm_password=NEW_PASSWORD))
    assert (await misc_routes.view_team_member_password("member", Response(), request(), principal()))["password"] == NEW_PASSWORD


@pytest.mark.asyncio
async def test_created_credentials_are_recoverable_without_leaking_ciphertext(setup):
    from starlette.responses import Response
    created = await misc_routes.create_team_member(TeamCreatePayload(email="new@example.com", full_name="New", role="sales", floor_ids=["ground-floor"], password=PASSWORD), principal())
    assert "password_encrypted" not in created
    assert (await misc_routes.view_team_member_password(created["id"], Response(), request(), principal()))["password"] == PASSWORD


def test_ciphertext_is_bound_to_member_and_authenticated():
    from services.team_credentials import decrypt_password, encrypt_password
    encrypted = encrypt_password(PASSWORD, "member")
    assert decrypt_password(encrypted, "member") == PASSWORD
    for value, user in [(encrypted, "other"), (encrypted[:-8] + "tampered", "member")]:
        with pytest.raises(HTTPException) as error:
            decrypt_password(value, user)
        assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_http_confirmation_mismatch_is_rejected_without_writes(setup):
    app = FastAPI()
    app.include_router(misc_routes.router, prefix="/api")
    app.include_router(auth_routes.router, prefix="/api")
    app.dependency_overrides[auth.get_current_user] = lambda: principal()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for path, body in [
            ("/api/auth/change-password", {"current_password": PASSWORD, "new_password": NEW_PASSWORD, "confirm_password": "mismatch"}),
            ("/api/team/member/reset-password", {"new_password": NEW_PASSWORD, "confirm_password": "mismatch"}),
        ]:
            result = await client.post(path, json=body)
            assert result.status_code == 422
    assert setup.users.updates == []


@pytest.mark.asyncio
async def test_self_change_rejects_password_reset_race(setup, monkeypatch):
    setup.users.docs = [member(id="actor")]
    original = setup.users.update_one
    async def concurrently_reset(query, update):
        setup.users.docs[0]["password_hash"] = "hash:concurrently-reset"
        return await original(query, update)
    monkeypatch.setattr(setup.users, "update_one", concurrently_reset)
    with pytest.raises(HTTPException) as error:
        await auth_routes.staff_change_password(ChangePasswordPayload(current_password=PASSWORD, new_password=NEW_PASSWORD), request(), principal("sales"))
    assert error.value.status_code == 409
    assert setup.users.docs[0]["password_hash"] == "hash:concurrently-reset"
    assert "password_encrypted" not in setup.users.docs[0]


@pytest.mark.asyncio
async def test_delegated_and_profile_members_may_change_only_own_credentials():
    from access_profiles import PROFILE_MODULES
    for profile in [None, *PROFILE_MODULES]:
        user = principal("sales", custom_access=True, access_profile=profile)
        assert await auth.authorize_staff_request(user, request("/api/auth/change-password")) is user
