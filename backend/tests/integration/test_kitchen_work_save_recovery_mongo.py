"""Work entry and retry through the actual Kitchen HTTP and Mongo boundaries."""
import asyncio
from uuid import uuid4

from tests.integration.test_kitchen_projects_mongo import (
    accepted, command, create_project, environment, headers,
)


def test_manual_work_save_retry_and_next_stage_preserve_first_save():
    async def scenario():
        async with environment() as env:
            project, _ = await create_project(env)
            for stage in ("visit", "cad", "design", "quotation", "order", "production"):
                project = await accepted(env, project, "move_stage", {"target_stage": stage})
            original = project
            key = str(uuid4())
            work = {"status": "Completed", "start_date": "2026-10-25", "completion_date": "2026-10-26", "notes": "Actual production completed"}
            saved = await accepted(env, original, "production_update", work, key=key)
            # A lost response is retried against the original version and key.
            replay = await accepted(env, original, "production_update", work, key=key)
            assert replay["replayed"] and replay["version"] == saved["version"]
            project = await accepted(env, replay, "move_stage", {"target_stage": "installation"})
            loaded = await env["api"].get(f"/api/kitchen-projects/{project['id']}", headers=headers(env))
            assert loaded.status_code == 200
            assert loaded.json()["stage"] == "installation"
            assert loaded.json()["production"]["notes"] == work["notes"]
            assert sum(event["type"] == "production_update" for event in loaded.json()["activity"]) == 1
            assert loaded.json()["orders"] == []
    asyncio.run(scenario())


def test_manual_installation_visit_retry_and_invalid_work_leave_saved_values_intact():
    async def scenario():
        async with environment() as env:
            project, _ = await create_project(env)
            for stage in ("visit", "cad", "design", "quotation", "order", "production", "installation"):
                project = await accepted(env, project, "move_stage", {"target_stage": stage})
            visit_key = str(uuid4())
            visit = {"actual": True, "date": "2026-10-26", "notes": "Measured site"}
            original = project
            project = await accepted(env, original, "site_visit", visit, key=visit_key)
            replay = await accepted(env, original, "site_visit", visit, key=visit_key)
            assert replay["site_visit_count"] == 1 and len(replay["site_visits"]) == 1
            assert replay["version"] == project["version"] and replay["replayed"]
            project = await accepted(env, replay, "installation_update", {"status": "In Progress", "start_date": "2026-10-26"})
            before = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            for invalid in (
                {"status": "In Production", "start_date": "2026-10-26"},
                {"status": "Completed", "start_date": "2026-10-26", "completion_date": "2026-10-25"},
                {"status": "Not Started", "start_date": "2026-10-26"},
            ):
                rejected = await command(env, project, "installation_update", invalid)
                assert rejected.status_code == 422
                assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == before
            rejected = await command(env, project, "site_visit", {"actual": True, "date": "2026-10-25"})
            assert rejected.status_code == 422
            assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == before
            project = await accepted(env, project, "installation_update", {"status": "Completed", "start_date": "2026-10-26", "completion_date": "2026-10-26"})
            assert project["stage"] == "installation" and project["site_visit_count"] == 1
            project = await accepted(env, project, "move_stage", {"target_stage": "completed"})
            assert project["stage"] == "completed" and project["installation"]["status"] == "Completed"
    asyncio.run(scenario())
