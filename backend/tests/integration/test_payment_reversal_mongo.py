import asyncio, os
import pytest
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from services.payment_reversal import reverse_payment
URL=os.environ.get('SANITARY_RESET_TEST_MONGO_URL','')
pytestmark=pytest.mark.skipif(not URL.startswith('mongodb://127.0.0.1:'),reason='requires local disposable MongoDB')

def test_payment_cost_and_stock_reversal():
 async def run():
  client=AsyncIOMotorClient(URL,serverSelectionTimeoutMS=5000); db=client.payment_reversal_disposable
  await client.drop_database(db.name)
  try:
   await db.quotations.insert_one({'id':'q','floor_id':'first-floor','payment_extra_amount':10,'payment_extra_history':[{'id':'cost','amount':10,'name':'Cost'}]})
   await db.payments.insert_many([{'id':'cash','floor_id':'first-floor','quotation_id':'q','amount':20}, {'id':'cost','floor_id':'first-floor','quotation_id':'q','entry_type':'additional_cost','additional_cost_id':'cost','amount':10}, {'id':'credit','floor_id':'first-floor','quotation_id':'q','entry_type':'godown_stock_credit','godown_stock_id':'lot','amount':15}])
   await db.purchase_orders.insert_one({'id':'po','floor_id':'first-floor','items':[{'id':'item','godown_transferred_qty':2,'godown_valued_qty':2,'godown_transferred_value':30,'godown_transfer_history':[{'stock_id':'lot','qty':2,'transferred_value':30}]}]})
   await db.godown_stock.insert_one({'id':'lot','floor_id':'first-floor','payment_id':'credit','source_purchase_order_id':'po','source_purchase_item_id':'item','qty_received':2,'available_qty':2,'transferred_value':30,'allocations':[]})
   assert (await reverse_payment(db,client,'cash','first-floor','owner'))['ok']
   assert (await reverse_payment(db,client,'cash','first-floor','owner'))['already_deleted']
   await reverse_payment(db,client,'cost','first-floor','owner')
   q=await db.quotations.find_one({'id':'q'}); assert q['payment_extra_amount']==0 and q['payment_extra_history']==[]
   await db.godown_stock.update_one({'id':'lot'},{'$set':{'available_qty':1}})
   with pytest.raises(HTTPException) as e: await reverse_payment(db,client,'credit','first-floor','owner')
   assert e.value.status_code==409 and await db.payments.count_documents({'id':'credit'})==1
   await db.godown_stock.update_one({'id':'lot'},{'$set':{'available_qty':2}})
   await db.godown_stock_media.insert_one({'id':'pic','floor_id':'first-floor','stock_id':'lot','bucket':'photos','storage_key':'godown/lot.jpg'})
   await reverse_payment(db,client,'credit','first-floor','owner')
   item=(await db.purchase_orders.find_one({'id':'po'}))['items'][0]
   assert item['godown_transferred_qty']==0 and item['godown_valued_qty']==0 and item['godown_transferred_value']==0 and not item['godown_transfer_history']
   assert await db.godown_stock.count_documents({})==0
   assert await db.godown_stock_media.count_documents({})==0
   assert (await db.settings.find_one({'kind':'stock_media_deletion_receipt'}))['pending_files']==[{'bucket':'photos','key':'godown/lot.jpg'}]
   with pytest.raises(HTTPException): await reverse_payment(db,client,'cash','second-floor','owner')
  finally:
   await client.drop_database(db.name); client.close()
 asyncio.run(run())
