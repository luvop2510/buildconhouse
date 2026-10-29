"""Run-owned local replica: summary HTTP reads and atomic linked sales losses."""
import asyncio
import os
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from motor.motor_asyncio import AsyncIOMotorClient


def test_summary_pages_and_lost_followups_use_real_mongo(monkeypatch):
    uri = os.environ.get("TILE_DRAFT_TEST_MONGO_URL")
    if uri != "mongodb://127.0.0.1:28176":
        pytest.skip("Explicit run-owned local replica required")
    assert os.environ.get("PYTHON_DOTENV_DISABLED") == "1"
    import auth
    import db as connection
    from models import UserPublic
    from routes import followup_routes as followups, quotation_routes as quotes

    async def run():
        client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=3000)
        database = client["forge_ground_lifecycle_qa_" + uuid4().hex]
        monkeypatch.setattr(connection, "client", client)
        monkeypatch.setattr(quotes, "db", database)
        monkeypatch.setattr(followups, "db", database)
        actor = UserPublic(id="local-sales-qa", full_name="Local QA", role="owner", active_floor_id="ground-floor")
        app = FastAPI()
        app.dependency_overrides[auth.get_current_user] = lambda: actor
        app.include_router(quotes.router, prefix="/api")
        try:
            await database.quotations.insert_many([{
                "id": f"q-{index:03d}", "number": f"TQ-{index}", "doc_type": "tiles_quotation",
                "floor_id": "ground-floor", "customer_id": "c", "customer_name": f"Buyer {index}",
                "status": "approved" if index == 120 else "draft", "grand_total": 100,
                "created_at": "2026-10-30T00:00:00Z", "updated_at": "v1",
                "items": [{"name": "Synthetic tile", "qty": 1}],
                "phone_snapshot": "private-fixture", "revisions": [{"private": True}],
            } for index in range(125)])
            await database.quotations.insert_one({"id": "foreign", "floor_id": "first-floor", "status": "draft", "customer_name": "Buyer 124"})
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-qa") as http:
                base = "/api/quotations?doc_type=tiles_quotation&view=pending&summary=true&limit=31"
                first = await http.get(base)
                assert first.status_code == 200, first.text
                rows = first.json()
                assert len(rows) == 31 and rows[0]["id"] == "q-124"
                assert rows[0]["item_count"] == 1
                assert not {"items", "phone_snapshot", "revisions", "_id"} & rows[0].keys()
                second = (await http.get(base + "&skip=30")).json()
                assert rows[30]["id"] == second[0]["id"]
                assert len({row["id"] for row in rows[:30] + second[:30]}) == 60
                assert len((await http.get(base + "&q=Buyer%20124")).json()) == 1
                assert (await http.get(base + "&q=%5B.*%5D")).json() == []

                for floor in ("ground-floor", "first-floor"):
                    qid, fid = f"lost-{floor}", f"followup-{floor}"
                    quote = {"id": qid, "floor_id": floor, "customer_id": "c", "doc_type": "tiles_quotation" if floor == "ground-floor" else "standard", "status": "approved"}
                    reminder = {"id": fid, "floor_id": floor, "customer_id": "c", "quotation_id": qid, "status": "open", "updated_at": "v1"}
                    await database.quotations.insert_one(quote.copy())
                    await database.followups.insert_many([reminder.copy(), {**reminder, "id": fid + "-sibling", "status": "snoozed"}])
                    patch = {"status": "dismissed", "completed_at": "v2", "completed_outcome": "lost", "resolution_note": "Other supplier", "lost_reason": "Other supplier", "updated_at": "v2"}
                    await followups._record_lost_quotation_followup(reminder, {"$set": patch, "$inc": {"call_attempts": 1}}, actor)
                    saved = await database.quotations.find_one({"id": qid})
                    assert saved["customer_outcome"] == "lost" and saved["status"] == "approved"
                    assert await database.followups.count_documents({"quotation_id": qid, "completed_outcome": "lost"}) == 2
                    with pytest.raises(HTTPException) as error:
                        await quotes.place_order_confirm(qid, quotes.PlaceOrderConfirmPayload(), actor)
                    assert error.value.status_code == 409
                    assert await database.event_outbox.count_documents({}) == 0

                completed = (await http.get("/api/quotations?doc_type=tiles_quotation&view=completed&summary=true")).json()
                assert [row["id"] for row in completed] == ["q-120"]
                lost = (await http.get("/api/quotations?doc_type=tiles_quotation&view=lost&summary=true")).json()
                assert [row["id"] for row in lost] == ["lost-ground-floor"]

                # A write failure after the quotation change rolls back the whole loss.
                reminder = {"id": "missing", "floor_id": "ground-floor", "customer_id": "c", "quotation_id": "q-001", "status": "open", "updated_at": "v1"}
                await database.followups.insert_one(reminder.copy())
                class BrokenFollowups:
                    find_one = database.followups.find_one
                    async def update_one(self, *args, **kwargs):
                        raise RuntimeError("injected follow-up write failure")
                from types import SimpleNamespace
                monkeypatch.setattr(followups, "db", SimpleNamespace(quotations=database.quotations, followups=BrokenFollowups()))
                with pytest.raises(RuntimeError, match="injected"):
                    await followups._record_lost_quotation_followup(reminder, {"$set": patch}, actor)
                assert "customer_outcome" not in await database.quotations.find_one({"id": "q-001"})
                assert (await database.followups.find_one({"id": "missing"}))["status"] == "open"
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("action", ["release", "move_to_godown", "dispatch_from_released", "dispatch_from_godown", "delivered"])
@pytest.mark.parametrize("fail_register", [False, True], ids=["commit", "register_insert_rolls_back"])
def test_tile_stock_and_register_commit_atomically_on_real_mongo(monkeypatch, action, fail_register):
    """Exercise real transaction abort after the permanent register has inserted."""
    uri = os.environ.get("TILE_DRAFT_TEST_MONGO_URL")
    if uri != "mongodb://127.0.0.1:28176":
        pytest.skip("Explicit run-owned local replica required")
    assert os.environ.get("PYTHON_DOTENV_DISABLED") == "1"
    from datetime import datetime, timezone
    from models import UserPublic
    from routes import tile_orders
    from services import activity_log, sequence, tile_movement_log

    async def run():
        client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=3000)
        database = client["forge_ground_movements_qa_" + uuid4().hex]
        monkeypatch.setattr(tile_orders, "client", client)
        for module in (tile_orders, activity_log, sequence, tile_movement_log):
            monkeypatch.setattr(module, "db", database)
        actor = UserPublic(id="movement-qa", full_name="Local warehouse QA", role="warehouse",
                           floor_ids=["ground-floor"], active_floor_id="ground-floor")
        identity = {"floor_id": "ground-floor", "is_deleted": False}
        item = {"id": "line", "name": "Synthetic tile", "qty": 20, "boxes_pending": 8, "boxes_ready": 8,
                "boxes_godown": 4, "boxes_dispatched": 0, "overall_status": "Ready", "current_location": "Ready"}
        if action == "delivered":
            item.update(qty=4, boxes_pending=0, boxes_ready=0, boxes_godown=0, boxes_dispatched=4,
                        overall_status="Dispatched", current_location="Dispatched")
        names = ("purchase_orders", "customer_orders", "ready_batches", "dispatches", "chalans", "material_movements", "counters", "activity_events")
        try:
            for name in names:
                await database.create_collection(name)
            year = datetime.now(timezone.utc).year
            await database.counters.insert_many([{"_id": key, "seq": 0} for key in (
                f"ready_batch:RB-{year}-", f"dispatch:DSP-{year}-", "chalan:CH-",
            )])
            await database.purchase_orders.insert_one({**identity, "id": "po", "number": "TPO-LOCAL-QA",
                "customer_id": "customer", "customer_name": "Synthetic buyer", "customer_order_id": "co",
                "brand_id": "brand", "brand_name": "Synthetic brand", "supplier_name": "Synthetic supplier",
                "items": [item], "overall_status": item["overall_status"]})
            await database.customer_orders.insert_one({**identity, "id": "co", "version": 0, "total_boxes": item["qty"],
                "delivery_name": "Synthetic site", "delivery_address": "Local QA", "delivery_city": "Mumbai",
                "brands": [{"purchase_order_id": "po", "status": item["overall_status"], "boxes_dispatched": item["boxes_dispatched"]}]})
            await database.ready_batches.insert_one({**identity, "id": "batch", "purchase_order_id": "po", "po_item_id": "line",
                "remaining_qty": 8, "created_at": "2026-10-01T00:00:00Z"})
            await database.dispatches.insert_one({**identity, "id": "dispatch", "dispatch_number": "TD-LOCAL-QA",
                "purchase_order_id": "po", "customer_order_id": "co", "chalan_id": "chalan", "customer_name": "Synthetic buyer",
                "delivered_at": None, "source": "godown", "ready_batches_consumed": [], "destination_name": "Synthetic site"})
            await database.chalans.insert_one({**identity, "id": "chalan", "number": "TC-LOCAL-QA", "dispatch_id": "dispatch",
                "items": [{"po_item_id": "line", "tile_name": "Synthetic tile", "boxes": 4}]})

            async def snapshot():
                return {name: await database[name].find({}, {"_id": 0}).sort("id", 1).to_list(100) for name in names}
            before = await snapshot()
            real_record = tile_movement_log.record_movement
            if fail_register:
                async def failing_record(**kwargs):
                    await real_record(**kwargs)
                    raise RuntimeError("injected permanent register failure after insert")
                monkeypatch.setattr(tile_orders, "record_movement", failing_record)
            else:
                monkeypatch.setattr(tile_orders, "record_movement", real_record)

            async def invoke():
                items = [{"po_item_id": "line", "qty": 2}]
                if action == "release":
                    return await tile_orders.mark_items_ready("po", tile_orders.BulkReadyBody(items=items), actor)
                if action == "move_to_godown":
                    return await tile_orders.move_material_to_godown("po", tile_orders.MoveToGodownBody(items=items), actor)
                if action == "dispatch_from_released":
                    return await tile_orders.dispatch_from_released("po", tile_orders.SimpleDispatchBody(items=items), actor)
                if action == "dispatch_from_godown":
                    return await tile_orders.dispatch_from_godown("po", tile_orders.SimpleDispatchBody(items=items), actor)
                return await tile_orders.mark_dispatch_delivered("dispatch", tile_orders.DeliveredBody(received_by="Site QA"), actor)

            if fail_register:
                with pytest.raises(RuntimeError, match="injected permanent register"):
                    await invoke()
                assert await snapshot() == before, "stock, batches, chalan, counters, rollups and register must all roll back"
            else:
                await invoke()
                rows = await database.material_movements.find({}, {"_id": 0}).to_list(10)
                assert len(rows) == 1
                assert rows[0]["movement_type"] == action and rows[0]["floor_id"] == "ground-floor"
                saved_item = (await database.purchase_orders.find_one({"id": "po"}))["items"][0]
                expected = {
                    "release": (10, 4, 0, 6), "move_to_godown": (6, 6, 0, 8),
                    "dispatch_from_released": (6, 4, 2, 8), "dispatch_from_godown": (8, 2, 2, 8),
                    "delivered": (0, 0, 4, 0),
                }[action]
                assert tuple(saved_item[key] for key in ("boxes_ready", "boxes_godown", "boxes_dispatched", "boxes_pending")) == expected
                if action.startswith("dispatch_from"):
                    assert await database.dispatches.count_documents({}) == 2
                    assert await database.chalans.count_documents({}) == 2
                    assert rows[0]["dispatch_id"] and rows[0]["chalan_id"]
                if action == "delivered":
                    assert saved_item["overall_status"] == "Delivered"
                    assert (await database.dispatches.find_one({"id": "dispatch"}))["delivered_at"]
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(run())
