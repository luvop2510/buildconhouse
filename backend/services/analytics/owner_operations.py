"""Read-only, floor-scoped owner workload and recorded contact activity."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from services.analytics.unified import INDIA, MAX_LINES, MAX_RECORDS, _bounded, scope_for, stamp
from services.lead_scope import POST_ORDER_CATEGORIES, POST_ORDER_RULES


def summarize_operations(rows, events, people, now):
    today = now.astimezone(INDIA).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    since = now - timedelta(days=30)
    owners = {person['id'] for person in people if person.get('role') == 'owner'}
    names = {person['id']: person.get('full_name') or 'Recorded team member' for person in people}
    team = {}
    def worker(identity, name=None):
        if not identity or identity in owners:
            return None
        return team.setdefault(identity, {'id': identity, 'name': names.get(identity) or name or 'Recorded team member',
                                          'open': 0, 'overdue': 0, 'completed': 0, 'contacts': 0, 'calls': 0})
    counts = {'open_followups': 0, 'overdue_followups': 0, 'completed_followups': 0, 'dismissed_followups': 0, 'unassigned_followups': 0}
    permitted_ids = {row['id'] for row in rows}
    for row in rows:
        opened = row.get('status') in {'open', 'snoozed'}
        completed = row.get('status') == 'done'
        due = stamp(row.get('due_at'))
        snoozed = stamp(row.get('snoozed_until'))
        overdue = opened and bool(due and due < today.isoformat()) and not (row.get('status') == 'snoozed' and snoozed and snoozed > now.isoformat())
        counts['open_followups'] += int(opened)
        counts['overdue_followups'] += int(overdue)
        counts['completed_followups'] += int(completed)
        counts['dismissed_followups'] += int(row.get('status') == 'dismissed')
        assignments = {a.get('user_id'): a.get('user_name') for a in row.get('assignments', []) if a.get('floor_id') == row.get('floor_id') and a.get('user_id')}
        if not assignments and row.get('assigned_to'):
            assignments = {row['assigned_to']: row.get('assigned_to_name')}
        assignments = {identity: name for identity, name in assignments.items() if identity not in owners}
        if opened and not assignments:
            counts['unassigned_followups'] += 1
        for identity, name in assignments.items():
            entry = worker(identity, name)
            entry['open'] += int(opened)
            entry['overdue'] += int(overdue)
            entry['completed'] += int(completed)
    attempts = {}
    for event in events:
        at = stamp(event.get('created_at'))
        if event.get('entity_id') not in permitted_ids or not at or not since.isoformat() <= at <= now.isoformat():
            continue
        if event.get('event_type') not in {'followup.contacted', 'followup.call_logged'}:
            continue
        actor = event.get('actor_id')
        if not worker(actor, event.get('actor_name')):
            continue
        payload = event.get('payload') or {}
        key = (actor, event['entity_id'], payload.get('attempt_id') or event.get('id'))
        if key[-1] is None:
            continue
        call = event['event_type'] == 'followup.call_logged' or payload.get('channel') == 'call'
        attempts[key] = attempts.get(key, False) or call
    for (actor, _, _), call in attempts.items():
        team[actor]['contacts'] += 1
        team[actor]['calls'] += int(call)
    return {**counts, 'team': sorted(team.values(), key=lambda row: (-row['open'], -row['contacts'], row['name'].casefold(), row['id']))}


async def owner_operations(db, q, floors, now=None, *, user=None):
    now = now or datetime.now(timezone.utc)
    scope = scope_for(q, floors)
    match = {**scope, 'category': {'$nin': sorted(POST_ORDER_CATEGORIES)}, 'rule_type': {'$nin': sorted(POST_ORDER_RULES)},
             'purchase_id': {'$in': [None, '']}, 'consolidated_order_id': {'$in': [None, '']}}
    projection = {'_id': 0, **{key: 1 for key in ('id', 'floor_id', 'status', 'due_at', 'snoozed_until', 'assignments', 'assigned_to', 'assigned_to_name')}}
    rows = await _bounded(db.followups.find(match, projection), 'Current follow-ups', MAX_RECORDS)
    event_match = {'floor_id': scope['floor_id'], 'entity_type': 'followup', 'entity_id': {'$in': [row['id'] for row in rows]},
                   'event_type': {'$in': ['followup.contacted', 'followup.call_logged']},
                   'created_at': {'$gte': (now - timedelta(days=30)).isoformat(), '$lte': now.isoformat()}}
    event_fields = {'_id': 0, **{key: 1 for key in ('id', 'entity_id', 'actor_id', 'actor_name', 'created_at', 'event_type', 'payload.attempt_id', 'payload.channel')}}
    events = await _bounded(db.activity_events.find(event_match, event_fields), 'Recorded team contacts', MAX_LINES) if rows else []
    ids = {row.get('assigned_to') for row in rows}
    ids.update(a.get('user_id') for row in rows for a in row.get('assignments', []) if a.get('floor_id') == row.get('floor_id'))
    ids.update(event.get('actor_id') for event in events)
    ids.discard(None)
    people = await _bounded(db.users.find({'id': {'$in': sorted(ids)}}, {'_id': 0, 'id': 1, 'full_name': 1, 'role': 1}), 'Recorded team members', MAX_RECORDS) if ids else []
    workflows = await workflow_snapshot(db, scope['floor_id']['$in'], user)
    return {'generated_at': now.isoformat(), 'floor_ids': scope['floor_id']['$in'], 'workflows': workflows,
            'period_label': 'Current follow-ups · contacts in the last 30 days',
            **summarize_operations(rows, events, people, now),
            'notes': ['Open and overdue counts are current floor-local follow-ups; overdue means due before today in India, excluding future snoozes.',
                      'Completed counts include all recorded done follow-ups. Dismissed follow-ups are separate. Team status counts belong to current recorded assignees, not the person who completed the work.',
                      'Contacts and calls count recorded attempts by their actual actor in the last 30 days. A call is included in contacts. Multi-person assignments can make team counts exceed unique follow-ups.',
                      'Operational follow-ups are independent of the selected sales period and customer, product or company filters.']}


async def workflow_snapshot(db, floors, user):
    result = []
    if 'second-floor' in floors and user is not None:
        from models_kitchen import STAGES
        from services.kitchen_projects import KitchenProjectService
        # The owner has already passed the requested floor boundary. Pin the
        # internal read to Kitchen so the global overview never inherits a
        # different operational floor from the user's current workspace.
        kitchen = await KitchenProjectService(db).dashboard(user.model_copy(update={'active_floor_id': 'second-floor'}))
        result.append({'floor_id': 'second-floor', 'name': 'Kitchen', 'unit': 'projects',
                       'total': kitchen['total_projects'], 'active': kitchen['active_projects'],
                       'completed': kitchen['stage_counts'].get('completed', 0), 'on_hold': kitchen['on_hold_projects'],
                       'overdue': kitchen['completion_overdue_projects'],
                       'stages': [{'id': stage, 'name': 'CAD' if stage == 'cad' else stage.capitalize(), 'count': kitchen['stage_counts'].get(stage, 0)} for stage in STAGES],
                       'workload': [{'id': row['assignee_id'], 'name': row.get('assignee_name') or 'Unassigned', 'count': row['project_count']} for row in kitchen['workload']]})
    if 'third-floor' in floors:
        rows = await db.furniture_quotations.aggregate([
            {'$match': {'floor_id': 'third-floor', 'is_deleted': {'$ne': True}}},
            {'$group': {'_id': '$status', 'count': {'$sum': 1}}},
        ], maxTimeMS=5000).to_list(100)
        stages = [{'id': row['_id'] or 'unknown', 'name': {'draft': 'Draft', 'final': 'Final'}.get(row['_id'], 'Status unavailable'), 'count': row['count']} for row in rows]
        result.append({'floor_id': 'third-floor', 'name': 'Furniture', 'unit': 'ledgers', 'total': sum(row['count'] for row in rows),
                       'active': None, 'completed': None, 'stages': sorted(stages, key=lambda row: row['id'])})
    return result
