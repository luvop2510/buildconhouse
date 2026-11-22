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
            await database.floors.insert_one({"id": "first-floor", "name": "Sanitary"})
            await database.quotations.insert_one(quote.copy())
            await database.followups.insert_one(legacy.copy())
            await database.users.insert_one({
                "id": employee.id, "full_name": employee.full_name, "role": "sales",
                "active": True, "floor_ids": ["first-floor"],
            })
            first_date, _ = followup_engine.quotation_send_schedule(sent_at, 7)
            async def send(session):
                await followup_engine.schedule_sent_quotation_followup(
                    quote, sent_at=sent_at, actor=employee, due_date=first_date, session=session,
                )
            async with await client.start_session() as session:
                await session.with_transaction(send)
                await session.with_transaction(send)
            assert first_date == today - timedelta(days=1)
            assert await database.followups.count_documents({"scheduled_from_send": True}) == 1
            original = await database.followups.find_one({"scheduled_from_send": True})
            previous = await database.followups.find_one({"id": legacy["id"]})
            assert previous["status"] == "done" and previous["notes"] == legacy["notes"]
            assert followup_engine.compute_bucket(original) == "overdue"
            assert followup_engine.compute_bucket({**original, "due_at": followup_engine.ist_day_bounds_utc()[0].isoformat()}) == "today"

            path = f"/api/followups/{original['id']}"
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://qa") as http:
                async def workspace(**params):
                    response = await http.get("/api/followups/planner", params={
                        "operational": True, "q": quote["number"], **params,
                    })
                    assert response.status_code == 200, response.text
                    return response.json()

                initial = (await http.get(path)).json()
                assert initial["followup"]["bucket"] == "overdue"
                assert (await workspace())["summary"]["overdue"]["count"] == 1
                note = {"note": "Discuss amended delivery", "request_key": "notes-qa-first"}
                assert (await http.post(path + "/notes", json={**note, "note": "  "})).status_code == 422
                actor = foreign_employee
                assert (await http.post(path + "/notes", json=note)).status_code == 404
                actor = employee
                note_writes = await asyncio.gather(*[http.post(path + "/notes", json=note) for _ in range(2)])
                assert [response.status_code for response in note_writes] == [200, 200]
                assert (await http.post(path + "/notes", json={**note, "note": "New content"})).status_code == 409
                latest = (await http.get(path)).json()["followup"]
                assert latest["status"] == "open"
                assert latest["latest_note"] == note["note"]
                assert len(latest["note_history"]) == 1
                saved_note = latest["note_history"][0]
                assert saved_note["note"] == note["note"]
                assert saved_note["actor_name"] == employee.full_name
                assert saved_note["recorded_at"]
                card = (await workspace(category="overdue"))["items"][0]["records"][0]["task"]
                assert card["latest_note"] == note["note"] and card["has_history"]
                actor = employee.model_copy(update={"role": "manager"})
                assert (await http.delete(path)).status_code == 409
                actor = employee
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
                assert first_saved["original_due_at"] == original["due_at"]
                postponed = await workspace(day=first["new_due_date"])
                assert postponed["summary"]["overdue"]["count"] == 0
                assert postponed["summary"]["upcoming"]["count"] == 1
                assert postponed["items"][0]["records"][0]["task"]["due_at"] == first_saved["due_at"]
                # An older reminder may have the audit entries without the explicit original field.
                await database.followups.update_one({"id": original["id"]}, {"$unset": {"original_due_at": ""}})

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
                assert history[0]["previous_due_at"] == original["due_at"] == custom.json()["original_due_at"]

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
                resolved = await workspace(category="completed")
                assert resolved["summary"]["upcoming"]["count"] == 0
                assert {row["id"] for group in resolved["items"] for row in group["records"]} == {original["id"], successor["id"]}

                await database.quotations.update_one({"id": quote["id"]}, {"$set": {
                    "status": "ordered", "ordered_at": now.isoformat(), "grand_total": 200,
                    "items": [{"id": "won-line", "brand_id": "qa-brand", "net_amount": 150}],
                }})
                loss_quote = {
                    **quote, "id": "qa-loss-quotation", "number": "FQ-QA-002", "grand_total": 100,
                    "items": [{"id": "lost-line", "brand_id": "qa-brand", "net_amount": 75}],
                }
                await database.quotations.insert_one(loss_quote)
                active = {key: value for key, value in original.items() if key not in {"_id", "source_key"}}
                await database.followups.insert_many([
                    {**active, "id": "qa-won-followup"},
                    {**active, "id": "qa-lost-followup", "quotation_id": loss_quote["id"],
                     "quotation_number": loss_quote["number"]},
                ])
                won = await http.post("/api/followups/qa-won-followup/log-call", json={"outcome": "won"})
                assert won.status_code == 200, won.text
                assert won.json()["completed_outcome"] == "won"
                lost = await http.post("/api/followups/qa-lost-followup/log-call", json={
                    "outcome": "lost", "notes": "Project paused",
                })
                assert lost.status_code == 200, lost.text
                assert lost.json()["completed_outcome"] == "lost"
                for outcome, number, amount in [("won", quote["number"], 150), ("lost", loss_quote["number"], 75)]:
                    report = await workspace(category=outcome, q=number, brand="qa-brand", period="today")
                    assert report["summary"][outcome]["count"] == 1
                    assert report["summary"][outcome]["amounts"] == [{"currency": "INR", "value": amount}]
                    record = report["items"][0]["records"][0]
                    assert (record["kind"], record["status"], record["quotation_number"]) == ("quotation", outcome, number)
                    assert record["date"] == today.isoformat()
                assert report["items"][0]["records"][0]["lost_reason"] == "Project paused"
        finally:
            await client.drop_database(database.name)
            client.close()

    asyncio.run(run())
