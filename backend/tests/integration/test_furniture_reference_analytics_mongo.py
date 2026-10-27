"""Reference currency joins on a disposable local Mongo; never application data."""
import asyncio
import os
from uuid import uuid4

import pytest
from motor.motor_asyncio import AsyncIOMotorClient
from fastapi import HTTPException

from services.analytics.filters import AnalyticsFilter
from services.analytics.furniture import gather_furniture_reference_rows, gather_furniture_reference_records


def test_furniture_reference_final_cohort_decimal_totals_scope_and_invalid_money():
    async def run():
        url = os.environ.get("SALES_TEST_MONGO_URL", "")
        assert url.startswith("mongodb://127.0.0.1:"), "Explicit disposable local Mongo required"
        client = AsyncIOMotorClient(url)
        database = client[f"furniture_reference_test_{uuid4().hex}"]
        try:
            def ledger(identity, **changes):
                return {"id": identity, "status": "final", "floor_id": "third-floor", "referrer_id": "shared", "referrer_name": "Shared studio", "referrer_type": "architect", "customer_name": identity,
                        "total_payable_rmb": "0.10", "total_received_rmb": "0.02", "balance_rmb": "0.08", "finalized_at": "2026-10-10T00:00:00+00:00", **changes}
            await database.furniture_quotations.insert_many([
                ledger("one"), ledger("two", total_payable_rmb="0.20"), ledger("draft", status="draft"),
                ledger("deleted", is_deleted=True), ledger("archived", is_archived=True),
                ledger("old", finalized_at="2026-09-30T23:59:59+00:00"), ledger("end", finalized_at="2026-11-01T00:00:00+00:00"),
                ledger("private", floor_id="first-floor"), ledger("another-reference", referrer_id="other"),
            ])
            window = ("2026-10-01T00:00:00+00:00", "2026-11-01T00:00:00+00:00")
            scope = AnalyticsFilter(floor_id="third-floor", referrer_id="shared")
            rows = await gather_furniture_reference_rows(database, scope, ["third-floor"], window)
            assert rows == [{"id": "shared", "name": "Shared studio", "type": "architect", "company": None, "revenue_rnb": 0.30, "orders_rnb": 2, "last_order_at": "2026-10-10T00:00:00+00:00"}]
            records, total, count = await gather_furniture_reference_records(database, scope, ["third-floor"], window)
            assert total == 0.30 and count == 2 and {row["id"] for row in records} == {"one", "two"}
            assert all("charges" not in row and "deposits" not in row for row in records)
            assert await gather_furniture_reference_rows(database, AnalyticsFilter(floor_id="all"), ["ground-floor"], window) == []
            await database.furniture_quotations.insert_one(ledger("invalid", total_payable_rmb="not-money"))
            with pytest.raises(HTTPException):
                await gather_furniture_reference_rows(database, scope, None, window)
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(run())
