"""Date, scope and monetary reconciliation using a run-owned Mongo database."""
import asyncio
from datetime import datetime, timezone
import os
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, Request
from motor.motor_asyncio import AsyncIOMotorClient


def test_planner_calculations_filters_and_permissions(monkeypatch):
    uri = os.environ.get("WORKFLOW_TEST_MONGO_URL")
    if not uri or not uri.startswith("mongodb://127.0.0.1:"):
        pytest.skip("Set WORKFLOW_TEST_MONGO_URL to a run-owned local Mongo instance")

    import auth
    from models import UserPublic
    from routes import followup_routes as routes
    from services import followup_planner as planner
    from services.access_grants import build_grant

    async def run():
        mongo = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=3000)
        db = mongo[f"planner_test_{uuid4().hex}"]
        monkeypatch.setattr(auth, "db", db)
        monkeypatch.setattr(routes, "db", db)

        async def fixed_clock(*args, **kwargs):
            return await planner.load_planner(*args, now=datetime(2026, 11, 20, 18, 35, tzinfo=timezone.utc), **kwargs)

        floor = "first-floor"
        actor = UserPublic(id="nikhil", email="nikhil@example.test", full_name="Nikhil", role="sales",
                           floor_ids=[floor], active_floor_id=floor)

        async def current_user(request: Request):
            return await auth.authorize_staff_request(actor.model_copy(deep=True), request)

        monkeypatch.setattr(routes, "load_planner", fixed_clock)
        app = FastAPI()
        app.include_router(routes.router, prefix="/api")
        app.dependency_overrides[auth.get_current_user] = current_user

        def quote(identity, **overrides):
            return {"id": identity, "number": "FQ-" + identity, "floor_id": floor, "customer_id": "ramesh",
                    "customer_name": "Ramesh", "created_by": actor.id, "created_at": "2026-11-18",
                    "status": "draft", "grand_total": 175,
                    "items": [{"id": "1", "brand_id": "grohe", "net_amount": 100},
                              {"id": "2", "brand_id": "vitra", "net_amount": 50}], **overrides}

        def task(identity, **overrides):
            return {"id": identity, "floor_id": floor, "customer_id": "ramesh", "customer_name": "Ramesh",
                    "customer_phone": "9825000000", "quotation_id": "pending", "quotation_number": "FQ-pending",
                    "due_at": "2026-11-20T18:30:00+00:00", "status": "open", "assigned_to": actor.id, **overrides}

        try:
            await db.floors.insert_many([{"id": floor, "name": "Sanitary"}, {"id": "ground-floor", "name": "Ground"}])
            await db.brands.insert_many([{"id": key, "name": key, "floor_id": scope} for key, scope in
                                         [("grohe", floor), ("vitra", floor), ("private", "ground-floor")]])
            await db.customers.insert_many([{"id": key, "floor_id": floor, "name": "Ramesh", "phone": "9825000000"}
                                            for key in ["ramesh", "ramesh-unrelated"]])
            await db.users.insert_one({**actor.model_dump(), "active": True})
            await db.quotations.insert_many([
                quote("pending", revisions=[{"snapshot": {"grand_total": 9000}}]),
                quote("won", status="ordered", ordered_at="2026-11-05T18:30:00Z", created_at="2026-05-02"),
                quote("lost", customer_outcome="lost", outcome_at="2026-07-08", outcome_reason="Budget",
                      created_at="2026-05-03", updated_at="2026-11-21"),
                quote("undated", customer_outcome="lost", quotation_import={"batch_id": "legacy"},
                      doc_date="19-Nov-2026", updated_at="2026-11-21"),
                quote("created-only"),
                quote("foreign", floor_id="ground-floor", customer_id="private"),
                quote("converted-tile", floor_id="ground-floor", doc_type="tiles_quotation",
                      customer_id="private", created_at="2026-10-02"),
            ])
            await db.activity_events.insert_many([
                {"event_type": "walkin.quotation_created", "entity_type": "walkin",
                 "quotation_id": "converted-tile", "customer_id": "private", "created_at": "2026-11-19"},
                {"event_type": "walkin.quotation_created", "entity_type": "walkin",
                 "quotation_id": "converted-tile", "customer_id": "wrong-client", "created_at": "2026-10-03"},
            ])
            await db.followups.insert_many([
                task("today", latest_note="Revised delivery discussed", origin="visit_showroom", walkin_id="showroom-lead",
                     priority_level="low", manual_priority_override="high", rule_type="manual", category="general",
                     pending_call_id="private", note_history=[{"note": "Revised delivery discussed", "request_hash": "private"}]),
                task("overdue", due_at="2026-11-20T18:29:00+00:00"),
                task("monday", due_at="2026-11-23", assigned_to="manoj", assigned_to_name="Manoj"),
                task("done", status="done", due_at="2026-11-17", completed_at="2026-11-20"),
                task("order-reminder", quotation_id="won", due_at="2026-11-19"),
                task("loss-reminder", quotation_id="lost", due_at="2026-11-19"),
                task("later-legacy-loss", quotation_id="undated", status="dismissed", completed_outcome="lost",
                     completed_at="2026-11-20T18:30:00+00:00"),
                task("same-phone", customer_id="ramesh-unrelated", quotation_id=None, quotation_number=None),
                task("forbidden", floor_id="ground-floor", customer_id="private"),
            ])
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://qa") as http:
                path = "/api/followups/planner"

                async def report(**params):
                    response = await http.get(path, params=params)
                    assert response.status_code == 200, response.text
                    return response.json()

                all_rows = await report(department="all")
                counts = all_rows["summary"]
                assert all_rows["today"] == "2026-11-21"
                assert (counts["today"]["count"], counts["overdue"]["count"]) == (2, 1)
                assert counts["all"]["amounts"] == [{"currency": "INR", "value": 875}]
                assert len(all_rows["items"]) == counts["all"]["customers"] == 2
                assert [option["id"] for option in all_rows["options"]["departments"]] == [floor]
                assert {option["id"] for option in all_rows["options"]["brands"]} == {"grohe", "vitra"}
                assert (await report(page_size=1))["has_more"] is True
                assert (await report(page=2, page_size=1))["has_more"] is False

                monday = await report(category="upcoming", week=1, day="2026-11-23", assigned_to="manoj")
                assert monday["schedule"][0]["day"] == "2026-11-23"
                assert monday["schedule"][0]["count"] == 1
                assert monday["items"][0]["records"][0]["id"] == "monday"
                assert (await report(q="+91 (98250) 00000"))["summary"]["today"]["count"] == 2
                assert (await report(category="today", q="FQ-pending"))["items"][0]["records"][0]["notes"] == "Revised delivery discussed"
                assert (await report(category="completed", period="last_7_days"))["summary"]["completed"]["count"] == 1
                assert (await report(category="created", period="this_week"))["summary"]["created"]["count"] == 3
                workload = await report(category="active", assigned_to="manoj")
                assert workload["summary"]["active"]["amounts"] == workload["employees"][0]["amounts"]
                assert [row["id"] for group in workload["items"] for row in group["records"]] == ["monday"]

                won = await report(category="won", period="last_30_days", brand="grohe", assigned_to=actor.id)
                assert won["summary"]["won"]["count"] == 1
                assert won["summary"]["won"]["amounts"] == [{"currency": "INR", "value": 100}]
                assert won["items"][0]["records"][0]["date"] == "2026-11-06"
                assert won["brands"][0]["won_amounts"] == won["summary"]["won"]["amounts"]
                lost = await report(category="lost", period="last_6_months")
                assert lost["summary"]["lost"]["count"] == lost["summary"]["lost"]["missing_dates"] == 1
                assert lost["items"][0]["records"][0]["lost_reason"] == "Budget"
                brand_outcomes = await report(category="outcomes", brand="grohe", period="last_6_months")
                assert brand_outcomes["summary"]["outcomes"]["count"] == 2
                assert brand_outcomes["summary"]["outcomes"]["amounts"] == [{"currency": "INR", "value": 200}]

                operational = await report(operational=True, department="all")
                rows = [row for group in operational["items"] for row in group["records"]]
                assert operational["operational"] is True
                assert len(rows) == operational["summary"]["all"]["count"] == 6
                assert all(row["kind"] == "followup" for row in rows)
                assert rows[0]["task"]["bucket"] == "overdue"
                assert operational["summary"]["all"]["customers"] == len(operational["items"]) == 2
                assert next(row for row in rows if row["id"] == "today")["task"]["has_history"] is True

                filtered = await report(operational=True, workspace="visit_showroom", period="last_30_days",
                                        category="today", assigned_to="nikhil,manoj", brand="grohe",
                                        priority="critical,high", task_category="general", q="FQ-pending")
                card = filtered["items"][0]["records"][0]["task"]
                assert (card["id"], card["walkin_id"], card["value"], card["bucket"]) == ("today", "showroom-lead", 100, "today")
                assert card["latest_note"] == "Revised delivery discussed"
                assert card["effective_priority_level"] == "high"
                assert "pending_call_id" not in card and "note_history" not in card
                assert filtered["summary"]["today"]["count"] == filtered["brands"][0]["today"] == 1
                assert filtered["summary"]["today"]["amounts"] == filtered["brands"][0]["workload_amounts"]
                assert filtered["summary"]["today"]["amounts"] == filtered["employees"][0]["amounts"]

                scheduled = await report(operational=True, day="2026-11-20")
                assert scheduled["items"][0]["records"][0]["id"] == "overdue"
                assert scheduled["schedule"][4]["day"] == "2026-11-20"
                assert scheduled["schedule"][4]["count"] == 1
                previous_week = await report(operational=True, week=-1)
                assert previous_week["schedule"][0]["day"] == "2026-11-09"
                saved_completed_today = await report(operational=True, legacy_bucket="completed_today")
                assert [row["id"] for group in saved_completed_today["items"] for row in group["records"]] == ["later-legacy-loss"]

                work = await report(category="overdue", scope="work")
                assert work["reports_available"] is False and "won" not in work["summary"]
                assert work["items"][0]["records"][0]["id"] == "overdue"
                assert (await http.get(path, params={"department": "ground-floor"})).status_code == 403

                await db.followups.update_one({"id": "overdue"}, {"$set": {"due_at": "2026-11-24"}})
                assert (await report(category="overdue"))["summary"]["overdue"]["count"] == 0
                assert (await report(category="upcoming", day="2026-11-24"))["items"][0]["records"][0]["id"] == "overdue"

                actor.custom_access = True
                grant = build_grant(user_id=actor.id, resource="followups", actions=["view"], floor_id=floor,
                                    expires_at=None, actor_id="owner", actor_name="Owner")
                await db.users.update_one({"id": actor.id}, {"$set": {"delegation_grants": [grant]}})
                await db.quotations.update_one({"id": "pending"}, {"$set": {
                    "doc_number": "QA-QUOTATION-ONLY", "doc_type": "standard", "grand_total": 700,
                }})
                await db.followups.update_one({"id": "today"}, {"$set": {"value": 19}})
                delegated = await report(department="all")
                assert delegated["summary"]["created"]["count"] == 0
                assert delegated["summary"]["today"]["count"] == 2
                denied = await report(operational=True, category="today", q="FQ-pending")
                visible_reminder = denied["items"][0]["records"][0]
                assert visible_reminder["quotation_number"] == visible_reminder["task"]["quotation_number"] == "FQ-pending"
                assert visible_reminder["value"] is None and visible_reminder["task"]["value"] == 19
                assert visible_reminder["doc_type"] is None and visible_reminder["brands"] == []
                assert denied["summary"]["today"]["amounts"] == denied["options"]["brands"] == []
                assert not (await report(operational=True, q="QA-QUOTATION-ONLY"))["items"]
                assert not (await report(category="today", q="FQ-pending"))["summary"]["today"]["amounts"]
                assert not (await report(operational=True, brand="grohe", scope="work"))["items"]

                actor = actor.model_copy(update={"role": "owner", "custom_access": False, "active_floor_id": "ground-floor"})
                legacy_conversion = await report(category="created", period="this_week", q="FQ-converted-tile")
                assert legacy_conversion["summary"]["created"]["count"] == 1
                record = legacy_conversion["items"][0]["records"][0]
                assert record["id"] == "converted-tile" and record["date"] == "2026-11-19"

                await db.floors.insert_one({"id": "third-floor", "name": "Furniture"})
                await db.users.insert_one({"id": "former-owner", "full_name": "Former Owner", "active": False, "role": "owner"})
                await db.followups.insert_one(task("furniture", floor_id="third-floor", customer_id="furniture-client",
                                                   quotation_id=None, assigned_to="former-owner", assigned_to_name="Former Owner"))
                furniture = await report(operational=True, department="third-floor")
                assert [(owner["id"], owner["today"]) for owner in furniture["employees"]] == [("unassigned", 1)]
                assert furniture["items"][0]["records"][0]["task"]["assigned_to_name"] is None
                assert (await report(operational=True, department="third-floor", assigned_to="unassigned"))["items"]

                grants = [
                    build_grant(user_id=actor.id, resource=resource, actions=["view"], floor_id="third-floor",
                                expires_at=None, actor_id="owner", actor_name="Owner")
                    for resource in ("followups", "furniture_quotations")
                ]
                await db.users.update_one({"id": actor.id}, {"$set": {"delegation_grants": grants, "floor_ids": ["third-floor"]}})
                await db.quotations.insert_one(quote("private-standard", floor_id="third-floor", customer_id="furniture-client"))
                await db.furniture_quotations.insert_one({
                    "id": "accessible-rnb", "floor_id": "third-floor", "customer_id": "furniture-client",
                    "created_at": "2026-11-19", "total_payable_rmb": 230,
                })
                await db.followups.update_one({"id": "furniture"}, {"$set": {"quotation_id": "private-standard", "quotation_number": "Saved reference"}})
                actor = actor.model_copy(update={"role": "sales", "custom_access": True, "active_floor_id": "third-floor",
                                                 "floor_ids": ["third-floor"]})
                scoped_furniture = await report(operational=True, category="created")
                assert scoped_furniture["summary"]["created"]["amounts"] == [{"currency": "RNB", "value": 230}]
                assert [row["id"] for group in scoped_furniture["items"] for row in group["records"]] == ["accessible-rnb"]
                scoped_reminder = (await report(operational=True, category="today"))["items"][0]["records"][0]
                assert scoped_reminder["quotation_number"] == "Saved reference" and scoped_reminder["brands"] == []
        finally:
            await mongo.drop_database(db.name)
            mongo.close()

    asyncio.run(run())
