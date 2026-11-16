"""Release/Godown quantities and replay receipts on a run-owned Mongo replica.

This fixture starts its own loopback-only process on an ephemeral port. It never
loads application startup, migrations, workers, real credentials or live data.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
from uuid import uuid4
from urllib.parse import urlparse

import httpx
import pytest
from fastapi import FastAPI
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import MongoClient


@pytest.fixture(scope="session")
def tile_replica(tmp_path_factory):
    existing = os.environ.get("TILE_WORKFLOW_TEST_MONGO_URL")
    if existing:
        parsed = urlparse(existing)
        try:
            valid = (parsed.scheme == "mongodb" and parsed.hostname in {"127.0.0.1", "localhost"}
                     and parsed.port and not parsed.username and not parsed.password
                     and parsed.path in {"", "/"} and not parsed.query and not parsed.fragment)
        except ValueError:
            valid = False
        if not valid:
            raise RuntimeError("Workflow acceptance requires an explicitly selected disposable loopback replica")
        probe = MongoClient(existing, serverSelectionTimeoutMS=3000)
        try:
            hello = probe.admin.command("hello")
            if not hello.get("setName") or not hello.get("isWritablePrimary"):
                raise RuntimeError("Workflow acceptance requires a ready replica primary")
            yield existing
        finally:
            probe.close()
        return
    binary = shutil.which("mongod")
    if not binary:
        pytest.skip("Disposable local Mongo binary unavailable")
    directory = tmp_path_factory.mktemp("tile-release-replica")
    with socket.socket() as address:
        address.bind(("127.0.0.1", 0))
        port = address.getsockname()[1]
    process = subprocess.Popen([
        binary, "--dbpath", str(directory), "--bind_ip", "127.0.0.1", "--port", str(port),
        "--replSet", "tile_quantity_qa", "--logpath", str(directory / "mongo.log"),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"mongodb://127.0.0.1:{port}/?replicaSet=tile_quantity_qa"
    probe = MongoClient(f"mongodb://127.0.0.1:{port}/?directConnection=true", serverSelectionTimeoutMS=100)
    try:
        for _ in range(100):
            try:
                probe.admin.command("ping")
                break
            except Exception:
                time.sleep(0.05)
        else:
            raise AssertionError("Disposable Mongo did not start")
        probe.admin.command("replSetInitiate", {"_id": "tile_quantity_qa", "members": [{"_id": 0, "host": f"127.0.0.1:{port}"}]})
        for _ in range(200):
            if probe.admin.command("hello").get("isWritablePrimary"):
                break
            time.sleep(0.05)
        else:
            raise AssertionError("Disposable replica did not elect a primary")
        yield url
    finally:
        probe.close()
        process.terminate()
        process.wait(timeout=10)


def _actor(actor_id="quantity-qa"):
    from models import UserPublic
    return UserPublic(id=actor_id, email=f"{actor_id}@example.invalid", full_name="Quantity QA", role="owner",
                      floor_ids=["ground-floor", "first-floor"], active_floor_id="ground-floor")


def _item(item_id="tile-matt", qty=10, **changes):
    return {"id": item_id, "product_id": f"catalog-{item_id}", "name": "Ivory", "sku": f"IVORY-{item_id}",
            "series": "Ivory collection", "finish": "Matt", "size": "600x600", "quantity_unit": "Box",
            "qty": qty, "boxes_pending": qty, "boxes_ready": 0, "boxes_godown": 0, "boxes_dispatched": 0,
            "overall_status": "Pending", "current_location": "Pending", **changes}


def _po(po_id="qa-po", **changes):
    return {"id": po_id, "number": "FPO-QA-0001", "floor_id": "ground-floor", "customer_id": "qa-buyer",
            "customer_name": "Synthetic buyer", "brand_id": "qa-brand", "brand_name": "Synthetic brand",
            "supplier_id": "qa-supplier", "supplier_name": "Synthetic supplier", "customer_order_id": "",
            "created_at": "2026-11-01T10:00:00+00:00", "is_deleted": False,
            "items": [_item(), _item("tile-gloss", 5, finish="Glossy", size="1200x2400", quantity_unit="Pieces")],
            **changes}


async def _bind(monkeypatch, url):
    import auth
    import db as connection
    from routes import tile_orders
    # Eagerly import every write dependency before replacing its db binding.
    import services.sequence
    import services.tile_movement_log

    client = AsyncIOMotorClient(url, serverSelectionTimeoutMS=3000)
    database = client["forge_tile_quantity_qa_" + uuid4().hex]
    original_db, original_client = connection.db, connection.client
    backend_root = str(Path(tile_orders.__file__).resolve().parents[1]) + "/"
    for module in list(sys.modules.values()):
        if not module or not str(getattr(module, "__file__", "")).startswith(backend_root):
            continue
        if getattr(module, "db", None) is original_db:
            monkeypatch.setattr(module, "db", database)
        if getattr(module, "client", None) is original_client:
            monkeypatch.setattr(module, "client", client)
    async def noop(**_kwargs):
        return None
    monkeypatch.setattr(tile_orders, "log_event", noop)
    app = FastAPI()
    actor = {"value": _actor()}
    app.dependency_overrides[auth.get_current_user] = lambda: actor["value"]
    app.include_router(tile_orders.router, prefix="/api")
    for collection in ["purchase_orders", "ready_batches", "material_movements"]:
        await database[collection].create_index("id", unique=True)
    # Prefix seeding is deliberately outside business transactions. Seed before
    # race/rollback tests so those tests exercise quantity commands directly.
    year = datetime.now(timezone.utc).year
    await database.counters.insert_one({"_id": f"ready_batch:RB-{year}-", "seq": 0})
    return client, database, app, actor, tile_orders


def test_full_partial_multiple_releases_replay_and_fresh_inventory(tile_replica, monkeypatch):
    async def run():
        client, db, app, actor, _route = await _bind(monkeypatch, tile_replica)
        try:
            await db.purchase_orders.insert_many([
                _po(), _po("foreign", floor_id="first-floor", items=[_item(boxes_godown=99)]),
                _po("deleted", is_deleted=True, items=[_item(boxes_godown=88)]),
            ])
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-qa") as http:
                ready = "/api/tile-orders/purchase-orders/qa-po/ready"
                move = "/api/tile-orders/purchase-orders/qa-po/items/move-to-godown"
                async def post(path, key, entries):
                    response = await http.post(path, json={"request_key": key, "items": entries})
                    assert response.status_code == 200, response.text
                    return response.json()
                first = {"po_item_id": "tile-matt", "qty": 4}
                released = await post(ready, "release-partial-one", [first])
                assert await post(ready, "release-partial-one", [first]) == released
                mismatch = await http.post(ready, json={"request_key": "release-partial-one", "items": [{**first, "qty": 3}]})
                assert mismatch.status_code == 409, mismatch.text
                assert (await http.get("/api/tile-orders/inventory")).json()["rows"] == []
                moved = await post(move, "move-partial-one", [first])
                assert await post(move, "move-partial-one", [first]) == moved
                # A new worker cannot consume or read another actor's receipt.
                actor["value"] = _actor("quantity-other")
                await post(ready, "release-partial-one", [{**first, "qty": 2}])
                actor["value"] = _actor()
                await post(ready, "release-rest-two", [{**first, "qty": 4}, {"po_item_id": "tile-gloss", "qty": 5}])
                await post(move, "move-rest-two", [{**first, "qty": 6}, {"po_item_id": "tile-gloss", "qty": 5}])
                # A new GET is the page reload boundary; use real aggregation,
                # never the fallback fake that originally missed this defect.
                inventory = await http.get("/api/tile-orders/inventory")
                assert inventory.status_code == 200, inventory.text
                rows = inventory.json()["rows"]
                assert inventory.json()["total"] == 2
                by_item = {row["po_item_id"]: row for row in rows}
                assert (by_item["tile-matt"]["quantity"], by_item["tile-matt"]["quantity_unit"]) == (10, "Box")
                assert (by_item["tile-gloss"]["quantity"], by_item["tile-gloss"]["quantity_unit"]) == (5, "Pieces")
                assert by_item["tile-gloss"]["finish"] == "Glossy"
                assert by_item["tile-gloss"]["size"] == "1200x2400"
                assert by_item["tile-gloss"]["product_id"] == "catalog-tile-gloss"
                assert by_item["tile-gloss"]["purchase_order_id"] == "qa-po"
                assert {row["product"] for row in rows} == {"IVORY-tile-matt", "IVORY-tile-gloss"}
                assert (await http.get("/api/tile-orders/inventory?search=IVORY-tile-gloss")).json()["total"] == 1
                saved = await db.purchase_orders.find_one({"id": "qa-po"})
                assert [(i["qty"], i["boxes_pending"], i["boxes_ready"], i["boxes_godown"], i["boxes_dispatched"]) for i in saved["items"]] == [(10, 0, 0, 10, 0), (5, 0, 0, 5, 0)]
                assert await db.ready_batches.count_documents({}) == 4
                assert await db.material_movements.count_documents({"movement_type": "release"}) == 4
                assert await db.material_movements.count_documents({"movement_type": "move_to_godown"}) == 3
                assert sum([batch["remaining_qty"] async for batch in db.ready_batches.find({})]) == 0
                # Replay after later movements preserves the later balance.
                assert await post(ready, "release-partial-one", [first]) == released
                assert await post(move, "move-partial-one", [first]) == moved
                assert (await http.get("/api/tile-orders/inventory")).json()["rows"] == rows
                assert await db.material_movements.count_documents({}) == 7
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_same_key_concurrent_release_and_move_commit_once(tile_replica, monkeypatch):
    async def run():
        client, db, app, _actor_state, _route = await _bind(monkeypatch, tile_replica)
        try:
            await db.purchase_orders.insert_one(_po(items=[_item(qty=20)]))
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-qa") as http:
                for action, path in [
                    ("release", "/api/tile-orders/purchase-orders/qa-po/ready"),
                    ("move", "/api/tile-orders/purchase-orders/qa-po/items/move-to-godown"),
                ]:
                    body = {"request_key": f"concurrent-{action}", "items": [{"po_item_id": "tile-matt", "qty": 4}]}
                    responses = await asyncio.gather(http.post(path, json=body), http.post(path, json=body))
                    assert any(r.status_code == 200 for r in responses), [r.text for r in responses]
                    assert all(r.status_code in {200, 409} for r in responses), [r.text for r in responses]
                    retry = await http.post(path, json=body)
                    assert retry.status_code == 200, retry.text
                saved = (await db.purchase_orders.find_one({"id": "qa-po"}))["items"][0]
                assert (saved["boxes_pending"], saved["boxes_ready"], saved["boxes_godown"]) == (16, 0, 4)
                assert await db.ready_batches.count_documents({}) == 1
                assert await db.material_movements.count_documents({}) == 2
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("action", ["release", "move"])
def test_audit_failure_rolls_back_quantities_batches_and_receipt(tile_replica, monkeypatch, action):
    async def run():
        client, db, app, _actor_state, route = await _bind(monkeypatch, tile_replica)
        try:
            await db.purchase_orders.insert_one(_po(items=[_item(qty=10)]))
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://local-qa") as http:
                ready = "/api/tile-orders/purchase-orders/qa-po/ready"
                move = "/api/tile-orders/purchase-orders/qa-po/items/move-to-godown"
                if action == "move":
                    initial = await http.post(ready, json={"items": [{"po_item_id": "tile-matt", "qty": 6}]})
                    assert initial.status_code == 200, initial.text
                before = await db.purchase_orders.find_one({"id": "qa-po"})
                counts = {name: await db[name].count_documents({}) for name in ["ready_batches", "material_movements", "tile_movement_receipts"]}
                original_record = route.record_movement
                async def fail_register(**kwargs):
                    await original_record(**kwargs)
                    raise RuntimeError("Synthetic audit write failure")
                monkeypatch.setattr(route, "record_movement", fail_register)
                body = {"request_key": f"rollback-{action}", "items": [{"po_item_id": "tile-matt", "qty": 4}]}
                failed = await http.post(ready if action == "release" else move, json=body)
                assert failed.status_code >= 500
                assert await db.purchase_orders.find_one({"id": "qa-po"}) == before
                assert {name: await db[name].count_documents({}) for name in counts} == counts
                monkeypatch.setattr(route, "record_movement", original_record)
                successful = await http.post(ready if action == "release" else move, json=body)
                assert successful.status_code == 200, successful.text
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())
