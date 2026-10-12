"""Hermetic completion regressions against a disposable local Mongo process."""
from __future__ import annotations

import asyncio
import importlib
import shutil
import socket
import subprocess
import time

import pytest
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import MongoClient

from models import UserPublic
from routes import purchases_tracker as tracker


@pytest.fixture
def mongo_url(tmp_path):
    binary = shutil.which("mongod")
    if not binary:
        pytest.skip("Disposable local Mongo binary unavailable")
    with socket.socket() as address:
        address.bind(("127.0.0.1", 0))
        port = address.getsockname()[1]
    process = subprocess.Popen([binary, "--dbpath", str(tmp_path), "--bind_ip", "127.0.0.1", "--port", str(port), "--logpath", str(tmp_path / "mongo.log")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"mongodb://127.0.0.1:{port}"
    try:
        probe = MongoClient(url, serverSelectionTimeoutMS=100)
        for _ in range(60):
            try:
                probe.admin.command("ping")
                break
            except Exception:
                time.sleep(0.05)
        else:
            raise AssertionError("Disposable Mongo did not start")
        probe.close()
        yield url
    finally:
        process.terminate()
        process.wait(timeout=10)


def user():
    return UserPublic(email="warehouse@forge.app", full_name="Warehouse", role="warehouse", floor_ids=["first-floor", "ground-floor"], active_floor_id="first-floor")


def item(item_id="i", stage="dispatched", qty=2, **extra):
    return {"id": item_id, "stage": stage, "qty": qty, "last_moved_at": "2026-10-10T12:00:00+00:00", **extra}


def po(po_id, customer="c", items=None, **extra):
    return {"id": po_id, "customer_id": customer, "customer_name": customer.upper(), "floor_id": "first-floor", "status": "ordered", "items": [item()] if items is None else items, **extra}


def test_completed_pipeline_all_active_quantity_floor_old_pending_and_rename(mongo_url):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.completion
        try:
            await db.purchase_orders.insert_many([
                po("complete", "complete"),
                po("complete-renamed", "complete", customer_name="Renamed"),
                po("partial-dispatched", "partial", [item(qty=1)]),
                po("partial-residual", "partial", [item(stage="in_box", qty=1)]),
                po("cancelled", "complete", [item(stage="in_box", cancelled=True)]),
                po("zero", "zero", [item(qty=0)]),
                po("godown", "godown", [item(godown_transferred_qty=2)]),
                po("cancelled-order", "cancelled-order", status="cancelled"),
                po("other-floor", "foreign", floor_id="ground-floor"),
                po("old-pending", "old", [item(stage="po_final")], created_at="2020-01-01"),
                *[po(f"old-{index}", "old") for index in range(1100)],
            ])
            rows = await db.purchase_orders.aggregate(tracker._completed_customer_pipeline(user())).to_list(None)
            assert {r["_id"] for r in rows} == {"complete"}
            assert rows[0]["item_count"] == 2 and rows[0]["quantity"] == 4
        finally:
            client.close()
    asyncio.run(run())


def test_chalan_dispatch_quantities_and_covering_delivery_timestamp(mongo_url):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.completion
        try:
            base = po("p", "partial", [item("i", stage="in_box", qty=4)])
            base["chalans"] = [{"id": "ch1", "stage": "dispatched", "dispatched_at": "2026-10-09", "items": [{"po_item_id": "i", "qty": 2}]}]
            await db.purchase_orders.insert_one(base)
            assert await db.purchase_orders.aggregate(tracker._completed_customer_pipeline(user())).to_list(None) == []
            await db.purchase_orders.update_one({"id": "p"}, {"$push": {"chalans": {"id": "ch2", "stage": "dispatched", "dispatched_at": "2026-10-10", "items": [{"po_item_id": "i", "qty": 2}]}}})
            rows = await db.purchase_orders.aggregate(tracker._completed_customer_pipeline(user())).to_list(None)
            assert rows[0]["_id"] == "partial" and rows[0]["last_delivered_at"] == "2026-10-10"
            pipeline = tracker._items_page_pipeline(view="stock", brand=None, customer="partial", stage=None, q=None, product_id=None, floor_ids=["first-floor"], sla_days=7, skip=0, limit=30)
            facet = (await db.purchase_orders.aggregate(pipeline).to_list(1))[0]
            assert facet["items"][0]["stage"] == "dispatched" and facet["stages"] == [{"_id": "dispatched", "count": 1}]
        finally:
            client.close()
    asyncio.run(run())


def test_migration_preserves_history_and_repeat_is_idempotent(mongo_url):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.completion
        try:
            received = item("received", stage="delivered", stage_history=[{"to_stage": "delivered", "note": "Auto-synced from PO receiving"}])
            delivered = item("delivered", stage="delivered", stage_history=[{"to_stage": "delivered", "note": "Handed to customer"}])
            transit = item("transit", stage="in_transit")
            await db.purchase_orders.insert_one(po("p", items=[received, delivered, transit]))
            migration = importlib.import_module("migrations.0028_purchase_five_stages")
            await migration.up(db)
            first = await db.purchase_orders.find_one({"id": "p"}, {"_id": 0})
            await migration.up(db)
            assert first == await db.purchase_orders.find_one({"id": "p"}, {"_id": 0})
            assert [i["stage"] for i in first["items"]] == ["in_box", "dispatched", "dispatched"]
            assert first["items"][0]["stage_history"] == received["stage_history"]
            assert first["items"][1]["delivered_at"] == delivered["last_moved_at"]
            assert first["items"][1]["legacy_stage"] == "delivered"
        finally:
            client.close()
    asyncio.run(run())


def test_active_crm_workspace_moves_completed_customers_but_stock_keeps_them(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.completion
        monkeypatch.setattr(tracker, "db", db)
        try:
            await db.customers.insert_many([{"id": c, "name": c, "floor_id": "first-floor"} for c in ["complete", "open", "new"]])
            await db.purchase_orders.insert_many([po("done", "complete"), po("open", "open", [item(stage="in_box")])])
            active = await tracker.active_customer_workspaces(include_completed=False, user=user())
            all_customers = await tracker.active_customer_workspaces(include_completed=True, user=user())
            assert {c["id"] for c in active} == {"open", "new"}
            assert {c["id"] for c in all_customers} == {"complete", "open", "new"}
        finally:
            client.close()
    asyncio.run(run())


def test_partial_dispatch_atomically_conserves_active_quantities_after_returns(mongo_url, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from services.purchase_stages import active_quantity

    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.completion
        updates = []
        class Orders:
            async def find_one(self, *args, **kwargs):
                return await db.purchase_orders.find_one(*args, **kwargs)
            async def update_one(self, query, update, **kwargs):
                result = await db.purchase_orders.update_one(query, update, **kwargs)
                saved = await db.purchase_orders.find_one({"id": "p"})
                updates.append((update, saved))
                return result
        monkeypatch.setattr(tracker, "db", SimpleNamespace(purchase_orders=Orders()))
        monkeypatch.setattr(tracker, "_sync_po_status_with_stages", AsyncMock(return_value=None))
        monkeypatch.setattr(tracker, "log_event", AsyncMock())
        monkeypatch.setattr(tracker, "reconcile_followups", AsyncMock())
        try:
            await db.purchase_orders.insert_one(po("p", items=[item("source", stage="in_box", qty=10, godown_transferred_qty=2, loan_replenishment_returned_qty=1, stage_history=[])]))
            first = await tracker._attempt_stage_change("source", "dispatched", user(), "$literal note", qty=3)
            assert first["split"] is True and len(updates) == 1
            saved = updates[-1][1]
            assert len(saved["items"]) == 2 and sum(active_quantity(i) for i in saved["items"]) == 7
            child = next(i for i in saved["items"] if i["id"] == first["new_item_id"])
            assert active_quantity(child) == 3 and child["godown_transferred_qty"] == 0 and child["loan_replenishment_returned_qty"] == 0
            assert child["stage_history"][-1]["note"] == "$literal note"
            assert await db.purchase_orders.aggregate(tracker._completed_customer_pipeline(user())).to_list(None) == []
            # Default move takes only the remaining active four units, keeping
            # the three returned units on the historical source line.
            second = await tracker._attempt_stage_change("source", "dispatched", user(), None)
            assert second["qty_moved"] == 4 and len(updates) == 2
            assert all(isinstance(update, list) for update, _saved in updates)
            saved = updates[-1][1]
            assert len(saved["items"]) == 3 and sum(active_quantity(i) for i in saved["items"]) == 7
            completed = await db.purchase_orders.aggregate(tracker._completed_customer_pipeline(user())).to_list(None)
            assert completed[0]["quantity"] == 7 and completed[0]["item_count"] == 2
        finally:
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("concurrent_change", [
    {"items.0.cancelled": True}, {"items.0.qty": 1},
    {"items.0.godown_transferred_qty": 1}, {"items.0.loaned_qty": 1},
    {"items.0.loan_replenishment_promised_qty": 1},
    {"items.0.stage": "company_billing"},
    {"chalans": [{"stage": "dispatched", "items": [{"po_item_id": "source", "qty": 2}]}]},
])
def test_dispatch_compare_and_set_rejects_concurrent_cancellation_quantity_or_chalan(mongo_url, monkeypatch, concurrent_change):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.completion
        class Orders:
            async def find_one(self, *args, **kwargs):
                return await db.purchase_orders.find_one(*args, **kwargs)
            async def update_one(self, query, update, **kwargs):
                await db.purchase_orders.update_one({"id": "p"}, {"$set": concurrent_change})
                return await db.purchase_orders.update_one(query, update, **kwargs)
        monkeypatch.setattr(tracker, "db", SimpleNamespace(purchase_orders=Orders()))
        monkeypatch.setattr(tracker, "log_event", AsyncMock())
        try:
            await db.purchase_orders.insert_one(po("p", items=[item("source", stage="in_box", qty=2)]))
            result = await tracker._attempt_stage_change("source", "dispatched", user(), None)
            assert result["conflict"] is True
            saved = await db.purchase_orders.find_one({"id": "p"})
            assert saved["items"][0]["stage"] == concurrent_change.get("items.0.stage", "in_box")
            assert not saved["items"][0].get("dispatched_at")
            tracker.log_event.assert_not_awaited()
        finally:
            client.close()
    asyncio.run(run())


def test_customer_and_quotation_views_follow_actual_fulfillment_and_reopen(mongo_url, monkeypatch):
    """Approval is independent of delivery; no page may hide an older open line."""
    from fastapi import Response
    from routes import customer_routes, quotation_routes

    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.completion
        monkeypatch.setattr(customer_routes, "db", db)
        monkeypatch.setattr(quotation_routes, "db", db)
        monkeypatch.setattr(tracker, "db", db)
        async def identity_images(items, _floor):
            return items
        monkeypatch.setattr(quotation_routes, "_canonicalize_item_images", identity_images)
        try:
            names = ["complete", "partial", "empty", "received", "reassigned"]
            await db.customers.insert_many([{"id": c, "name": c, "floor_id": "first-floor"} for c in names])
            await db.quotations.insert_many([{"id": f"q-{c}", "number": f"Q-{c}", "customer_id": c, "customer_name": c, "created_by": "test-owner", "created_by_name": "Test owner", "floor_id": "first-floor", "status": "ordered", "items": []} for c in names])
            await db.purchase_orders.insert_many([
                po("complete", "complete", [item(qty=8, godown_transferred_qty=2, loan_replenishment_returned_qty=1)]),
                po("partial-done", "partial"),
                po("partial-old", "partial", [item(stage="po_final")], created_at="2020-01-01"),
                po("zero", "empty", [item(qty=0)]),
                po("received", "received", [item(stage="delivered", stage_history=[{"note": "Auto-synced from PO receiving"}])]),
                # Item ownership wins over the original order/customer name.
                po("reassigned", "complete", [item(customer_id="reassigned", stage="in_box")]),
                # Other floor neither leaks completion nor blocks this floor.
                po("foreign", "complete", [item(stage="in_box")], floor_id="ground-floor"),
            ])
            async def customers(view):
                return await customer_routes.list_customers(Response(), skip=0, limit=500, confirmed_only=True, completion=view, user=user())
            async def quotations(view):
                return await quotation_routes.list_quotations(doc_type="standard", completion=view, skip=0, limit=100, user=user())
            assert {c.id for c in await customers("completed")} == {"complete"}
            assert {c.id for c in await customers("active")} == {"partial", "empty", "received", "reassigned"}
            assert {q["customer_id"] for q in await quotations("completed")} == {"complete"}
            assert {q["customer_id"] for q in await quotations("active")} == {"partial", "empty", "received", "reassigned"}
            assert all(q["purchase_completion_status"] == "completed" for q in await quotations("completed"))
            assert (await customer_routes.get_customer("complete", with_completion=True, user=user())).purchase_completion_status == "completed"
            assert (await quotation_routes.get_quotation("q-complete", with_completion=True, user=user())).purchase_completion_status == "completed"
            assert {c["id"] for c in await tracker.active_customer_workspaces(False, user())} == {"partial", "empty", "received", "reassigned"}
            # Reopens all views without editing the Customer or Quotation.
            await db.purchase_orders.insert_one(po("new-order", "complete", [item(stage="in_box")]))
            assert await customers("completed") == []
            assert await quotations("completed") == []
            assert (await customer_routes.get_customer("complete", with_completion=True, user=user())).purchase_completion_status == "active"
            assert (await quotation_routes.get_quotation("q-complete", with_completion=True, user=user())).purchase_completion_status == "active"
            assert "complete" in {c["id"] for c in await tracker.active_customer_workspaces(False, user())}
        finally:
            client.close()
    asyncio.run(run())



def test_po_only_customers_and_transferred_owners_share_confirmed_and_completed_directories(mongo_url, monkeypatch):
    from fastapi import Response
    from routes import customer_routes
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.completion
        monkeypatch.setattr(customer_routes, "db", db)
        monkeypatch.setattr(tracker, "db", db)
        try:
            names = ["direct", "transferred", "original", "cancelled", "zero", "returned", "foreign"]
            await db.customers.insert_many([{"id": name, "name": name, "floor_id": "first-floor"} for name in names])
            await db.purchase_orders.insert_many([
                po("direct", "direct"),
                po("transfer", "original", [item(customer_id="transferred")]),
                po("cancelled", "cancelled", [item(cancelled=True)]),
                po("zero", "zero", [item(qty=0)]),
                po("returned", "returned", [item(godown_transferred_qty=2)]),
                po("foreign", "foreign", floor_id="ground-floor"),
                po("cancelled-po", "cancelled", status="cancelled"),
            ])
            confirmed = await customer_routes.list_customers(Response(), skip=0, limit=500, confirmed_only=True, completion=None, user=user())
            assert {row.id for row in confirmed} == {"direct", "transferred"}
            completed = await customer_routes.list_customers(Response(), skip=0, limit=500, confirmed_only=True, completion="completed", user=user())
            assert {row.id for row in completed} == {row["id"] for row in await tracker.completed_customer_facets(0, 100, user())} == {"direct", "transferred"}
            await db.purchase_orders.insert_one(po("new", "direct", [item(stage="in_box")]))
            active = await customer_routes.list_customers(Response(), skip=0, limit=500, confirmed_only=True, completion="active", user=user())
            assert {row.id for row in active} == {"direct"}
        finally:
            client.close()
    asyncio.run(run())


def test_record_floor_completion_and_tile_list_ignore_owner_ambient_workspace(mongo_url, monkeypatch):
    from routes import customer_routes, quotation_routes
    from fastapi import HTTPException
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.completion
        monkeypatch.setattr(customer_routes, "db", db)
        monkeypatch.setattr(quotation_routes, "db", db)
        async def images(items, _floor): return items
        monkeypatch.setattr(quotation_routes, "_canonicalize_item_images", images)
        owner = UserPublic(id="owner", email="owner@example.com", full_name="Owner", role="owner", active_floor_id="first-floor")
        try:
            await db.customers.insert_one({"id": "tile", "name": "Tile buyer", "floor_id": "ground-floor"})
            await db.quotations.insert_one({"id": "tile-q", "number": "TQ-1", "floor_id": "ground-floor", "doc_type": "tiles_quotation", "customer_id": "tile", "customer_name": "Tile buyer", "created_by": "owner", "created_by_name": "Owner", "items": [], "status": "ordered"})
            await db.purchase_orders.insert_many([
                po("tile-po", "tile", floor_id="ground-floor"),
                po("sanitary-unrelated", "tile", [item(stage="in_box")]),
            ])
            assert (await customer_routes.get_customer("tile", with_completion=True, user=owner)).purchase_completion_status == "completed"
            assert (await quotation_routes.get_quotation("tile-q", with_completion=True, user=owner)).purchase_completion_status == "completed"
            listed = await quotation_routes.list_quotations(doc_type="tiles_quotation", completion="completed", skip=0, limit=100, user=owner)
            assert [row["id"] for row in listed] == ["tile-q"]
            assert listed[0]["purchase_completion_status"] == "completed"
            assert owner.active_floor_id == "first-floor"
            unauthorized = UserPublic(id="sales", email="sales@example.com", full_name="Sales", role="sales", floor_ids=["first-floor"], active_floor_id="first-floor")
            for handler, identity in [(customer_routes.get_customer, "tile"), (quotation_routes.get_quotation, "tile-q")]:
                with pytest.raises(HTTPException) as error:
                    await handler(identity, with_completion=True, user=unauthorized)
                assert error.value.status_code == 404
        finally:
            client.close()
    asyncio.run(run())
