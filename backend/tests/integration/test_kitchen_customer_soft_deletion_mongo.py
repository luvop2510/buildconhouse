"""Real transaction/auth acceptance on an explicitly selected loopback replica."""
import asyncio
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


@pytest.mark.asyncio
async def test_genuine_pending_write_blocks_deletion_until_failed_save_exits(monkeypatch):
    from fastapi import HTTPException
    from models import UserPublic
    from services.kitchen_projects import KitchenProjectService
    from services.mutation_admission import admission_status
    async with environment() as env:
        mount(env, monkeypatch)
        project, _ = await create_project(env)
        entered, finish = asyncio.Event(), asyncio.Event()

        @env["app"].post("/api/test-save")
        async def failing_save():
            actor = UserPublic(id=env["ids"]["owner"], full_name="Owner", role="owner", active_floor_id="second-floor")
            async with KitchenProjectService(env["db"]).admission(actor, "update", scope={"project_id": project["id"]}):
                entered.set()
                await finish.wait()
                raise HTTPException(422, "Synthetic failed save")

        path = "/api/kitchen-customer-deletion/" + project["id"]
        api, actor_headers = env["api"], headers(env)
        preview = await api.get(path, headers=actor_headers)
        confirmation = {"confirmation": preview.json()["confirmation"]}
        pending = asyncio.create_task(api.post("/api/test-save", headers=actor_headers))
        try:
            await asyncio.wait_for(entered.wait(), 3)
            status = await admission_status(env["db"])
            assert status["writer_count"] == 1
            assert status["writers"][0]["operation"] == "http:POST:other"
            assert status["writers"][0]["owner_known"] is True
            assert status["writers"][0]["age_seconds"] is not None
            busy = await api.delete(path, headers=actor_headers, params=confirmation)
            assert busy.status_code == 409
            assert "affecting this customer" in busy.json()["detail"]
            assert await env["db"].kitchen_customer_deletions.count_documents({}) == 0
        finally:
            finish.set()
            failed = await pending
        assert failed.status_code == 422
        gate = await env["db"].settings.find_one({"_id": "customer-graph-mutation-admission:v1"})
        assert gate["writers"] == [] and gate["writer_info"] == {}
        assert (await api.delete(path, headers=actor_headers, params=confirmation)).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["lead", "visit", "cad", "design", "quotation", "order", "production", "installation", "completed"])
async def test_delete_each_stage_preserves_other_customers_and_recovers_all_projects(monkeypatch, stage):
    """Labelled stage fixtures test deletion eligibility, not stage advancement."""
    from uuid import uuid4
    async with environment() as env:
        mount(env, monkeypatch)
        project, _ = await create_project(env)
        second, _ = await create_project(env)
        database, api, actor = env["db"], env["api"], headers(env)
        other_customer = str(uuid4())
        await database.customers.insert_one({"id": other_customer, "name": "Unrelated Kitchen customer",
                                             "phone": "9900000099", "floor_id": "second-floor", "address": "Synthetic"})
        unrelated = {**deepcopy(await database.kitchen_projects.find_one({"id": project["id"]})),
                     "_id": str(uuid4()), "id": str(uuid4()), "customer_id": other_customer,
                     "customer": {"id": other_customer, "name": "Unrelated Kitchen customer", "phone": "9900000099", "address": "Synthetic"},
                     "customer_phone_normalized": "9900000099",
                     "project_reference": "KP-UNRELATED", "reference": "KP-UNRELATED"}
        await database.kitchen_projects.insert_one(unrelated)
        await database.kitchen_projects.update_one({"id": project["id"]}, {"$set": {
            "stage": stage, "attachments": [{"id": "retained-pdf", "storage_key": "private/original.pdf"}]}})
        before = await database.kitchen_projects.find_one({"id": project["id"]})
        path = "/api/kitchen-customer-deletion/" + project["id"]
        preview = await api.get(path, headers=actor)
        assert preview.status_code == 200, preview.text
        assert {row["id"] for row in preview.json()["projects"]} == {project["id"], second["id"]}
        params = {"confirmation": preview.json()["confirmation"]}
        deleted = await api.delete(path, headers=actor, params=params)
        assert deleted.status_code == 200, deleted.text
        assert deleted.json() == {"deleted": True, "customer_id": project["customer_id"], "recoverable": True}
        assert (await api.delete(path, headers=actor, params=params)).json() == deleted.json()
        for identity in (project["id"], second["id"]):
            assert (await api.get("/api/kitchen-projects/" + identity, headers=actor)).status_code == 404
        # Fresh HTTP reads model a reloaded browser's list, search and dashboard.
        listed = await api.get("/api/kitchen-projects", headers=actor)
        assert {row["id"] for row in listed.json()["rows"]} == {unrelated["id"]}
        searched = await api.get("/api/customer-search", headers=actor, params={"search": "Kitchen acceptance customer"})
        assert searched.status_code == 200 and searched.json()["total"] == 0
        dashboard = await api.get("/api/kitchen-projects/dashboard", headers=actor)
        assert dashboard.json()["total_projects"] == dashboard.json()["total_customers"] == 1
        retained = await database.kitchen_projects.find_one({"id": project["id"]})
        assert retained["stage"] == stage and retained["attachments"] == before["attachments"]
        assert retained["version"] == before["version"] + 1 and retained["deleted_at"]
        assert await database.kitchen_projects.find_one({"id": unrelated["id"]}) == unrelated
        assert await database.customers.count_documents({"id": env["ids"]["other_customer"], "deleted_at": {"$exists": False}}) == 1
        gate = await database.settings.find_one({"_id": "customer-graph-mutation-admission:v1"})
        assert gate["writers"] == [] and gate["exclusive"] is None
        assert gate.get("writer_info", {}) == {} and "exclusive_info" not in gate


@pytest.mark.asyncio
async def test_stranded_global_writer_does_not_block_transactionally_fenced_kitchen_delete(monkeypatch):
    from services.mutation_admission import KEY, admission_status
    async with environment() as env:
        mount(env, monkeypatch)
        project, _ = await create_project(env)
        database, api = env["db"], env["api"]
        await database.settings.update_one({"_id": KEY}, {"$set": {"writers": ["legacy-unknown-owner"], "exclusive": None}})
        before = await database.settings.find_one({"_id": KEY})
        status = await admission_status(database)
        assert status["writers"] == [{"fingerprint": "b4c9fe04a3fa", "owner_known": False, "age_seconds": None}]
        path = "/api/kitchen-customer-deletion/" + project["id"]
        preview = await api.get(path, headers=headers(env))
        deleted = await api.delete(path, headers=headers(env), params={"confirmation": preview.json()["confirmation"]})
        assert deleted.status_code == 200, deleted.text
        after = await database.settings.find_one({"_id": KEY})
        assert after["writers"] == before["writers"] and after["exclusive"] is None
        assert await database.kitchen_customer_deletions.count_documents({}) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [False, True])
async def test_scoped_unrelated_kitchen_writer_can_continue_but_unknown_legacy_writer_waits(monkeypatch, legacy):
    from services.kitchen_projects import KitchenProjectService, POLICY_ID
    from models import UserPublic
    async with environment() as env:
        mount(env, monkeypatch)
        project, _ = await create_project(env)
        actor = UserPublic(id=env["ids"]["owner"], full_name="Owner", role="owner", active_floor_id="second-floor")
        path = "/api/kitchen-customer-deletion/" + project["id"]
        preview = await env["api"].get(path, headers=headers(env))
        params = {"confirmation": preview.json()["confirmation"]}
        scope = {} if legacy else {"customer_id": "different-customer"}
        async with KitchenProjectService(env["db"]).admission(actor, "update", scope=scope):
            before = await env["db"].kitchen_configuration.find_one({"_id": POLICY_ID})
            response = await env["api"].delete(path, headers=headers(env), params=params)
            assert response.status_code == (409 if legacy else 200), response.text
            after = await env["db"].kitchen_configuration.find_one({"_id": POLICY_ID})
            assert after["active_command_count"] == before["active_command_count"] == 1
            assert after["command_admissions"] == before["command_admissions"]
        if legacy:
            assert (await env["api"].delete(path, headers=headers(env), params=params)).status_code == 200


@pytest.mark.asyncio
async def test_legacy_global_exclusive_still_prevents_kitchen_soft_delete(monkeypatch):
    from services.mutation_admission import admission
    async with environment() as env:
        mount(env, monkeypatch)
        project, _ = await create_project(env)
        path = "/api/kitchen-customer-deletion/" + project["id"]
        preview = await env["api"].get(path, headers=headers(env))
        async with admission(env["db"], exclusive=True):
            result = await env["api"].delete(path, headers=headers(env), params={"confirmation": preview.json()["confirmation"]})
            assert result.status_code == 409 and result.json()["code"] == "mutation_admission_busy"
        assert await env["db"].kitchen_customer_deletions.count_documents({}) == 0


@pytest.mark.asyncio
async def test_pending_customer_contact_edit_blocks_only_its_customer(monkeypatch):
    from routes import customer_routes
    async with environment() as env:
        mount(env, monkeypatch)
        project, _ = await create_project(env)
        entered, finish = asyncio.Event(), asyncio.Event()
        original = customer_routes._update_customer_fields
        async def delayed(*args):
            entered.set()
            await finish.wait()
            return await original(*args)
        monkeypatch.setattr(customer_routes, "_update_customer_fields", delayed)
        path = "/api/kitchen-customer-deletion/" + project["id"]
        preview = await env["api"].get(path, headers=headers(env))
        pending = asyncio.create_task(env["api"].patch("/api/customers/" + project["customer_id"],
            headers=headers(env), json={"notes": "Preserve this acknowledged contact edit"}))
        try:
            await asyncio.wait_for(entered.wait(), 3)
            busy = await env["api"].delete(path, headers=headers(env), params={"confirmation": preview.json()["confirmation"]})
            assert busy.status_code == 409 and "affecting this customer" in busy.json()["detail"]
        finally:
            finish.set()
            saved = await pending
        assert saved.status_code == 200, saved.text
        fresh = await env["api"].get(path, headers=headers(env))
        assert (await env["api"].delete(path, headers=headers(env), params={"confirmation": fresh.json()["confirmation"]})).status_code == 200
        retained = await env["db"].customers.find_one({"id": project["customer_id"]})
        assert retained["notes"] == "Preserve this acknowledged contact edit" and retained["deleted_at"]


@pytest.mark.asyncio
async def test_deletion_transaction_fences_a_new_project_command(monkeypatch):
    from contextlib import asynccontextmanager
    from services import kitchen_customer_deletion as deletion
    from services.kitchen_projects import KitchenProjectService
    from tests.integration.test_kitchen_projects_mongo import command
    async with environment() as env:
        mount(env, monkeypatch)
        project, _ = await create_project(env)
        fenced, finish, attempted = asyncio.Event(), asyncio.Event(), asyncio.Event()
        original_fence, original_admission = deletion.serialize_customer_writes, KitchenProjectService.admission
        async def hold_fence(*args):
            await original_fence(*args)
            fenced.set()
            await finish.wait()
        @asynccontextmanager
        async def admission(self, *args, **kwargs):
            attempted.set()
            async with original_admission(self, *args, **kwargs) as policy:
                yield policy
        monkeypatch.setattr(deletion, "serialize_customer_writes", hold_fence)
        monkeypatch.setattr(KitchenProjectService, "admission", admission)
        path = "/api/kitchen-customer-deletion/" + project["id"]
        preview = await env["api"].get(path, headers=headers(env))
        deleting = asyncio.create_task(env["api"].delete(path, headers=headers(env), params={"confirmation": preview.json()["confirmation"]}))
        saving = None
        try:
            await asyncio.wait_for(fenced.wait(), 3)
            saving = asyncio.create_task(command(env, project, "edit_lead", {"notes": "A late autosave must not revive the project"}))
            await asyncio.wait_for(attempted.wait(), 3)
        finally:
            finish.set()
            deleted = await deleting
        assert deleted.status_code == 200, deleted.text
        failed = await saving
        assert failed.status_code in {404, 409}, failed.text
        retained = await env["db"].kitchen_projects.find_one({"id": project["id"]})
        assert retained["deleted_at"] and retained["lead"]["notes"] != "A late autosave must not revive the project"


@pytest.mark.asyncio
async def test_same_customer_creation_cannot_insert_after_deletion_snapshot(monkeypatch):
    from services.kitchen_projects import KitchenProjectService
    from uuid import uuid4
    async with environment() as env:
        mount(env, monkeypatch)
        project, _ = await create_project(env)
        entered, finish = asyncio.Event(), asyncio.Event()
        original = KitchenProjectService.public
        async def hold_create(self, row, *args, **kwargs):
            result = await original(self, row, *args, **kwargs)
            if row["id"] != project["id"]:
                entered.set()
                await finish.wait()
            return result
        monkeypatch.setattr(KitchenProjectService, "public", hold_create)
        path = "/api/kitchen-customer-deletion/" + project["id"]
        preview = await env["api"].get(path, headers=headers(env))
        creating = asyncio.create_task(env["api"].post("/api/kitchen-projects", headers=headers(env), json={
            "customer_id": project["customer_id"], "idempotency_key": str(uuid4()), "lead": {"site_location": "Pending new project"}}))
        try:
            await asyncio.wait_for(entered.wait(), 3)
            busy = await env["api"].delete(path, headers=headers(env), params={"confirmation": preview.json()["confirmation"]})
            assert busy.status_code == 409 and "affecting this customer" in busy.json()["detail"]
        finally:
            finish.set()
            created = await creating
        assert created.status_code == 200, created.text
        stale = await env["api"].delete(path, headers=headers(env), params={"confirmation": preview.json()["confirmation"]})
        assert stale.status_code == 409 and "changed" in stale.json()["detail"]
        fresh = await env["api"].get(path, headers=headers(env))
        assert len(fresh.json()["projects"]) == 2
        assert (await env["api"].delete(path, headers=headers(env), params={"confirmation": fresh.json()["confirmation"]})).status_code == 200
        assert await env["db"].kitchen_projects.count_documents({"deleted_at": {"$exists": False}}) == 0
        late = await env["api"].post("/api/kitchen-projects", headers=headers(env), json={
            "customer_id": project["customer_id"], "idempotency_key": str(uuid4()), "lead": {"site_location": "Must not resurrect"}})
        assert late.status_code in {404, 409}, late.text


@pytest.mark.asyncio
async def test_generic_kitchen_customer_delete_uses_same_fence_with_stranded_global_token(monkeypatch):
    from services.mutation_admission import KEY
    async with environment() as env:
        mount(env, monkeypatch)
        project, _ = await create_project(env)
        await env["db"].settings.update_one({"_id": KEY}, {"$addToSet": {"writers": "legacy-global-writer"}})
        path = "/api/customers/" + project["customer_id"]
        preview = await env["api"].get(path + "/deletion-preview", headers=headers(env))
        assert preview.status_code == 200, preview.text
        response = await env["api"].delete(path, headers=headers(env), params={"confirmation": preview.json()["confirmation"]})
        assert response.status_code == 200, response.text
        gate = await env["db"].settings.find_one({"_id": KEY})
        assert gate["writers"] == ["legacy-global-writer"]
