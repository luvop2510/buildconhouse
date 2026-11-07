"""Forecast folding and cadence writes on a disposable local Mongo database."""
import asyncio
import importlib
from datetime import datetime, timezone
from uuid import uuid4

from motor.motor_asyncio import AsyncIOMotorClient

from routes import sales_workspace_routes as reports
from routes import customer_routes
from models import CustomerPublic
from services import automation_rules as rules
from services.analytics.filters import AnalyticsFilter
from tests.integration.test_purchase_completion_mongo import mongo_url  # noqa: F401


def test_forecast_preserves_year_boundaries_scopes_and_legacy_amounts(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        database = client[f"review_reporting_{uuid4().hex}"]
        monkeypatch.setattr(reports, "db", database)
        try:
            await database.products.insert_one({"id": "p1", "brand_id": "b1", "floor_id": "ground-floor"})
            docs = [{"id": str(index), "ordered_at": date, "grand_total": amount,
                     "status": "ordered", "floor_id": "ground-floor", "items": [{"product_id": "p1"}]}
                    for index, (date, amount) in enumerate([
                        ("2025-11-01T00:00:00+00:00", 0),
                        ("2025-12-01T00:00:00+00:00", "23.50"),
                        ("2025-12-31T23:59:59+00:00", 6.5),
                        ("2026-01-01T00:00:00+00:00", None),
                        ("2026-01-31T12:00:00+00:00", ""),
                    ])]
            docs.extend([
                {**docs[0], "id": "outside-month", "ordered_at": "2026-02-01T00:00:00+00:00", "grand_total": 9999},
                {**docs[0], "id": "outside-floor", "floor_id": "first-floor", "grand_total": 9999},
                {**docs[0], "id": "outside-brand", "items": [{"product_id": "p2"}], "grand_total": 9999},
                {**docs[0], "id": "draft", "status": "draft", "grand_total": 9999},
            ])
            await database.quotations.insert_many(docs)
            result = await reports._forecast(
                AnalyticsFilter(brand_id="b1", floor_id="ground-floor"), ["ground-floor"],
                datetime(2026, 2, 20, tzinfo=timezone.utc),
            )
            assert result["monthly_history"] == [0, 30, 0]
            assert result["months_used"] == 3
            assert result["forecast"] == 10
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(run())


def test_cadence_bulk_initialization_preserves_saved_settings_and_identity(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        database = client[f"review_rules_{uuid4().hex}"]
        monkeypatch.setattr(rules, "db", database)
        try:
            await database.automation_rules.insert_many([
                {"id": "selection", "category": "selection", "reminder_offsets_days": [2, 4, 7, 10]},
                {"id": "customized", "category": "quotation_tiles", "reminder_offsets_days": [3, 9], "is_active": False},
            ])
            await rules.ensure_seeded()
            first = await database.automation_rules.find({}, {"_id": 0}).sort("category", 1).to_list(10)
            await rules.ensure_seeded()
            assert await database.automation_rules.find({}, {"_id": 0}).sort("category", 1).to_list(10) == first
            assert len(first) == 3
            assert (await database.automation_rules.find_one({"category": "selection"}))["reminder_offsets_days"] == [0, 2, 4, 7, 10]
            assert (await database.automation_rules.find_one({"category": "quotation_tiles"}))["reminder_offsets_days"] == [3, 9]
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(run())


def test_portal_summary_index_repeats_without_rewriting_documents(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        database = client[f"review_portal_{uuid4().hex}"]
        monkeypatch.setattr(customer_routes, "db", database)
        migration = importlib.import_module("migrations.0043_portal_quotation_page")
        try:
            docs = [{"id": f"quote-{index:04d}", "number": f"Q-{index:04d}",
                     "customer_id": "customer-a" if index % 10 == 0 else "customer-b",
                     "created_at": "2026-11-01", "status": "draft", "grand_total": 100,
                     **({"items": [{"name": "Private line"}], "revisions": [{"note": "Old version"}]}
                        if index % 20 else {})}
                    for index in range(1000)]
            await database.quotations.insert_many(docs)
            before = await database.quotations.find({}, {"_id": 0}).sort("id", 1).to_list(None)
            await migration.up(database)
            await migration.up(database)
            assert await database.quotations.find({}, {"_id": 0}).sort("id", 1).to_list(None) == before
            customer = CustomerPublic(id="customer-a", name="Fixture", floor_id="first-floor", portal_enabled=True)
            page = await customer_routes.portal_quotations_page(skip=0, limit=20, q="", cust=customer)
            assert page["total"] == 100 and page["has_more"]
            assert [row["id"] for row in page["items"]] == [f"quote-{index:04d}" for index in range(990, 790, -10)]
            assert all(row["item_count"] == row["revision_count"] == (int(row["id"].split("-")[1]) % 20 != 0)
                       for row in page["items"])
            assert all("items" not in row and "revisions" not in row for row in page["items"])
            plan = await database.command("explain", {"find": "quotations", "filter": {"customer_id": "customer-a"},
                "sort": {"created_at": -1, "id": -1}, "limit": 20}, verbosity="executionStats")
            assert plan["executionStats"]["totalDocsExamined"] == 20
            assert migration.NAME in str(plan["queryPlanner"]["winningPlan"])
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(run())
