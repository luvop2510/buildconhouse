import asyncio
import os
from datetime import date

import pytest
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient

URL = os.environ.get('SANITARY_RESET_TEST_MONGO_URL', '')
pytestmark = pytest.mark.skipif(not URL.startswith('mongodb://127.0.0.1:'), reason='requires disposable local MongoDB')


def test_stock_movement_reversal_is_scoped_replay_safe_and_preserves_reserved_stock(monkeypatch):
    from models import UserPublic
    from routes import godown_stock_routes as route
    async def run():
        client = AsyncIOMotorClient(URL, serverSelectionTimeoutMS=5000)
        db = client.stock_movement_delete_disposable
        await client.drop_database(db.name)
        monkeypatch.setattr(route, 'db', db)
        monkeypatch.setattr(route, 'client', client)
        user = lambda floor: UserPublic(id='owner', email='owner@example.test', full_name='Owner', role='owner', active_floor_id=floor)
        try:
            await db.godown_stock.insert_many([
                {'id':'lot', 'floor_id':'first-floor', 'updated_at':'old', 'qty_received':10, 'available_qty':5, 'loaned_out_qty':2,
                 'stock_movements':[{'id':'receipt', 'kind':'receipt', 'qty':4, 'command_key':'receipt-key', 'actor_id':'owner'},
                                    {'id':'out', 'kind':'adjustment_out', 'qty':2, 'command_key':'out-key', 'actor_id':'owner'}]},
                {'id':'other', 'floor_id':'ground-floor', 'qty_received':1, 'available_qty':1, 'stock_movements':[]},
            ])
            with pytest.raises(HTTPException) as forbidden:
                await route.delete_stock_movement('lot', 'receipt', user('second-floor'))
            assert forbidden.value.status_code == 403
            with pytest.raises(HTTPException) as in_use:
                await route.delete_stock_movement('lot', 'receipt', user('first-floor'))
            assert in_use.value.status_code == 409
            await route.delete_stock_movement('lot', 'out', user('first-floor'))
            row = await db.godown_stock.find_one({'id':'lot'})
            assert row['available_qty'] == 7 and row['qty_received'] == 10
            assert (await route.delete_stock_movement('lot', 'out', user('first-floor')))['already_deleted']
            await route.delete_stock_movement('lot', 'receipt', user('first-floor'))
            row = await db.godown_stock.find_one({'id':'lot'})
            assert row['available_qty'] == 3 and row['qty_received'] == 6 and row['stock_movements'] == []
            old_command = route.StockMovement(kind='receipt', qty=4, occurred_on=date(2026,1,1), reason='Test movement',
                                               expected_updated_at=row['updated_at'], idempotency_key='receipt-key')
            with pytest.raises(HTTPException) as replay:
                await route.record_stock_movement('lot', old_command, user('first-floor'))
            assert replay.value.status_code == 409
            assert (await db.godown_stock.find_one({'id':'other'}))['available_qty'] == 1
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())
