"""Real Mongo request uniqueness and signed receipt ordering; HTTP is fake."""
from __future__ import annotations

import asyncio
import importlib

import httpx
import pytest
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError, OperationFailure

from services import whatsapp_delivery as service
from tests.integration.test_purchase_completion_mongo import mongo_url  # noqa: F401


def test_migration_unique_requests_sparse_message_ids_and_idempotency(mongo_url):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.whatsapp
        try:
            migration = importlib.import_module("migrations.0027_furniture_and_whatsapp_indexes")
            await migration.up(db)
            await migration.up(db)
            rows = [{"floor_id": "third-floor", "source_id": "q1", "idempotency_key": f"key{i}"} for i in range(3)]
            await db.whatsapp_deliveries.insert_many(rows)
            with pytest.raises(DuplicateKeyError):
                await db.whatsapp_deliveries.insert_one({k: v for k, v in rows[0].items() if k != "_id"})
            await db.whatsapp_deliveries.update_one({"idempotency_key": "key0"}, {"$set": {"message_id": "wamid.1"}})
            with pytest.raises(DuplicateKeyError):
                await db.whatsapp_deliveries.update_one({"idempotency_key": "key1"}, {"$set": {"message_id": "wamid.1"}})
            indexes = await db.whatsapp_status_events.index_information()
            assert indexes["whatsapp_status_expiry"]["expireAfterSeconds"] == 30 * 86400
        finally:
            client.close()
    asyncio.run(run())


def test_migration_fails_closed_for_wrong_options_under_required_index_name(mongo_url):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.whatsapp
        try:
            await db.whatsapp_deliveries.create_index([("floor_id", 1), ("source_id", 1), ("idempotency_key", 1)], name="whatsapp_delivery_request")
            with pytest.raises(OperationFailure):
                await importlib.import_module("migrations.0027_furniture_and_whatsapp_indexes").up(db)
        finally:
            client.close()
    asyncio.run(run())


def test_signed_callbacks_arriving_before_send_response_are_reconciled_without_regression(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.whatsapp
        monkeypatch.setattr(service, "db", db)
        monkeypatch.setenv("WHATSAPP_ACCESS_TOKEN", "fake-token")
        monkeypatch.setenv("WHATSAPP_PHONE_NUMBER_ID", "123")
        monkeypatch.delenv("WHATSAPP_DOCUMENT_TEMPLATE", raising=False)
        calls = []

        def event(state, timestamp):
            return {"entry": [{"changes": [{"value": {"metadata": {"phone_number_id": "123"}, "statuses": [{"id": "wamid.1", "status": state, "timestamp": str(timestamp)}]}}]}]}

        class FakeHttp:
            def __init__(self, **_kwargs):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *_args):
                pass
            async def post(self, url, **_kwargs):
                calls.append(url)
                if url.endswith("/media"):
                    data = {"id": "media1"}
                else:
                    # Callback can win the race before provider ID persistence.
                    assert await service.record_statuses(event("read", 101)) == 0
                    data = {"messages": [{"id": "wamid.1"}]}
                return httpx.Response(200, json=data, request=httpx.Request("POST", url))

        monkeypatch.setattr(service.httpx, "AsyncClient", FakeHttp)
        try:
            await importlib.import_module("migrations.0027_furniture_and_whatsapp_indexes").up(db)
            request = dict(pdf_bytes=b"%PDF-1.4 exact", filename="Quote.pdf", recipient_phone="9909906652", message="Quotation attached", idempotency_key="request1234567890", floor_id="third-floor", source_id="q1", actor_id="owner")
            receipt = await service.send_document(**request)
            assert receipt["status"] == "read"
            assert await service.record_statuses(event("delivered", 102)) == 0
            assert await service.record_statuses(event("sent", 103)) == 0
            assert await service.record_statuses(event("failed", 104)) == 0
            assert await service.record_statuses(event("read", 101)) == 0
            saved = await db.whatsapp_deliveries.find_one({"source_id": "q1"})
            assert saved["status"] == "read" and saved["provider_event_order"] == 1014
            second = await service.send_document(**request)
            assert second["status"] == "read" and len(calls) == 2
            assert await db.whatsapp_status_events.count_documents({}) == 1
        finally:
            client.close()
    asyncio.run(run())


def test_same_second_delivery_beats_sent_then_read_beats_delivery(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.whatsapp
        monkeypatch.setattr(service, "db", db)
        monkeypatch.setenv("WHATSAPP_PHONE_NUMBER_ID", "123")
        try:
            await importlib.import_module("migrations.0027_furniture_and_whatsapp_indexes").up(db)
            await db.whatsapp_deliveries.insert_one({"message_id": "wamid.1", "floor_id": "third-floor", "source_id": "q1", "idempotency_key": "key1", "status": "accepted"})
            async def record(state):
                return await service.record_statuses({"entry": [{"changes": [{"value": {"metadata": {"phone_number_id": "123"}, "statuses": [{"id": "wamid.1", "status": state, "timestamp": "100"}]}}]}]})
            assert await record("sent") == 1
            assert await record("delivered") == 1
            assert await record("sent") == 0
            assert await record("read") == 1
            assert await record("delivered") == 0
            assert (await db.whatsapp_deliveries.find_one({"message_id": "wamid.1"}))["status"] == "read"
        finally:
            client.close()
    asyncio.run(run())
