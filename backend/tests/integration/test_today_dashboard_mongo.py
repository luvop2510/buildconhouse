"""Real Mongo aggregation contract; requires an explicit isolated test endpoint."""
import os
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from motor.motor_asyncio import AsyncIOMotorClient

from models import UserPublic
from services.today_dashboard import today_dashboard, today_overview

pytestmark = pytest.mark.skipif(not os.getenv("TEST_TODAY_MONGO_URL"), reason="Explicit isolated Today MongoDB required")


@pytest.mark.asyncio
async def test_today_dates_counts_floor_scope_and_department_projection():
    client = AsyncIOMotorClient(os.environ["TEST_TODAY_MONGO_URL"], serverSelectionTimeoutMS=3000)
    name = "forge_today_test_" + uuid4().hex
    db = client[name]
    now = datetime(2026, 10, 29, 0, 15, tzinfo=timezone.utc)
    floor = "first-floor"
    def followup(identity, **extra):
        return {"id": identity, "floor_id": floor, "status": "open", "category": "quotation", "rule_type": "manual",
                "customer_name": "Customer", "due_at": "2026-10-29T01:00:00Z", "value": 1234, "customer_phone": "private", **extra}
    actor = UserPublic(id="person", email="person@example.com", full_name="Person", role="owner", active_floor_id=floor)
    try:
        await db.customers.insert_many([
            {"id": "customer-a", "floor_id": floor, "name": "Customer", "phone": "9000000000"},
            {"id": "customer-a-copy", "floor_id": floor, "name": "Customer", "phone": "+91 90000 00000",
             "imported_from_customer_id": "customer-a"},
            {"id": "customer-b", "floor_id": floor, "name": "Customer", "phone": "9000000000"},
        ])
        await db.followups.insert_many([
            followup("today", customer_id="customer-a", project_name="Apartment renovation"),
            followup("overdue", customer_id="customer-b", due_at="2026-10-28T18:29:59Z"),
            followup("snoozed", status="snoozed", due_at="2026-10-26T00:00:00Z", snoozed_until="2026-10-30T00:00:00Z"),
            followup("done", status="done", completed_at="2026-10-28T18:30:00Z"),
            followup("foreign", floor_id="ground-floor"), followup("payment", category="payment"),
        ])
        await db.walkins.insert_many([
            {"id": "walkin", "floor_id": floor, "status": "selection_scheduled", "customer_name": "Visit", "next_followup_at": "2026-10-29T10:00:00Z"},
            {"id": "no-date", "floor_id": floor, "status": "new", "customer_name": "Undated"},
        ])
        await db.purchase_orders.insert_one({"id": "purchase", "floor_id": floor, "status": "draft", "customer_name": "Delivery", "expected_delivery_at": "2026-10-28T18:30:00Z"})
        await db.payments.insert_many([
            {"id": "in-day", "floor_id": floor, "status": "completed", "amount": 500, "paid_at": "2026-10-28T18:30:00Z"},
            {"id": "outside", "floor_id": floor, "status": "completed", "amount": 900, "paid_at": "2026-10-29T18:30:00Z"},
            {"id": "foreign", "floor_id": "ground-floor", "status": "completed", "amount": 900, "paid_at": "2026-10-29T01:00:00Z"},
            {"id": "credit", "floor_id": floor, "status": "completed", "entry_type": "godown_stock_credit", "amount": 900, "paid_at": "2026-10-29T01:00:00Z"},
        ])
        await db.quotations.insert_many([
            {"id": "debt", "floor_id": floor, "customer_name": "Collect", "status": "ordered", "grand_total": 100,
             "payment_extra_amount": 999, "payment_extra_history": [{"amount": 20}]},
            {"id": "settled", "floor_id": floor, "status": "ordered", "grand_total": 100},
            {"id": "draft", "floor_id": floor, "status": "draft", "customer_id": "customer-a-copy", "customer_name": "Customer", "project_name": "Guest bathroom", "valid_until": "2026-10-29T02:00:00Z", "grand_total": 900},
            {"id": "debt", "floor_id": "ground-floor", "status": "ordered", "grand_total": 900},
        ])
        await db.payments.insert_many([
            {"quotation_id": "debt", "floor_id": floor, "status": "completed", "amount": 30, "paid_at": "2026-10-29T02:00:00Z"},
            {"quotation_id": "debt", "floor_id": floor, "status": "completed", "entry_type": "godown_stock_credit", "amount": 10, "paid_at": "2026-10-29T02:00:00Z"},
            {"quotation_id": "settled", "floor_id": floor, "status": "completed", "amount": 100, "paid_at": "2026-10-29T02:00:00Z"},
            {"quotation_id": "debt", "floor_id": "ground-floor", "status": "completed", "amount": 9000, "paid_at": "2026-10-29T02:00:00Z"},
        ])
        await db.purchase_shortages.insert_one({"id": "shortage", "floor_id": floor, "status": "awaiting_reorder", "customer_name": "Reorder"})
        await db.purchase_transfers.insert_many([
            {"id": "loan", "floor_id": floor, "type": "loan", "status": "return_due", "source_customer_name": "Lender"},
            {"id": "not-due", "floor_id": floor, "type": "loan", "status": "awaiting_return"},
            {"id": "foreign-loan", "floor_id": "ground-floor", "type": "loan", "status": "return_due"},
        ])
        result = await today_dashboard(db, actor, now)
        assert result["task_summary"] == {"open": 10, "due_today": 4, "overdue": 1, "completed_today": 1}
        assert result["payments"] is None
        overview = await today_overview(db, actor, now)
        assert overview["payments"] == {"currency": "INR", "received_today": 630, "receipt_count": 3}
        assert result["unavailable_sections"] == []
        assert {task["id"] for task in result["tasks"]} == {"today", "overdue", "snoozed", "walkin", "no-date", "purchase", "debt", "draft", "shortage", "loan"}
        tasks = {task["id"]: task for task in result["tasks"]}
        assert tasks["today"]["customer_id"] == "customer-a"
        assert tasks["draft"]["customer_id"] == "customer-a-copy"
        assert tasks["today"]["customer_group"] == tasks["draft"]["customer_group"]
        assert tasks["overdue"]["customer_group"] != tasks["today"]["customer_group"]
        assert tasks["today"]["reference"] == "Apartment renovation"
        assert tasks["draft"]["reference"] == "Guest bathroom"
        assert tasks["overdue"]["customer_id"] == "customer-b"
        assert tasks["overdue"]["customer_name"] == tasks["today"]["customer_name"] == "Customer"
        assert tasks["snoozed"]["customer_id"] is None
        assert tasks["debt"]["progress"] == 33
        assert all("value" not in task and "customer_phone" not in task for task in result["tasks"])
        await db.users.insert_one({"id": "person", "floor_ids": [floor], "delegation_grants": [
            {"user_id": "person", "resource": "purchases", "floor_id": floor, "actions": ["view"]}]})
        limited = actor.model_copy(update={"role": "worker", "custom_access": True, "floor_ids": [floor]})
        result = await today_dashboard(db, limited, now)
        assert result["task_summary"] == {"open": 2, "due_today": 1, "overdue": 0, "completed_today": 0}
        assert [task["id"] for task in result["tasks"]] == ["purchase", "shortage"]
        assert result["payments"] is None and result["workflows"] == []
        for resource, task_id in [("payments", "debt"), ("godown_stock", "loan"), ("quotations", "draft")]:
            await db.users.update_one({"id": "person"}, {"$set": {"delegation_grants": [
                {"user_id": "person", "resource": resource, "floor_id": floor, "actions": ["view"]}]}})
            queue = await today_dashboard(db, limited, now)
            assert [task["id"] for task in queue["tasks"]] == [task_id]
            assert queue["task_summary"]["open"] == 1
            assert queue["payments"] is None and queue["workflows"] == []
        await db.quotations.insert_one({"id": "tile", "floor_id": "ground-floor", "status": "draft", "doc_type": "tiles_selection"})
        tile_actor = actor.model_copy(update={"role": "sales", "active_floor_id": "ground-floor", "floor_ids": ["ground-floor"]})
        tile_queue = await today_dashboard(db, tile_actor, now)
        assert next(task for task in tile_queue["tasks"] if task["id"] == "tile")["href"] == "/tiles/selection?id=tile"
        await db.kitchen_projects.insert_one({"id": "kitchen", "floor_id": "second-floor", "stage": "visit", "customer": {"name": "Kitchen"},
                                            "assigned_to": "person", "assigned_to_name": "Person",
                                            "visit": {"visit_date": "2026-10-29"}, "target_completion_date": "2026-10-31"})
        kitchen = actor.model_copy(update={"role": "sales", "active_floor_id": "second-floor", "floor_ids": ["second-floor"]})
        result = await today_dashboard(db, kitchen, now)
        assert result["task_summary"]["due_today"] == 1 and result["tasks"][0]["due_at"] == "2026-10-28T18:30:00+00:00"
        assert result["tasks"][0]["progress"] is None and result["payments"] is None
        await db.kitchen_projects.insert_many([
            {"id": "other-worker", "floor_id": "second-floor", "stage": "cad", "assigned_to": "other", "assignments": {"lead": "person", "cad": "other"}},
            {"id": "unassigned", "floor_id": "second-floor", "stage": "lead"},
            {"id": "own-cad", "floor_id": "second-floor", "stage": "cad", "assigned_to": "person", "cad": {"progress": 43}},
            {"id": "completed", "floor_id": "second-floor", "stage": "completed", "assigned_to": "person", "completion_date": "2026-10-29"},
            {"id": "lost", "floor_id": "second-floor", "stage": "lead", "assigned_to": "person", "status": "Lost"},
            {"id": "paused", "floor_id": "second-floor", "stage": "cad", "assigned_to": "person", "lifecycle_status": "On Hold"},
            {"id": "foreign-assigned", "floor_id": "ground-floor", "stage": "cad", "assigned_to": "person"},
        ])
        result = await today_dashboard(db, kitchen, now)
        assert {task["id"] for task in result["tasks"]} == {"kitchen", "own-cad"}
        assert result["task_summary"] == {"open": 2, "due_today": 1, "overdue": 0, "completed_today": 1}
        assert next(task for task in result["tasks"] if task["id"] == "own-cad")["progress"] == 43
        await db.kitchen_projects.update_one({"id": "kitchen"}, {"$set": {"stage": "cad", "assigned_to": "other", "assignments": {"visit": "person", "cad": "other"}}})
        result = await today_dashboard(db, kitchen, now)
        assert [task["id"] for task in result["tasks"]] == ["own-cad"]
        overview = await today_dashboard(db, actor.model_copy(update={"active_floor_id": "second-floor"}), now)
        assert {task["id"] for task in overview["tasks"]} == {"kitchen", "other-worker", "unassigned", "own-cad"}
    finally:
        await client.drop_database(name)
        client.close()


@pytest.mark.asyncio
async def test_followup_pages_keep_linked_tasks_together_and_keep_floor_scope(monkeypatch):
    from routes import followup_routes

    client = AsyncIOMotorClient(os.environ["TEST_TODAY_MONGO_URL"], serverSelectionTimeoutMS=3000)
    database = client["forge_followup_group_test_" + uuid4().hex]
    monkeypatch.setattr(followup_routes, "db", database)
    actor = UserPublic(id="owner", email="owner@example.com", full_name="Owner", role="owner",
                       active_floor_id="first-floor")
    try:
        await database.customers.insert_many([
            {"id": "source", "floor_id": "ground-floor", "name": "Same name"},
            {"id": "alias", "floor_id": "first-floor", "name": "Same name", "imported_from_customer_id": "source"},
            {"id": "same-floor-alias", "floor_id": "first-floor", "name": "Same name", "identity_source_customer_id": "source"},
        ])
        rows = [{"id": f"t-{number:02d}", "floor_id": "first-floor", "customer_id": f"customer-{number:02d}",
                 "status": "open", "category": "general", "due_at": "2099-01-01T00:00:00+00:00", "priority_score": 100 - number}
                for number in range(28)]
        rows[0]["customer_id"] = "alias"
        rows[-1]["customer_id"] = "same-floor-alias"
        await database.followups.insert_many([*rows, {**rows[0], "id": "foreign", "floor_id": "ground-floor"}])
        first = await followup_routes.list_followups_page(user=actor, view="active", page=1, page_size=25, group_by_customer=True)
        second = await followup_routes.list_followups_page(user=actor, view="active", page=2, page_size=25, group_by_customer=True)
        first_ids = {row["id"]: row for row in first["items"]}
        assert len(first_ids) == 26 and first["has_more"]
        assert first_ids["t-00"]["customer_group"] == first_ids["t-27"]["customer_group"]
        assert first_ids["t-00"]["customer_id"] != first_ids["t-27"]["customer_id"]
        assert {row["id"] for row in second["items"]} == {"t-25", "t-26"}
        assert "foreign" not in first_ids and not second["has_more"]
    finally:
        await client.drop_database(database.name)
        client.close()
