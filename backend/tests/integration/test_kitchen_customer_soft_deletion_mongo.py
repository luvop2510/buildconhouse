"""Real transaction/auth acceptance on an explicitly selected loopback replica."""
from copy import deepcopy

import pytest
from pymongo.errors import DuplicateKeyError

from tests.integration.test_kitchen_projects_mongo import environment, create_project, headers
from tests.integration.test_tile_release_godown_mongo import tile_replica


@pytest.fixture(autouse=True)
def owned_replica(tile_replica, monkeypatch):
    monkeypatch.setenv("KITCHEN_TEST_MONGO_URL", tile_replica.split("?")[0])
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")


def mount(env, monkeypatch):
    from routes import kitchen_customer_deletion_routes, access_grants_routes
    from services.mutation_admission import MutationAdmissionMiddleware
    monkeypatch.setattr(kitchen_customer_deletion_routes, "db", env["db"])
    monkeypatch.setattr(access_grants_routes, "db", env["db"])
    env["app"].include_router(kitchen_customer_deletion_routes.router, prefix="/api")
    env["app"].include_router(access_grants_routes.router, prefix="/api")
    env["app"].add_middleware(MutationAdmissionMiddleware)


@pytest.mark.asyncio
async def test_owner_removes_all_kitchen_projects_recoverably_and_replays(monkeypatch):
    async with environment() as env:
        mount(env, monkeypatch)
        project, _ = await create_project(env)
        second, _ = await create_project(env)
        database, api = env["db"], env["api"]
        await database.kitchen_stage_followups.insert_one({"project_id": project["id"], "customer_id": project["customer_id"], "notes": "Retain history"})
        await database.kitchen_projects.update_one({"id": second["id"]}, {"$set": {"stage": "installation", "attachments": [{"id": "historic-file", "storage_key": "private/original.pdf"}]}})
        before = await database.kitchen_projects.find_one({"id": second["id"]})
        path = "/api/kitchen-customer-deletion/" + project["id"]
        preview = await api.get(path, headers=headers(env))
        assert preview.status_code == 200, preview.text
        assert len(preview.json()["projects"]) == 2
        confirmed = {"confirmation": preview.json()["confirmation"]}
        deleted = await api.delete(path, headers=headers(env), params=confirmed)
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["recoverable"] is True
        assert (await api.delete(path, headers=headers(env), params=confirmed)).json() == deleted.json()
        assert (await api.get("/api/kitchen-projects/" + second["id"], headers=headers(env))).status_code == 404
        assert (await api.get("/api/customers/" + project["customer_id"], headers=headers(env))).status_code == 404
        assert (await api.get("/api/kitchen-projects", headers=headers(env))).json()["total"] == 0
        assert (await api.get("/api/kitchen-projects/customers", headers=headers(env))).json()["total"] == 0
        assert (await api.get("/api/customers", headers=headers(env))).json() == []
        dashboard = await api.get("/api/kitchen-projects/dashboard", headers=headers(env))
        assert dashboard.status_code == 200, dashboard.text
        assert dashboard.json()["total_projects"] == 0 and dashboard.json()["total_customers"] == 0
        assert all(count == 0 for count in dashboard.json()["stage_counts"].values())
        search = await api.get("/api/customer-search", headers=headers(env), params={"search": "Kitchen acceptance customer"})
        assert search.status_code == 200 and search.json()["total"] == 0
        retained = await database.kitchen_projects.find_one({"id": second["id"]})
        assert retained["attachments"] == before["attachments"] and retained["stage"] == "installation"
        assert retained["version"] == before["version"] + 1
        assert await database.kitchen_stage_followups.count_documents({}) == 1
        audit = await database.kitchen_customer_deletions.find_one({"customer_id": project["customer_id"]})
        assert audit["actor_id"] == env["ids"]["owner"] and audit["deleted_at"]
        assert await database.customers.count_documents({"id": env["ids"]["other_customer"], "deleted_at": {"$exists": False}}) == 1
        # A pre-deletion aggregate cannot replace the tombstone using old CAS.
        result = await database.kitchen_projects.replace_one({"id": second["id"], "version": before["version"]}, before)
        assert result.matched_count == 0


@pytest.mark.asyncio
async def test_default_deny_owner_grant_and_immediate_revoke(monkeypatch):
    async with environment() as env:
        mount(env, monkeypatch)
        project, _ = await create_project(env)
        path = "/api/kitchen-customer-deletion/" + project["id"]
        api = env["api"]
        assert (await api.get(path, headers=headers(env, "worker"))).status_code == 403
        assert (await api.delete(path, headers=headers(env, "worker"), params={"confirmation": "a" * 64})).status_code == 403
        grant_path = "/api/settings/access-grants/" + env["ids"]["worker"]
        grant = await api.post(grant_path, headers=headers(env), json={"resource": "customer_delete", "actions": ["view", "delete"], "floor_id": "second-floor"})
        assert grant.status_code == 201, grant.text
        preview = await api.get(path, headers=headers(env, "worker"))
        assert preview.status_code == 200, preview.text
        # Revocation reads the live delegation, even if an already displayed
        # preview/old token suggests the worker still has permission.
        revoke = await api.delete(grant_path + "/" + grant.json()["id"], headers=headers(env))
        assert revoke.status_code == 200, revoke.text
        assert (await api.delete(path, headers=headers(env, "worker"), params={"confirmation": preview.json()["confirmation"]})).status_code == 403
        assert await env["db"].kitchen_projects.count_documents({"deleted_at": {"$exists": True}}) == 0
        # The explicit owner grant also enables a complete successful delete.
        granted = await api.post(grant_path, headers=headers(env), json={"resource": "customer_delete", "actions": ["view", "delete"], "floor_id": "second-floor"})
        assert granted.status_code == 201, granted.text
        preview = await api.get(path, headers=headers(env, "worker"))
        deleted = await api.delete(path, headers=headers(env, "worker"), params={"confirmation": preview.json()["confirmation"]})
        assert deleted.status_code == 200, deleted.text


@pytest.mark.asyncio
async def test_changed_project_requires_fresh_confirmation(monkeypatch):
    async with environment() as env:
        mount(env, monkeypatch)
        project, _ = await create_project(env)
        path = "/api/kitchen-customer-deletion/" + project["id"]
        preview = await env["api"].get(path, headers=headers(env))
        await env["db"].kitchen_projects.update_one({"id": project["id"]}, {"$inc": {"version": 1}})
        result = await env["api"].delete(path, headers=headers(env), params={"confirmation": preview.json()["confirmation"]})
        assert result.status_code == 409, result.text
        assert await env["db"].customers.count_documents({"deleted_at": {"$exists": True}}) == 0


@pytest.mark.asyncio
async def test_audit_failure_rolls_back_customer_and_project_tombstones(monkeypatch):
    from models import UserPublic
    from services.kitchen_customer_deletion import preview, remove
    async with environment() as env:
        mount(env, monkeypatch)
        project, _ = await create_project(env)
        owner = UserPublic(id=env["ids"]["owner"], full_name="Owner", role="owner", active_floor_id="second-floor")
        plan = await preview(env["db"], owner, project["id"])
        before = deepcopy(await env["db"].kitchen_projects.find_one({"id": project["id"]}))
        await env["db"].kitchen_customer_deletions.insert_one({"_id": project["customer_id"], "actor_id": "different", "confirmation": "different"})
        with pytest.raises(DuplicateKeyError):
            await remove(env["db"], owner, project["id"], plan["confirmation"])
        assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == before
        assert await env["db"].customers.count_documents({"deleted_at": {"$exists": True}}) == 0


@pytest.mark.asyncio
async def test_delete_grant_does_not_bypass_other_current_stage_visibility(monkeypatch):
    from auth import invalidate_principal_cache
    from services.access_grants import build_grant
    async with environment() as env:
        mount(env, monkeypatch)
        project, _ = await create_project(env)
        second, _ = await create_project(env)
        await env["db"].kitchen_projects.update_one({"id": second["id"]}, {"$set": {"stage": "installation"}})
        grants = [build_grant(user_id=env["ids"]["worker"], resource=resource, actions=actions,
            floor_id="second-floor", expires_at=None, actor_id=env["ids"]["owner"], actor_name="Owner")
            for resource, actions in [("kitchen_lead", ["view"]), ("customer_delete", ["view", "delete"])]]
        await env["db"].users.update_one({"id": env["ids"]["worker"]}, {"$set": {"delegation_grants": grants}})
        invalidate_principal_cache("staff", env["ids"]["worker"])
        path = "/api/kitchen-customer-deletion/" + project["id"]
        denied = await env["api"].get(path, headers=headers(env, "worker"))
        assert denied.status_code == 403, denied.text
        assert "installation" not in denied.text
        assert await env["db"].customers.count_documents({"deleted_at": {"$exists": True}}) == 0
