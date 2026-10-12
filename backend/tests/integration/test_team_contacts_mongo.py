"""Opt-in contact/auth lifecycle checks on a disposable local Mongo database."""
import asyncio
import importlib
import os
from uuid import uuid4

import pytest
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError
from starlette.requests import Request

import auth
from models import LoginPayload, TeamCreatePayload, TeamUpdatePayload, UserPublic
from routes import auth_routes, misc_routes
from services.team_data_reset import OWNER_EMAIL, OWNER_ID

PASSWORD = "Owner-selected-secret-2026"


def test_contact_login_reload_delete_and_partial_email_index(monkeypatch):
    url = os.environ.get("TEAM_CONTACTS_TEST_MONGO_URL", "")
    if not url:
        pytest.skip("Set TEAM_CONTACTS_TEST_MONGO_URL to a disposable local MongoDB")
    if not url.startswith(("mongodb://127.0.0.1:", "mongodb://localhost:")):
        raise RuntimeError("Contact tests require disposable local MongoDB")

    async def run():
        client = AsyncIOMotorClient(url)
        database = client[f"forge_team_contacts_test_{uuid4().hex}"]
        async def noop(*_args, **_kwargs):
            return None
        request = Request({"type": "http", "method": "POST", "path": "/api/auth/login", "headers": [],
                           "query_string": b"", "scheme": "http", "server": ("test", 80)})
        async def login(identifier):
            return await auth_routes.staff_login(LoginPayload(email=identifier, password=PASSWORD), request)
        async def me(token):
            me_request = Request({"type": "http", "method": "GET", "path": "/api/auth/me", "headers": [],
                                  "query_string": b"", "scheme": "http", "server": ("test", 80)})
            return await auth.get_current_user(request=me_request, authorization=f"Bearer {token}", x_floor_id=None, dl=None)
        try:
            for module in (auth, auth_routes, misc_routes):
                monkeypatch.setattr(module, "db", database)
            for module in (auth_routes, misc_routes):
                monkeypatch.setattr(module, "log_event", noop)
            monkeypatch.setattr(auth_routes, "reserve_login_attempt", noop)
            monkeypatch.setattr(auth_routes, "clear_login_attempts", noop)
            await database.users.create_index("email", unique=True, name="users_email_unique")
            await database.users.create_index("login_id_key", unique=True, name="users_login_id_unique",
                                              partialFilterExpression={"login_id_key": {"$type": "string"}})
            owner = UserPublic(id=OWNER_ID, email=OWNER_EMAIL, login_id="JK", full_name="JK", role="owner")
            owner_doc = owner.model_dump(exclude={"active_floor_id", "session_id"})
            owner_doc.update(password_hash=auth.hash_password(PASSWORD), login_id_key="jk")
            # Reproduce the legacy owner with absent default security fields.
            owner_doc.pop("custom_access")
            owner_doc.pop("access_profile")
            await database.users.insert_one(owner_doc)
            migration = importlib.import_module("migrations.0032_optional_staff_email")
            await migration.up(database)
            await migration.up(database)
            indexes = await database.users.index_information()
            assert "users_email_unique" not in indexes
            assert indexes["users_email_optional_unique"]["unique"] is True
            assert indexes["users_email_optional_unique"]["partialFilterExpression"] == {"email": {"$type": "string"}}

            first = await misc_routes.create_team_member(TeamCreatePayload(login_id="staff-one", full_name="One", role="worker", custom_access=True, password=PASSWORD), owner)
            second = await misc_routes.create_team_member(TeamCreatePayload(login_id="staff-two", full_name="Two", role="worker", custom_access=True, password=PASSWORD), owner)
            assert first["email"] is None and second["email"] is None
            assert await database.users.count_documents({"email": None}) == 2
            owner_login = await login("JK")
            owner_sid = auth.decode_token(owner_login.access_token)["session_id"]
            assert owner_login.user.email == OWNER_EMAIL
            assert next(row for row in await misc_routes.list_team(owner) if row["id"] == owner.id)["email"] is None
            phone_edit = await misc_routes.update_team_member(owner.id, TeamUpdatePayload(phone="9909906652"), owner)
            assert phone_edit["email"] is None
            assert (await database.users.find_one({"id": owner.id}))["email"] == OWNER_EMAIL
            assert (await login(OWNER_EMAIL)).user.id == owner.id
            explicit = await misc_routes.update_team_member(owner.id, TeamUpdatePayload(email=OWNER_EMAIL), owner)
            assert explicit["email"] == OWNER_EMAIL and explicit["contact_email_added"] is True
            before = await database.users.find_one({"id": owner.id})
            edited = await misc_routes.update_team_member(owner.id, TeamUpdatePayload(phone="+91 99099 06652", mobile="9909906652", email=" New@Example.com "), owner)
            after = await database.users.find_one({"id": owner.id})
            assert edited["email"] == "new@example.com"
            assert before["password_hash"] == after["password_hash"]
            assert before["role"] == after["role"] == "owner"
            assert (await database.user_sessions.find_one({"id": owner_sid}))["revoked"] is False
            assert (await me(owner_login.access_token)).phone == "+91 99099 06652"
            assert (await login("new@example.com")).user.id == owner.id
            assert len(await misc_routes.list_team(owner)) == 3
            await misc_routes.update_team_member(owner.id, TeamUpdatePayload(email=None, phone=None, mobile=""), owner)
            assert (await me(owner_login.access_token)).email is None
            assert (await login("JK")).user.email is None
            # Clearing the last identity is rejected before the database write.
            with pytest.raises(HTTPException) as exc:
                await misc_routes.update_team_member(owner.id, TeamUpdatePayload(login_id=None), owner)
            assert exc.value.status_code == 422
            assert (await login("JK")).user.id == owner.id
            # Driver-enforced uniqueness handles requests racing API prechecks.
            await misc_routes.update_team_member(first["id"], TeamUpdatePayload(email="staff@example.com"), owner)
            with pytest.raises(DuplicateKeyError):
                await database.users.update_one({"id": second["id"]}, {"$set": {"email": "staff@example.com"}})
            # Malformed legacy contact data cannot poison login or /me.
            await database.users.update_one({"id": second["id"]}, {"$set": {"phone": 9909906652, "mobile": ["invalid"], "email": "invalid legacy"}})
            auth.invalidate_principal_cache("staff", second["id"])
            staff_login = await login("staff-two")
            hydrated = await me(staff_login.access_token)
            assert hydrated.phone == "9909906652" and hydrated.mobile is None and hydrated.email is None
            listed = await misc_routes.list_team(owner)
            assert next(row for row in listed if row["id"] == second["id"])["email"] is None
            await auth_routes.logout_current_session(f"Bearer {staff_login.access_token}")
            with pytest.raises(HTTPException) as exc:
                await me(staff_login.access_token)
            assert exc.value.status_code == 401
            staff_login = await login("staff-two")
            assert (await me(staff_login.access_token)).id == second["id"]
            await misc_routes.delete_team_member(second["id"], owner)
            with pytest.raises(HTTPException) as exc:
                await me(staff_login.access_token)
            assert exc.value.status_code == 401
            with pytest.raises(HTTPException) as exc:
                await login("staff-two")
            assert exc.value.status_code == 403
            assert len(await misc_routes.list_team(owner)) == 2
            assert (await me(owner_login.access_token)).id == owner.id
            with pytest.raises(HTTPException) as exc:
                await misc_routes.create_team_member(TeamCreatePayload(login_id="staff-two", full_name="Replacement", role="worker", custom_access=True, password=PASSWORD), owner)
            assert exc.value.status_code == 409
        finally:
            for doc in await database.users.find({}, {"id": 1}).to_list(100):
                auth.invalidate_principal_cache("staff", doc["id"])
            await client.drop_database(database.name)
            client.close()

    asyncio.run(run())
