"""Transactional reversal of a floor-scoped payment or its source transaction."""
from datetime import datetime, timezone
import math
from fastapi import HTTPException
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern


async def reverse_payment(db, client, payment_id, floor, actor):
    if floor not in {'first-floor', 'ground-floor'}:
        raise HTTPException(403, 'Payment deletion is available on Ground and Sanitary floors')
    receipt_id = f'payment-reversal:{floor}:{payment_id}'
    async def operation(session):
        if await db.settings.find_one({'id':receipt_id}, session=session):
            return {'ok':True, 'already_deleted':True}
        payment = await db.payments.find_one({'id':payment_id, 'floor_id':floor}, session=session)
        if not payment:
            raise HTTPException(404, 'Payment not found')
        quote = await db.quotations.find_one({'id':payment.get('quotation_id'), 'floor_id':floor}, session=session)
        if not quote:
            raise HTTPException(409, 'The linked order is unavailable; the payment cannot be reversed safely')
        kind = payment.get('entry_type') or 'payment'
        update = {'$inc':{'payment_revision':1}}
        if kind == 'additional_cost':
            history = quote.get('payment_extra_history')
            if not isinstance(history,list):
                raise HTTPException(409, 'The linked cost history is unavailable')
            matches = [row for row in history if row.get('id') == payment.get('additional_cost_id')]
            if len(matches) != 1 or round(float(matches[0].get('amount') or 0),2) != round(float(payment.get('amount') or 0),2):
                raise HTTPException(409, 'The linked cost has changed')
            remaining = [row for row in history if row.get('id') != payment.get('additional_cost_id')]
            update['$set'] = {'payment_extra_history':remaining, 'payment_extra_amount':round(sum(float(row.get('amount') or 0) for row in remaining),2),
                              'payment_extra_name':remaining[-1].get('name') if remaining else None}
        elif kind == 'godown_stock_credit':
            lot = await db.godown_stock.find_one({'id':payment.get('godown_stock_id'), 'floor_id':floor}, session=session)
            if not lot or lot.get('payment_id') != payment_id:
                raise HTTPException(409, 'The linked go-down stock record is unavailable')
            qty = float(lot.get('qty_received') or 0)
            value = float(lot.get('transferred_value') or 0)
            if (not math.isfinite(qty) or not math.isfinite(value) or value < 0 or qty <= 0
                or float(lot.get('available_qty') or 0) != qty or float(lot.get('loaned_out_qty') or 0) != 0
                or lot.get('allocations') or lot.get('stock_movements') or lot.get('customer_transfers')
                or await db.godown_customer_transfers.find_one({'floor_id':floor, 'stock_id':lot['id']}, session=session)):
                raise HTTPException(409, 'This stock has already been used or changed; restore its movements before reversing it')
            po = await db.purchase_orders.find_one({'id':lot.get('source_purchase_order_id'), 'floor_id':floor}, session=session)
            item = next((row for row in (po or {}).get('items',[]) if row.get('id') == lot.get('source_purchase_item_id')), None)
            history = [row for row in (item or {}).get('godown_transfer_history',[]) if row.get('stock_id') == lot['id']]
            if not item or len(history) != 1 or float(history[0].get('qty') or 0) != qty or round(float(history[0].get('transferred_value') or 0),2) != round(value,2):
                raise HTTPException(409, 'The linked purchase movement has changed')
            if any(not math.isfinite(float(item.get(k) or 0)) or float(item.get(k) or 0) + 1e-8 < v for k,v in [('godown_transferred_qty',qty),('godown_valued_qty',qty),('godown_transferred_value',value)]):
                raise HTTPException(409, 'The linked purchase quantities have changed')
            result = await db.purchase_orders.update_one({'_id':po['_id'], 'items.id':item['id']}, {'$inc':{
                'items.$.godown_transferred_qty':-qty, 'items.$.godown_valued_qty':-qty, 'items.$.godown_transferred_value':-value},
                '$pull':{'items.$.godown_transfer_history':{'stock_id':lot['id']}}}, session=session)
            if not result.modified_count: raise HTTPException(409, 'Purchase movement changed')
            from services.stock_media_cleanup import detach_stock_photos
            await detach_stock_photos(db, floor, lot['id'], session)
            await db.godown_stock.delete_one({'_id':lot['_id']}, session=session)
            await db.activity_events.delete_many({'floor_id':floor, 'payload.stock_id':lot['id']}, session=session)
        elif kind != 'payment':
            raise HTTPException(409, 'This ledger entry needs a linked transaction reversal')
        await db.quotations.update_one({'_id':quote['_id']}, update, session=session)
        await db.payments.delete_one({'_id':payment['_id']}, session=session)
        await db.activity_events.delete_many({'floor_id':floor,'entity_type':'payment','entity_id':payment_id},session=session)
        receipt = {'id':receipt_id,'kind':'payment_reversal_receipt','actor_id':actor,'floor_id':floor,
                   'quotation_id':quote['id'],'completed_at':datetime.now(timezone.utc).isoformat()}
        if payment.get('idempotency_key'):
            receipt['payment_key'] = payment['idempotency_key']
        if kind == 'godown_stock_credit':
            receipt['stock_id'] = payment['godown_stock_id']
        if kind == 'additional_cost' and matches[0].get('request_key'):
            receipt['cost_key'] = matches[0]['request_key']
        await db.settings.insert_one(receipt, session=session)
        return {'ok':True,'already_deleted':False}
    async with await client.start_session() as session:
        return await session.with_transaction(operation,read_concern=ReadConcern('snapshot'),write_concern=WriteConcern('majority'))
