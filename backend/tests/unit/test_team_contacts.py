"""Team contact changes must preserve authentication and authorization."""
from copy import deepcopy
import importlib
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError, OperationFailure

import auth
from models import LoginPayload, TeamCreatePayload, TeamUpdatePayload, UserPublic
from routes import auth_routes, misc_routes
from tests.unit.test_owner_managed_passwords import PASSWORD, member, principal, request, setup as _owner_setup_fixture

setup = _owner_setup_fixture


@pytest.mark.parametrize("field", ["phone", "mobile"])
@pytest.mark.parametrize("value", ["123", "1234567890123456", "number", "123+456789", "١٢٣٤٥٦٧٨٩٠", 9909906652, {"number": "9909906652"}, ["9909906652"]])
def test_invalid_contact_writes_are_validation_errors(field, value):
    with pytest.raises(ValidationError):
        TeamUpdatePayload(**{field: value})
    with pytest.raises(ValidationError):
        TeamCreatePayload(full_name="Staff", role="worker", password=PASSWORD, login_id="staff", **{field: value})


@pytest.mark.parametrize("field", ["phone", "mobile"])
@pytest.mark.parametrize("value,expected", [(None, None), ("", None), ("   ", None), (" +91 (99099) 06652 ", "+91 (99099) 06652"), ("079-1234567", "079-1234567")])
def test_phone_validation_preserves_valid_format_and_clears_blanks(field, value, expected):
    assert getattr(TeamUpdatePayload(**{field: value}), field) == expected


@pytest.mark.parametrize("value", [9909906652, 9909906652.0, "9909906652"])
def test_legacy_numeric_contacts_hydrate_as_text(value):
    user = UserPublic(**member(phone=value, mobile=value))
    assert user.phone == user.mobile == "9909906652"


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["owner", "sales", "worker"])
async def test_contact_edit_keeps_sessions_roles_and_password_valid(setup, role, monkeypatch):
    setup.users.docs = [member(role=role, floor_ids=[], login_id="JK PATEL", login_id_key="jk patel")]
    invalidated = []
    monkeypatch.setattr(misc_routes, "invalidate_principal_cache", lambda *args: invalidated.append(args))
    before = deepcopy(setup.users.docs[0])
    result = await misc_routes.update_team_member("member", TeamUpdatePayload(phone="+91 99099 06652", mobile="9909906652", email=" Added@Example.com "), principal())
    assert result["email"] == "added@example.com"
    assert result["phone"] == "+91 99099 06652" and result["mobile"] == "9909906652"
    assert setup.revoked == []
    assert invalidated == [("staff", "member")]
    for field in ["role", "floor_ids", "password_hash"]:
        assert setup.users.docs[0][field] == before[field]
    assert set(setup.users.updates[0][1]["$set"]) == {"email", "phone", "mobile", "updated_at", "contact_email_added"}
    for identifier in ["jk patel", "added@example.com"]:
        response = await auth_routes.staff_login(LoginPayload(email=identifier, password=PASSWORD), request())
        assert response.user.id == "member"
    assert (await misc_routes.list_team(principal()))[0]["mobile"] == "9909906652"


@pytest.mark.asyncio
async def test_clearing_contact_fields_keeps_username_login_and_rejects_last_identity_removal(setup):
    setup.users.docs[0].update(login_id="JK", login_id_key="jk", phone="9909906652", mobile="9909906652")
    result = await misc_routes.update_team_member("member", TeamUpdatePayload(phone=None, mobile=" ", email=""), principal())
    assert result["phone"] is None and result["mobile"] is None and result["email"] is None
    assert (await auth_routes.staff_login(LoginPayload(email="JK", password=PASSWORD), request())).user.email is None
    before = deepcopy(setup.users.docs[0])
    with pytest.raises(HTTPException) as error:
        await misc_routes.update_team_member("member", TeamUpdatePayload(login_id=None), principal())
    assert error.value.status_code == 422 and setup.users.docs[0] == before


@pytest.mark.asyncio
async def test_duplicate_email_edits_reject_before_writing_and_remain_loginable(setup):
    setup.users.docs.append(member(id="other", email="taken@example.com"))
    with pytest.raises(HTTPException) as error:
        await misc_routes.update_team_member("member", TeamUpdatePayload(email=" TAKEN@example.com "), principal())
    assert error.value.status_code == 409 and setup.users.updates == []
    assert (await auth_routes.staff_login(LoginPayload(email="member@example.com", password=PASSWORD), request())).user.id == "member"


@pytest.mark.asyncio
async def test_concurrent_identity_changes_fail_without_removing_last_sign_in(setup, monkeypatch):
    setup.users.docs[0].update(login_id="JK", login_id_key="jk")
    original_write = misc_routes._write_team_patch
    async def raced_write(target, patch):
        setup.users.docs[0].update(login_id=None, login_id_key=None)
        await original_write(target, patch)
    monkeypatch.setattr(misc_routes, "_write_team_patch", raced_write)
    with pytest.raises(HTTPException) as error:
        await misc_routes.update_team_member("member", TeamUpdatePayload(email=None), principal())
    assert error.value.status_code == 409
    assert setup.users.docs[0]["email"] == "member@example.com"


@pytest.mark.asyncio
async def test_username_only_creation_login_and_team_reload(setup):
    for login_id in ["new-one", "new-two"]:
        result = await misc_routes.create_team_member(TeamCreatePayload(login_id=login_id, full_name="New", role="worker", custom_access=True, password=PASSWORD, mobile="9909906652"), principal())
        assert result["email"] is None and result["mobile"] == "9909906652"
        assert (await auth_routes.staff_login(LoginPayload(email=login_id, password=PASSWORD), request())).user.id == result["id"]
    assert len(await misc_routes.list_team(principal())) == 3
    with pytest.raises(HTTPException) as error:
        await misc_routes.create_team_member(TeamCreatePayload(full_name="No identity", role="worker", password=PASSWORD), principal())
    assert error.value.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("phone,mobile", [(9909906652, 9909906652.0), ({"old": "invalid"}, ["invalid"])])
async def test_legacy_contacts_never_crash_login_or_authenticated_hydration(setup, monkeypatch, phone, mobile):
    setup.users.docs[0].update(phone=phone, mobile=mobile)
    response = await auth_routes.staff_login(LoginPayload(email="member@example.com", password=PASSWORD), request())
    async def load(*_args, **_kwargs):
        return deepcopy(setup.users.docs[0])
    monkeypatch.setattr(auth, "_load_active_principal", load)
    current = await auth.get_current_user(request=request("/api/auth/me", "GET"), authorization=f"Bearer {response.access_token}", x_floor_id=None, dl=None)
    assert current.id == "member"
    assert current.phone == response.user.phone and current.mobile == response.user.mobile
    listed = (await misc_routes.list_team(principal()))[0]
    assert listed["phone"] == current.phone and listed["mobile"] == current.mobile


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [{"phone": "abc"}, {"mobile": "123"}, {"email": "invalid"}])
async def test_http_contact_validation_never_mutates_account_or_breaks_next_login(setup, body):
    app = FastAPI()
    app.include_router(misc_routes.router, prefix="/api")
    app.include_router(auth_routes.router, prefix="/api")
    app.dependency_overrides[auth.require_owner] = principal
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.patch("/api/team/member", json=body)
        assert response.status_code == 422 and isinstance(response.json()["detail"], list)
        login = await client.post("/api/auth/login", json={"email": "member@example.com", "password": PASSWORD})
        assert login.status_code == 200 and login.json()["user"]["id"] == "member"
    assert setup.users.updates == []


@pytest.mark.asyncio
async def test_index_race_returns_conflict_without_revoking_sessions(setup, monkeypatch):
    async def write(*_args):
        raise DuplicateKeyError("duplicate email")
    monkeypatch.setattr(misc_routes, "_write_team_patch", write)
    with pytest.raises(HTTPException) as error:
        await misc_routes.update_team_member("member", TeamUpdatePayload(email="unique@example.com"), principal())
    assert error.value.status_code == 409 and setup.revoked == []


@pytest.mark.asyncio
async def test_optional_email_migration_is_idempotent_and_builds_before_dropping():
    migration = importlib.import_module("migrations.0032_optional_staff_email")
    events = []
    indexes = {
        "legacy": {"key": [("email", 1)], "unique": True},
        "legacy_sparse": {"key": [("email", 1)], "unique": True, "sparse": True},
        "legacy_exists": {"key": [("email", 1)], "unique": True, "partialFilterExpression": {"email": {"$exists": True}}},
        "id": {"key": [("id", 1)], "unique": True},
        "email_search": {"key": [("email", 1)]},
    }
    class Collection:
        async def create_index(self, keys, **options):
            events.append("create")
            indexes[options["name"]] = {"key": keys, **options}
        async def index_information(self):
            return deepcopy(indexes)
        async def drop_index(self, name):
            assert "users_email_optional_unique" in indexes
            events.append("drop")
            del indexes[name]
    database = SimpleNamespace(users=Collection())
    await migration.up(database)
    await migration.up(database)
    assert events == ["create", "drop", "drop", "drop", "create"]
    assert indexes["users_email_optional_unique"]["partialFilterExpression"] == {"email": {"$type": "string"}}
    assert "id" in indexes and "email_search" in indexes


@pytest.mark.asyncio
async def test_optional_email_migration_never_drops_legacy_constraint_when_build_fails():
    migration = importlib.import_module("migrations.0032_optional_staff_email")
    class Collection:
        async def create_index(self, *_args, **_kwargs):
            raise OperationFailure("wrong options", code=85)
        async def index_information(self):
            return {"legacy": {"key": [("email", 1)], "unique": True}}
        async def drop_index(self, _name):
            pytest.fail("Must not drop working constraint")
    with pytest.raises(OperationFailure):
        await migration.up(SimpleNamespace(users=Collection()))


@pytest.mark.asyncio
@pytest.mark.parametrize("index_options,healthy", [
    ({"unique": True, "partialFilterExpression": {"email": {"$type": "string"}}}, True),
    ({"unique": True}, False),
    ({"unique": True, "sparse": True}, False),
    ({"unique": True, "partialFilterExpression": {"email": {"$exists": True}}}, False),
    ({"unique": False, "partialFilterExpression": {"email": {"$type": "string"}}}, False),
])
async def test_bootstrap_requires_exact_optional_email_constraint_and_reads_indexes_once(monkeypatch, index_options, healthy):
    import bootstrap
    calls = []
    specs = {}
    for collection, signatures in bootstrap.REQUIRED_INDEXES.items():
        specs[collection] = {str(i): {"key": list(signature), "unique": signature in bootstrap.REQUIRED_UNIQUE_INDEXES.get(collection, [])}
                             for i, signature in enumerate(signatures)}
    for collection, signatures in bootstrap.REQUIRED_UNIQUE_INDEXES.items():
        for signature in signatures:
            specs[collection][repr(signature)] = {"key": list(signature), "unique": True}
    specs["users"] = {"email": {"key": [("email", 1)], **index_options}}
    class Collection:
        def __init__(self, name):
            self.name = name
        async def index_information(self):
            calls.append(self.name)
            return specs[self.name]
    class Database:
        async def list_collection_names(self):
            return list(bootstrap.REQUIRED_COLLECTIONS)
        def __getitem__(self, name):
            return Collection(name)
    class Client:
        admin = SimpleNamespace(command=None)
        def __init__(self, *_args, **_kwargs):
            async def command(*_args):
                return None
            self.admin = SimpleNamespace(command=command)
        def __getitem__(self, _name):
            return Database()
        def close(self):
            pass
    async def no_demo(_database):
        return []
    monkeypatch.setattr(bootstrap, "AsyncIOMotorClient", Client)
    monkeypatch.setattr(bootstrap, "_check_demo_accounts", no_demo)
    report = bootstrap.BootstrapReport()
    await bootstrap._check_mongo(SimpleNamespace(mongo_url="mongodb://localhost:27017", db_name="test"), report)
    assert report.healthy is healthy
    assert bool(report.checks["mongo"]["missing_unique_indexes"].get("users")) is not healthy
    assert len(calls) == len(set(calls)) == len(bootstrap.REQUIRED_INDEXES)


@pytest.mark.parametrize("email", [None, "", "invalid", 123, {"bad": "email"}, ["invalid"], False])
def test_legacy_email_contact_cannot_poison_public_account_model(email):
    user = UserPublic(**member(email=email, login_id="JK"))
    assert user.email is None and user.login_id == "JK"


@pytest.mark.asyncio
async def test_invalid_legacy_email_cannot_be_used_to_clear_last_username(setup):
    setup.users.docs[0].update(email="invalid", login_id="JK", login_id_key="jk")
    with pytest.raises(HTTPException) as exc:
        await misc_routes.update_team_member("member", TeamUpdatePayload(login_id=None), principal())
    assert exc.value.status_code == 422 and setup.users.updates == []


@pytest.mark.asyncio
async def test_contact_responses_never_expose_mfa_material(setup):
    setup.users.docs[0].update(mfa_secret_encrypted="encrypted secret", mfa_recovery_hashes=["private"], mfa_pending={"secret": "private"})
    for result in [(await misc_routes.list_team(principal()))[0], await misc_routes.update_team_member("member", TeamUpdatePayload(phone="9909906652"), principal())]:
        assert not {"password_hash", "mfa_secret_encrypted", "mfa_recovery_hashes", "mfa_pending"}.intersection(result)


@pytest.mark.asyncio
async def test_known_reset_owner_email_is_hidden_until_explicitly_entered(setup):
    from services.team_data_reset import OWNER_EMAIL, OWNER_ID
    setup.users.docs = [member(id=OWNER_ID, email=OWNER_EMAIL, role="owner", login_id="JK", login_id_key="jk")]
    actor = UserPublic(**setup.users.docs[0])
    assert (await misc_routes.list_team(actor))[0]["email"] is None
    assert (await auth_routes.staff_login(LoginPayload(email=OWNER_EMAIL, password=PASSWORD), request())).user.email == OWNER_EMAIL
    changed = await misc_routes.update_team_member(OWNER_ID, TeamUpdatePayload(phone="9909906652"), actor)
    assert changed["email"] is None and setup.users.docs[0]["email"] == OWNER_EMAIL
    assert "contact_email_added" not in setup.users.docs[0] and setup.revoked == []
    changed = await misc_routes.update_team_member(OWNER_ID, TeamUpdatePayload(email=OWNER_EMAIL), actor)
    assert changed["email"] == OWNER_EMAIL and setup.users.docs[0]["contact_email_added"] is True
    assert (await misc_routes.list_team(actor))[0]["email"] == OWNER_EMAIL
    changed = await misc_routes.update_team_member(OWNER_ID, TeamUpdatePayload(email=" entered@example.com "), actor)
    assert changed["email"] == "entered@example.com" and setup.users.docs[0]["contact_email_added"] is True
    changed = await misc_routes.update_team_member(OWNER_ID, TeamUpdatePayload(email=None), actor)
    assert changed["email"] is None and setup.users.docs[0]["contact_email_added"] is False
    assert (await auth_routes.staff_login(LoginPayload(email="JK", password=PASSWORD), request())).user.id == OWNER_ID
    assert setup.revoked == []


@pytest.mark.parametrize("id,email", [("unrelated-owner", "jkpatel@buildconhouse.com"), ("unrelated-owner", "legitimate@example.com")])
def test_legacy_legitimate_addresses_are_not_suppressed(id, email):
    assert misc_routes._team_public(member(id=id, email=email))["email"] == email


@pytest.mark.asyncio
@pytest.mark.parametrize("email,added", [("explicit@example.com", True), (None, False)])
async def test_new_members_record_email_contact_provenance(setup, email, added):
    created = await misc_routes.create_team_member(TeamCreatePayload(login_id="new", email=email, full_name="New", role="worker", custom_access=True, password=PASSWORD), principal())
    assert created["contact_email_added"] is added
    assert next(doc for doc in setup.users.docs if doc["id"] == created["id"])["contact_email_added"] is added
