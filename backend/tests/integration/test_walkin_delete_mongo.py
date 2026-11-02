"""Deletion removes walk-in details without changing separate leads or floors."""
import asyncio
import os

import pytest
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient

URL = os.environ.get('SANITARY_RESET_TEST_MONGO_URL', '')
pytestmark = pytest.mark.skipif(not URL.startswith('mongodb://127.0.0.1:'), reason='requires disposable local MongoDB')


def test_walkin_delete_scoped_private_and_idempotent(monkeypatch):
    from models import UserPublic
    from routes import walkin_routes
    async def run():
        client = AsyncIOMotorClient(URL, serverSelectionTimeoutMS=10000)
        db = client.walkin_delete_disposable
        await client.drop_database(db.name)
        monkeypatch.setattr(walkin_routes, 'db', db)
        owner = lambda floor: UserPublic(id='owner', email='owner@example.test', full_name='Owner', role='owner', active_floor_id=floor, floor_ids=[])
        try:
            await db.walkins.insert_many([{'id':'w1','floor_id':'first-floor','is_deleted':False,'customer_name':'Private','customer_phone':'9000000000'},
                {'id':'w2','floor_id':'ground-floor','is_deleted':False,'customer_name':'Keep'}])
            await db.followups.insert_many([{'id':'f1','floor_id':'first-floor','walkin_id':'w1'}, {'id':'f2','floor_id':'third-floor','walkin_id':'w1'}])
            await db.activity_events.insert_many([{'id':'a1','floor_id':'first-floor','entity_type':'walkin','entity_id':'w1','summary':'Private'},
                {'id':'a2','floor_id':'ground-floor','entity_type':'walkin','entity_id':'w2'}])
            with pytest.raises(HTTPException) as wrong:
                await walkin_routes.delete_walkin('w1', owner('ground-floor'))
            assert wrong.value.status_code == 404
            assert (await walkin_routes.delete_walkin('w1', owner('first-floor')))['ok']
            tombstone = await db.walkins.find_one({'id':'w1'}, {'_id':0})
            assert set(tombstone) == {'id','floor_id','is_deleted','deleted_at','deleted_by'}
            assert await db.activity_events.count_documents({'id':'a1'}) == 0
            assert await db.activity_events.count_documents({'id':'a2'}) == 1
            assert await db.followups.count_documents({}) == 2
            assert (await walkin_routes.delete_walkin('w1', owner('first-floor')))['ok']
            with pytest.raises(HTTPException) as missing:
                await walkin_routes.get_walkin('w1', owner('first-floor'))
            assert missing.value.status_code == 404
            for floor in ('second-floor', 'third-floor'):
                with pytest.raises(HTTPException) as forbidden:
                    await walkin_routes.delete_walkin('w2', owner(floor))
                assert forbidden.value.status_code == 403
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())
