"""Reference drilldown counts/lists against a disposable Mongo, without sales prerequisites."""
import asyncio
import importlib

from motor.motor_asyncio import AsyncIOMotorClient
from tests.integration.test_purchase_completion_mongo import mongo_url  # noqa: F401
from models import UserPublic
from routes import sales_data_routes as routes


def test_reference_drilldown_walkins_custom_window_deduplication_and_paging(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.reference_people
        monkeypatch.setattr(routes, "db", db)
        user = UserPublic(id="manager", role="manager", full_name="Manager", email="manager@example.test", floor_ids=["first-floor"], active_floor_id="first-floor")
        base = {"referrer_id": "r", "referrer_name": "Architect", "referrer_type": "architect", "floor_id": "first-floor", "created_at": "2026-10-12T10:00:00+00:00"}
        try:
            await db.referrers.insert_one({"id": "r", "name": "Architect", "type": "architect", "floor_id": "first-floor"})
            await db.walkins.insert_many([
                {**base, "id": "walk-in", "customer_name": "Non-converted walk-in", "phone_normalized": "9909900011", "status": "open"},
                {**base, "id": "duplicate", "customer_name": "Non-converted walk-in", "customer_phone": "+91 99099-00011", "status": "lost"},
                {**base, "id": "confirmed-lead", "customer_name": "Confirmed customer", "customer_phone": "9909900012"},
                {**base, "id": "early", "created_at": "2026-09-30T23:59:59+00:00", "customer_phone": "9909900013"},
                {**base, "id": "late", "created_at": "2026-11-01T00:00:00+00:00", "customer_phone": "9909900014"},
                {**base, "id": "other-floor", "floor_id": "ground-floor", "customer_phone": "9909900015"},
                {**base, "id": "other-referrer", "referrer_id": "other", "customer_phone": "9909900016"},
                {**base, "id": "deleted", "is_deleted": True, "customer_phone": "9909900017"},
            ])
            await db.customers.insert_one({**base, "id": "confirmed", "name": "Confirmed customer", "phone": "9909900012"})
            await db.quotations.insert_one({**base, "id": "q", "number": "Q1", "customer_id": "confirmed", "customer_name": "Confirmed customer", "status": "ordered", "ordered_at": base["created_at"], "grand_total": 100})
            async def detail(**kwargs):
                return await routes.referrer_detail("r", floor_id="first-floor", date_from="2026-10-01T00:00:00Z", date_to="2026-11-01T00:00:00Z", preset="custom", user=user, **kwargs)
            migration = importlib.import_module("migrations.0040_reference_acquisition_reads")
            await migration.up(db)
            await migration.up(db)
            result = await detail()
            assert result["customers_acquired"] == 2
            assert {person["customer_name"] for person in result["referred_people"]} == {"Non-converted walk-in", "Confirmed customer"}
            assert {person["customer_name"]: person["confirmed"] for person in result["referred_people"]} == {"Non-converted walk-in": 0, "Confirmed customer": 1}
            assert result["total_revenue"] == 100
            assert all(person["floor_ids"] == ["first-floor"] for person in result["referred_people"])
            paged = await detail(people_offset=1)
            assert paged["customers_acquired"] == 2 and len(paged["referred_people"]) == 1
            assert paged["referred_people"][0]["customer_name"] == result["referred_people"][1]["customer_name"]
            assert set(paged["referred_people"][0]["sources"]) == set(result["referred_people"][1]["sources"])
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_kitchen_referred_people_retain_nested_customer_names_without_orders(mongo_url):
    from services.analytics.lead_referrals import gather_acquired_people
    from services.analytics.filters import AnalyticsFilter
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.kitchen_reference_people
        try:
            await db.kitchen_projects.insert_one({"id": "k", "referrer_id": "r", "floor_id": "second-floor", "created_at": "2026-10-12T00:00:00+00:00", "customer_phone_normalized": "9909900011", "customer": {"name": "Kitchen walk-in", "phone": "9909900011"}, "stage": "visit", "orders": [], "quotation_versions": [], "design_versions": []})
            result = await gather_acquired_people(db, AnalyticsFilter(referrer_id="r"), ["second-floor"], (None, None))
            assert result["total"] == 1
            assert result["people"][0]["customer_name"] == "Kitchen walk-in" and result["people"][0]["confirmed"] == 0
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_current_followup_summary_excludes_retired_kitchen_records(mongo_url):
    from datetime import datetime, timezone
    from services.analytics.filters import AnalyticsFilter
    from services.analytics.sales_summary import gather_followup_summary
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.retired_kitchen_followups
        try:
            await db.followups.insert_many([
                {"id": "k", "floor_id": "second-floor", "status": "open", "due_at": "2026-10-01T00:00:00+00:00"},
                {"id": "s", "floor_id": "first-floor", "status": "open", "due_at": "2026-10-01T00:00:00+00:00"},
            ])
            now = datetime(2026, 10, 28, tzinfo=timezone.utc)
            assert await gather_followup_summary(db, AnalyticsFilter(floor_id="all"), None, now) == {"followups": 1, "overdue_followups": 1}
            assert await gather_followup_summary(db, AnalyticsFilter(floor_id="second-floor"), None, now) == {"followups": 0, "overdue_followups": 0}
            assert await db.followups.count_documents({}) == 2
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())
