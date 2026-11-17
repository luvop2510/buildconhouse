"""Run-owned loopback replica: concurrent profile creation and dispatch rollback.

Uses the quantity acceptance's disposable Mongo fixture only, with a separate
random database. Application lifespan, real credentials and workers never run.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from uuid import uuid4

import httpx
from motor.motor_asyncio import AsyncIOMotorClient

from tests.integration.test_tile_release_godown_mongo import tile_replica, _bind, _po, _item


def test_driver_reuse_all_dispatch_paths_snapshots_and_rollback(tile_replica, monkeypatch):
    async def run():
        client, db, app, _actor, route = await _bind(monkeypatch, tile_replica)
        try:
            year = datetime.now(timezone.utc).year
            await db.counters.insert_many([
                {"_id": f"dispatch:DSP-{year}-", "seq": 0}, {"_id": "chalan:CH-", "seq": 0},
            ])
            # Two simple paths use their saved pools; generic dispatch supports
            # its legacy direct-from-pending path and must save the driver too.
            await db.purchase_orders.insert_many([
                _po("released", items=[_item(qty=6, boxes_pending=0, boxes_ready=6)]),
                _po("godown", items=[_item(qty=6, boxes_pending=0, boxes_godown=6)]),
                _po("generic", items=[_item(qty=6)]),
                _po("rollback", items=[_item(qty=6, boxes_pending=0, boxes_godown=6)]),
            ])
            await db.ready_batches.insert_one({"id": "batch-driver", "purchase_order_id": "released", "po_item_id": "tile-matt",
                "qty": 6, "remaining_qty": 6, "floor_id": "ground-floor", "is_deleted": False, "created_at": "2026-11-01"})
            transport = {"driver_name": "Ramesh", "driver_mobile": "+91 9876543210", "vehicle_number": "GJ-01-1000"}
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-qa") as http:
                async def dispatch(po, path, vehicle, **extras):
                    response = await http.post(f"/api/tile-orders/purchase-orders/{po}/{path}", json={
                        "items": [{"po_item_id": "tile-matt", "qty": 2}], **transport,
                        "vehicle_number": vehicle, "receiver_name": "Trip receiver", "reference_number": "Trip LR", **extras,
                    })
                    assert response.status_code == 200, response.text
                    return response.json()
                first = await dispatch("released", "dispatch-from-released", "GJ-01-1000")
                second = await dispatch("godown", "dispatch-from-godown", "GJ-01-2000")
                await dispatch("generic", "dispatch", "GJ-01-3000", destination_type="Customer",
                               destination_name="Trip customer", destination_address="Trip location", destination_city="Rajkot")
                profiles = (await http.get("/api/tile-orders/drivers?search=Ramesh")).json()["drivers"]
                assert profiles == [{"name": "Ramesh", "mobile": "9876543210", "vehicle_number": "GJ-01-3000"}]
                assert (await http.get("/api/tile-orders/drivers?search=%2B91%209876543210")).json()["drivers"] == profiles
                assert await db.dispatch_drivers.count_documents({}) == 1
                assert (await db.chalans.find_one({"id": first["chalan"]["id"]}))["vehicle_number"] == "GJ-01-1000"
                assert (await db.chalans.find_one({"id": second["chalan"]["id"]}))["vehicle_number"] == "GJ-01-2000"
                # Editing only a historical trip field does not regress the
                # current profile back to this older dispatch's driver snapshot.
                patch = await http.patch(f"/api/tile-orders/dispatches/{first['dispatch']['id']}/transport", json={
                    "receiver_name": "New trip receiver", "driver_name": "Ramesh", "driver_mobile": "9876543210", "vehicle_number": "GJ-01-1000",
                })
                assert patch.status_code == 200, patch.text
                assert (await db.dispatch_drivers.find_one({}))["vehicle_number"] == "GJ-01-3000"
                patch = await http.patch(f"/api/tile-orders/dispatches/{second['dispatch']['id']}/transport", json={
                    "driver_name": "Rameshbhai", "driver_mobile": "9876543210", "vehicle_number": "GJ-01-4000",
                })
                assert patch.status_code == 200, patch.text
                assert (await db.dispatch_drivers.find_one({}))["vehicle_number"] == "GJ-01-4000"
                assert (await db.chalans.find_one({"id": first["chalan"]["id"]}))["driver_name"] == "Ramesh"
                saved = await db.dispatch_drivers.find_one({})
                assert not set(saved) & {"receiver_name", "destination_address", "reference_number", "labor_cost"}

                # Force a late transaction failure after the profile upsert.
                async def fail_register(**kwargs):
                    raise RuntimeError("QA transaction rollback")
                monkeypatch.setattr(route, "record_movement", fail_register)
                try:
                    await dispatch("rollback", "dispatch-from-godown", "SHOULD-ROLL-BACK")
                except RuntimeError as error:
                    assert str(error) == "QA transaction rollback"
                else:
                    raise AssertionError("Expected late transaction failure")
                assert (await db.dispatch_drivers.find_one({}))["vehicle_number"] == "GJ-01-4000"
                assert await db.dispatches.count_documents({}) == 3
                assert await db.chalans.count_documents({}) == 3
                assert (await db.purchase_orders.find_one({"id": "rollback"}))["items"][0]["boxes_godown"] == 6
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_concurrent_first_use_deduplicates_normalized_mobile(tile_replica):
    from services.dispatch_drivers import DriverSnapshotFields, save_dispatch_driver
    async def run():
        client = AsyncIOMotorClient(tile_replica, serverSelectionTimeoutMS=3000)
        db = client["forge_driver_race_" + uuid4().hex]
        try:
            # Save uses only Mongo's unique _id; no index setup is necessary.
            await asyncio.gather(*[
                save_dispatch_driver(db, DriverSnapshotFields(driver_name="Ramesh", driver_mobile=mobile, vehicle_number="GJ-01-1000"),
                    floor_id="ground-floor", actor_id="qa", session=None)
                for mobile in ["9876543210", "+91 98765 43210", "09876543210"] * 8
            ])
            assert await db.dispatch_drivers.count_documents({}) == 1
            assert (await db.dispatch_drivers.find_one({}))["_id"] == "ground-floor:9876543210"
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_driver_search_ranks_before_limit_and_matches_first_character(tile_replica, monkeypatch):
    async def run():
        client, db, app, _actor, _route = await _bind(monkeypatch, tile_replica)

        def profile(name, mobile, vehicle="", *, day=1, floor="ground-floor"):
            return {"_id": f"{floor}:{mobile}", "floor_id": floor, "name": name, "mobile": mobile,
                    "vehicle_number": vehicle, "updated_at": f"2026-11-{day:02d}"}

        try:
            await db.dispatch_drivers.insert_many([
                profile("H", "7000000000"),
                profile("Harish", "9876543210", "GJ-01-1000", day=2),
                profile("Ramesh", "7999000000", "GJ-01-9000", day=3),
                profile("H", "7777777777", day=30, floor="first-floor"),
                *[profile(f"Shah {i}", f"71000000{i:02d}", day=20) for i in range(15)],
            ])
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-qa") as http:
                async def search(query):
                    response = await http.get("/api/tile-orders/drivers", params={"search": query})
                    assert response.status_code == 200, response.text
                    assert response.headers["cache-control"] == "no-store"
                    return response.json()["drivers"]

                one = await search("h")
                assert len(one) == 12
                assert [driver["name"] for driver in one[:2]] == ["H", "Harish"]
                assert [driver["name"] for driver in one[2:]] == [f"Shah {i}" for i in range(10)]
                assert set(one[0]) == {"name", "mobile", "vehicle_number"}
                assert (await search("Ha"))[0]["name"] == "Harish"
                assert [driver["name"] for driver in await search("gj")] == ["Ramesh", "Harish"]
                for query in ("9", "987", "+91 (987) 654-3210", "09876-543210", "+91 987"):
                    assert (await search(query))[0]["name"] == "Harish"
                assert await search("9-") == await search("9")
                assert await search("GJ-01-1000") == await search("9876543210")
                assert await search("GJ1") == []
                assert await search(".*") == []
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())
