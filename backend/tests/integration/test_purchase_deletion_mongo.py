import asyncio, os
import pytest
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from services.purchase_deletion import delete_purchase
URL=os.environ.get('SANITARY_RESET_TEST_MONGO_URL','')
pytestmark=pytest.mark.skipif(not URL.startswith('mongodb://127.0.0.1:'),reason='requires disposable local MongoDB')

def test_delete_unfulfilled_purchase_is_scoped_retryable_and_preserves_references():
 async def run():
  client=AsyncIOMotorClient(URL,serverSelectionTimeoutMS=5000);db=client.purchase_delete_disposable
  await client.drop_database(db.name)
  try:
   await db.purchase_orders.insert_many([{'id':'p','floor_id':'first-floor','quotation_id':'q','automation_key':'event:po:brand','items':[{'id':'i','qty':2,'qty_received':0}],'attachments':[{'storage_key':'purchase-orders/p/a.pdf'}]}, {'id':'keep','floor_id':'ground-floor','items':[]}])
   await db.quotations.insert_one({'id':'q','floor_id':'first-floor'})
   await db.followups.insert_many([{'id':'related','floor_id':'first-floor','purchase_id':'p'},{'id':'other','floor_id':'ground-floor','purchase_id':'p'}])
   await db.activity_events.insert_one({'floor_id':'first-floor','purchase_id':'p'})
   await db.notifications.insert_one({'floor_id':'first-floor','link':'/purchases/p'})
   with pytest.raises(HTTPException) as wrong: await delete_purchase(db,client,'p','ground-floor','owner','private')
   assert wrong.value.status_code==404
   await db.godown_stock.insert_one({'floor_id':'first-floor','source_purchase_order_id':'p'})
   with pytest.raises(HTTPException) as guarded: await delete_purchase(db,client,'p','first-floor','owner','private')
   assert guarded.value.status_code==409 and await db.purchase_orders.count_documents({'id':'p'})==1
   await db.godown_stock.delete_many({})
   assert (await delete_purchase(db,client,'p','first-floor','owner','private'))['ok']
   assert (await delete_purchase(db,client,'p','first-floor','owner','private'))['already_deleted']
   assert await db.purchase_orders.count_documents({'id':'keep'})==1
   assert await db.quotations.count_documents({'id':'q'})==1
   assert await db.followups.count_documents({'id':'related'})==0 and await db.followups.count_documents({'id':'other'})==1
   receipt=await db.settings.find_one({'purchase_automation_key':'event:po:brand'})
   assert receipt['pending_private_files']==[{'bucket':'private','key':'purchase-orders/p/a.pdf'}]
   assert await db.notifications.count_documents({})==0
   with pytest.raises(HTTPException) as forbidden: await delete_purchase(db,client,'keep','third-floor','owner','private')
   assert forbidden.value.status_code==403
  finally:
   await client.drop_database(db.name);client.close()
 asyncio.run(run())

def test_tile_purchase_deletion_updates_customer_order_and_keeps_sibling():
 async def run():
  client=AsyncIOMotorClient(URL,serverSelectionTimeoutMS=5000); db=client.purchase_delete_tile_disposable
  await client.drop_database(db.name)
  try:
   await db.customer_orders.insert_one({'id':'co','floor_id':'ground-floor','is_deleted':False,'version':4,
     'brands':[{'purchase_order_id':'p','supplier_name':'A','status':'Pending','boxes_dispatched':0},
               {'purchase_order_id':'s','supplier_name':'B','status':'Partially Dispatched','boxes_dispatched':2}],
     'total_products':3,'total_boxes':10,'total_value':1050})
   await db.purchase_orders.insert_many([
    {'id':'p','floor_id':'ground-floor','customer_order_id':'co','automation_key':'event:po:a','grand_total':400,
     'items':[{'id':'a','qty':4,'boxes_ready':0,'boxes_dispatched':0}]},
    {'id':'s','floor_id':'ground-floor','customer_order_id':'co','grand_total':600,'items':[{'id':'b','qty':6}]},
   ])
   await db.material_movements.insert_many([
    {'floor_id':'ground-floor','purchase_order_id':'p','movement_type':'order_created'},
    {'floor_id':'ground-floor','purchase_order_id':'s','movement_type':'order_created'}])
   await db.material_movements.insert_one({'floor_id':'ground-floor','purchase_order_id':'p','movement_type':'release'})
   with pytest.raises(HTTPException) as blocked: await delete_purchase(db,client,'p','ground-floor','owner','private')
   assert blocked.value.status_code == 409
   await db.material_movements.delete_one({'purchase_order_id':'p','movement_type':'release'})
   await db.godown_stock.insert_one({'floor_id':'third-floor','source_purchase_order_id':'p'})
   with pytest.raises(HTTPException) as foreign: await delete_purchase(db,client,'p','ground-floor','owner','private')
   assert foreign.value.status_code == 409
   await db.godown_stock.delete_many({})
   await delete_purchase(db,client,'p','ground-floor','owner','private')
   co=await db.customer_orders.find_one({'id':'co'})
   assert co['total_products']==2 and co['total_boxes']==6 and co['total_value']==650
   assert co['completion_percentage']==33.3 and co['version']==5
   assert [b['purchase_order_id'] for b in co['brands']]==['s']
   assert co['dashboard_summary']['overall_status']=='Partially Dispatched'
   assert await db.material_movements.count_documents({'purchase_order_id':'p'})==0
   assert await db.material_movements.count_documents({'purchase_order_id':'s'})==1
   assert await db.purchase_orders.count_documents({'id':'s'})==1
   assert (await delete_purchase(db,client,'p','ground-floor','owner','private'))['already_deleted']
  finally:
   await client.drop_database(db.name);client.close()
 asyncio.run(run())
