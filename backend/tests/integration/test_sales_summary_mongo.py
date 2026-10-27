"""Sales read-model arithmetic and scope on an explicitly isolated local Mongo."""
import asyncio
import os
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi import Response
from motor.motor_asyncio import AsyncIOMotorClient

from models import UserPublic
from routes import sales_summary_routes
from services.analytics.filters import AnalyticsFilter, FloorAccessError
from services.analytics.periods import resolve
from services.analytics.sales_summary import gather_financial_summary, gather_followup_summary


def test_sales_summary_financial_counts_units_credits_scope_and_empty(monkeypatch):
    async def run():
        url = os.environ.get("SALES_TEST_MONGO_URL", "")
        assert url.startswith("mongodb://127.0.0.1:"), "Explicit disposable local Mongo required"
        client = AsyncIOMotorClient(url)
        db = client[f"sales_summary_test_{uuid4().hex}"]
        monkeypatch.setattr(sales_summary_routes, "db", db)
        try:
            await db.products.insert_many([{"id": "p1", "brand_id": "b1", "floor_id": "first-floor"}, {"id": "p2", "brand_id": "b2", "floor_id": "ground-floor"}])
            await db.brands.insert_many([{"id": "b1", "name": "Hansgrohe"}, {"id": "b2", "name": "Tiles"}])
            def order(id, customer, amount, floor="first-floor", status="ordered", at="2026-10-10T10:00:00+00:00", **extra):
                return {"id": id, "customer_id": customer, "customer_name": customer, "grand_total": amount, "floor_id": floor, "status": status, "ordered_at": at, "items": [{"product_id": "p1" if floor == "first-floor" else "p2", "name": "Mixer" if floor == "first-floor" else "Tile", "net_amount": amount, "qty": 2, "quantity_unit": "Box"}], **extra}
            await db.quotations.insert_many([
                order("overpaid", "A", 100), order("unpaid", "B", 200, payment_extra_history=[{"amount": 20}]),
                order("old", "C", 50, at="2026-09-10T00:00:00+00:00"),
                order("tile", "D", 400, floor="ground-floor"), order("draft", "E", 9999, status="draft"),
            ])
            await db.payments.insert_many([
                {"quotation_id": "overpaid", "floor_id": "first-floor", "status": "completed", "amount": 150},
                {"quotation_id": "unpaid", "floor_id": "first-floor", "status": "pending", "amount": 200},
                {"quotation_id": "unpaid", "floor_id": "ground-floor", "status": "completed", "amount": 200},
                {"quotation_id": "unpaid", "floor_id": "first-floor", "status": "completed", "amount": 30, "entry_type": "godown_stock_credit"},
            ])
            now = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)
            period = resolve("this_month", now=now)
            data = await gather_financial_summary(db, AnalyticsFilter(floor_id="first-floor"), None, period)
            assert data["kpis"] == {"revenue": 300, "revenue_rnb": 0, "orders": 2, "customers": 2, "total_customers": 3, "products": 1, "outstanding": 240, "outstanding_rnb": 0}
            assert data["quantities"] == [{"unit": "Pieces", "quantity": 4}]
            assert [r["customer_id"] for r in data["customers"]] == ["B", "C", "A"]
            combined = await gather_financial_summary(db, AnalyticsFilter(floor_id="all"), None, period)
            assert combined["kpis"]["revenue"] == 700
            assert combined["quantities"] == [{"unit": "Boxes", "quantity": 2}, {"unit": "Pieces", "quantity": 4}]
            assert sum(row["revenue"] for row in combined["brands"]) == 700
            with pytest.raises(FloorAccessError):
                await gather_financial_summary(db, AnalyticsFilter(floor_id="ground-floor"), ["first-floor"], period)
            empty = await gather_financial_summary(db, AnalyticsFilter(floor_id="second-floor"), None, period)
            assert empty["kpis"]["revenue"] == 0 and empty["coverage"]["sales_available"] is True and empty["coverage"]["products_available"] is False
            await db.followups.insert_many([
                {"id": "late", "floor_id": "first-floor", "status": "open", "due_at": "2026-10-25T12:00:00+00:00"},
                {"id": "today", "floor_id": "first-floor", "status": "open", "due_at": "2026-10-27T00:00:00+00:00"},
                {"id": "snoozed", "floor_id": "first-floor", "status": "snoozed", "due_at": "2026-10-25T12:00:00+00:00", "snoozed_until": "2026-10-29T00:00:00+00:00"},
                {"id": "closed", "floor_id": "first-floor", "status": "closed", "due_at": "2026-10-25T12:00:00+00:00"},
                {"id": "other", "floor_id": "ground-floor", "status": "open", "due_at": "2026-10-25T12:00:00+00:00"},
            ])
            assert await gather_followup_summary(db, AnalyticsFilter(floor_id="first-floor"), None, now) == {"followups": 3, "overdue_followups": 1}
            owner = UserPublic(id="sales-test", email="sales@example.test", full_name="Sales QA", role="owner", active_floor_id="first-floor")
            response = Response()
            output = await sales_summary_routes.sales_summary(response, floor_id="first-floor", preset="all", fresh=True, user=owner)
            assert response.headers["cache-control"] == "no-store"
            assert output["kpis"]["outstanding"] == 240
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_four_department_reporting_keeps_currency_versions_and_customer_identities_separate():
    async def run():
        url = os.environ.get("SALES_TEST_MONGO_URL", "")
        assert url.startswith("mongodb://127.0.0.1:"), "Explicit disposable local Mongo required"
        client = AsyncIOMotorClient(url)
        database = client[f"sales_summary_four_floor_test_{uuid4().hex}"]
        try:
            now = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)
            period = resolve("this_month", now=now)
            await database.quotations.insert_one({"id": "sanitary", "customer_id": "same-person", "customer_name": "Same buyer", "floor_id": "first-floor", "status": "ordered",
                                                 "ordered_at": "2026-10-05T10:00:00+00:00", "grand_total": 100.11, "items": []})
            def kitchen(identity, **overrides):
                return {"id": identity, "floor_id": "second-floor", "customer_id": "kitchen-buyer", "customer": {"name": "Kitchen buyer", "phone": "9876543210"},
                        "status": "Active", "stage": "completed", "workflow_cycle": 1,
                        "design_versions": [{"id": "selected-design", "response": "Approved", "workflow_cycle": 1}, {"id": "newer-unselected-design", "response": "Pending"}],
                        "quotation_versions": [{"id": "selected-quote", "design_version_id": "selected-design", "shared_date": "2026-09-15", "response": "Approved"},
                                               {"id": "newer-unselected-quote", "response": "Rejected", "design_version_id": "newer-unselected-design"}],
                        "orders": [{"id": "historical", "quotation_version_id": "selected-quote", "confirmed": True, "status": "Confirmed", "final_amount": "99999.99", "at": "2026-09-01T10:00:00+00:00"},
                                   {"id": identity+"-order", "quotation_version_id": "selected-quote", "confirmed": True, "status": "Confirmed", "final_amount": "500.25", "at": "2026-10-10T10:00:00+00:00",
                                    "advance": {"received": True, "amount": "100.05"}}], **overrides}
            await database.kitchen_projects.insert_many([
                kitchen("valid-no-referrer"), kitchen("cancelled", lifecycle_status="Cancelled"),
                kitchen("on-hold", status="On Hold"), kitchen("invalidated", commercial_basis_invalidated=True),
                kitchen("pending-revision", design_revision_pending=True), kitchen("old-cycle", workflow_cycle=2),
                kitchen("wrong-basis", orders=[{"id": "wrong", "quotation_version_id": "missing", "confirmed": True, "status": "Confirmed", "final_amount": "700", "at": "2026-10-10T10:00:00+00:00"}]),
                kitchen("no-longer-confirmed", orders=[{"id": "old-confirmed", "quotation_version_id": "selected-quote", "confirmed": True, "status": "Confirmed", "final_amount": "700"},
                                                     {"id": "latest-no", "quotation_version_id": "selected-quote", "confirmed": False, "status": "Confirmed", "final_amount": "500", "at": "2026-10-10T10:00:00+00:00"}]),
            ])
            def furniture(identity, **overrides):
                return {"id": identity, "floor_id": "third-floor", "status": "final", "finalized_at": "2026-10-12T10:00:00+00:00",
                        "customer_id": None, "customer_name": "Furniture buyer", "customer_phone": "+91 90000-00001",
                        "total_payable_rmb": "25.10", "balance_rmb": "20.02", **overrides}
            await database.furniture_quotations.insert_many([
                furniture("legacy-a"), furniture("legacy-b", customer_phone="9000000001", total_payable_rmb="0.20", balance_rmb="0.10"),
                furniture("linked", customer_id="same-person", customer_phone="9000000002", total_payable_rmb="30.03", balance_rmb="5.01"),
                furniture("old-unpaid", finalized_at="2026-09-12T10:00:00+00:00", customer_phone="9000000003", total_payable_rmb="3.33", balance_rmb="1.11"),
                furniture("overpaid", customer_phone="9000000004", total_payable_rmb="10.00", balance_rmb="-2.00"),
                furniture("draft", status="draft"), furniture("deleted", is_deleted=True), furniture("archived", is_archived=True),
                furniture("archived-date", archived_at="2026-10-13T10:00:00+00:00"), furniture("wrong-floor", floor_id="first-floor"),
            ])
            all_data = await gather_financial_summary(database, AnalyticsFilter(floor_id="all"), None, period)
            assert all_data["kpis"] == {"revenue": 600.36, "revenue_rnb": 65.33, "orders": 6, "customers": 4,
                                        "total_customers": 5, "products": 0, "outstanding": 500.31, "outstanding_rnb": 26.24}
            assert [row["floor_id"] for row in all_data["departments"]] == ["ground-floor", "first-floor", "second-floor", "third-floor"]
            assert all_data["departments"][2] == {"floor_id": "second-floor", "currency": "INR", "revenue": 500.25, "outstanding": 400.20, "orders": 1, "customers": 1, "total_customers": 1}
            legacy_row = next(row for row in all_data["customers"] if row["key"] == "RNB:phone:9000000001")
            assert legacy_row["revenue"] == 25.30 and legacy_row["outstanding"] == 20.12 and legacy_row["orders"] == 2
            assert legacy_row["customer_id"] is None and legacy_row["floor_ids"] == ["third-floor"]
            same_rows = [row for row in all_data["customers"] if row["customer_id"] == "same-person"]
            assert len(same_rows) == 2 and {row["currency"] for row in same_rows} == {"INR", "RNB"}
            furniture_only = await gather_financial_summary(database, AnalyticsFilter(floor_id="third-floor"), ["third-floor"], period)
            assert furniture_only["kpis"]["revenue"] == 0 and furniture_only["kpis"]["revenue_rnb"] == 65.33
            assert furniture_only["coverage"]["sales_available"] is True and furniture_only["coverage"]["products_available"] is False
            assert [row["floor_id"] for row in furniture_only["departments"]] == ["third-floor"]
            restricted = await gather_financial_summary(database, AnalyticsFilter(floor_id="all"), ["second-floor"], period)
            assert restricted["kpis"]["revenue"] == 500.25 and restricted["kpis"]["revenue_rnb"] == 0
            assert restricted["kpis"]["orders"] == 1 and restricted["kpis"]["customers"] == 1
            no_access = await gather_financial_summary(database, AnalyticsFilter(floor_id="all"), [], period)
            assert no_access["departments"] == [] and no_access["kpis"]["orders"] == 0
            assert no_access["coverage"]["sales_available"] is False
            await database.furniture_quotations.update_one({"id": "legacy-a"}, {"$set": {"balance_rmb": "0.00"}})
            changed = await gather_financial_summary(database, AnalyticsFilter(floor_id="third-floor"), None, period)
            assert changed["kpis"]["outstanding_rnb"] == 6.22
            await database.furniture_quotations.insert_one(furniture("invalid", total_payable_rmb="not-money"))
            from fastapi import HTTPException
            with pytest.raises(HTTPException) as error:
                await gather_financial_summary(database, AnalyticsFilter(floor_id="third-floor"), None, period)
            assert error.value.status_code == 422
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(run())
