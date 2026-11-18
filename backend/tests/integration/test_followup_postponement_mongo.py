"""Follow-up commands against an isolated local Mongo replica set."""
import asyncio
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from motor.motor_asyncio import AsyncIOMotorClient


def test_send_schedule_postpone_history_and_contact_outcome(monkeypatch):
    uri = os.environ.get("WORKFLOW_TEST_MONGO_URL")
    if not uri or not uri.startswith("mongodb://127.0.0.1:"):
        pytest.skip("Set WORKFLOW_TEST_MONGO_URL to a run-owned local replica set")

    import auth
    import db as connection
    from models import UserPublic
    from routes import followup_routes
    from services import activity_log, followup_engine

    async def run():
        client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=3000)
        database = client[f"followup_workflow_test_{uuid4().hex}"]
        monkeypatch.setattr(connection, "client", client)
        for module in (auth, activity_log, followup_routes, followup_engine):
            monkeypatch.setattr(module, "db", database)
        employee = UserPublic(id="qa-employee", email="employee@example.test", full_name="QA Employee", role="sales",
                              floor_ids=["first-floor"], active_floor_id="first-floor")
        foreign_employee = UserPublic(id="qa-other-floor", email="other@example.test", full_name="Other Department", role="sales",
                                      floor_ids=["ground-floor"], active_floor_id="ground-floor")
        actor = employee
        app = FastAPI()
        app.include_router(followup_routes.router, prefix="/api")
        app.dependency_overrides[auth.get_current_user] = lambda: actor
        now = datetime.now(timezone.utc)
        today = now.astimezone(followup_engine.IST).date()
        sent_at = now - timedelta(days=8)
        quote = {
            "id": "qa-quotation", "number": "FQ-QA-001", "customer_id": "qa-customer", "customer_name": "QA Customer",
            "floor_id": "first-floor", "doc_type": "standard", "status": "sent",
        }
        legacy = {
            "id": "old-pdf-reminder", "floor_id": "first-floor", "quotation_id": quote["id"], "status": "open",
            "automation_key": "quotation-generated:qa-quotation:revision:1:followup", "notes": "Historical review note",
        }
        try:
            await database.quotations.insert_one(quote.copy())
            await database.followups.insert_one(legacy.copy())
            await database.users.insert_one({
                "id": employee.id, "full_name": employee.full_name, "role": "sales",
                "active": True, "floor_ids": ["first-floor"],
            })
            async def send(session):
                return await followup_engine.schedule_sent_quotation_followup(quote, sent_at=sent_at, actor=employee, session=session)
            async with await client.start_session() as session:
                first_date = await session.with_transaction(send)
                assert await session.with_transaction(send) == first_date
            assert first_date == (today - timedelta(days=1)).isoformat()
            assert await database.followups.count_documents({"scheduled_from_send": True}) == 1
            original = await database.followups.find_one({"scheduled_from_send": True})
            previous = await database.followups.find_one({"id": legacy["id"]})
            assert previous["status"] == "done" and previous["notes"] == legacy["notes"]
            assert followup_engine.compute_bucket(original) == "overdue"
            assert followup_engine.compute_bucket({**original, "due_at": followup_engine.ist_day_bounds_utc()[0].isoformat()}) == "today"

            path = f"/api/followups/{original['id']}"
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://qa") as http:
                initial = (await http.get(path)).json()
                assert initial["followup"]["bucket"] == "overdue"
                first = {
                    "expected_due_at": original["due_at"],
                    "new_due_date": (today + timedelta(days=1)).isoformat(),
                    "reason": "Customer is travelling",
                }
                assert (await http.post(path + "/postpone", json={**first, "reason": "  "})).status_code == 422
                assert (await http.post(path + "/postpone", json={**first, "new_due_date": today.isoformat()})).status_code == 422
                assert (await http.patch(path, json={"due_at": first["new_due_date"]})).status_code == 422
                assert (await http.post(path + "/snooze", json={"preset": "tomorrow"})).status_code == 422
                actor = foreign_employee
                assert (await http.post(path + "/postpone", json=first)).status_code == 404
                actor = employee
                replies = await asyncio.gather(*[http.post(path + "/postpone", json=first) for _ in range(2)])
                assert [response.status_code for response in replies] == [200, 200]
                first_saved = replies[0].json()
                assert first_saved["bucket"] == "tomorrow"
                assert len(first_saved["postponement_history"]) == 1

                third_day = await http.post(path + "/postpone", json={
                    "expected_due_at": first_saved["due_at"], "new_due_date": (today + timedelta(days=4)).isoformat(),
                    "reason": "Requested three more days",
                })
                assert third_day.status_code == 200, third_day.text
                assert (await http.post(path + "/postpone", json={**first, "reason": "Conflicting update"})).status_code == 409
                custom = await http.post(path + "/postpone", json={
                    "expected_due_at": third_day.json()["due_at"], "new_due_date": (today + timedelta(days=12)).isoformat(),
                    "reason": "Available after handover",
                })
                assert custom.status_code == 200, custom.text
                assert custom.json()["bucket"] == "later"
                history = (await http.get(path)).json()["followup"]["postponement_history"]
                assert [row["reason"] for row in history] == [first["reason"], "Requested three more days", "Available after handover"]
                assert all(row["actor_id"] == employee.id and row["actor_name"] == employee.full_name and row["changed_at"] for row in history)

                outcome = {
                    "outcome": "pending", "notes": "Shared revised delivery estimate",
                    "response": "Call after confirmation",
                    "next_followup_at": (now + timedelta(days=14)).isoformat(), "request_key": "outcome-qa-pending",
                }
                first_outcome, retry = await asyncio.gather(*[http.post(path + "/log-call", json=outcome) for _ in range(2)])
                assert [response.status_code for response in (first_outcome, retry)] == [200, 200], [first_outcome.text, retry.text]
                assert first_outcome.json()["completed_outcome"] == "pending"
                assert (await http.post(path + "/log-call", json={**outcome, "notes": "Different note"})).status_code == 409
                assert await database.followups.count_documents({"previous_followup_id": original["id"]}) == 1
                successor = await database.followups.find_one({"previous_followup_id": original["id"]})
                assert successor["status"] == "open"
                completed = (await http.get(path)).json()["followup"]
                assert completed["bucket"] == "completed"
                assert len(completed["call_history"]) == 1 and completed["call_history"][0]["notes"] == outcome["notes"]
                assert completed["postponement_history"] == history
                assert (await http.post(path + "/postpone", json=first)).status_code == 409
                completed_successor = await http.post(f"/api/followups/{successor['id']}/complete", json={})
                assert completed_successor.json()["bucket"] == "completed"
        finally:
            await client.drop_database(database.name)
            client.close()

    asyncio.run(run())
