"""Run-owned loopback replica: actual transactions and HTTP write admission."""
import asyncio
import os
from uuid import uuid4
import httpx
import pytest
from fastapi import FastAPI, HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from services.customer_deletion import delete_customer_graph, plan_deletion, public_plan
from services.mutation_admission import MutationAdmissionMiddleware, admission


def test_concurrent_save_cannot_resurrect_deleted_customer(monkeypatch):
    uri = os.environ.get('DELETION_TEST_MONGO_URL')
    if uri != 'mongodb://127.0.0.1:28124':
        pytest.skip('Explicit run-owned local replica required')
    assert os.environ.get('PYTHON_DOTENV_DISABLED') == '1'
    async def scenario():
        import db
        client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=3000)
        name = 'forge_deletion_qa_' + uuid4().hex
        database = client[name]
        monkeypatch.setattr(db, 'db', database)
        customer = {'id':'target','name':'Synthetic target','phone':'9000000000','floor_id':'first-floor'}
        await database.customers.insert_many([customer,{'id':'survivor','name':'Keep','floor_id':'first-floor'}])
        entered, release = asyncio.Event(), asyncio.Event()
        app = FastAPI()
        app.add_middleware(MutationAdmissionMiddleware)
        @app.post('/api/quotations')
        async def save():
            if not await database.customers.find_one({'id':'target'}): raise HTTPException(404)
            entered.set()
            await release.wait()
            await database.quotations.insert_one({'id':'new','customer_id':'target','floor_id':'first-floor','status':'draft'})
            await database.activity_events.insert_one({'id':'log','customer_id':'target'})
            return {'ok':True}
        @app.delete('/api/customers/target')
        async def remove(confirmation: str):
            return await delete_customer_graph(database, client,'target','owner',confirmation)
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://qa') as http:
                before = public_plan(await plan_deletion(database,customer_id='target'),'owner')
                saving = asyncio.create_task(http.post('/api/quotations'))
                await asyncio.wait_for(entered.wait(),3)
                blocked = await http.delete('/api/customers/target',params={'confirmation':before['confirmation']})
                assert blocked.status_code == 409
                assert await database.customers.count_documents({'id':'target'}) == 1
                release.set()
                assert (await saving).status_code == 200
                stale = await http.delete('/api/customers/target',params={'confirmation':before['confirmation']})
                assert stale.status_code == 409
                fresh = public_plan(await plan_deletion(database,customer_id='target'),'owner')
                deleted = await http.delete('/api/customers/target',params={'confirmation':fresh['confirmation']})
                assert deleted.status_code == 200, deleted.text
                assert await database.quotations.count_documents({}) == 0
                assert await database.activity_events.count_documents({'customer_id':'target'}) == 0
                assert await database.customers.count_documents({'id':'survivor'}) == 1
                assert (await http.post('/api/quotations')).status_code == 404
                async with admission(database, exclusive=True):
                    with pytest.raises(HTTPException):
                        async with admission(database): pass
                async with admission(database): pass
        finally:
            release.set()
            await client.drop_database(name)
            client.close()
    asyncio.run(scenario())
