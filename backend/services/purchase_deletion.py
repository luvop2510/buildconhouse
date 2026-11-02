"""Remove a purchase while preserving other orders and stock commitments."""
from datetime import datetime, timezone
import re
from fastapi import HTTPException
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern
from services.tile_order_status import completion_percentage, rollup_status


async def delete_purchase(db, client, po_id, floor, actor, private_bucket):
    if floor not in {'first-floor', 'ground-floor'}:
        raise HTTPException(403, 'Purchase deletion is available on Ground and Sanitary floors')
    receipt_id = f'purchase-deletion:{floor}:{po_id}'
    async def operation(session):
        if await db.settings.find_one({'id':receipt_id}, session=session):
            return {'ok':True, 'already_deleted':True}
        po = await db.purchase_orders.find_one({'id':po_id,'floor_id':floor},session=session)
        if not po:
            raise HTTPException(404, 'Purchase not found')
        if po.get('chalans'):
            raise HTTPException(409, 'Reverse the linked delivery notes before deleting this purchase')
        fields=('qty_received','godown_transferred_qty','godown_borrowed_qty','loaned_qty',
                'loan_replenishment_promised_qty','loan_replenishment_returned_qty',
                'boxes_ready','boxes_dispatched','boxes_godown','qty_dispatched','qty_delivered')
        for item in po.get('items') or []:
            if any(float(item.get(field) or 0) != 0 for field in fields) or item.get('godown_stock_id') or item.get('godown_transfer_history') or item.get('customer_loan_history'):
                raise HTTPException(409, 'Reverse the purchase stock and delivery movements before deleting it')
        related = {
            'godown_stock': {'source_purchase_order_id':po_id},
            'purchase_transfers': {'$or':[{'source_po_id':po_id},{'destination_po_id':po_id},{'replenishment_po_id':po_id}]},
            'purchase_shortages': {'$or':[{'purchase_order_id':po_id},{'source_po_id':po_id},{'po_id':po_id}]},
            'godown_customer_transfers': {'recipient_purchase_order_id':po_id},
            'ready_batches': {'purchase_order_id':po_id}, 'dispatches': {'purchase_order_id':po_id},
            'chalans': {'purchase_order_id':po_id},
            'material_movements': {'purchase_order_id':po_id, '$or':[
                {'movement_type': {'$ne':'order_created'}}, {'floor_id': {'$ne':floor}}]},
        }
        for collection, query in related.items():
            # A reference on another floor is still a dependency: deleting the
            # purchase would otherwise leave that floor with a dangling link.
            if await db[collection].find_one(query, {'_id':1}, session=session):
                raise HTTPException(409, 'Reverse the purchase stock and delivery movements before deleting it')
        co_id = po.get('customer_order_id')
        if co_id:
            co = await db.customer_orders.find_one({'id':co_id, 'floor_id':floor, 'is_deleted':False}, session=session)
            if not co:
                raise HTTPException(409, 'Linked customer order needs attention before deleting this purchase')
            brands = co.get('brands') or []
            matching = [brand for brand in brands if brand.get('purchase_order_id') == po_id]
            if len(matching) != 1:
                raise HTTPException(409, 'Linked customer order needs attention before deleting this purchase')
            remaining = [brand for brand in brands if brand.get('purchase_order_id') != po_id]
            products = int(co.get('total_products') or 0) - len(po.get('items') or [])
            boxes = round(float(co.get('total_boxes') or 0) - sum(float(item.get('qty') or 0) for item in po.get('items') or []), 6)
            value = round(float(co.get('total_value') or 0) - float(po.get('grand_total') or 0), 2)
            if products < 0 or boxes < -0.000001 or value < -0.01:
                raise HTTPException(409, 'Linked customer order totals need attention before deleting this purchase')
            boxes = max(0, boxes)
            overall = rollup_status([brand.get('status', 'Pending') for brand in remaining])
            pct = completion_percentage(boxes, sum(float(brand.get('boxes_dispatched') or 0) for brand in remaining))
            at = datetime.now(timezone.utc).isoformat()
            await db.customer_orders.update_one({'_id':co['_id']}, {'$set':{
                'brands':remaining, 'total_products':products, 'total_boxes':boxes, 'total_value':max(0, value),
                'overall_status':overall, 'completion_percentage':pct,
                'dashboard_summary':{'completion_percentage':pct,'overall_status':overall,
                    'supplier_statuses':[{'supplier_name':brand.get('supplier_name'),'status':brand.get('status')} for brand in remaining]},
                'last_activity':'Purchase deleted', 'last_activity_at':at, 'updated_at':at,
            }, '$inc':{'version':1}}, session=session)
        files=[]
        for attachment in po.get('attachments') or []:
            key=attachment.get('storage_key')
            if key:
                if not key.startswith(f'purchase-orders/{po_id}/') or '..' in key.split('/'):
                    raise HTTPException(409,'Purchase attachment needs attention before deletion')
                files.append({'bucket':private_bucket,'key':key})
        await db.purchase_orders.delete_one({'_id':po['_id']},session=session)
        await db.material_movements.delete_many({'floor_id':floor,'purchase_order_id':po_id,'movement_type':'order_created'},session=session)
        await db.followups.delete_many({'floor_id':floor,'$or':[{'purchase_id':po_id},{'purchase_order_id':po_id}]},session=session)
        await db.activity_events.delete_many({'floor_id':floor,'$or':[{'purchase_id':po_id},{'purchase_order_id':po_id},{'entity_type':'purchase','entity_id':po_id}]},session=session)
        await db.event_outbox.delete_many({'floor_id':floor,'$or':[{'payload.po_id':po_id},{'payload.purchase_order_id':po_id}]},session=session)
        link = r'(?:^|/)' + re.escape(po_id) + r'(?:[/?#]|$)'
        await db.notifications.delete_many({'floor_id':floor,'link':{'$regex':link}},session=session)
        await db.download_tokens.delete_many({'floor_id':floor,'target':{'$regex':link}},session=session)
        await db.settings.insert_one({'id':receipt_id,'kind':'customer_deletion_receipt','floor_id':floor,'actor_id':actor,
            'completed_at':datetime.now(timezone.utc).isoformat(),'pending_private_files':files,
            'purchase_automation_key':po.get('automation_key')},session=session)
        return {'ok':True,'already_deleted':False}
    async with await client.start_session() as session:
        return await session.with_transaction(operation,read_concern=ReadConcern('snapshot'),write_concern=WriteConcern('majority'))
