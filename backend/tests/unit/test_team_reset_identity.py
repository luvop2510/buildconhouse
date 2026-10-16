from __future__ import annotations

import asyncio
import importlib
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pymongo.errors import OperationFailure
from starlette.requests import Request

from models import LoginPayload
from routes import auth_routes
from services.login_identity import normalize_login_id
from services.team_data_reset import REQUEST_ID, reset_team_data


def test_reset_requires_maintenance_and_recognized_request_before_access(monkeypatch):
    arguments = {"request_id": REQUEST_ID, "owner_password": "test-owner-credential", "expected_user_count": 1}
    monkeypatch.delenv("FORGE_CUSTOMER_RESET_MAINTENANCE", raising=False)
    with pytest.raises(RuntimeError, match="maintenance"):
        asyncio.run(reset_team_data(None, None, **arguments))
    monkeypatch.setenv("FORGE_CUSTOMER_RESET_MAINTENANCE", "true")
    arguments["request_id"] = "mistyped-request"
    with pytest.raises(ValueError, match="Unrecognized"):
        asyncio.run(reset_team_data(None, None, **arguments))


@pytest.mark.parametrize("identifier", ["JK PATEL", " jk   patel ", "ＪＫ ＰＡＴＥＬ"])
def test_username_normalization(identifier):
    assert normalize_login_id(identifier) == "jk patel"


@pytest.mark.parametrize(("identifier", "query"), [
    (" jk  PATEL ", {"login_id_key": "jk patel"}),
    (" JKPatel@Buildconhouse.com ", {"email": "jkpatel@buildconhouse.com"}),
])
def test_login_uses_explicit_username_or_email_and_normalized_throttle(monkeypatch, identifier, query):
    calls = []
    reservations = []

    class Users:
        async def find_one(self, actual, projection):
            calls.append(actual)
            return {"id": "owner", "email": "jkpatel@buildconhouse.com", "login_id": "JK PATEL",
                "full_name": "JK PATEL", "role": "owner", "password_hash": "test-hash"}

    async def reserve(ip, value):
        reservations.append(value)

    async def clear(*args):
        return None

    async def session(*args, **kwargs):
        return "test-session"

    async def event(**kwargs):
        return None

    monkeypatch.setattr(auth_routes, "db", SimpleNamespace(users=Users()))
    monkeypatch.setattr(auth_routes, "reserve_login_attempt", reserve)
    monkeypatch.setattr(auth_routes, "clear_login_attempts", clear)
    monkeypatch.setattr(auth_routes, "create_session", session)
    monkeypatch.setattr(auth_routes, "log_event", event)
    monkeypatch.setattr(auth_routes, "verify_password", lambda password, encoded: password == "test-correct-password")
    request = Request({"type": "http", "method": "POST", "path": "/api/auth/login", "headers": []})
    response = asyncio.run(auth_routes.staff_login(LoginPayload(email=identifier, password="test-correct-password"), request))
    assert response.user.login_id == "JK PATEL"
    assert calls == [query, {"id": "owner", "password_hash": "test-hash"}]
    assert reservations == [normalize_login_id(identifier)]
    with pytest.raises(HTTPException, match="Invalid email or password"):
        asyncio.run(auth_routes.staff_login(LoginPayload(email=identifier, password="wrong"), request))


@pytest.mark.parametrize("correct", [True, False])
def test_login_index_conflicts_require_actual_unique_partial_index(correct):
    migration = importlib.import_module("migrations.0030_staff_login_id_index")

    class Users:
        async def create_index(self, *args, **kwargs):
            raise OperationFailure("conflicting name", code=85)

        async def index_information(self):
            return {"existing": {"key": [("login_id_key", 1)], "unique": correct,
                "partialFilterExpression": {"login_id_key": {"$type": "string"}}}}

    database = SimpleNamespace(users=Users())
    if correct:
        asyncio.run(migration.up(database))
    else:
        with pytest.raises(OperationFailure):
            asyncio.run(migration.up(database))


@pytest.mark.asyncio
async def test_controlled_reset_provisions_encrypted_owner_credentials_without_receipt_leak(monkeypatch):
    from services import team_data_reset
    from services.team_credentials import decrypt_password
    owner_password = "RememberOwner!2026"
    stored = []
    class Collection:
        async def find_one(self, *args, **kwargs):
            return None
        async def count_documents(self, *args, **kwargs):
            return 1
        def find(self, *args, **kwargs):
            async def rows():
                yield {"id": "old-owner"}
            return rows()
        async def delete_many(self, *args, **kwargs):
            return SimpleNamespace(deleted_count=1)
        async def update_many(self, *args, **kwargs):
            return SimpleNamespace(modified_count=0)
        async def insert_one(self, doc, **kwargs):
            stored.append(doc)
    class Database:
        users = settings = customers = Collection()
        def __getitem__(self, name):
            return self.users
    class Session:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def with_transaction(self, operation, **kwargs):
            return await operation(self)
    class Client:
        async def start_session(self):
            return Session()
    async def preview(*args, **kwargs):
        return {"portal_accounts_disabled": 0, "deleted": {"users": 1}}
    monkeypatch.setenv("FORGE_CUSTOMER_RESET_MAINTENANCE", "true")
    monkeypatch.setattr(team_data_reset, "team_reset_preview", preview)
    monkeypatch.setattr(team_data_reset, "hash_password", lambda password: "independent-login-hash")
    receipt = await reset_team_data(Database(), Client(), request_id=REQUEST_ID,
                                    owner_password=owner_password, expected_user_count=1)
    owner = next(doc for doc in stored if doc.get("role") == "owner")
    assert owner["password_hash"] == "independent-login-hash"
    assert decrypt_password(owner["password_encrypted"], owner["id"]) == owner_password
    assert owner_password not in repr(stored)
    assert owner_password not in repr(receipt)
