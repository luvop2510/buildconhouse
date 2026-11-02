"""Exercise custom catalog creation and deletion on disposable floor data."""
import asyncio
import os
from uuid import uuid4

import pytest
from motor.motor_asyncio import AsyncIOMotorClient
from fastapi import HTTPException

URL = os.environ.get('SANITARY_RESET_TEST_MONGO_URL', '')
pytestmark = pytest.mark.skipif(not URL.startswith('mongodb://127.0.0.1:'), reason='requires disposable local MongoDB')


def test_create_delete_custom_product_for_each_floor(monkeypatch):
    from models import UserPublic
    from routes import catalog_routes
    async def run():
        client = AsyncIOMotorClient(URL, serverSelectionTimeoutMS=10000)
        db = client.catalog_custom_disposable
        await client.drop_database(db.name)
        monkeypatch.setattr(catalog_routes, 'db', db)
        async def refresh(): return None
        monkeypatch.setattr(catalog_routes.catalog_service, 'refresh_catalog_snapshot', refresh)
        try:
            await db.brands.create_index([('floor_id',1),('slug',1)],unique=True)
            await db.categories.create_index([('floor_id',1),('slug',1)],unique=True)
            ids = []
            for floor in ('ground-floor','first-floor'):
                user = UserPublic(id='owner', email='owner@example.test', full_name='Owner', role='owner', active_floor_id=floor, floor_ids=[])
                body = catalog_routes.CatalogCustomProductInput(name='Test item', sku='', price=20, mrp=25, request_id=str(uuid4()))
                first = await catalog_routes.create_catalog_custom_product(body, user)
                retry = await catalog_routes.create_catalog_custom_product(body, user)
                assert first.id == retry.id and first.floor_id == floor
                assert await db.products.count_documents({'id': first.id, 'active': True}) == 1
                await db.products.update_one({'id':first.id}, {'$set': {'variants':[{'sku':'INLINE/1', 'name':'Inline'}, {'sku':'KEEP','name':'Keep'}]}})
                assert (await catalog_routes.delete_product_variant(first.id, 'INLINE/1', user))['ok']
                assert [row['sku'] for row in (await db.products.find_one({'id':first.id}))['variants']] == ['KEEP']
                assert (await catalog_routes.delete_product_variant(first.id, 'INLINE/1', user))['ok']
                await db.products.insert_one({'id':'sibling-'+floor, 'floor_id':floor, 'brand_id':first.brand_id,
                    'variants':[{'id':first.id, 'sku':first.sku}, {'id':'keep', 'sku':'keep'}], 'related_ids':[first.id, 'keep']})
                ids.append((floor, first.id))
                foreign_floor = 'ground-floor' if floor != 'ground-floor' else 'first-floor'
                foreign_user = UserPublic(id='owner', email='owner@example.test', full_name='Owner', role='owner', active_floor_id=foreign_floor, floor_ids=[])
                with pytest.raises(HTTPException) as blocked:
                    await catalog_routes.delete_product(first.id, foreign_user)
                assert blocked.value.status_code == 404
                assert (await db.products.find_one({'id': first.id}))['active'] is True
                assert (await catalog_routes.delete_product(first.id, user))['ok']
                assert (await db.products.find_one({'id':first.id}))['active'] is False
                sibling = await db.products.find_one({'id':'sibling-'+floor})
                assert [row['id'] for row in sibling['variants']] == ['keep']
                assert sibling['related_ids'] == ['keep']
                with pytest.raises(HTTPException) as missing:
                    await catalog_routes.get_product(first.id, user, None)
                assert missing.value.status_code == 404
            assert len({item[1] for item in ids}) == 2
            assert await db.brands.count_documents({'slug':'custom'}) == 2
            assert await db.categories.count_documents({'slug':'custom'}) == 2
            for floor in ('second-floor', 'third-floor'):
                user = UserPublic(id='owner', email='owner@example.test', full_name='Owner', role='owner', active_floor_id=floor, floor_ids=[])
                body = catalog_routes.CatalogCustomProductInput(name='Test item', price=20, mrp=25, request_id=str(uuid4()))
                with pytest.raises(HTTPException) as blocked:
                    await catalog_routes.create_catalog_custom_product(body, user)
                assert blocked.value.status_code == 403
                with pytest.raises(HTTPException) as blocked:
                    await catalog_routes.delete_product(ids[0][1], user)
                assert blocked.value.status_code == 403
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())
