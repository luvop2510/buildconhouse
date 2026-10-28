"""Unified analytics acceptance on an explicitly disposable local Mongo only."""
import asyncio
import os
from dataclasses import replace
from datetime import datetime, timezone
from io import BytesIO
from uuid import uuid4

import pytest
from motor.motor_asyncio import AsyncIOMotorClient
from openpyxl import load_workbook

from services.analytics.unified import Query, dashboard, load_model
from services.analytics.unified_profiles import directory, profile
from services.analytics.unified_exports import export_bytes, report_sections
from services.analytics.filters import FloorAccessError


def test_unified_actual_mongo_four_floors_history_date_filters_and_exports():
    async def run():
        url = os.environ.get("SALES_TEST_MONGO_URL", "")
        assert url.startswith("mongodb://127.0.0.1:"), "Explicit disposable local Mongo required"
        client = AsyncIOMotorClient(url)
        database = client[f"unified_sales_test_{uuid4().hex}"]
        try:
            await database.customers.insert_many([{"id": "c1", "name": "Shared customer", "floor_id": "ground-floor"}, {"id": "c2", "name": "Kitchen customer", "floor_id": "second-floor"}])
            await database.brands.insert_many([{"id": "b1", "name": "Tile company", "floor_id": "ground-floor"}, {"id": "b2", "name": "Sanitary company", "floor_id": "first-floor"}])
            await database.products.insert_many([{"id": "p1", "name": "Tile one", "sku": "T1", "brand_id": "b1", "floor_id": "ground-floor", "related_ids": ["p3"]}, {"id": "p2", "name": "Tap", "brand_id": "b2", "floor_id": "first-floor"}, {"id": "p3", "name": "Unsold related tile", "brand_id": "b1", "floor_id": "ground-floor"}])
            await database.referrers.insert_one({"id": "a1", "name": "Architect", "type": "architect", "floor_id": "ground-floor"})
            await database.quotations.insert_many([
                {"id": "tiles", "number": "T-1", "floor_id": "ground-floor", "customer_id": "c1", "customer_name": "Shared customer", "referrer_id": "a1", "referrer_name": "Architect", "referrer_type": "architect", "status": "ordered", "ordered_at": "2026-10-10T12:00:00+00:00", "created_at": "2026-10-01T10:00:00+00:00", "grand_total": 100, "items": [{"id": "l1", "product_id": "p1", "name": "Tile one", "qty": 2, "net_amount": 60, "size": "600x600", "finish": "Matt"}, {"id": "l2", "product_id": "p1", "name": "Tile one", "qty": 1, "net_amount": 40}]},
                {"id": "sanitary", "floor_id": "first-floor", "customer_id": "c1", "customer_name": "Shared customer", "status": "ordered", "ordered_at": "2026-10-10T12:00:00+00:00", "created_at": "2026-10-02T10:00:00+00:00", "grand_total": 200, "items": [{"id": "l3", "product_id": "p2", "name": "Tap", "qty": 1, "net_amount": 200}]},
                {"id": "draft", "number": "T-DRAFT", "floor_id": "ground-floor", "customer_id": "c1", "customer_name": "Shared customer", "status": "draft", "created_at": "2026-10-12T10:00:00+00:00", "grand_total": 9999, "items": [{"id": "draftline", "product_id": "p1", "qty": 1, "net_amount": 9999}]},
            ])
            await database.purchase_orders.insert_one({"id": "supplier-po", "floor_id": "ground-floor", "grand_total": 99999999, "status": "confirmed"})
            await database.payments.insert_many([{"id": "cash", "quotation_id": "tiles", "floor_id": "ground-floor", "status": "completed", "amount": 30, "paid_at": "2026-10-11T10:00:00+00:00"}, {"id": "credit", "quotation_id": "tiles", "floor_id": "ground-floor", "status": "completed", "amount": 10, "paid_at": "2026-10-11T10:00:00+00:00", "entry_type": "godown_stock_credit"}, {"id": "wrong-floor", "quotation_id": "tiles", "floor_id": "first-floor", "status": "completed", "amount": 999, "paid_at": "2026-10-11T10:00:00+00:00"}])
            await database.activity_events.insert_one({"id": "event", "quotation_id": "draft", "floor_id": "ground-floor", "created_at": "2026-10-12T10:00:00+00:00", "event_type": "quotation.created"})
            await database.kitchen_projects.insert_many([
                {"id": "kitchen", "project_reference": "K-1", "floor_id": "second-floor", "customer_id": "c2", "customer": {"name": "Kitchen customer"}, "status": "Active", "stage": "completed", "workflow_cycle": 1, "design_versions": [{"id": "d1", "response": "Approved", "workflow_cycle": 1}], "quotation_versions": [{"id": "q1", "design_version_id": "d1", "shared_date": "2026-10-01", "received_date": "2026-10-01", "response": "Approved", "amount": "500"}], "orders": [{"id": "ko1", "quotation_version_id": "q1", "confirmed": True, "status": "Confirmed", "final_amount": "500", "at": "2026-10-10T10:00:00+00:00", "advance": {"received": True, "amount": "100", "date": "2026-10-11"}}]},
                {"id": "unconfirmed", "floor_id": "second-floor", "customer_id": "c2", "customer": {"name": "Kitchen customer"}, "status": "Active", "stage": "quotation", "created_at": "2026-10-09T10:00:00+00:00", "quotation_versions": [{"id": "q2", "received_date": "2026-10-10", "response": "Pending", "amount": "400"}]},
            ])
            await database.furniture_quotations.insert_many([{"id": "furniture", "floor_id": "third-floor", "customer_id": "c1", "customer_name": "Shared customer", "status": "final", "finalized_at": "2026-10-10T10:00:00+00:00", "created_at": "2026-10-01T10:00:00+00:00", "total_payable_rmb": "50", "total_received_rmb": "10", "balance_rmb": "40", "charges": [{"id": "charge", "description": "Sofa order", "amount_rmb": "50"}], "deposits": [{"id": "fd1", "amount_rmb": "10", "created_at": "2026-10-11T10:00:00+00:00"}]}, {"id": "furniture-draft", "floor_id": "third-floor", "status": "draft", "total_payable_rmb": "999999"}])
            q = Query(preset="custom", date_from="2026-10-01", date_to="2026-10-28")
            rows = await load_model(database, q, None)
            report = dashboard(rows, q, None, datetime(2026, 10, 28, tzinfo=timezone.utc))
            assert report["kpis"]["sales"] == 800 and report["kpis"]["sales_rnb"] == 50
            assert report["kpis"]["orders"] == 4 and report["kpis"]["customers"] == 2
            assert report["kpis"]["collected"] == 130 and report["kpis"]["outstanding"] == 660
            assert sum(f["sales"] for f in report["floors"] if f["currency"] == "INR") == 800
            assert [r["id"] for r in rows] == ["tiles", "sanitary", "kitchen", "furniture"]
            payment_report = dashboard(rows, replace(q, date_basis="payment", granularity="day"), None)
            assert payment_report["kpis"]["sales"] == 130 and payment_report["kpis"]["sales_rnb"] == 10
            assert sum(point["sales"] for point in payment_report["trend"]) == 130
            company_q = replace(q, company_id="b1")
            company_rows = await load_model(database, company_q, ["ground-floor"])
            company = await profile(database, company_rows, company_q, ["ground-floor"], "companies", "b1", table_page_size=100)
            assert company["kpis"]["sales"] == 100
            assert {r["id"] for r in company["tables"]["quotations"]["items"]} == {"tiles", "draft"}
            assert {r["id"] for r in company["tables"]["products"]["items"]} == {"p1", "p3"}
            assert any(event["id"] == "event" for event in company["tables"]["activity"]["items"])
            product_q = replace(q, product_id="p1")
            product_rows = await load_model(database, product_q, ["ground-floor"])
            product = await profile(database, product_rows, product_q, ["ground-floor"], "products", "p1")
            assert product["tables"]["related_products"]["items"][0]["id"] == "p3"
            directory_result = await directory(database, company_rows, company_q, ["ground-floor"], "products")
            assert directory_result["total"] == 2
            workbook = load_workbook(BytesIO(export_bytes(company, report_sections(company, view="profile"), "xlsx", {"Selected entity ID": "b1"})))
            assert {row[0] for row in list(workbook["Orders"].values)[1:]} == {"tiles"}
            assert export_bytes(company, report_sections(company, view="profile"), "pdf", {"Selected entity ID": "b1"}).startswith(b"%PDF")
            with pytest.raises(FloorAccessError):
                await load_model(database, replace(q, floor_id="first-floor"), ["ground-floor"])
            assert await load_model(database, q, []) == []
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(run())


def test_duplicate_review_actual_mongo_cas_concurrency_redaction_and_no_merges():
    from routes.sales_identity_review_routes import IdentityDecision
    from services.analytics.identity_review import duplicate_groups, review_identity
    from models import UserPublic
    from fastapi import HTTPException
    async def run():
        url = os.environ.get("SALES_TEST_MONGO_URL", "")
        assert url.startswith("mongodb://127.0.0.1:"), "Explicit disposable local Mongo required"
        client = AsyncIOMotorClient(url)
        database = client[f"unified_identity_test_{uuid4().hex}"]
        try:
            source = [{"id": "one", "name": " Shared Customer ", "floor_id": "ground-floor"}, {"id": "two", "name": "shared   customer", "floor_id": "first-floor"}]
            await database.customers.insert_many(source)
            owner = UserPublic(id="owner", email="owner@example.test", full_name="Owner", role="owner")
            groups = await duplicate_groups(database, Query(), None, "customers")
            assert len(groups) == 1 and len(groups[0]["entities"]) == 2
            decision = IdentityDecision(kind="customers", entity_ids=["one", "two"], expected_revision=0, decision="distinct", note="Checked source records")
            saved = await review_identity(database, Query(), None, owner, decision)
            assert saved["revision"] == 1
            assert await review_identity(database, Query(), None, owner, decision) == saved
            assert await duplicate_groups(database, Query(), ["ground-floor"], "customers") == []
            manager = owner.model_copy(update={"role": "manager"})
            with pytest.raises(HTTPException) as denied:
                await review_identity(database, Query(), None, manager, decision)
            assert denied.value.status_code == 403
            first = decision.model_copy(update={"expected_revision": 1, "decision": "needs_correction", "note": "First correction"})
            second = decision.model_copy(update={"expected_revision": 1, "decision": "resolved", "note": "Second correction"})
            outcomes = await asyncio.gather(review_identity(database, Query(), None, owner, first), review_identity(database, Query(), None, owner, second), return_exceptions=True)
            assert sum(isinstance(result, HTTPException) and result.status_code == 409 for result in outcomes) == 1
            assert sum(isinstance(result, dict) and result["revision"] == 2 for result in outcomes) == 1
            ledger = await database.settings.find_one({"_id": groups[0]["id"]})
            assert len(ledger["history"]) == 2 and ledger["revision"] == 2
            assert await database.customers.count_documents({}) == 2
            assert [row["name"] for row in await database.customers.find({}, {"_id": 0}).sort("id", 1).to_list(10)] == [row["name"] for row in source]
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(run())
