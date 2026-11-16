"""Real HTTP/auth/Mongo acceptance; only a run-owned loopback database is allowed."""
import asyncio
import importlib
from uuid import uuid4

import pytest

from models_kitchen import STAGES
from tests.integration.test_kitchen_projects_mongo import environment, headers, create_project, accepted


async def indexes(env):
    migration = importlib.import_module("migrations.0045_kitchen_stage_followups")
    await migration.up(env["db"])
    await migration.up(env["db"])


def entry(stage="lead", **fields):
    return {"stage": stage, "date": "2026-09-14", "notes": "Asked about the next visit", "interaction_type": "Visit",
            "idempotency_key": str(uuid4()), **fields}


@pytest.mark.asyncio
async def test_interactions_all_actual_stages_remain_persistent_after_stage_movement():
    async with environment() as env:
        await indexes(env)
        project, _ = await create_project(env)
        path = f"/api/kitchen-projects/{project['id']}/follow-ups"
        before = await env["db"].kitchen_projects.find_one({"id": project["id"]})
        for stage in STAGES:
            for number in (1, 2, 3):
                response = await env["api"].post(path, headers=headers(env), json=entry(stage, interaction_type="Call" if number == 2 else "Visit"))
                assert response.status_code == 200, response.text
                record = response.json()
                assert (record["number"], record["stage"], record["customer_id"], record["date"]) == (number, stage, project["customer_id"], "2026-09-14")
                assert "_id" not in record and "request_fingerprint" not in record
            result = await env["api"].get(path, headers=headers(env), params={"stage": stage})
            assert result.headers["cache-control"] == "no-store"
            assert [row["number"] for row in result.json()["rows"]] == [3, 2, 1]
        after = await env["db"].kitchen_projects.find_one({"id": project["id"]})
        assert before == after, "Recording an interaction must never mutate workflow/version/history"
        moved = await accepted(env, project, "convert")
        assert moved["stage"] == "visit"
        history = await env["api"].get(path, headers=headers(env))
        assert history.json()["total"] == len(STAGES) * 3
        assert len(history.json()["rows"]) == len(STAGES) * 3


@pytest.mark.asyncio
async def test_unique_sequence_concurrency_retry_and_literal_validation():
    async with environment() as env:
        await indexes(env)
        project, _ = await create_project(env)
        path = f"/api/kitchen-projects/{project['id']}/follow-ups"
        payload = entry()
        repeated = await asyncio.gather(*(env["api"].post(path, headers=headers(env), json=payload) for _ in range(5)))
        assert all(response.status_code == 200 for response in repeated), [response.text for response in repeated]
        assert {response.json()["number"] for response in repeated} == {1}
        assert await env["db"].kitchen_stage_followups.count_documents({"project_id": project["id"]}) == 1
        concurrent = await asyncio.gather(*(env["api"].post(path, headers=headers(env), json=entry()) for _ in range(5)))
        assert all(response.status_code == 200 for response in concurrent), [response.text for response in concurrent]
        assert sorted(response.json()["number"] for response in concurrent) == [2, 3, 4, 5, 6]
        changed = await env["api"].post(path, headers=headers(env), json={**payload, "notes": "Different intent"})
        assert changed.status_code == 409
        for patch in ({"date": ""}, {"date": "2026-02-30"}, {"interaction_type": "Email"}, {"number": 99}, {"notes": "Line one\nLine two"}):
            response = await env["api"].post(path, headers=headers(env), json={**entry(), **patch})
            assert response.status_code == 422, response.text
        assert await env["db"].kitchen_stage_followups.count_documents({"project_id": project["id"]}) == 6


@pytest.mark.asyncio
async def test_direct_authorization_and_history_stage_scope():
    async with environment() as env:
        import auth
        from services.access_grants import build_grant
        await indexes(env)
        project, _ = await create_project(env)
        path = f"/api/kitchen-projects/{project['id']}/follow-ups"
        for stage in ("lead", "design"):
            response = await env["api"].post(path, headers=headers(env), json=entry(stage))
            assert response.status_code == 200, response.text
        worker_id = env["ids"]["worker"]
        grant = build_grant(user_id=worker_id, resource="kitchen_lead", actions=["view", "update"], floor_id="second-floor",
            expires_at=None, actor_id=env["ids"]["owner"], actor_name="Owner")
        await env["db"].users.update_one({"id": worker_id}, {"$set": {"delegation_grants": [grant]}})
        auth.invalidate_principal_cache("staff", worker_id)
        allowed = await env["api"].get(path, headers=headers(env, "worker"))
        assert allowed.status_code == 200, allowed.text
        assert allowed.json()["total"] == 1
        assert {row["stage"] for row in allowed.json()["rows"]} == {"lead"}
        allowed_write = await env["api"].post(path, headers=headers(env, "worker"), json=entry())
        assert allowed_write.status_code == 200, allowed_write.text
        for method, query in (("get", {"params": {"stage": "design"}}), ("post", {"json": entry("design")})):
            denied = await getattr(env["api"], method)(path, headers=headers(env, "worker"), **query)
            assert denied.status_code == 403, denied.text
        for selected_headers in (headers(env, "denied"), headers(env, floor="first-floor")):
            denied = await env["api"].post(path, headers=selected_headers, json=entry())
            assert denied.status_code in {403, 404}, denied.text
        missing = await env["api"].post("/api/kitchen-projects/missing/follow-ups", headers=headers(env), json=entry())
        assert missing.status_code == 404
        assert await env["db"].kitchen_stage_followups.count_documents({"project_id": project["id"]}) == 3
