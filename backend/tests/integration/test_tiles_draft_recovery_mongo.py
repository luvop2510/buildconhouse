"""Run-owned loopback Mongo: tile draft first-response, replay, CAS and deletion."""
import asyncio
import os
from itertools import count
from uuid import uuid4

import httpx
from fastapi import FastAPI
from motor.motor_asyncio import AsyncIOMotorClient
import pytest


def test_tile_draft_recovery_and_cancellation_use_real_transactions(monkeypatch):
    uri = os.environ.get("TILE_DRAFT_TEST_MONGO_URL")
    if uri != "mongodb://127.0.0.1:28176":
        pytest.skip("Explicit run-owned local tile replica required")
    assert os.environ.get("PYTHON_DOTENV_DISABLED") == "1"
    async def run():
        import auth
        import db as connection
        from models import UserPublic
        from routes import quotation_routes, customer_routes
        client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=3000)
        name = "forge_tile_draft_qa_" + uuid4().hex
        database = client[name]
        serial = count(1)
        async def noop(*args, **kwargs):
            return None
        async def number():
            return f"FQ-QA-{next(serial)}"
        monkeypatch.setattr(connection, "client", client)
        monkeypatch.setattr(quotation_routes, "db", database)
        monkeypatch.setattr(customer_routes, "db", database)
        monkeypatch.setattr(quotation_routes, "log_event", noop)
        monkeypatch.setattr(customer_routes, "log_event", noop)
        monkeypatch.setattr(quotation_routes, "reconcile_followups_admitted", noop)
        monkeypatch.setattr(quotation_routes, "_next_number", number)
        actor = UserPublic(id="draft-qa-manager", email="draft-qa@example.invalid", full_name="Draft QA",
                           role="manager", floor_ids=["ground-floor"], active_floor_id="ground-floor")
        app = FastAPI()
        app.dependency_overrides[auth.get_current_user] = lambda: actor
        app.include_router(quotation_routes.router, prefix="/api")
        app.include_router(customer_routes.router, prefix="/api")
        try:
            await database.quotations.create_index("id", unique=True)
            await database.customers.create_index("id", unique=True)
            key = str(uuid4())
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://qa") as http:
                contact_body = {"name": "Synthetic draft contact", "client_draft_id": key}
                contacts = await asyncio.gather(*[http.post("/api/customers", json=contact_body) for _ in range(4)])
                assert all(response.status_code == 200 for response in contacts), [response.text for response in contacts]
                customer_id = contacts[0].json()["id"]
                assert {response.json()["id"] for response in contacts} == {customer_id}
                assert await database.customers.count_documents({}) == 1
                body = {"customer_id": customer_id, "doc_type": "tiles_quotation", "client_draft_id": key, "address_snapshot": ""}
                quotes = await asyncio.gather(*[http.post("/api/quotations", json=body) for _ in range(4)])
                assert all(response.status_code == 200 for response in quotes), [response.text for response in quotes]
                original = quotes[0].json()
                assert {response.json()["id"] for response in quotes} == {original["id"]}
                assert await database.quotations.count_documents({}) == 1
                assert "_id" not in original
                saved = await http.patch(f"/api/quotations/{original['id']}", json={"notes": "Saved after recovery",
                    "silent": True, "expected_updated_at": original["updated_at"]})
                assert saved.status_code == 200, saved.text
                replay = await http.post("/api/quotations", json=body)
                assert replay.status_code == 200, replay.text
                assert replay.json()["create_replayed"] is True
                assert replay.json()["create_original_updated_at"] == original["updated_at"]
                assert replay.json()["updated_at"] != original["updated_at"]
                stale = await http.patch(f"/api/quotations/{original['id']}", json={"notes": "Stale overwrite",
                    "silent": True, "expected_updated_at": original["updated_at"]})
                assert stale.status_code == 409
                assert (await database.quotations.find_one({"id": original["id"]}))["notes"] == "Saved after recovery"
                lookup = f"/api/quotations/client-draft/{key}?doc_type=tiles_quotation"
                assert (await http.get(lookup)).json()["id"] == original["id"]
                await database.quotations.update_one({"id": original["id"]}, {"$set": {"status": "ordered"}})
                assert (await http.delete(lookup)).status_code == 409
                await database.quotations.update_one({"id": original["id"]}, {"$set": {"status": "draft"}})
                discarded = await http.delete(lookup)
                assert discarded.status_code == 200, discarded.text
                assert await database.quotations.count_documents({}) == 0
                assert (await http.post("/api/quotations", json=body)).status_code == 410
                cancelled_key = str(uuid4())
                assert (await http.delete(f"/api/quotations/client-draft/{cancelled_key}?doc_type=tiles_quotation")).status_code == 200
                assert (await http.post("/api/quotations", json={**body, "client_draft_id": cancelled_key})).status_code == 410
                assert await database.quotations.count_documents({}) == 0
                await database.customers.delete_one({"id": customer_id})
                assert (await http.post("/api/customers", json=contact_body)).status_code == 410
        finally:
            await client.drop_database(name)
            client.close()
    asyncio.run(run())


def test_first_tile_selection_moves_directly_and_creates_one_order_with_real_mongo(monkeypatch):
    uri = os.environ.get("TILE_DRAFT_TEST_MONGO_URL")
    if uri != "mongodb://127.0.0.1:28176":
        pytest.skip("Explicit run-owned local tile replica required")
    assert os.environ.get("PYTHON_DOTENV_DISABLED") == "1"
    import sys
    from pathlib import Path
    import auth
    import db as connection
    from models import UserPublic
    from routes import quotation_routes as quotes, customer_routes as customers
    import services.domain_outbox as outbox
    # Load the dependencies before binding every backend database reference.
    import services.sequence, services.tile_movement_log, services.walkin_service, services.followup_engine

    async def run():
        client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=3000)
        name = "forge_tile_order_qa_" + uuid4().hex
        database = client[name]
        original_db, original_client = connection.db, connection.client
        backend_root = str(Path(quotes.__file__).resolve().parents[1]) + "/"
        for module in list(sys.modules.values()):
            if not module or not str(getattr(module, "__file__", "")).startswith(backend_root):
                continue
            if getattr(module, "db", None) is original_db:
                monkeypatch.setattr(module, "db", database)
            if getattr(module, "client", None) is original_client:
                monkeypatch.setattr(module, "client", client)

        async def noop(*args, **kwargs):
            pass
        monkeypatch.setattr(quotes, "reconcile_followups_admitted", noop)
        monkeypatch.setattr(outbox, "notify", noop)
        actor = UserPublic(id="local-tile-order-qa", full_name="Local tile QA", role="owner",
                           floor_ids=["ground-floor"], active_floor_id="ground-floor")
        app = FastAPI()
        app.dependency_overrides[auth.get_current_user] = lambda: actor
        app.include_router(quotes.router, prefix="/api")
        app.include_router(customers.router, prefix="/api")
        try:
            for collection in ["customers", "quotations", "purchase_orders", "customer_orders", "payments"]:
                await database[collection].create_index("id", unique=True)
            await outbox.ensure_outbox_indexes()
            await database.brands.insert_one({"id": "brand-local", "name": "Local tile brand", "floor_id": "ground-floor"})
            await database.products.insert_one({"id": "product-local", "sku": "QA-TILE", "name": "Synthetic tile",
                "floor_id": "ground-floor", "brand_id": "brand-local", "category_id": "tiles",
                "price": 100, "mrp": 100, "specs": {}, "active": True})
            key = str(uuid4())
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-qa") as http:
                contact = await http.post("/api/customers", json={"name": "Synthetic tile buyer", "client_draft_id": key})
                assert contact.status_code == 200, contact.text
                selection = await http.post("/api/quotations", json={
                    "customer_id": contact.json()["id"], "doc_type": "tiles_selection", "client_draft_id": key,
                    "address_snapshot": "Synthetic site address", "items": [{"product_id": "product-local",
                    "sku": "QA-TILE", "name": "Synthetic tile", "qty": 2, "unit_price": 100,
                    "rate_box": 100, "quantity_unit": "Box"}],
                })
                assert selection.status_code == 200, selection.text
                qid = selection.json()["id"]
                moved = await http.post(f"/api/quotations/{qid}/move-to-quotation")
                assert moved.status_code == 200, moved.text
                preview = await http.get(f"/api/quotations/{qid}/place-order/preview")
                assert preview.status_code == 200, preview.text
                review = preview.json().get("price_review") or {}
                body = {"catalog_price_choice": "keep", "catalog_price_token": review.get("token")} if review.get("changes") else {}
                ordered = await http.post(f"/api/quotations/{qid}/place-order/confirm", json=body)
                assert ordered.status_code == 200, ordered.text
                repeated = await http.post(f"/api/quotations/{qid}/place-order/confirm", json=body)
                assert repeated.status_code == 200, repeated.text
                counts = {collection: await database[collection].count_documents({})
                          for collection in ["quotations", "purchase_orders", "customer_orders", "payments"]}
                assert counts == {"quotations": 1, "purchase_orders": 1, "customer_orders": 1, "payments": 1}
                assert (await database.quotations.find_one({"id": qid}))["status"] == "ordered"
                assert (await database.purchase_orders.find_one({}))["floor_id"] == "ground-floor"
                assert ordered.json()["count"] == 1
        finally:
            await client.drop_database(name)
            client.close()
    asyncio.run(run())
