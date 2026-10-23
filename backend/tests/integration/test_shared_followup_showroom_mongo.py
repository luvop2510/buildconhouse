"""Real HTTP transfer/inbox checks using the existing disposable-Mongo harness.

Requires explicitly run-owned KITCHEN_TEST_MONGO_URL; never production startup,
provider calls, migrations of business data or externally configured datasets.
"""
import asyncio
from uuid import uuid4

import pytest

from models import Followup, now_iso
from models_walkins import WalkIn
from routes import followup_routes, walkin_routes
from tests.integration.test_kitchen_projects_mongo import environment, headers
from scripts.repair_showroom_followup_origins import repair


@pytest.mark.parametrize("floor", ["ground-floor", "first-floor", "second-floor", "third-floor"])
@pytest.mark.parametrize("legacy_transferred", [False, True])
def test_assigned_walkin_transfer_is_visible_in_its_floor_showroom_inbox(monkeypatch, floor, legacy_transferred):
    async def scenario():
        async with environment() as env:
            with monkeypatch.context() as patch:
                patch.setattr(walkin_routes, "db", env["db"])
                patch.setattr(followup_routes, "db", env["db"])
                env["app"].include_router(walkin_routes.router, prefix="/api")
                env["app"].include_router(followup_routes.router, prefix="/api")
                walkin_id, customer_id, lead_id, worker = (str(uuid4()) for _ in range(4))
                at = now_iso()
                assignments = [{"floor_id": floor, "user_id": worker, "user_name": "Selected worker"}]
                lead = Followup(id=lead_id, floor_id=floor, customer_id=customer_id,
                    customer_name="Synthetic showroom visitor", customer_phone="9900000042",
                    category="walk_in", origin="walkin", rule_type="manual", walkin_id=walkin_id,
                    assigned_to=worker, assignments=assignments, lead_group_id=lead_id,
                    due_at=at, contact_attempts=4,
                    status="done" if legacy_transferred else "open",
                    completed_at=at if legacy_transferred else None).model_dump()
                walkin = WalkIn(id=walkin_id, floor_id=floor, number="WI-SYNTHETIC",
                    customer_id=customer_id, customer_name=lead["customer_name"], customer_phone=lead["customer_phone"],
                    salesperson_id=worker, assignments=assignments, visited_at=at,
                    scope_followup_id=lead_id,
                    showroom_followup_id=lead_id if legacy_transferred else None,
                    showroom_transferred_at=at if legacy_transferred else None).model_dump()
                other_floor = "ground-floor" if floor != "ground-floor" else "first-floor"
                sibling = {**lead, "id": str(uuid4()), "floor_id": other_floor}
                await env["db"].followups.insert_many([lead, sibling])
                await env["db"].walkins.insert_one(walkin)
                if legacy_transferred:
                    audit = await repair(env["db"], floor)
                    assert audit["candidates"] == 1 and audit["repaired"] == 0
                    assert (await env["db"].followups.find_one({"id": lead_id}))["origin"] == "walkin"
                    assert (await repair(env["db"], floor, apply=True))["repaired"] == 1
                    assert (await repair(env["db"], floor, apply=True))["candidates"] == 0
                request_headers = headers(env, floor=floor)
                endpoint = f"/api/walkins/{walkin_id}/visit-showroom"
                first = await env["api"].post(endpoint, headers=request_headers)
                assert first.status_code == 200, first.text
                again = await env["api"].post(endpoint, headers=request_headers)
                assert again.json() == first.json() == {"walkin_id": walkin_id, "followup_id": lead_id}

                # Actual database-side origin filter and aggregation, not a mocked response shape.
                page = await env["api"].get("/api/followups/page?origin=visit_showroom", headers=request_headers)
                assert page.status_code == 200, page.text
                assert [row["id"] for row in page.json()["items"]] == [lead_id]
                saved = await env["db"].followups.find_one({"id": lead_id}, {"_id": 0})
                assert saved["origin"] == "visit_showroom"
                for field in ("assigned_to", "assignments", "lead_group_id", "status", "completed_at", "due_at", "contact_attempts"):
                    assert saved[field] == lead[field], field
                assert await env["db"].followups.count_documents({"floor_id": floor}) == 1
                assert (await env["db"].followups.find_one({"id": sibling["id"]}))["origin"] == "walkin"
                wrong_floor = await env["api"].get("/api/followups/page?origin=visit_showroom", headers=headers(env, floor=other_floor))
                assert wrong_floor.json()["items"] == []
                register = await env["api"].get("/api/walkins", headers=request_headers)
                assert register.status_code == 200 and register.json() == []
                events = await env["db"].activity_events.find({"event_type": "walkin.visit_showroom"}, {"_id": 0}).to_list(10)
                assert len(events) == (0 if legacy_transferred else 1)
                if events:
                    assert events[0]["floor_id"] == floor

    asyncio.run(scenario())


def test_showroom_repair_refuses_ambiguous_customer_or_missing_followup():
    async def scenario():
        async with environment() as env:
            database = env["db"]
            floor = "first-floor"
            base = {"floor_id": floor, "is_deleted": False, "showroom_transferred_at": now_iso()}
            await database.walkins.insert_many([
                {**base, "id": "walkin-wrong", "customer_id": "customer-a", "showroom_followup_id": "wrong"},
                {**base, "id": "walkin-missing", "customer_id": "customer-b", "showroom_followup_id": "missing"},
            ])
            row = {"id": "wrong", "floor_id": floor, "origin": "walkin", "rule_type": "manual",
                   "walkin_id": "walkin-wrong", "customer_id": "another-customer", "status": "snoozed"}
            await database.followups.insert_one(dict(row))
            result = await repair(database, floor, apply=True)
            assert result["candidates"] == result["repaired"] == 0
            assert result["conflicts"] == 2
            assert await database.followups.count_documents({}) == 1
            assert await database.followups.find_one({"id": "wrong"}, {"_id": 0}) == row
    asyncio.run(scenario())
