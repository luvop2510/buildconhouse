"""Active and delivered product partitions must conserve actual quantities."""
import asyncio
from unittest.mock import AsyncMock

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
import pytest

from routes import purchases_tracker as tracker
from services.customer_completion import completed_customer_ids
from tests.integration.test_purchase_completion_mongo import mongo_url, item, po, user


def _page(view, customer=None, stage=None):
    return tracker._items_page_pipeline(view=view, brand=None, customer=customer, stage=stage, q=None,
        product_id=None, floor_ids=["first-floor"], sla_days=7, skip=0, limit=100)


def test_dispatched_rows_and_partial_chalan_quantities_move_to_completed_register(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        database = client.visibility
        monkeypatch.setattr(tracker, "db", database)
        try:
            source = po("partial", "partial", [item("partial", stage="in_box", qty=10)])
            source["chalans"] = [{"stage": "dispatched", "dispatched_at": "2026-10-20", "items": [{"po_item_id": "partial", "qty": 4}]}]
            await database.purchase_orders.insert_many([
                source, po("done", "done", [item("done", qty=3)]),
                po("mixed", "mixed", [item("split-done", qty=2), item("split-open", stage="in_box", qty=5)]),
                po("cancelled", "cancelled", [item("cancelled", cancelled=True)]),
                po("foreign", "foreign", [item("foreign")], floor_id="ground-floor"),
                po("returned", "returned", [item("returned", qty=2, godown_transferred_qty=2)]),
                po("legacy-receiving", "receiving", [item("received", stage="delivered", stage_history=[{"note": "Auto-synced from PO receiving"}])]),
            ])
            for view in ("today", "stock", "customers"):
                facet = (await database.purchase_orders.aggregate(_page(view)).to_list(1))[0]
                quantities = {line["item_id"]: line["qty"] for line in facet["items"]}
                assert quantities == {"partial": 6, "split-open": 5, "received": 2}
                assert all(line["stage"] != "dispatched" for line in facet["items"])
                exported = await tracker._iter_items(view, None, None, None, None, 7, floor_ids=["first-floor"])
                assert {line["item_id"]: line["qty"] for line in exported} == quantities
            delivered = (await database.purchase_orders.aggregate(_page("completed")).to_list(1))[0]
            assert {line["item_id"]: line["qty"] for line in delivered["items"]} == {"partial": 4, "done": 3, "split-done": 2}
            assert all(line["stage"] == "dispatched" for line in delivered["items"])
            assert (await database.purchase_orders.aggregate(_page("stock", stage="dispatched")).to_list(1))[0]["items"] == []
            assert (await database.purchase_orders.aggregate(_page("completed", "foreign")).to_list(1))[0]["items"] == []
            customers = await tracker.completed_customer_facets(skip=0, limit=100, user=user())
            by_customer = {row["id"]: row for row in customers}
            assert set(by_customer) == {"partial", "done", "mixed"}
            assert by_customer["partial"]["quantity"] == 4 and not by_customer["partial"]["fully_completed"]
            assert by_customer["done"]["fully_completed"]
            assert not by_customer["mixed"]["fully_completed"]
            assert await completed_customer_ids(database, user()) == {"done"}
            assert (await database.purchase_orders.find_one({"id": "partial"}))["items"][0]["qty"] == 10
            facets = await tracker.brand_facets(user=user())
            assert facets["all"] == 3
            stages = await tracker.stage_catalog(user=user())
            assert sum(row["count"] for row in stages) == 3
            assert next(row for row in stages if row["key"] == "dispatched")["count"] == 0
        finally:
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("requested,destination", [(None, "dispatched"), (6, "dispatched"), (7, "dispatched"), (6, "company_billing")])
def test_stage_move_only_admits_remaining_undispatched_quantity(mongo_url, monkeypatch, requested, destination):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        database = client.visibility
        monkeypatch.setattr(tracker, "db", database)
        monkeypatch.setattr(tracker, "_sync_po_status_with_stages", AsyncMock(return_value=None))
        monkeypatch.setattr(tracker, "log_event", AsyncMock())
        monkeypatch.setattr(tracker, "reconcile_followups", AsyncMock())
        try:
            source = po("partial", "partial", [item("partial", stage="in_box", qty=10, stage_history=[])])
            source["chalans"] = [{"stage": "dispatched", "items": [{"po_item_id": "partial", "qty": 4}]}]
            await database.purchase_orders.insert_one(source)
            if requested == 7:
                with pytest.raises(HTTPException) as error:
                    await tracker._attempt_stage_change("partial", destination, user(), None, qty=requested)
                assert error.value.status_code == 400
                assert len((await database.purchase_orders.find_one({"id": "partial"}))["items"]) == 1
            else:
                result = await tracker._attempt_stage_change("partial", destination, user(), None, qty=requested)
                assert result["qty_moved"] == 6
                active = (await database.purchase_orders.aggregate(_page("stock")).to_list(1))[0]
                done = (await database.purchase_orders.aggregate(_page("completed")).to_list(1))[0]
                assert sum(line["qty"] for line in active["items"]) == (0 if destination == "dispatched" else 6)
                assert sum(line["qty"] for line in done["items"]) == (10 if destination == "dispatched" else 4)
                saved = await database.purchase_orders.find_one({"id": "partial"})
                assert saved["chalans"] == source["chalans"]
                assert next(line for line in saved["items"] if line["id"] == "partial")["qty"] == 4
                assert await completed_customer_ids(database, user()) == ({"partial"} if destination == "dispatched" else set())
        finally:
            client.close()
    asyncio.run(run())


def test_partial_chalan_removal_preserves_delivered_history_and_pending_stock(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        database = client.visibility
        monkeypatch.setattr(tracker, "db", database)
        try:
            source = po("partial", "partial", [item("partial", stage="in_box", qty=10)])
            source["chalans"] = [{"stage": "dispatched", "items": [{"po_item_id": "partial", "qty": 4}]}]
            await database.purchase_orders.insert_one(source)
            before = await database.purchase_orders.find_one({"id": "partial"})
            with pytest.raises(HTTPException) as error:
                await tracker._cancel_item("partial", None, user())
            assert error.value.status_code == 409 and "separate line" in error.value.detail
            assert await database.purchase_orders.find_one({"id": "partial"}) == before
            active = (await database.purchase_orders.aggregate(_page("stock")).to_list(1))[0]
            done = (await database.purchase_orders.aggregate(_page("completed")).to_list(1))[0]
            assert active["items"][0]["qty"] == 6 and done["items"][0]["qty"] == 4
        finally:
            client.close()
    asyncio.run(run())


def test_prior_godown_and_loan_returns_are_counted_once_alongside_partial_dispatch(mongo_url):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        database = client.visibility
        try:
            source = po("partial", "partial", [item("partial", stage="in_box", qty=10, godown_transferred_qty=2, loan_replenishment_returned_qty=1)])
            source["chalans"] = [{"stage": "dispatched", "items": [{"po_item_id": "partial", "qty": 4}]}]
            await database.purchase_orders.insert_one(source)
            active = (await database.purchase_orders.aggregate(_page("stock")).to_list(1))[0]
            done = (await database.purchase_orders.aggregate(_page("completed")).to_list(1))[0]
            assert active["items"][0]["qty"] == 3
            assert done["items"][0]["qty"] == 4
            assert active["items"][0]["qty"] + done["items"][0]["qty"] + 2 + 1 == 10
        finally:
            client.close()
    asyncio.run(run())


def test_fully_covered_chalan_is_common_customer_completion_without_a_stage_write(mongo_url):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        database = client.visibility
        try:
            source = po("covered", "covered", [item("covered", stage="in_box", qty=4)])
            source["chalans"] = [{"stage": "dispatched", "items": [{"po_item_id": "covered", "qty": 4}]}]
            await database.purchase_orders.insert_one(source)
            assert await completed_customer_ids(database, user()) == {"covered"}
            assert (await database.purchase_orders.find_one({"id": "covered"}))["items"][0]["stage"] == "in_box"
        finally:
            client.close()
    asyncio.run(run())
