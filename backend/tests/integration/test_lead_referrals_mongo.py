"""Actual aggregation checks against an explicitly selected disposable Mongo."""
import asyncio
import os
from uuid import uuid4

import pytest
from motor.motor_asyncio import AsyncIOMotorClient

from services.analytics.filters import AnalyticsFilter
from services.analytics.lead_referrals import gather_acquired_customers
from services.analytics.workspaces import gather_workspace


def test_multifloor_leads_and_orders_count_each_referred_person_once():
    url = os.environ.get("LEAD_REFERRALS_TEST_MONGO_URL", "")
    if not url:
        pytest.skip("Requires LEAD_REFERRALS_TEST_MONGO_URL disposable local database")
    assert url.startswith(("mongodb://127.0.0.1:", "mongodb://localhost:"))

    async def run():
        client = AsyncIOMotorClient(url)
        db = client[f"forge_lead_referrals_test_{uuid4().hex}"]
        base = {"referrer_id": "interior-a", "referrer_name": "Interior A", "referrer_type": "interior_designer", "created_at": "2026-10-12", "floor_id": "ground-floor"}
        try:
            await db.customers.insert_many([
                {**base, "id": "c1", "phone": "+91 99099 06652"},
                {**base, "id": "c1-sanitary", "phone": "9909906652", "floor_id": "first-floor"},
                {**base, "id": "c2", "phone": "9909906653"},
                {**base, "id": "deleted", "phone": "9909906654", "is_deleted": True},
            ])
            await db.walkins.insert_one({**base, "id": "w1", "customer_id": "c1", "customer_phone": "99099-06652"})
            await db.followups.insert_many([
                {**base, "id": "f1", "lead_group_id": "lead-a", "customer_id": "c1", "customer_phone": "9909906652"},
                {**base, "id": "f2", "lead_group_id": "lead-a", "customer_id": "c1-sanitary", "customer_phone": "+919909906652", "floor_id": "first-floor"},
                {**base, "id": "floor-secret", "customer_phone": "9909906655", "floor_id": "third-floor"},
                {**base, "id": "before-period", "customer_phone": "9909906656", "created_at": "2026-09-01"},
                {**base, "id": "other-interior", "customer_phone": "9909906657", "referrer_id": "interior-b"},
            ])
            await db.quotations.insert_many([{**base, "id": "q1", "customer_id": "c1", "status": "ordered", "grand_total": 100}, {**base, "id": "q2", "customer_id": "c1", "status": "ordered", "grand_total": 200, "referrer_name": "Interior A renamed"}])
            rows = await gather_acquired_customers(db, AnalyticsFilter(referrer_id="interior-a"), ["ground-floor", "first-floor"], ("2026-10-01", "2026-11-01"), "interior_designer")
            assert rows == [{"id": "interior-a", "name": "Interior A renamed", "type": "interior_designer", "customers_acquired": 2, "company": None}]
            await db.referrers.insert_one({'id': 'interior-a', 'name': 'Designer A', 'company': 'Interior Studio A', 'floor_id': 'first-floor'})
            named = await gather_acquired_customers(db, AnalyticsFilter(referrer_id='interior-a'), ['ground-floor', 'first-floor'], ('2026-10-01', '2026-11-01'), 'interior_designer')
            assert named[0]['company'] == 'Interior Studio A' and named[0]['name'] == 'Designer A'
            empty = await gather_acquired_customers(db, AnalyticsFilter(), [], (None, None))
            assert empty == []
            sales = await gather_workspace(db, {"status": "ordered"}, "interior_designer")
            assert len(sales['relationships']) == 1
            assert sales['relationships'][0]['revenue'] == 300
            assert sales['relationships'][0]['customers'] == 1
        finally:
            await client.drop_database(db.name)
            client.close()

    asyncio.run(run())
