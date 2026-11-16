"""Actual auth + route + disposable Mongo interest persistence and isolation."""
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from tests.integration.test_kitchen_projects_mongo import environment, headers


@asynccontextmanager
async def intake_environment(monkeypatch):
    import auth
    from routes import walkin_routes, followup_routes
    from services import sequence, walkin_service, duplicate_detection
    from services.access_grants import build_grant
    async with environment() as env:
        with monkeypatch.context() as patch:
            for module in (walkin_routes, followup_routes, sequence, walkin_service, duplicate_detection):
                patch.setattr(module, "db", env["db"])
            patch.setattr(walkin_routes, "reconcile_followups_admitted", AsyncMock())
            env["app"].include_router(walkin_routes.router, prefix="/api")
            env["app"].include_router(followup_routes.router, prefix="/api")
            await env["db"].floors.insert_many([
                {"id": "ground-floor", "name": "Ground Tiles", "active": True, "internal_secret": "never expose"},
                {"id": "third-floor", "name": "Furniture", "active": True},
                {"id": "future-floor", "name": "Future showroom", "active": True},
                {"id": "inactive-floor", "name": "Closed showroom", "active": False},
            ])
            worker_id = env["ids"]["worker"]
            grants = [build_grant(user_id=worker_id, resource=resource, actions=actions, floor_id="ground-floor",
                      expires_at=None, actor_id=env["ids"]["owner"], actor_name="Owner")
                      for resource, actions in (("walkins", ["view", "create", "update"]), ("followups", ["view", "update"]))]
            await env["db"].users.update_one({"id": worker_id}, {"$set": {"role": "worker", "floor_ids": ["ground-floor"], "delegation_grants": grants}})
            auth.invalidate_principal_cache("staff", worker_id)
            customer_id = str(uuid4())
            await env["db"].customers.insert_one({"id": customer_id, "name": "Source visitor", "floor_id": "ground-floor", "phone": "9900000067", "address": "Synthetic showroom address"})
            env["source_customer_id"] = customer_id
            yield env


def data(env, **changes):
    worker = env["ids"]["worker"]
    return {"floor_id": "ground-floor", "customer_name": "Source visitor", "customer_phone": "9900000067", "address": "Synthetic showroom address",
            "use_existing_customer_id": env["source_customer_id"], "source": "Walk-in", "salesperson_id": worker,
            "interested_floor_ids": ["ground-floor", "first-floor", "second-floor", "third-floor", "future-floor"],
            "assignments": [{"floor_id": "ground-floor", "user_id": worker}], **changes}


@pytest.mark.asyncio
async def test_ground_only_employee_can_record_every_active_interest_without_foreign_records_or_access(monkeypatch):
    async with intake_environment(monkeypatch) as env:
        selected_headers = headers(env, "worker", "ground-floor")
        foreign_before = await env["db"].customers.find({"floor_id": {"$ne": "ground-floor"}}).sort("id", 1).to_list(100)
        user_before = await env["db"].users.find_one({"id": env["ids"]["worker"]})
        options = await env["api"].get("/api/walkins/config/interested-floors", headers=selected_headers)
        assert options.status_code == 200, options.text
        assert {row["id"] for row in options.json()} == set(data(env)["interested_floor_ids"])
        assert all(set(row) == {"id", "name"} for row in options.json())
        created = await env["api"].post("/api/walkins", headers=selected_headers, json=data(env))
        assert created.status_code == 200, created.text
        saved = created.json()
        assert saved["floor_id"] == "ground-floor" and saved["customer_id"] == env["source_customer_id"]
        assert saved["interested_floor_ids"] == data(env)["interested_floor_ids"]
        assert {row["floor_id"] for row in saved["assignments"]} == {"ground-floor"}
        editor = await env["api"].get("/api/walkins/config/interested-floors", headers=selected_headers, params={"walkin_id": saved["id"]})
        assert editor.status_code == 200 and editor.json() == options.json()
        workers = await env["api"].get("/api/walkins/config/interest-assignees", headers=selected_headers,
            params={"walkin_id": saved["id"], "floor_ids": "ground-floor,second-floor"})
        assert workers.status_code == 200, workers.text
        assert any(row["id"] == env["ids"]["worker"] for row in workers.json())
        assert all(row["floor_ids"] == ["ground-floor"] for row in workers.json())
        reopened = await env["api"].get(f"/api/walkins/{saved['id']}", headers=selected_headers)
        assert reopened.status_code == 200 and reopened.json()["interested_floor_ids"] == saved["interested_floor_ids"]
        edited = await env["api"].patch(f"/api/walkins/{saved['id']}", headers=selected_headers,
            json={"interested_floor_ids": ["second-floor"], "reference_source": "Customer asked about Kitchen"})
        assert edited.status_code == 200, edited.text
        assert edited.json()["interested_floor_ids"] == ["second-floor"]
        assert edited.json()["floor_id"] == "ground-floor" and edited.json()["customer_id"] == env["source_customer_id"]
        assert edited.json()["salesperson_id"] == env["ids"]["worker"]
        assert await env["db"].customers.find({"floor_id": {"$ne": "ground-floor"}}).sort("id", 1).to_list(100) == foreign_before
        assert await env["db"].followups.count_documents({"floor_id": {"$ne": "ground-floor"}}) == 0
        assert await env["db"].kitchen_projects.count_documents({}) == 0
        assert await env["db"].users.find_one({"id": env["ids"]["worker"]}) == user_before
        for endpoint in ("/api/customers", "/api/kitchen-projects", "/api/followups"):
            denied = await env["api"].get(endpoint, headers=headers(env, "worker", "second-floor"))
            assert denied.status_code == 403, denied.text


@pytest.mark.asyncio
async def test_metadata_picker_requires_source_create_and_never_accepts_forged_routing(monkeypatch):
    import auth
    from services.access_grants import build_grant
    async with intake_environment(monkeypatch) as env:
        selected_headers = headers(env, "worker", "ground-floor")
        for patch in ({"floor_id": "second-floor"}, {"interested_floor_ids": ["inactive-floor"]},
                      {"interested_floor_ids": ["imaginary-floor"]}, {"assignments": [{"floor_id": "second-floor", "user_id": "foreign-worker"}]}):
            response = await env["api"].post("/api/walkins", headers=selected_headers, json=data(env, **patch))
            assert response.status_code in {403, 422}, response.text
        assert await env["db"].walkins.count_documents({}) == 0
        worker_id = env["ids"]["worker"]
        readonly = build_grant(user_id=worker_id, resource="walkins", actions=["view"], floor_id="ground-floor", expires_at=None,
                               actor_id=env["ids"]["owner"], actor_name="Owner")
        await env["db"].users.update_one({"id": worker_id}, {"$set": {"delegation_grants": [readonly]}})
        auth.invalidate_principal_cache("staff", worker_id)
        options = await env["api"].get("/api/walkins/config/interested-floors", headers=selected_headers)
        assert options.status_code == 403, options.text


@pytest.mark.asyncio
async def test_owner_retains_authorized_multifloor_fanout(monkeypatch):
    async with intake_environment(monkeypatch) as env:
        worker = env["ids"]["manager"]
        await env["db"].users.update_one({"id": worker}, {"$set": {"role": "sales", "custom_access": False,
            "floor_ids": ["ground-floor", "first-floor", "second-floor", "third-floor", "future-floor"]}})
        payload = data(env, assignments=[{"floor_id": floor, "user_id": worker} for floor in data(env)["interested_floor_ids"]])
        created = await env["api"].post("/api/walkins", headers=headers(env, floor="ground-floor"), json=payload)
        assert created.status_code == 200, created.text
        assert created.json()["interested_floor_ids"] == payload["interested_floor_ids"]
        assert await env["db"].followups.count_documents({}) == 5
        assert {row["floor_id"] for row in await env["db"].followups.find({}).to_list(20)} == set(payload["interested_floor_ids"])
