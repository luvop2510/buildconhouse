"""Customer lending uses real replica transactions, CAS and nested array filters."""
import asyncio
from datetime import datetime, timezone
import os
import shutil
import socket
import subprocess
import time
from unittest.mock import AsyncMock
from uuid import uuid4
from urllib.parse import urlsplit

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import MongoClient
from pymongo.errors import PyMongoError
import pytest

from models import UserPublic
from routes import purchases_tracker as tracker
from services import domain_outbox, sequence, transfer_workflow as workflow
from services.purchase_stages import active_quantity


@pytest.fixture(scope="module")
def loan_mongo_uri(tmp_path_factory):
    configured = os.environ.get("SANITARY_LOAN_TEST_MONGO_URL")
    if configured:
        parsed = urlsplit(configured)
        assert (parsed.scheme == "mongodb" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
                and parsed.port and not parsed.username and not parsed.password
                and parsed.path in {"", "/"}), "Loan tests require an explicit loopback replica without an application database"
        probe = MongoClient(configured, directConnection=True, serverSelectionTimeoutMS=3000)
        try:
            hello = probe.admin.command("hello")
            assert hello.get("isWritablePrimary") and hello.get("setName"), "Loan tests require a writable replica primary"
            assert all(urlsplit("mongodb://" + host).hostname in {"127.0.0.1", "localhost", "::1"}
                       for host in hello.get("hosts", [])), "Loan replica members must all be loopback"
        finally:
            probe.close()
        yield configured
        return
    binary = shutil.which("mongod")
    if not binary:
        if os.environ.get("CI"):
            pytest.fail("CI requires SANITARY_LOAN_TEST_MONGO_URL or a disposable local mongod")
        pytest.skip("Disposable local Mongo binary unavailable")
    with socket.socket() as address:
        address.bind(("127.0.0.1", 0))
        port = address.getsockname()[1]
    folder = tmp_path_factory.mktemp("sanitary-loan-replica")
    replica = "loan_qa_" + uuid4().hex[:10]
    process = subprocess.Popen([
        binary, "--replSet", replica, "--dbpath", str(folder), "--bind_ip", "127.0.0.1",
        "--port", str(port), "--logpath", str(folder / "mongo.log"),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    probe = MongoClient(f"mongodb://127.0.0.1:{port}", directConnection=True, serverSelectionTimeoutMS=200)
    try:
        for _ in range(100):
            try:
                probe.admin.command("ping")
                break
            except PyMongoError:
                time.sleep(.05)
        else:
            raise AssertionError("Disposable loan Mongo failed to start")
        probe.admin.command("replSetInitiate", {"_id": replica, "members": [{"_id": 0, "host": f"127.0.0.1:{port}"}]})
        for _ in range(160):
            if probe.admin.command("hello").get("isWritablePrimary"):
                break
            time.sleep(.05)
        else:
            raise AssertionError("Disposable loan Mongo did not elect a primary")
        yield f"mongodb://127.0.0.1:{port}/?replicaSet={replica}"
    finally:
        probe.close()
        process.terminate()
        process.wait(timeout=10)


def actor():
    return UserPublic(id="loan-warehouse", email="warehouse@example.test", full_name="Warehouse",
                      role="warehouse", floor_ids=["first-floor"], active_floor_id="first-floor")


def _item(identity, customer, stage, qty=84):
    return {"id": identity, "customer_id": customer, "product_id": "basin", "sku": "BASIN-1",
            "name": "Basin", "qty": qty, "unit_cost": 100, "stage": stage,
            "stage_history": [], "last_moved_at": "2026-10-27T00:00:00+00:00"}


async def setup_database(monkeypatch, uri, target_stage="po_final"):
    client = AsyncIOMotorClient(uri)
    database = client["sanitary_loan_" + uuid4().hex]
    for module in (workflow, tracker, domain_outbox, sequence):
        monkeypatch.setattr(module, "db", database)
    for module in (workflow, domain_outbox):
        monkeypatch.setattr(module, "client", client)
    # Only unrelated reporting effects are mocked; all business persistence,
    # status synchronization, outbox dispatch and activity journals use Mongo.
    monkeypatch.setattr(tracker, "log_event", AsyncMock())
    monkeypatch.setattr(tracker, "reconcile_followups_admitted", AsyncMock())
    monkeypatch.setattr(domain_outbox, "_bump_analytics_versions", AsyncMock())
    await workflow.ensure_transfer_indexes()
    await domain_outbox.ensure_outbox_indexes()
    await database.customers.insert_many([
        {"id": identity, "name": identity.title(), "floor_id": "first-floor"}
        for identity in ("lender", "recipient")
    ])
    await database.purchase_orders.insert_many([
        {"id": "lender-po", "number": "LENDER-1", "customer_id": "lender", "customer_name": "Lender",
         "floor_id": "first-floor", "status": "ordered", "items": [_item("lender-item", "lender", "in_box")], "grand_total": 8400},
        {"id": "recipient-po", "number": "RECIPIENT-1", "customer_id": "recipient", "customer_name": "Recipient",
         "floor_id": "first-floor", "status": "ordered", "items": [_item("recipient-item", "recipient", target_stage)], "grand_total": 8400},
    ])
    # Seed outside the loan transaction, as ordinary startup/sequence allocation does.
    stem = f"FPO-{datetime.now(timezone.utc).year}-"
    await database.counters.insert_one({"_id": f"purchase_order:{stem}", "seq": 0})
    return client, database


async def lend():
    return await workflow.execute_transfer(
        item_id="lender-item", destination_customer_id="recipient", new_customer=None,
        qty=4, reason="Customer needs four basins", idempotency_key="loan-four", user=actor(),
    )


async def conserved_quantity(database):
    orders = await database.purchase_orders.find({}).to_list(None)
    return sum(active_quantity(line) - float(line.get("loaned_qty") or 0)
               for order in orders for line in order["items"])


async def arrive_replacement(database, loan):
    replacement = loan["replenishment_item_id"]
    result = await tracker._apply_stage_change(replacement, "in_box", actor(), "Four replacements arrived",
                                               idempotency_key="replacement-arrival")
    assert result["loans_due"] == [loan["id"]]
    again = await tracker._apply_stage_change(replacement, "in_box", actor(), "Four replacements arrived",
                                              idempotency_key="replacement-arrival")
    assert again["idempotent"] is True
    assert again["loans_due"] == [loan["id"]]
    row = await database.purchase_orders.find_one({"id": "recipient-po"})
    replacement_row = next(line for line in row["items"] if line["id"] == replacement)
    assert replacement_row["loan_replenishment_reserved_qty"] == 4
    return replacement


def test_lend_four_dispatch_eighty_and_return_four_once(loan_mongo_uri, monkeypatch):
    async def run():
        client, database = await setup_database(monkeypatch, loan_mongo_uri)
        try:
            assert await conserved_quantity(database) == 168
            first = await lend()
            assert first["idempotent"] is False
            loan = await database.purchase_transfers.find_one({"id": first["transfer_id"]})
            recipient = await database.purchase_orders.find_one({"id": "recipient-po"})
            normal = next(line for line in recipient["items"] if line["id"] == "recipient-item")
            replacement = next(line for line in recipient["items"] if line["id"] == loan["replenishment_item_id"])
            assert normal["qty"] == 80 and not normal.get("loan_replenishment_for_customer_name")
            assert replacement["qty"] == replacement["loan_replenishment_promised_qty"] == 4
            assert replacement["loan_replenishment_for_customer_name"] == "Lender"
            assert sum(line["qty"] for line in recipient["items"]) == 84
            assert await conserved_quantity(database) == 168
            assert (await lend())["idempotent"] is True
            assert await database.purchase_transfers.count_documents({}) == 1
            assert await database.event_outbox.count_documents({"status": "completed"}) == 1
            assert await database.activity_events.count_documents({}) == 2
            assert await database.payments.count_documents({}) == 0

            dispatched = await tracker._apply_stage_change("lender-item", "dispatched", actor(), None,
                                                           idempotency_key="dispatch-unloaned")
            assert dispatched["qty_moved"] == 80 and dispatched["qty_remaining"] == 4
            lender = await database.purchase_orders.find_one({"id": "lender-po"})
            original = next(line for line in lender["items"] if line["id"] == "lender-item")
            dispatch = next(line for line in lender["items"] if line["id"] == dispatched["new_item_id"])
            assert original["qty"] == original["loaned_qty"] == 4 and original["stage"] == "in_box"
            assert dispatch["qty"] == 80 and dispatch["stage"] == "dispatched"
            assert dispatch["loaned_qty"] == 0 and dispatch["customer_loan_history"] == []
            assert await conserved_quantity(database) == 168
            replacement_id = await arrive_replacement(database, loan)
            returned = await workflow.settle_loan_transfer(transfer_id=loan["id"], user=actor())
            assert returned["status"] == "returned" and returned["idempotent"] is False
            lender = await database.purchase_orders.find_one({"id": "lender-po"})
            original = next(line for line in lender["items"] if line["id"] == "lender-item")
            assert original["qty"] == 4 and original["stage"] == "in_box" and original["loaned_qty"] == 0
            assert original["customer_loan_history"][0]["status"] == "returned"
            recipient = await database.purchase_orders.find_one({"id": "recipient-po"})
            replacement = next(line for line in recipient["items"] if line["id"] == replacement_id)
            assert replacement["loan_replenishment_returned_qty"] == 4
            assert replacement["loan_replenishment_status"] == "returned"
            borrowed_po = await database.purchase_orders.find_one({"id": loan["destination_po_id"]})
            assert borrowed_po["items"][0]["qty"] == 4
            assert borrowed_po["items"][0]["loan_return_status"] == "returned"
            assert borrowed_po["items"][0]["loan_return_due"] is False
            before = await database.purchase_orders.find({}).sort("id", 1).to_list(None)
            assert (await workflow.settle_loan_transfer(transfer_id=loan["id"], user=actor()))["idempotent"] is True
            assert await database.purchase_orders.find({}).sort("id", 1).to_list(None) == before
            with pytest.raises(HTTPException) as error:
                await workflow.execute_transfer(item_id=replacement_id, destination_customer_id="lender", new_customer=None,
                                                qty=1, reason=None, idempotency_key="relend-returned", user=actor())
            assert error.value.status_code == 400 and "Only 0 available" in error.value.detail
            assert await database.purchase_transfers.count_documents({}) == 1
            assert await conserved_quantity(database) == 168
            assert sum(line["qty"] for order in before for line in order["items"]) == 172
            assert (await database.purchase_transfers.find_one({"id": loan["id"]}))["status"] == "returned"
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("stage", ["order_in_company", "company_billing", "in_box", "dispatched"])
def test_recipient_other_than_po_final_is_rejected_without_writes(loan_mongo_uri, monkeypatch, stage):
    async def run():
        client, database = await setup_database(monkeypatch, loan_mongo_uri, stage)
        try:
            before = await database.purchase_orders.find({}).sort("id", 1).to_list(None)
            with pytest.raises(HTTPException) as error:
                await lend()
            assert error.value.status_code == 409 and "PO Final" in error.value.detail
            assert await database.purchase_orders.find({}).sort("id", 1).to_list(None) == before
            assert await database.purchase_transfers.count_documents({}) == 0
            assert await database.event_outbox.count_documents({}) == 0
            assert await conserved_quantity(database) == 168
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(run())


def test_failed_return_rolls_back_consumption_source_and_journal(loan_mongo_uri, monkeypatch):
    async def run():
        client, database = await setup_database(monkeypatch, loan_mongo_uri)
        try:
            created = await lend()
            loan = await database.purchase_transfers.find_one({"id": created["transfer_id"]})
            await arrive_replacement(database, loan)
            await database.purchase_orders.delete_one({"id": loan["destination_po_id"]})
            before_orders = await database.purchase_orders.find({}).sort("id", 1).to_list(None)
            before_loan = await database.purchase_transfers.find_one({"id": loan["id"]})
            with pytest.raises(HTTPException) as error:
                await workflow.settle_loan_transfer(transfer_id=loan["id"], user=actor())
            assert error.value.status_code == 409 and "Borrowed item" in error.value.detail
            assert await database.purchase_orders.find({}).sort("id", 1).to_list(None) == before_orders
            assert await database.purchase_transfers.find_one({"id": loan["id"]}) == before_loan
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(run())


def test_concurrent_returns_can_only_consume_the_replacement_once(loan_mongo_uri, monkeypatch):
    async def run():
        client, database = await setup_database(monkeypatch, loan_mongo_uri)
        try:
            created = await lend()
            loan = await database.purchase_transfers.find_one({"id": created["transfer_id"]})
            replacement_id = await arrive_replacement(database, loan)
            results = await asyncio.gather(*[
                workflow.settle_loan_transfer(transfer_id=loan["id"], user=actor()) for _ in range(2)
            ], return_exceptions=True)
            assert sum(isinstance(result, dict) and result.get("idempotent") is False for result in results) == 1
            for result in results:
                if isinstance(result, Exception):
                    assert (isinstance(result, PyMongoError) and result.has_error_label("TransientTransactionError")) or (isinstance(result, HTTPException) and result.status_code == 409)
            assert (await workflow.settle_loan_transfer(transfer_id=loan["id"], user=actor()))["idempotent"] is True
            recipient = await database.purchase_orders.find_one({"id": "recipient-po"})
            replacement = next(line for line in recipient["items"] if line["id"] == replacement_id)
            assert replacement["loan_replenishment_returned_qty"] == 4
            lender = await database.purchase_orders.find_one({"id": "lender-po"})
            assert lender["items"][0]["loaned_qty"] == 0
            assert sum(event.get("action") == "transfer_in" for event in lender["items"][0]["stage_history"]) == 1
            assert await conserved_quantity(database) == 168
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(run())
