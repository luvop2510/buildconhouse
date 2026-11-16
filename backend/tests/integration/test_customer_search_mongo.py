"""Run-owned Mongo + real authenticated Home search API acceptance.

Run only this file with KITCHEN_TEST_MONGO_URL and hermetic runtime settings.
The shared harness creates/drops a random database and never boots production.
"""
import asyncio
from uuid import uuid4

from auth import invalidate_principal_cache
from services.access_grants import build_grant
from tests.integration.test_kitchen_projects_mongo import environment, headers, create_project


def test_home_search_real_phone_matching_complete_profile_and_source_permissions():
    async def scenario():
        async with environment() as env:
            project, _ = await create_project(env)
            customer = env["ids"]["customer"]
            await env["db"].customers.update_one({"id": customer}, {"$set": {"phone": "+91 (98765) 43210"}})
            await env["db"].kitchen_projects.update_one({"id": project["id"]}, {"$set": {
                "customer.phone": "+91 (98765) 43210", "stage": "completed", "completion_date": "2026-11-15",
                "installation": {"status": "Completed", "notes": "Saved installation history", "completed_date": "2026-11-15"},
                "activity": [{"id": "past-stage", "type": "stage.changed", "at": "2026-11-14", "actor_id": env["ids"]["owner"], "payload": {"from_stage": "installation", "to_stage": "completed"}}],
                "attachments": [{"id": "saved-pdf", "filename": "design.pdf", "content_type": "application/pdf", "stage": "design", "storage_key": "private-object", "bucket": "private"}]}})
            await env["db"].kitchen_stage_followups.insert_one({"id": "interaction", "floor_id": "second-floor", "project_id": project["id"], "customer_id": customer, "stage": "lead", "number": 1, "date": "2026-11-10", "interaction_type": "Call", "notes": "Saved inquiry call", "request_fingerprint": "private"})
            await env["db"].customers.insert_one({"id": str(uuid4()), "floor_id": "first-floor", "name": "Other floor Meena", "phone": "+91 (98765) 43210"})
            for term in ("Kitchen acceptance customer", "acceptance cust", "9876543210", "98765", "+91 98765 43210"):
                response = await env["api"].get("/api/customer-search", params={"search": term}, headers=headers(env))
                assert response.status_code == 200, response.text
                rows = response.json()["rows"]
                assert any(row["kind"] == "kitchen" and row["id"] == project["id"] for row in rows)
                if "98765" in term:
                    assert {row["floor_id"] for row in rows} == {"first-floor", "second-floor"}
            response = await env["api"].get("/api/customer-search/profile", params={"kind": "kitchen", "id": project["id"], "floor_id": "second-floor"}, headers=headers(env))
            assert response.status_code == 200, response.text
            assert response.headers["cache-control"] == "no-store"
            record = next(row["data"] for row in response.json()["records"] if row["kind"] == "kitchen")
            assert record["completion_date"] == "2026-11-15"
            assert record["installation"]["notes"] == "Saved installation history"
            assert record["activity"][0]["payload"]["from_stage"] == "installation"
            assert record["follow_ups"][0]["notes"] == "Saved inquiry call"
            assert record["attachments"][0]["filename"] == "design.pdf"
            assert "private-object" not in response.text and '"request_fingerprint"' not in response.text
            # The normal Kitchen worker has this floor only, so same phone on
            # another floor never enlarges the consolidated identity.
            response = await env["api"].get("/api/customer-search", params={"search": "98765"}, headers=headers(env, "worker"))
            assert response.status_code == 200
            assert all(row["floor_id"] == "second-floor" for row in response.json()["rows"])
            # Replace all-section access with a single stage grant. Current-stage
            # Completed records and their direct profile must disappear.
            grant = build_grant(user_id=env["ids"]["worker"], resource="kitchen_design", actions=["view"], floor_id="second-floor", expires_at=None, actor_id=env["ids"]["owner"], actor_name="Synthetic owner")
            await env["db"].users.update_one({"id": env["ids"]["worker"]}, {"$set": {"delegation_grants": [grant]}})
            invalidate_principal_cache("staff", env["ids"]["worker"])
            response = await env["api"].get("/api/customer-search", params={"search": "98765"}, headers=headers(env, "worker"))
            assert response.status_code == 200 and response.json()["rows"] == [], response.text
            response = await env["api"].get("/api/customer-search/profile", params={"kind": "kitchen", "id": project["id"], "floor_id": "second-floor"}, headers=headers(env, "worker"))
            assert response.status_code == 404
            # A customer soft deletion also retires related shared source rows.
            await env["db"].customers.update_one({"id": customer}, {"$set": {"deleted_at": "2026-11-16"}})
            await env["db"].followups.insert_one({"id": "old-shared", "floor_id": "second-floor", "customer_id": customer, "customer_name": "Kitchen acceptance customer"})
            response = await env["api"].get("/api/customer-search", params={"search": "Kitchen acceptance customer"}, headers=headers(env))
            assert response.status_code == 200 and response.json()["rows"] == [], response.text
    asyncio.run(scenario())
