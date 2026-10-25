"""Multi-floor sales leads with floor-local records and shared assignment metadata.

No cross-floor query replaces the operational authorization boundary. A grouped
lead has one customer/follow-up per selected floor, linked by lead_group_id.
"""
from collections import defaultdict
import asyncio
from uuid import uuid5, NAMESPACE_URL

from fastapi import HTTPException

from services.referrer_identity import referrer_query
from auth import accessible_floor_ids, profile_floor_ids, require_floor_access
from models import Followup, now_iso
from services.access_grants import grant_allows, grants_for_user

POST_ORDER_CATEGORIES = frozenset({'payment', 'purchase', 'dispatch', 'delivery', 'operations', 'complaint', 'support'})
POST_ORDER_RULES = frozenset({'payment_overdue', 'payment_partial', 'purchase_dispatched', 'purchase_delivered', 'shortage_reorder', 'order_confirmed_ops'})
STAFF_PROJECTION = {'_id': 0, 'id': 1, 'full_name': 1, 'role': 1, 'active': 1, 'floor_ids': 1, 'access_profile': 1, 'custom_access': 1, 'delegation_grants': 1, 'is_deleted': 1, 'deleted_at': 1}


def _followup_resources(floor, notebook_converted):
    if floor in {'second-floor', 'third-floor'}:
        return ('followups', 'notebook_quotations' if notebook_converted else 'notebook_walkins')
    return ('followups',)


def can_assign(staff, floor, grants=(), notebook_converted=False):
    if not staff.get('active', True) or staff.get('is_deleted') or staff.get('deleted_at'):
        return False
    if staff.get('role') == 'owner':
        # Owners delegate work and are never assignees. Keeping this rule in
        # the shared eligibility check protects every floor and notebook
        # workflow, including requests that bypass the Team UI.
        return False
    profile = profile_floor_ids(staff.get('access_profile'))
    floors = profile if profile is not None else staff.get('floor_ids', [])
    if staff.get('custom_access'):
        resources = _followup_resources(floor, notebook_converted)
        return floor in floors and any(all(any(grant_allows(g, user_id=staff['id'], resource=resource, action=action, floor_id=floor)
            for g in staff.get('delegation_grants', grants)) for action in ('view', 'update')) for resource in resources)
    if staff.get('access_profile') and profile is None:
        return False
    if staff.get('access_profile') in {'ground_payments_dispatches', 'sanitary_purchases'}:
        return False
    return staff.get('role') in {'manager', 'admin', 'sales'} and (staff.get('role') == 'manager' or floor in floors)


async def eligible_staff(database, floors, notebook_converted=False):
    rows = await database.users.find({'active': True}, STAFF_PROJECTION).sort('full_name', 1).to_list(1000)
    legacy_ids = [s['id'] for s in rows if s.get('custom_access') and 'delegation_grants' not in s]
    grants_by_user = defaultdict(list)
    if legacy_ids:
        for grant in await database.access_grants.find({'user_id': {'$in': legacy_ids}}, {'_id': 0}).to_list(10000):
            grants_by_user[grant['user_id']].append(grant)
    stages = notebook_converted if isinstance(notebook_converted, dict) else {floor: notebook_converted for floor in floors}
    return [{**s, 'eligible_floor_ids': [f for f in floors if can_assign(s, f, grants_by_user[s['id']], stages.get(f, False))]} for s in rows]


async def validate_assignments(database, floors, assignments, notebook_converted=False):
    normalized = []
    if assignments:
        candidates = {s['id']: s for s in await eligible_staff(database, floors, notebook_converted)}
        seen = set()
        for assignment in assignments:
            item = assignment.model_dump() if hasattr(assignment, 'model_dump') else assignment
            key = (item['floor_id'], item['user_id'])
            staff = candidates.get(item['user_id'])
            if item['floor_id'] not in floors or not staff or item['floor_id'] not in staff['eligible_floor_ids']:
                raise HTTPException(422, 'Assignee must have sales follow-up access to the selected floor and notebook stage')
            if key not in seen:
                normalized.append({'floor_id': key[0], 'user_id': key[1], 'user_name': staff['full_name']})
                seen.add(key)
    return normalized


def require_group_floor(floor, user, source_floor):
    if getattr(user, 'custom_access', False) and floor != source_floor:
        # Source authorization narrows request-local grants to its one stage.
        # Foreign floors use their actual stage grant below, within the user's
        # account floor boundary; never broaden the authenticated source scope.
        permitted = profile_floor_ids(getattr(user, 'access_profile', None))
        permitted = permitted if permitted is not None else user.floor_ids
        if floor not in permitted:
            raise HTTPException(403, 'You do not have access to this floor')
    else:
        require_floor_access(floor, user)


async def validate_scope(database, user, floor_ids, assignments, notebook_converted=False, source_floor=None):
    floors = list(dict.fromkeys(floor_ids))
    if not floors or len(floors) > 20:
        raise HTTPException(422, 'Choose at least one floor')
    for floor in floors:
        require_group_floor(floor, user, source_floor) if source_floor else require_floor_access(floor, user)
    found = await database.floors.find({'id': {'$in': floors}, 'active': {'$ne': False}}, {'_id': 0, 'id': 1}).to_list(20)
    if set(floors) != {f['id'] for f in found}:
        raise HTTPException(422, 'A selected floor is unavailable')
    return floors, await validate_assignments(database, floors, assignments, notebook_converted)


async def notebook_stages(database, source, floors):
    """The canonical destination notebook can be further along than its source."""
    from services.followup_notebook import normalize_mobile
    async def stage(floor):
        if floor not in {'second-floor', 'third-floor'}:
            return floor, False
        if floor == source.get('floor_id') and source.get('id'):
            return floor, bool(source.get('is_converted'))
        customer = None
        if source.get('customer_phone'):
            phone = source['customer_phone']
            customer = await database.customers.find_one({'floor_id': floor, '$or': [{'phone_normalized': normalize_mobile(phone)}, {'phone': phone}]}, {'_id': 0, 'id': 1})
        row = await database.followups.find_one({'notebook_key': f"{floor}:{customer['id']}"}, {'_id': 0, 'is_converted': 1}) if customer else None
        return floor, bool(row.get('is_converted')) if row else bool(source.get('is_converted'))
    return dict(await asyncio.gather(*(stage(floor) for floor in floors)))


async def referrer_fields(database, referrer_id, floor, user):
    if not referrer_id:
        return {'referrer_id': None, 'referrer_name': None, 'referrer_type': None}
    query = {'id': referrer_id}
    permitted = accessible_floor_ids(user)
    if permitted is not None:
        query['floor_id'] = {'$in': permitted}
    ref = await database.referrers.find_one(referrer_query(query), {'_id': 0, 'id': 1, 'name': 1, 'type': 1, 'active': 1})
    if not ref or ref.get('active') is False:
        raise HTTPException(422, 'Active referrer not found in your permitted floors')
    return {'referrer_id': ref['id'], 'referrer_name': ref['name'], 'referrer_type': ref['type']}


async def update_interests(database, *, user, source, floor_ids, assignments=None, metadata=None, dry_run=False):
    if source.get('category') in POST_ORDER_CATEGORIES or source.get('rule_type') in POST_ORDER_RULES or source.get('purchase_id') or source.get('consolidated_order_id'):
        raise HTTPException(409, 'Follow-ups cover only leads before an order is placed')
    requested_pairs = {(a.floor_id, a.user_id) if hasattr(a, 'floor_id') else (a['floor_id'], a['user_id']) for a in assignments or []}
    current_pairs = {(a['floor_id'], a['user_id']) for a in source.get('assignments', [])}
    owner_rows = await database.users.find({'role': 'owner'}, {'_id': 0, 'id': 1}).to_list(1000)
    owner_ids = {row['id'] for row in owner_rows}
    has_owner_assignment = any(user_id in owner_ids for _, user_id in current_pairs)
    if (source.get('lead_group_id')
            and set(floor_ids) == set(source.get('interested_floor_ids') or [source['floor_id']])
            and (assignments is None or requested_pairs == current_pairs)
            and not has_owner_assignment and source.get('assigned_to') not in owner_ids and not metadata):
        return source
    group = source.get('lead_group_id') or source['id']
    existing = await database.followups.find({'$or': [{'lead_group_id': group, 'status': {'$in': ['open', 'snoozed']}}, {'id': source['id']}]}, {'_id': 0}).to_list(1000)
    # Editing the shared scope must not reveal/mutate inaccessible siblings.
    for row in existing:
        require_group_floor(row['floor_id'], user, source['floor_id'])
    floors, _ = await validate_scope(database, user, floor_ids, [], source_floor=source['floor_id'])
    if any(floor != source['floor_id'] for floor in floors) and not source.get('customer_phone'):
        raise HTTPException(422, 'A phone is required to link a customer across floors')
    by_floor = {row['floor_id']: row for row in existing if row.get('status') in {'open', 'snoozed'} or row['id'] == source['id']}
    by_floor.setdefault(source['floor_id'], source)
    # Resolve destination conflicts and committed orders before the first
    # write. Retry-safe identities handle later network failures.
    from services.followup_notebook import normalize_mobile
    targets = {}
    async def resolve_target(floor):
        local = by_floor.get(floor)
        if not local:
            removed = await database.followups.find_one({'id': str(uuid5(NAMESPACE_URL, f'lead:{group}:{floor}')), 'resolution_note': 'Floor interest removed'}, {'_id': 0})
            if removed:
                local = removed
        customer = None
        if local:
            customer = {'id': local['customer_id']}
        elif source.get('customer_phone'):
            phone = source['customer_phone']
            customer = await database.customers.find_one({'floor_id': floor, '$or': [{'phone_normalized': normalize_mobile(phone)}, {'phone': phone}]}, {'_id': 0})
            if customer and floor in {'second-floor', 'third-floor'}:
                old = await database.followups.find_one({'notebook_key': f"{floor}:{customer['id']}"}, {'_id': 0})
                if old:
                    if old.get('consolidated_order_id') or old.get('completed_outcome') in {'won', 'lost'}:
                        raise HTTPException(409, 'This floor already has a closed customer lead')
                    local = old
        if customer and await database.quotations.find_one({'floor_id': floor, 'customer_id': customer['id'], 'status': 'ordered'}, {'_id': 0, 'id': 1}):
            raise HTTPException(409, 'This customer already placed an order; open Orders')
        return floor, customer, local
    # Floor-local reads are independent. Keep writes behind the complete
    # validation barrier while avoiding a network round trip per floor.
    for floor, customer, local in await asyncio.gather(*(resolve_target(floor) for floor in floors)):
        targets[floor] = customer
        if local:
            by_floor[floor] = local
    stages = {floor: bool((by_floor.get(floor) or source).get('is_converted')) for floor in floors}
    if assignments is None:
        # Existing grouped leads can predate the owner-only-delegates rule.
        # Clean stale owner entries on the next edit, while explicit attempts
        # to assign an owner still fail validation below.
        requested_assignments = [
            item for item in source.get('assignments', [])
            if (item.user_id if hasattr(item, 'user_id') else item.get('user_id')) not in owner_ids
        ]
    else:
        requested_assignments = assignments
    selected_assignments = await validate_assignments(database, floors, requested_assignments, stages)
    # Authentication authorized the source row's stage. Reused canonical rows
    # require their own stage capability before any floor receives a write.
    if getattr(user, 'custom_access', False):
        destinations = set(floors) | set(by_floor)
        destinations.discard(source['floor_id'])
        if destinations:
            grants = await grants_for_user(database, user.id)
            for floor in destinations:
                converted = bool((by_floor.get(floor) or source).get('is_converted'))
                resources = _followup_resources(floor, converted)
                if not any(all(any(grant_allows(g, user_id=user.id, resource=resource, action=action, floor_id=floor) for g in grants) for action in ('view', 'update')) for resource in resources):
                    raise HTTPException(403, 'The destination floor or notebook stage is outside your assigned access')
    if dry_run:
        return source
    now = now_iso()
    patch = {**(metadata or {}), 'lead_group_id': group, 'interested_floor_ids': floors, 'assignments': selected_assignments, 'updated_at': now}
    for floor in floors:
        local = by_floor.get(floor)
        floor_assignments = [a for a in selected_assignments if a['floor_id'] == floor]
        local_patch = dict(patch)
        if local and local.get('resolution_note') == 'Floor interest removed':
            local_patch.update(status='open', completed_at=None, resolution_note=None)
        if floor_assignments:
            local_patch.update(assigned_to=floor_assignments[0]['user_id'], assigned_to_name=floor_assignments[0]['user_name'])
        elif assignments is not None or (local or {}).get('assigned_to') in owner_ids:
            local_patch.update(assigned_to=None, assigned_to_name=None)
        if local:
            await database.followups.update_one({'id': local['id'], 'floor_id': floor}, {'$set': local_patch})
        else:
            phone = source['customer_phone']
            customer = targets[floor]
            if not customer:
                customer = {'id': str(uuid5(NAMESPACE_URL, f'lead-customer:{group}:{floor}')), 'floor_id': floor, 'name': source['customer_name'], 'phone': phone, 'phone_normalized': normalize_mobile(phone), 'tier': source.get('customer_tier', 'retail'), 'portal_enabled': False, 'created_at': now, 'updated_at': now}
                await database.customers.update_one({'id': customer['id']}, {'$setOnInsert': customer}, upsert=True)
            row = Followup(id=str(uuid5(NAMESPACE_URL, f'lead:{group}:{floor}')), floor_id=floor, customer_id=customer['id'], customer_name=source['customer_name'], customer_phone=phone,
                rule_type='manual', category='sales', reason=source.get('reason') or 'Customer interested', due_at=source.get('due_at') or now, is_automated=False,
                is_converted=bool(source.get('is_converted')), converted_at=source.get('converted_at'), quotation_price=source.get('quotation_price'),
                **local_patch).model_dump()
            if floor in {'second-floor', 'third-floor'}:
                row.update(notebook_key=f"{floor}:{customer['id']}", source_key=f"notebook:{floor}:{customer['id']}", address=source.get('address'), kitchen_type=source.get('kitchen_type') if floor == 'second-floor' else None)
                # The canonical notebook row may predate this grouped lead.
                old = await database.followups.find_one({'notebook_key': row['notebook_key']}, {'_id': 0})
                if old:
                    if old.get('consolidated_order_id') or old.get('completed_outcome') in {'won', 'lost'}:
                        raise HTTPException(409, 'This floor already has a closed customer lead')
                    await database.followups.update_one({'id': old['id']}, {'$set': local_patch})
                    row = {**old, **local_patch}
                else:
                    await database.followups.update_one({'id': row['id']}, {'$setOnInsert': row}, upsert=True)
            else:
                await database.followups.update_one({'id': row['id']}, {'$setOnInsert': row}, upsert=True)
            by_floor[floor] = row
        if metadata and any(k.startswith('referrer_') for k in metadata):
            customer_id = (by_floor.get(floor) or source).get('customer_id')
            await database.customers.update_one({'id': customer_id, 'floor_id': floor}, {'$set': {k: v for k,v in metadata.items() if k.startswith('referrer_')}})
    for floor, row in by_floor.items():
        if floor not in floors:
            await database.followups.update_one({'id': row['id'], 'status': {'$in': ['open','snoozed']}}, {'$set': {**patch, 'status': 'dismissed', 'completed_at': now, 'resolution_note': 'Floor interest removed'}})
    return await database.followups.find_one({'id': source['id']}, {'_id': 0})


def team_report(rows, events):
    """Linear, bounded transformation; counts work performed by its actor."""
    events_by_lead = defaultdict(list)
    actor_counts = defaultdict(lambda: {'contacts': 0, 'calls': 0})
    attempts = {}
    for event in events:
        events_by_lead[event['entity_id']].append(event)
        payload = event.get('payload') or {}
        if event.get('event_type') not in {'followup.contacted', 'followup.call_logged'}:
            continue
        key = (event.get('actor_id'), event['entity_id'], payload.get('attempt_id') or event.get('id') or id(event))
        is_call = event.get('event_type') == 'followup.call_logged' or payload.get('channel') == 'call'
        attempts[key] = attempts.get(key, False) or is_call
    for (actor, lead, _attempt), is_call in attempts.items():
        actor_counts[(actor, lead)]['contacts'] += 1
        actor_counts[(actor, lead)]['calls'] += int(is_call)
    workers = {}
    seen = defaultdict(set)
    completion = defaultdict(dict)
    for row in rows:
        assigned = [a for a in row.get('assignments', []) if a['floor_id'] == row['floor_id']]
        if not assigned and row.get('assigned_to'):
            assigned = [{'user_id': row['assigned_to'], 'user_name': row.get('assigned_to_name')}]
        for assignment in assigned:
            uid = assignment['user_id']
            worker = workers.setdefault(uid, {'user_id': uid, 'user_name': assignment.get('user_name') or uid, 'assigned_leads': 0, 'contacts_made': 0, 'calls_made': 0, 'completed_leads': 0, 'leads': []})
            identity = row.get('lead_group_id') or row.get('walkin_id') or row.get('customer_id') or row['id']
            if identity not in seen[uid]:
                worker['assigned_leads'] += 1
                seen[uid].add(identity)
            counts = actor_counts[(uid, row['id'])]
            worker['contacts_made'] += counts['contacts']
            worker['calls_made'] += counts['calls']
            completion[uid][identity] = completion[uid].get(identity, True) and row.get('status') in {'done','dismissed'}
            worker['leads'].append({**{k: row.get(k) for k in ('id','customer_name','floor_id','status','contact_attempts','call_attempts','last_contacted_at','latest_response')}, 'latest_update': row.get('updated_at'), 'activity': events_by_lead[row['id']]})
    for uid, worker in workers.items():
        worker['completed_leads'] = sum(completion[uid].values())
    return sorted(workers.values(), key=lambda w: w['user_name'].casefold())
