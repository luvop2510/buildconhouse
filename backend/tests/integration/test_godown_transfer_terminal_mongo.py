"""Actual replica transactions: deleting customer history cannot replay stock."""
import asyncio
import json
import shutil
import socket
import subprocess
import time
from uuid import uuid4
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError

from models import UserPublic
from routes import godown_stock_routes as route
from services.customer_deletion import apply_plan, plan_deletion
from services.godown_transfer_receipts import completion_receipt, preserve_removed_history


@pytest.fixture(scope="module")
def receipt_mongo_uri(tmp_path_factory):
    binary = shutil.which("mongod")
    if not binary:
        pytest.skip("Disposable Mongo binary unavailable")
    with socket.socket() as address:
        address.bind(("127.0.0.1", 0))
        port = address.getsockname()[1]
    folder = tmp_path_factory.mktemp("stock-terminal-replica")
    name = "stock_receipt_qa"
    process = subprocess.Popen([binary, "--replSet", name, "--dbpath", str(folder), "--bind_ip", "127.0.0.1", "--port", str(port), "--logpath", str(folder / "mongo.log")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    uri = f"mongodb://127.0.0.1:{port}"
    probe = MongoClient(uri, directConnection=True, serverSelectionTimeoutMS=200)
    try:
        for _ in range(100):
            try:
                probe.admin.command("ping")
                break
            except Exception:
                time.sleep(.05)
        else:
            raise AssertionError("Disposable Mongo failed to start")
        probe.admin.command("replSetInitiate", {"_id": name, "members": [{"_id": 0, "host": f"127.0.0.1:{port}"}]})
        for _ in range(160):
            if probe.admin.command("hello").get("isWritablePrimary"):
                break
            time.sleep(.05)
        else:
            raise AssertionError("Disposable replica failed to elect a primary")
        yield uri + f"/?replicaSet={name}"
    finally:
        probe.close()
        process.terminate()
        process.wait(timeout=10)


def actor():
    return UserPublic(id="warehouse-actor", email="actor@example.test", full_name="Warehouse actor", role="warehouse", floor_ids=["first-floor"], active_floor_id="first-floor")


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("shared", [False, True])
def test_deleted_or_redacted_transfer_keeps_nonpersonal_terminal_evidence(receipt_mongo_uri, monkeypatch, legacy, shared):
    async def run():
        client = AsyncIOMotorClient(receipt_mongo_uri)
        db = client["terminal_" + uuid4().hex]
        monkeypatch.setattr(route, "db", db)
        monkeypatch.setattr(route, "client", client)
        monkeypatch.setattr(route, "log_event", AsyncMock())
        number = 0
        async def sequence(*_args, **_kwargs):
            nonlocal number
            number += 1
            return f"QA-{number:04}"
        monkeypatch.setattr(route, "next_number", sequence)
        try:
            await route.ensure_godown_stock_indexes()
            await db.godown_stock.insert_one({"id": "stock", "floor_id": "first-floor", "product_id": "product", "sku": "B-1", "name": "Basin", "unit_price": 100, "mrp": 100, "available_qty": 5, "qty_received": 5,
                **({"source_customer_id": "surviving-source", "source_customer_name": "Surviving source"} if shared else {})})
            if shared:
                await db.customers.insert_one({"id": "surviving-source", "floor_id": "first-floor", "name": "Surviving source"})
            body = route.CustomerTransfer(qty=2, new_customer=route.NewTransferCustomer(name="Private removed customer", email="removed@example.com", phone="9000000000"), unit_price=100, idempotency_key="terminal-command")
            result = await route.transfer_stock_to_customer("stock", body, actor())
            stored = await db.godown_customer_transfers.find_one({"id": result["id"]})
            terminal = completion_receipt(stored)
            assert await db.settings.count_documents({"kind": "godown_transfer_completion"}) == 1
            assert (await db.godown_stock.find_one({"id": "stock"}))["available_qty"] == 3
            if legacy:
                await db.settings.delete_one({"_id": terminal["_id"]})
                await db.godown_customer_transfers.update_one({"id": result["id"]}, {"$unset": {"request_sha256": "", "transfer_type": ""}})
            async with await client.start_session() as session:
                async with session.start_transaction():
                    plan = await plan_deletion(db, customer_id=result["recipient_customer_id"], session=session)
                    await apply_plan(db, plan, session)
            assert await db.customers.count_documents({"id": result["recipient_customer_id"]}) == 0
            history = await db.godown_customer_transfers.find_one({"id": result["id"]})
            assert bool(history) is shared
            if shared:
                assert "recipient_customer_id" not in history and "recipient_customer_name" not in history
            terminal = await db.settings.find_one({"kind": "godown_transfer_completion"})
            assert terminal["history_removed"] is True
            assert not {"recipient_customer_id", "recipient_customer_name", "source_customer_id", "reason", "name", "phone", "email"} & terminal.keys()
            serialized = json.dumps(terminal, default=str)
            assert "Private removed customer" not in serialized and "removed@example.com" not in serialized
            before = {name: await db[name].count_documents({}) for name in ["customers", "quotations", "purchase_orders", "godown_customer_transfers"]}
            for request in [body, body.model_copy(update={"qty": 1})]:
                with pytest.raises(HTTPException) as error:
                    await route.transfer_stock_to_customer("stock", request, actor())
                assert error.value.status_code == 410
                assert error.value.detail["code"] == "godown_transfer_record_removed"
                assert error.value.detail["transfer"]["qty"] == 2
                assert "request_sha256" not in error.value.detail["transfer"]
            assert (await db.godown_stock.find_one({"id": "stock"}))["available_qty"] == 3
            assert before == {name: await db[name].count_documents({}) for name in before}
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_history_removal_and_its_completion_marker_roll_back_together(receipt_mongo_uri):
    async def run():
        client = AsyncIOMotorClient(receipt_mongo_uri)
        db = client["terminal_rollback_" + uuid4().hex]
        transfer = {"id": "history", "floor_id": "first-floor", "stock_id": "stock", "qty": 2, "transfer_type": "godown_stock", "idempotency_key": "godown-transfer:rollback-command", "created_by": "actor"}
        try:
            await db.godown_customer_transfers.insert_one(transfer)
            with pytest.raises(RuntimeError):
                async with await client.start_session() as session:
                    async with session.start_transaction():
                        await preserve_removed_history(db, transfer, session)
                        await db.godown_customer_transfers.delete_one({"id": "history"}, session=session)
                        raise RuntimeError("Simulated deletion failure")
            assert await db.settings.count_documents({}) == 0
            assert await db.godown_customer_transfers.count_documents({"id": "history"}) == 1
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("field,value", [("floor_id", "ground-floor"), ("stock_id", "other-stock"), ("actor_id", "other-actor"), ("transfer_id", "other-transfer"), ("qty", 3), ("request_sha256", "different-hash")])
def test_conflicting_terminal_evidence_aborts_history_removal(receipt_mongo_uri, field, value):
    async def run():
        client = AsyncIOMotorClient(receipt_mongo_uri)
        db = client["terminal_conflict_" + uuid4().hex]
        transfer = {"id": "history", "floor_id": "first-floor", "stock_id": "stock", "qty": 2, "transfer_type": "godown_stock", "idempotency_key": "godown-transfer:conflicting-evidence", "created_by": "actor", "request_sha256": "original-hash"}
        receipt = {**completion_receipt(transfer), field: value}
        try:
            await db.settings.insert_one(receipt)
            async with await client.start_session() as session:
                async with session.start_transaction():
                    with pytest.raises(HTTPException) as error:
                        await preserve_removed_history(db, transfer, session)
                    assert error.value.status_code == 409
            saved = await db.settings.find_one({"_id": receipt["_id"]})
            assert "history_removed" not in saved
            assert saved[field] == value
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("legacy", [False, True])
def test_retry_racing_history_deletion_never_recreates_customer_or_consumes_twice(receipt_mongo_uri, monkeypatch, legacy):
    async def run():
        client = AsyncIOMotorClient(receipt_mongo_uri)
        db = client["terminal_race_" + uuid4().hex]
        monkeypatch.setattr(route, "db", db)
        monkeypatch.setattr(route, "client", client)
        monkeypatch.setattr(route, "log_event", AsyncMock())
        monkeypatch.setattr(route, "next_number", AsyncMock(side_effect=["QA-1", "QA-2", "QA-3", "QA-4"]))
        entered, release = asyncio.Event(), asyncio.Event()
        try:
            await route.ensure_godown_stock_indexes()
            await db.godown_stock.insert_one({"id": "stock", "floor_id": "first-floor", "product_id": "product", "sku": "B-1", "name": "Basin", "unit_price": 100, "available_qty": 5, "qty_received": 5})
            body = route.CustomerTransfer(qty=2, new_customer=route.NewTransferCustomer(name="Race recipient"), unit_price=100, idempotency_key="racing-command")
            result = await route.transfer_stock_to_customer("stock", body, actor())
            stored = await db.godown_customer_transfers.find_one({"id": result["id"]})
            if legacy:
                await db.settings.delete_one({"_id": completion_receipt(stored)["_id"]})
                await db.godown_customer_transfers.update_one({"id": result["id"]}, {"$unset": {"request_sha256": "", "transfer_type": ""}})
            class History:
                pause = True
                async def find_one(self, *args, **kwargs):
                    if self.pause:
                        self.pause = False
                        entered.set()
                        await release.wait()
                    return await db.godown_customer_transfers.find_one(*args, **kwargs)
                def __getattr__(self, key):
                    return getattr(db.godown_customer_transfers, key)
            class Database:
                godown_customer_transfers = History()
                def __getattr__(self, key):
                    return getattr(db, key)
            monkeypatch.setattr(route, "db", Database())
            retry = asyncio.create_task(route.transfer_stock_to_customer("stock", body, actor()))
            await asyncio.wait_for(entered.wait(), 5)
            async with await client.start_session() as session:
                async with session.start_transaction():
                    plan = await plan_deletion(db, customer_id=result["recipient_customer_id"], session=session)
                    await apply_plan(db, plan, session)
            release.set()
            with pytest.raises(HTTPException) as error:
                await retry
            assert error.value.status_code == 410
            assert error.value.detail["code"] == "godown_transfer_record_removed"
            assert (await db.godown_stock.find_one({"id": "stock"}))["available_qty"] == 3
            assert await db.customers.count_documents({}) == 0
            assert await db.purchase_orders.count_documents({}) == 0
            assert await db.quotations.count_documents({}) == 0
            assert await db.godown_customer_transfers.count_documents({}) == 0
            assert await db.settings.count_documents({"kind": "godown_transfer_completion", "history_removed": True}) == 1
        finally:
            release.set()
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("mismatch", ["actor", "stock", "floor"])
@pytest.mark.parametrize("duplicate_fallback", [False, True])
def test_terminal_lookup_cannot_resolve_another_scope(receipt_mongo_uri, monkeypatch, mismatch, duplicate_fallback):
    async def run():
        client = AsyncIOMotorClient(receipt_mongo_uri)
        db = client["terminal_scope_" + uuid4().hex]
        monkeypatch.setattr(route, "db", db)
        monkeypatch.setattr(route, "client", client)
        monkeypatch.setattr(route, "log_event", AsyncMock())
        monkeypatch.setattr(route, "next_number", AsyncMock(side_effect=["QA-1", "QA-2"]))
        transfer = {"id": "old-transfer", "floor_id": "first-floor", "stock_id": "stock", "qty": 2,
                    "transfer_type": "godown_stock", "idempotency_key": "godown-transfer:scope-command", "created_by": actor().id}
        try:
            await route.ensure_godown_stock_indexes()
            await db.settings.insert_one({**completion_receipt(transfer), "history_removed": True})
            caller = actor().model_copy(update={"id": "other-actor"}) if mismatch == "actor" else actor()
            stock_id = "other-stock" if mismatch == "stock" else "stock"
            if mismatch == "floor":
                caller = actor().model_copy(update={"floor_ids": ["ground-floor"], "active_floor_id": "ground-floor"})
                stock_id = "ground-stock"
                await db.godown_stock.insert_one({"id": stock_id, "floor_id": "ground-floor", "product_id": "product", "sku": "B-1", "name": "Other-floor basin", "unit_price": 100, "available_qty": 5, "qty_received": 5})
            body = route.CustomerTransfer(qty=2, new_customer=route.NewTransferCustomer(name="Uncreated customer"), unit_price=100, idempotency_key="scope-command")
            if duplicate_fallback:
                monkeypatch.setattr(route, "_transfer_stock_to_customer_once", AsyncMock(side_effect=DuplicateKeyError("Synthetic duplicate")))
            with pytest.raises(HTTPException) as error:
                await route.transfer_stock_to_customer(stock_id, body, caller)
            assert error.value.status_code == 409
            assert isinstance(error.value.detail, str)  # No other scope's receipt.
            assert await db.customers.count_documents({}) == 0
            assert await db.quotations.count_documents({}) == 0
            assert await db.purchase_orders.count_documents({}) == 0
            if mismatch == "floor":
                assert (await db.godown_stock.find_one({"id": stock_id}))["available_qty"] == 5
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())
