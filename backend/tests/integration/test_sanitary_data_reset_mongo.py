"""Run only against the disposable local replica set used for this reset."""
import asyncio
import os

import pytest
from motor.motor_asyncio import AsyncIOMotorClient
from services.sanitary_data_reset import FLOOR, RECEIPT, apply_reset, cleanup_files, make_plan

URL = os.environ.get("SANITARY_RESET_TEST_MONGO_URL", "")
pytestmark = pytest.mark.skipif(not URL.startswith("mongodb://127.0.0.1:"), reason="requires disposable local MongoDB replica set")


def test_scoped_reset_transaction_replay_and_file_retry(monkeypatch):
    monkeypatch.setenv("FORGE_CUSTOMER_RESET_MAINTENANCE", "true")
    async def run():
        client = AsyncIOMotorClient(URL, serverSelectionTimeoutMS=10000)
        db = client.sanitary_reset_disposable
        await client.drop_database(db.name)
        try:
            for name in ("customers", "quotations", "purchase_orders", "payments", "walkins", "followups", "godown_stock", "referrers", "suppliers"):
                await db[name].insert_many([{"id": name + "-s", "floor_id": FLOOR}, {"id": name + "-g", "floor_id": "ground-floor"}])
            await db.products.insert_many([{"id": "product-s", "floor_id": FLOOR}, {"id": "product-g", "floor_id": "ground-floor"}])
            await db.product_media.insert_one({"id": "catalog-photo", "floor_id": FLOOR, "storage_key": "catalog/image"})
            await db.product_usage.insert_many([{"product_id": "product-s"}, {"product_id": "product-g"}])
            await db.event_outbox.insert_many([{"id": "legacy", "payload": {"quotation_id": "quotations-s"}}, {"id": "other", "floor_id": "ground-floor"}])
            await db.followup_saved_views.insert_one({"id": "view", "floor_id": "ground-floor", "filters": {"customer_id": "customers-s", "status": "open"}})
            await db.user_sessions.insert_one({"id": "session"})
            await db.godown_stock_media.insert_one({"floor_id": FLOOR, "stock_id": "godown_stock-s", "bucket": "photos", "storage_key": "godown/photo.jpg"})
            plan = await make_plan(db)
            assert plan["counts"]["customers"] == 1
            assert plan["counts"]["event_outbox"] == 1
            assert len(plan["files"]) == 2
            receipt = await apply_reset(db, client)
            assert receipt["deleted"]["customers"] == 1
            assert (await db.settings.find_one({'id': 'customer-reset-generation:first-floor'}))['generation'] == 'sanitary-reset-20261102'
            assert await db.customers.count_documents({"floor_id": FLOOR}) == 0
            assert await db.customers.count_documents({"floor_id": "ground-floor"}) == 1
            assert await db.products.count_documents({}) == 2
            assert await db.product_media.count_documents({}) == 1
            assert await db.product_usage.count_documents({}) == 1
            assert await db.event_outbox.count_documents({}) == 1
            assert (await db.followup_saved_views.find_one({"id": "view"}))["filters"] == {"status": "open"}
            assert await db.user_sessions.count_documents({}) == 0
            await db.customers.insert_one({"id": "new", "floor_id": FLOOR})
            await apply_reset(db, client)
            assert await db.customers.count_documents({"id": "new"}) == 1
            class Store:
                def __init__(self, fail=False): self.fail = fail
                async def delete(self, **kwargs):
                    if self.fail: raise RuntimeError("offline")
            assert await cleanup_files(db, {"current": Store(), "legacy": Store(True)}) == 1
            assert len((await db.settings.find_one({"id": RECEIPT}))["pending_files"]) == 1
            assert await cleanup_files(db, {"current": Store(), "legacy": Store()}) == 0
            assert (await db.settings.find_one({"id": RECEIPT}))["pending_files"] == []
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_rejects_foreign_floor_reference_and_preserves_shared_catalog_image(monkeypatch):
    async def run():
        client = AsyncIOMotorClient(URL, serverSelectionTimeoutMS=10000)
        db = client.sanitary_reset_disposable
        await client.drop_database(db.name)
        try:
            await db.customers.insert_one({"id": "sanitary", "floor_id": FLOOR})
            await db.quotations.insert_one({"id": "foreign", "floor_id": "ground-floor", "customer_id": "sanitary"})
            with pytest.raises(RuntimeError, match="Cross-floor reference"):
                await make_plan(db)
            await db.quotations.delete_many({})
            await db.godown_stock_media.insert_one({"floor_id": FLOOR, "storage_key": "godown/shared", "bucket": "photos"})
            await db.product_media.insert_one({"storage_key": "godown/shared"})
            plan = await make_plan(db)
            assert plan['files'] == []
            await db.product_media.delete_many({})
            await db.products.insert_one({"id": "product", "floor_id": FLOOR, "images": ["https://media.test/godown/shared"]})
            assert (await make_plan(db))['files'] == []
            await db.products.update_one({"id":"product"}, {"$set": {"images": [], "hero_image_url": "https://media.test/godown/shared"}})
            assert (await make_plan(db))['files'] == []
            await db.products.update_one({"id":"product"}, {"$set": {"hero_image_url": None, "dimension_image_urls": ["https://media.test/godown/shared"]}})
            assert (await make_plan(db))['files'] == []
            await db.products.delete_many({})
            await db.quotations.insert_one({"id":"foreign-image", "floor_id":"third-floor", "items":[{"image":"https://media.test/godown/shared"}]})
            assert (await make_plan(db))['files'] == []
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_shared_referrers_survive_other_floors_but_leave_sanitary_directory(monkeypatch):
    from services.referrer_identity import referrer_query
    monkeypatch.setenv("FORGE_CUSTOMER_RESET_MAINTENANCE", "true")
    async def run():
        client = AsyncIOMotorClient(URL, serverSelectionTimeoutMS=10000)
        db = client.sanitary_reset_disposable
        await client.drop_database(db.name)
        try:
            await db.referrers.insert_many([
                {"id": "local", "floor_id": FLOOR},
                {"id": "sanitary-shared", "floor_id": FLOOR, "shared_across_floors": True},
                {"id": "ground-shared", "floor_id": "ground-floor", "shared_across_floors": True},
            ])
            await db.quotations.insert_one({"id":"kitchen-quote", "floor_id":"second-floor", "referrer_id":"sanitary-shared"})
            plan = await make_plan(db)
            assert plan["counts"]["referrers"] == 1
            assert plan["counts"]["shared_referrers_hidden"] == 2
            await apply_reset(db, client)
            assert await db.referrers.count_documents(referrer_query({"floor_id": FLOOR})) == 0
            for floor in ("ground-floor", "second-floor", "third-floor"):
                ids = {row["id"] async for row in db.referrers.find(referrer_query({"floor_id": {"$in": [floor]}}))}
                assert ids == {"sanitary-shared", "ground-shared"}
            assert await db.quotations.count_documents({"id":"kitchen-quote"}) == 1
            ids = {row["id"] async for row in db.referrers.find(referrer_query({"floor_id": {"$in": [FLOOR, "ground-floor"]}}))}
            assert ids == {"sanitary-shared", "ground-shared"}
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_customer_floor_reset_preserves_stock_other_floors_and_replay():
    from uuid import uuid4
    from services.sanitary_customer_floor_reset import reset_customer_floor
    async def run():
        client = AsyncIOMotorClient(URL, serverSelectionTimeoutMS=10000)
        db = client.sanitary_reset_disposable
        await client.drop_database(db.name)
        request = str(uuid4())
        try:
            await db.customers.insert_many([{'id':'c', 'floor_id':FLOOR, 'name':'Example'}, {'id':'other', 'floor_id':'ground-floor'}])
            await db.quotations.insert_many([{'id':'q', 'floor_id':FLOOR, 'customer_id':'c', 'status':'draft'}, {'id':'orphan', 'floor_id':FLOOR, 'status':'draft'}, {'id':'ground', 'floor_id':'ground-floor'}])
            await db.followups.insert_many([{'id':'lead', 'floor_id':FLOOR}, {'id':'ground', 'floor_id':'ground-floor'}])
            await db.godown_stock.insert_one({'id':'lot','floor_id':FLOOR,'available_qty':5,'allocations':[]})
            await db.products.insert_one({'id':'catalog','floor_id':FLOOR})
            result = await reset_customer_floor(db, client, 'owner', request)
            assert result['ok']
            assert (await db.settings.find_one({'id':'customer-reset-generation:first-floor'}))['generation'] == request
            assert await db.customers.count_documents({'floor_id':FLOOR}) == 0
            assert await db.quotations.count_documents({'floor_id':FLOOR}) == 0
            assert await db.followups.count_documents({'floor_id':FLOOR}) == 0
            assert await db.customers.count_documents({'floor_id':'ground-floor'}) == 1
            assert (await db.godown_stock.find_one({'id':'lot'}))['available_qty'] == 5
            assert await db.products.count_documents({}) == 1
            await db.customers.insert_one({'id':'new','floor_id':FLOOR})
            assert (await reset_customer_floor(db, client, 'owner', request))['already_applied']
            assert await db.customers.count_documents({'id':'new'}) == 1
            assert (await db.settings.find_one({'id':'customer-reset-generation:first-floor'}))['generation'] == request
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_ground_customer_reset_does_not_change_sanitary_or_stock():
    from uuid import uuid4
    from services.sanitary_customer_floor_reset import reset_customer_floor
    async def run():
        client = AsyncIOMotorClient(URL, serverSelectionTimeoutMS=10000)
        db = client.sanitary_reset_disposable
        await client.drop_database(db.name)
        try:
            await db.customers.insert_many([{'id':'ground', 'floor_id':'ground-floor'}, {'id':'sanitary', 'floor_id':FLOOR}])
            await db.quotations.insert_many([{'id':'ground-q', 'floor_id':'ground-floor', 'customer_id':'ground', 'status':'draft'}, {'id':'sanitary-q', 'floor_id':FLOOR, 'customer_id':'sanitary', 'status':'draft'}])
            await db.godown_stock.insert_one({'id':'ground-stock', 'floor_id':'ground-floor', 'available_qty':7, 'allocations':[]})
            request = str(uuid4())
            await reset_customer_floor(db, client, 'owner', request, floor_id='ground-floor')
            assert await db.customers.count_documents({'floor_id':'ground-floor'}) == 0
            assert await db.quotations.count_documents({'floor_id':'ground-floor'}) == 0
            assert await db.customers.count_documents({'floor_id':FLOOR}) == 1
            assert await db.quotations.count_documents({'floor_id':FLOOR}) == 1
            assert (await db.godown_stock.find_one({'id':'ground-stock'}))['available_qty'] == 7
            assert (await db.settings.find_one({'id':'customer-reset-generation:ground-floor'}))['generation'] == request
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_owner_can_delete_directly_and_reset_floor_over_http(monkeypatch):
    from uuid import uuid4
    from fastapi import FastAPI
    import httpx
    import db as database_module
    from models import UserPublic
    from routes import customer_routes, quotation_routes
    from services.mutation_admission import MutationAdmissionMiddleware

    async def run():
        client = AsyncIOMotorClient(URL, serverSelectionTimeoutMS=10000)
        db = client.sanitary_reset_disposable
        await client.drop_database(db.name)
        monkeypatch.setattr(database_module, 'db', db)
        monkeypatch.setattr(customer_routes, 'db', db)
        monkeypatch.setattr(quotation_routes, 'db', db)
        owner = UserPublic(id='owner', email='owner@example.test', full_name='Owner', role='owner', active_floor_id=FLOOR, floor_ids=[])
        app = FastAPI()
        app.add_middleware(MutationAdmissionMiddleware)
        app.dependency_overrides[customer_routes._customer_deletion_owner] = lambda: owner
        app.dependency_overrides[quotation_routes.get_current_user] = lambda: owner
        app.include_router(customer_routes.router, prefix='/api')
        app.include_router(quotation_routes.router, prefix='/api')
        try:
            await db.customers.insert_many([{'id':'one','floor_id':FLOOR,'name':'One'}, {'id':'two','floor_id':FLOOR,'name':'Two'}])
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as http:
                response = await http.delete('/api/customers/one')
                assert response.status_code == 200, response.text
                request = str(uuid4())
                response = await http.post('/api/customers/floor-reset', json={'request_id':request})
                assert response.status_code == 200, response.text
                assert await db.customers.count_documents({'floor_id':FLOOR}) == 0
                generation = await http.get('/api/quotations/floor-reset-generation')
                assert generation.status_code == 200 and generation.json()['generation'] == request
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())
