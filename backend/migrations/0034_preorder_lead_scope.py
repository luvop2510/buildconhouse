"""Retire post-order follow-ups without erasing their business history.

Existing manual and automated payment/dispatch/delivery/operations rows close
once and remain available as historical records. No customer/order/payment is
removed. Add indexes for floor-local team pages and retry-safe grouped leads.
"""
from models import now_iso
from pymongo.errors import OperationFailure
from services.lead_scope import POST_ORDER_CATEGORIES, POST_ORDER_RULES


async def _index(collection, keys, name):
    try:
        await collection.create_index(keys, name=name)
    except OperationFailure as error:
        if error.code != 85:
            raise


async def up(db):
    now = now_iso()
    await db.followups.update_many({
        'status': {'$in': ['open', 'snoozed']},
        '$or': [{'category': {'$in': sorted(POST_ORDER_CATEGORIES)}}, {'rule_type': {'$in': sorted(POST_ORDER_RULES)}}, {'purchase_id': {'$type': 'string', '$ne': ''}}],
    }, {'$set': {'status': 'done', 'auto_resolved': True, 'completed_at': now, 'updated_at': now,
                  'resolution_note': 'Order activity belongs in Orders; follow-ups cover pre-order sales only'}})
    # Legacy manual leads have no group metadata. Consolidate only a confirmed
    # quotation's own linked or unlinked customer leads; retain unrelated
    # project quotations and closed history. Iterate instead of loading orders.
    async for order in db.quotations.find({'status': 'ordered', 'customer_id': {'$type': 'string'}, 'floor_id': {'$type': 'string'}}, {'_id': 0, 'id': 1, 'number': 1, 'customer_id': 1, 'floor_id': 1}).sort([('ordered_at', 1), ('id', 1)]):
        query = {'floor_id': order['floor_id'], 'customer_id': order['customer_id'], 'status': {'$in': ['open', 'snoozed']},
                 'category': {'$nin': sorted(POST_ORDER_CATEGORIES)}, 'rule_type': {'$nin': sorted(POST_ORDER_RULES)},
                 '$or': [{'quotation_id': order['id']}, {'quotation_id': {'$in': [None, '']}}]}
        groups = await db.followups.distinct('lead_group_id', query)
        patch = {'status': 'done', 'auto_resolved': True, 'completed_outcome': 'won', 'notebook_status': 'won',
                 'completed_at': now, 'updated_at': now, 'snoozed_until': None,
                 'consolidated_order_id': order['id'], 'consolidated_order_floor_id': order['floor_id'],
                 'resolution_note': f"Consolidated into order {order.get('number') or order['id']}"}
        if groups:
            await db.followups.update_many({'lead_group_id': {'$in': [g for g in groups if g]}, 'status': {'$in': ['open', 'snoozed']}}, {'$set': patch})
        await db.followups.update_many(query, {'$set': patch})
    await _index(db.followups, [('lead_group_id', 1), ('floor_id', 1)], name='followups_lead_group_floor')
    await _index(db.followups, [('floor_id', 1), ('updated_at', -1), ('id', -1)], name='followups_team_floor_page')
    for collection in (db.customers, db.walkins, db.followups):
        await _index(collection, [('referrer_id', 1), ('floor_id', 1), ('created_at', 1)], name='lead_referrer_acquisition')
    await _index(db.activity_events, [('entity_type', 1), ('entity_id', 1), ('created_at', -1)], name='lead_activity_page')
