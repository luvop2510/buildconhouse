"""Real HTTP and Mongo proof of per-stage Kitchen delegation and handoff."""
import asyncio
import copy
from uuid import uuid4

from services.access_grants import KITCHEN_STAGE_RESOURCES, build_grant
from tests.integration.test_kitchen_projects_mongo import environment, headers, reach_stage, command


async def assign(env, stages, actions=("view", "update")):
    from auth import invalidate_principal_cache
    grants = [build_grant(user_id=env["ids"]["worker"], resource=KITCHEN_STAGE_RESOURCES[stage], actions=list(actions),
        floor_id="second-floor", expires_at=None, actor_id=env["ids"]["owner"], actor_name="Owner") for stage in stages]
    await env["db"].users.update_one({"id": env["ids"]["worker"]}, {"$set": {"delegation_grants": grants, "role": "worker"}})
    invalidate_principal_cache("staff", env["ids"]["worker"])


def test_each_stage_scopes_lists_dashboard_detail_and_private_history():
    async def run():
        async with environment() as env:
            original = await reach_stage(env, "order")
            raw = await env["db"].kitchen_projects.find_one({"id": original["id"]})
            ids = {}
            for stage in KITCHEN_STAGE_RESOURCES:
                row = copy.deepcopy(raw)
                row["id"] = row["_id"] = str(uuid4())
                row["stage"] = stage
                row["reference"] = row["project_reference"] = "KIT-" + stage
                await env["db"].kitchen_projects.insert_one(row)
                ids[stage] = row["id"]
            await env["db"].kitchen_projects.delete_one({"id": original["id"]})
            for stage in KITCHEN_STAGE_RESOURCES:
                await assign(env, [stage])
                actor = headers(env, "worker")
                listing = await env["api"].get("/api/kitchen-projects", headers=actor)
                assert listing.status_code == 200, listing.text
                assert listing.json()["total"] == 1 and listing.json()["rows"][0]["id"] == ids[stage]
                dashboard = await env["api"].get("/api/kitchen-projects/dashboard", headers=actor)
                assert dashboard.status_code == 200 and dashboard.json()["total_projects"] == 1
                assert {name for name, count in dashboard.json()["stage_counts"].items() if count} == {stage}
                detail = await env["api"].get(f"/api/kitchen-projects/{ids[stage]}", headers=actor)
                assert detail.status_code == 200, detail.text
                assert detail.json()["access_scoped"] and detail.json()["permissions"]["visible_stages"] == [stage]
                assert detail.json()["activity"] == []
                sibling = "visit" if stage == "lead" else "lead"
                denied = await env["api"].get(f"/api/kitchen-projects/{ids[sibling]}", headers=actor)
                assert denied.status_code in {403, 404}
                forged = await env["api"].get(f"/api/kitchen-projects?stage={sibling}", headers=actor)
                assert forged.status_code == 403
                if stage == "lead":
                    data = detail.json()
                    assert data["orders"] == data["quotation_versions"] == data["design_versions"] == data["attachments"] == []
                    assert data["order_amount"] is None
                    attachment = raw["attachments"][0]["id"]
                    forbidden_file = await env["api"].get(f"/api/kitchen-projects/{ids[stage]}/attachments/{attachment}", headers=actor)
                    assert forbidden_file.status_code == 404
            await assign(env, ["lead", "design"])
            union = await env["api"].get("/api/kitchen-projects", headers=headers(env, "worker"))
            assert union.status_code == 200 and union.json()["total"] == 2
    asyncio.run(run())


def test_stage_handoff_has_actor_bound_minimal_retry_and_no_destination_access():
    async def run():
        async with environment() as env:
            project = await reach_stage(env, "lead")
            await assign(env, ["lead"], ("view", "create", "update"))
            contact = await env["api"].get(f"/api/customers/{project['customer_id']}", headers=headers(env, "worker"))
            assert contact.status_code == 200
            edited = await env["api"].patch(f"/api/customers/{project['customer_id']}", json={"address": "Worker contact correction", "email": None}, headers=headers(env, "worker"))
            assert edited.status_code == 200, edited.text
            created = await env["api"].post("/api/kitchen-projects", json={"customer": {"name": "Worker lead", "phone": "9988776601", "address": "Worker site"}, "idempotency_key": str(uuid4())}, headers=headers(env, "worker"))
            assert created.status_code == 200, created.text
            financial = await command(env, project, "order_installment", {"order_id": "forged", "amount": "1.00", "date": "2026-10-20"}, actor="worker")
            assert financial.status_code == 403
            key = str(uuid4())
            moved = await command(env, project, "move_stage", {"target_stage": "visit"}, actor="worker", key=key)
            assert moved.status_code == 200, moved.text
            assert set(moved.json()) == {"id", "stage", "version", "access_handoff"}
            assert moved.json()["access_handoff"] and moved.json()["stage"] == "visit"
            retry = await command(env, project, "move_stage", {"target_stage": "visit"}, actor="worker", key=key)
            assert retry.status_code == 200 and retry.json()["access_handoff"] and retry.json()["replayed"]
            forbidden = await env["api"].get(f"/api/kitchen-projects/{project['id']}", headers=headers(env, "worker"))
            assert forbidden.status_code in {403, 404}
            changed = await command(env, project, "move_stage", {"target_stage": "cad"}, actor="worker", key=key)
            assert changed.status_code == 409
            unknown = await command(env, project, "move_stage", {"target_stage": "lead"}, actor="worker")
            assert unknown.status_code in {403, 404}
            await assign(env, ["lead"], ("view",))
            revoked = await command(env, project, "move_stage", {"target_stage": "visit"}, actor="worker", key=key)
            assert revoked.status_code == 403
    asyncio.run(run())
