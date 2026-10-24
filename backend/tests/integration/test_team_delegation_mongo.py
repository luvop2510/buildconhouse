"""Opt-in delegation checks on an isolated, disposable local Mongo database."""
from __future__ import annotations

import asyncio
import os

import pytest
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from starlette.requests import Request

import auth
from models import UserPublic
from routes import access_grants_routes as routes
from services.access_grants import grants_for_user


def test_atomic_delegation_snapshot_updates_live_access_without_signing_out_sessions(monkeypatch):
    url = os.environ.get("TEAM_DELEGATION_TEST_MONGO_URL", "")
    if not url:
        pytest.skip("Set TEAM_DELEGATION_TEST_MONGO_URL to a disposable local MongoDB")
    if not url.startswith(("mongodb://127.0.0.1:", "mongodb://localhost:")):
        raise RuntimeError("Delegation tests require disposable local MongoDB")

    async def run():
        client = AsyncIOMotorClient(url)
        db = client.forge_team_delegation_test
        try:
            await client.drop_database(db.name)
            await db.floors.insert_many([{"id": floor, "active": True} for floor in ["ground-floor", "first-floor", "second-floor", "third-floor"]])
            await db.users.insert_one({"id": "worker", "email": "worker@example.com", "full_name": "Worker", "role": "manager",
                "floor_ids": ["ground-floor", "first-floor"], "custom_access": True, "delegation_grants": [], "active": True})
            await db.user_sessions.insert_many([{"id": sid, "user_type": "staff", "user_id": "worker", "revoked": False} for sid in ["phone", "laptop"]])
            await db.access_grants.insert_one({"id": "legacy", "user_id": "worker", "resource": "quotations", "floor_id": None, "actions": ["view", "delete"]})
            monkeypatch.setattr(routes, "db", db)
            monkeypatch.setattr(auth, "db", db)
            owner = UserPublic(id="owner", email="owner@example.com", full_name="Owner", role="owner")
            draft = routes.DelegationInput(floor_ids=["ground-floor", "first-floor"], grants=[
                {"resource": "payments", "floor_id": "ground-floor", "actions": ["view"]},
                {"resource": "catalog", "floor_id": "first-floor", "actions": ["view", "create"]},
            ])
            result = await routes.replace_access_grants("worker", draft, owner)
            saved = await db.users.find_one({"id": "worker"}, {"_id": 0})
            assert saved["floor_ids"] == draft.floor_ids and saved["delegation_grants"] == result["grants"]
            assert await db.user_sessions.count_documents({"user_id": "worker", "revoked": {"$ne": True}}) == 2
            assert await grants_for_user(db, "worker") == result["grants"]

            # The same bearer session resolves the updated floor/page grants
            # on its next request and remains usable without another login.
            auth.db = db
            token = auth.create_token("worker", "staff", {"session_id": "phone"})
            existing_session_request = Request({"type": "http", "method": "GET", "path": "/api/payments/orders",
                "headers": [], "query_string": b"", "scheme": "http", "server": ("test", 80)})
            current = await auth.get_current_user(request=existing_session_request, authorization=f"Bearer {token}", x_floor_id="ground-floor")
            assert current.id == "worker" and current.active_floor_id == "ground-floor"

            for path, method, floor, allowed in [
                ("/api/payments/orders", "GET", "ground-floor", True),
                ("/api/payments/orders", "POST", "ground-floor", False),
                ("/api/payments/orders", "GET", "first-floor", False),
                ("/api/products", "POST", "first-floor", True),
                ("/api/products", "GET", "ground-floor", False),
                ("/api/quotations", "GET", "first-floor", False),
            ]:
                user = UserPublic(**saved)
                user.active_floor_id = floor
                request = Request({"type": "http", "method": method, "path": path, "headers": [], "query_string": b"", "scheme": "http", "server": ("test", 80)})
                if allowed:
                    assert await auth.authorize_staff_request(user, request) is user
                else:
                    with pytest.raises(HTTPException) as exc:
                        await auth.authorize_staff_request(user, request)
                    assert exc.value.status_code == 403

            before = await db.users.find_one({"id": "worker"})
            invalid = routes.DelegationInput(floor_ids=["ground-floor"], grants=[{"resource": "catalog", "floor_id": "first-floor", "actions": ["view"]}])
            with pytest.raises(HTTPException):
                await routes.replace_access_grants("worker", invalid, owner)
            assert await db.users.find_one({"id": "worker"}) == before

            for grant in result["grants"]:
                await routes.delete_access_grant("worker", grant["id"], owner)
            assert await grants_for_user(db, "worker") == []
            assert (await db.users.find_one({"id": "worker"}))["custom_access"] is True
            assert await db.access_grants.count_documents({"id": "legacy"}) == 1
        finally:
            auth.invalidate_principal_cache("staff", "worker")
            await client.drop_database(db.name)
            client.close()

    asyncio.run(run())
