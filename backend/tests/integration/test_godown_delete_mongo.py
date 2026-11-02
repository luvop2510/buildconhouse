import asyncio, os
import pytest
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
URL=os.environ.get('SANITARY_RESET_TEST_MONGO_URL','')
pytestmark=pytest.mark.skipif(not URL.startswith('mongodb://127.0.0.1:'),reason='requires local disposable MongoDB')

def test_delete_direct_and_purchase_stock_without_touching_other_floors(monkeypatch):
 from models import UserPublic
 from routes import godown_stock_routes as route
 async def run():
  client=AsyncIOMotorClient(URL,serverSelectionTimeoutMS=5000); db=client.godown_delete_disposable
  await client.drop_database(db.name); monkeypatch.setattr(route,'db',db); monkeypatch.setattr(route,'client',client)
  user=lambda floor:UserPublic(id='owner',email='owner@example.test',full_name='Owner',role='owner',active_floor_id=floor,floor_ids=[])
  try:
   await db.godown_stock.insert_many([{'_id':'cmd','id':'direct','floor_id':'first-floor','qty_received':5,'available_qty':5,'intake_command':{'payload_sha256':'x'}}, {'id':'foreign','floor_id':'ground-floor','qty_received':1,'available_qty':1}, {'id':'purchase-stock','floor_id':'first-floor','qty_received':2,'available_qty':2,'transferred_value':30,'source_purchase_order_id':'po','source_purchase_item_id':'item'}])
   await db.purchase_orders.insert_one({'id':'po','floor_id':'first-floor','items':[{'id':'item','godown_transferred_qty':2,'godown_valued_qty':2,'godown_transferred_value':30,'godown_transfer_history':[{'stock_id':'purchase-stock','qty':2,'transferred_value':30}]}]})
   with pytest.raises(HTTPException) as blocked: await route.delete_stock('foreign',user('first-floor'))
   assert blocked.value.status_code==404
   await db.godown_stock_media.insert_many([
     {'id':'photo','floor_id':'first-floor','stock_id':'direct','bucket':'photos','storage_key':'godown/direct.jpg'},
     {'id':'shared','floor_id':'first-floor','stock_id':'direct','bucket':'photos','storage_key':'godown/shared.jpg'}])
   await db.products.insert_one({'id':'catalog','hero_image_url':'https://media.test/godown/shared.jpg'})
   await route.delete_stock('direct',user('first-floor'))
   assert (await route.delete_stock('direct',user('first-floor')))['already_deleted']
   assert await db.godown_stock_media.count_documents({'stock_id':'direct'})==0
   from services.stock_media_cleanup import cleanup_stock_media
   class Store:
    def __init__(self): self.keys=[]
    async def delete(self, bucket, key): self.keys.append((bucket,key))
   store=Store(); await cleanup_stock_media(db,store)
   assert store.keys==[('photos','godown/direct.jpg')]
   assert not (await db.settings.find_one({'kind':'stock_media_deletion_receipt'}))['pending_files']
   assert await db.settings.count_documents({'intake_command_id':'cmd'})==1
   await db.godown_stock.update_one({'id':'purchase-stock'},{'$set':{'available_qty':1}})
   with pytest.raises(HTTPException) as changed: await route.delete_stock('purchase-stock',user('first-floor'))
   assert changed.value.status_code==409
   await db.godown_stock.update_one({'id':'purchase-stock'},{'$set':{'available_qty':2}})
   await route.delete_stock('purchase-stock',user('first-floor'))
   item=(await db.purchase_orders.find_one({'id':'po'}))['items'][0]
   assert item['godown_transferred_qty']==0 and item['godown_valued_qty']==0 and item['godown_transferred_value']==0 and not item['godown_transfer_history']
   assert await db.godown_stock.count_documents({'floor_id':'ground-floor'})==1
   with pytest.raises(HTTPException) as forbidden: await route.delete_stock('foreign',user('third-floor'))
   assert forbidden.value.status_code==403
  finally:
   await client.drop_database(db.name); client.close()
 asyncio.run(run())
