"""Hermetic behavior checks for grouped lead writes and overlapping call actors."""
import asyncio
import hashlib
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from models import Followup, FollowupCreate, FollowupCallOutcomePayload, FollowupContactPayload, UserPublic
from routes import followup_routes as routes
from services import lead_scope
from services.access_grants import build_grant


def field(row, key):
    for part in key.split('.'):
        row = row.get(part) if isinstance(row, dict) else None
    return row


def matches(row, query):
    for key, condition in query.items():
        if key == '$and':
            if not all(matches(row, branch) for branch in condition):
                return False
        elif key == '$or':
            if not any(matches(row, branch) for branch in condition):
                return False
        elif isinstance(condition, dict):
            value = field(row, key)
            if '$in' in condition and value not in condition['$in']:
                return False
            if '$ne' in condition and value == condition['$ne']:
                return False
        elif field(row, key) != condition:
            return False
    return True


def set_field(row, key, value, remove=False):
    parts = key.split('.')
    for part in parts[:-1]:
        row = row.setdefault(part, {})
    if remove:
        row.pop(parts[-1], None)
    else:
        row[parts[-1]] = deepcopy(value)


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, *args):
        return self

    async def to_list(self, limit):
        return deepcopy(self.rows[:limit])


class Collection:
    def __init__(self, rows=()):
        self.rows = deepcopy(list(rows))
        self.writes = 0
        self.before_update = None
        self.after_update = None

    def find(self, query, projection=None):
        return Cursor([row for row in self.rows if matches(row, query)])

    async def find_one(self, query, projection=None):
        return next((deepcopy(row) for row in self.rows if matches(row, query)), None)

    async def insert_one(self, row):
        self.writes += 1
        self.rows.append(deepcopy(row))

    async def update_one(self, query, update, upsert=False):
        if self.before_update:
            await self.before_update(query, update)
        row = next((row for row in self.rows if matches(row, query)), None)
        matched = row is not None
        if row is None and upsert:
            row = {**query, **deepcopy(update.get('$setOnInsert', {}))}
            self.rows.append(row)
        if row is not None:
            self.writes += 1
            for key, value in update.get('$set', {}).items():
                set_field(row, key, value)
            for key, value in update.get('$inc', {}).items():
                set_field(row, key, (field(row, key) or 0) + value)
            for key in update.get('$unset', {}):
                set_field(row, key, None, remove=True)
        if self.after_update:
            await self.after_update(query, update)
        return SimpleNamespace(matched_count=int(matched), modified_count=int(matched))


def grant(uid, floor, resource):
    return build_grant(user_id=uid, resource=resource, actions=['view', 'update'], floor_id=floor,
                       expires_at=None, actor_id='owner', actor_name='Owner')


def database():
    return SimpleNamespace(followups=Collection(), customers=Collection(), quotations=Collection(),
                           floors=Collection([{'id': floor} for floor in ('first-floor', 'ground-floor', 'second-floor', 'third-floor')]),
                           users=Collection(), access_grants=Collection())


def principal(uid='owner', custom=False, floors=('second-floor', 'third-floor')):
    return UserPublic(id=uid, email=f'{uid}@example.test', full_name=uid, role='worker' if custom else 'owner',
                      custom_access=custom, floor_ids=list(floors), active_floor_id=floors[0])


def source_row(floor='second-floor'):
    return Followup(id='source', floor_id=floor, customer_id='customer', customer_name='Customer',
                    customer_phone='9876543210', category='sales', reason='Discuss samples', due_at='2026-10-15T10:00:00Z').model_dump()


def test_actual_destination_stage_controls_assignees_and_preserves_canonical_stage():
    async def run():
        db = database()
        source = source_row()
        db.followups.rows = [source, {**source_row('third-floor'), 'id': 'canonical', 'customer_id': 'furniture',
                                      'notebook_key': 'third-floor:furniture', 'is_converted': True}]
        db.customers.rows = [{'id': 'furniture', 'floor_id': 'third-floor', 'phone_normalized': '9876543210'}]
        for uid, resource in [('walkin-worker', 'notebook_walkins'), ('quotation-worker', 'notebook_quotations')]:
            db.users.rows.append({'id': uid, 'full_name': uid, 'active': True, 'custom_access': True,
                                  'role': 'worker', 'floor_ids': ['third-floor'], 'delegation_grants': [grant(uid, 'third-floor', resource)]})
        stages = await lead_scope.notebook_stages(db, source, ['second-floor', 'third-floor'])
        assert stages == {'second-floor': False, 'third-floor': True}
        eligible = await lead_scope.eligible_staff(db, ['third-floor'], stages)
        assert next(row for row in eligible if row['id'] == 'walkin-worker')['eligible_floor_ids'] == []
        assert next(row for row in eligible if row['id'] == 'quotation-worker')['eligible_floor_ids'] == ['third-floor']
        with pytest.raises(HTTPException) as error:
            await lead_scope.update_interests(db, user=principal(), source=source, floor_ids=['second-floor', 'third-floor'],
                assignments=[{'floor_id': 'third-floor', 'user_id': 'walkin-worker'}])
        assert error.value.status_code == 422 and db.followups.writes == 0
        await lead_scope.update_interests(db, user=principal(), source=source, floor_ids=['second-floor', 'third-floor'],
            assignments=[{'floor_id': 'third-floor', 'user_id': 'quotation-worker'}])
        canonical = await db.followups.find_one({'id': 'canonical'})
        assert canonical['is_converted'] is True and canonical['assigned_to'] == 'quotation-worker'
    asyncio.run(run())


@pytest.mark.parametrize('converted', [False, True])
def test_foreign_notebook_floor_requires_actual_stage_update_grant_before_writes(converted):
    async def run():
        db = database()
        source = source_row()
        db.followups.rows = [source, {**source_row('third-floor'), 'id': 'canonical', 'customer_id': 'furniture',
                                      'notebook_key': 'third-floor:furniture', 'is_converted': converted}]
        db.customers.rows = [{'id': 'furniture', 'floor_id': 'third-floor', 'phone_normalized': '9876543210'}]
        actor = principal('worker', custom=True)
        db.users.rows = [{'id': actor.id, 'floor_ids': actor.floor_ids, 'delegation_grants': [grant(actor.id, 'second-floor', 'notebook_walkins')]}]
        with pytest.raises(HTTPException) as error:
            await lead_scope.update_interests(db, user=actor, source=source, floor_ids=['second-floor', 'third-floor'], assignments=[])
        assert error.value.status_code == 403 and db.followups.writes == db.customers.writes == 0
        db.users.rows[0]['delegation_grants'].append(grant(actor.id, 'third-floor', 'notebook_quotations' if converted else 'notebook_walkins'))
        # Authentication has narrowed request-local grants to the source
        # walk-in stage; the other stage must use its actual target grant.
        object.__setattr__(actor, '_custom_grant_floor_ids', ['second-floor'])
        await lead_scope.update_interests(db, user=actor, source=source, floor_ids=['second-floor', 'third-floor'], assignments=[])
        assert db.followups.writes == 2
    asyncio.run(run())


def test_newer_call_initiation_survives_old_outcome_and_is_not_counted_twice(monkeypatch):
    async def run():
        db = database()
        db.followups.rows = [source_row('first-floor')]
        actor = principal('worker', floors=('first-floor',))
        monkeypatch.setattr(routes, 'db', db)
        monkeypatch.setattr(routes, 'log_event', AsyncMock())
        await routes.contact_followup('source', FollowupContactPayload(channel='call'), actor)
        actor_key = hashlib.sha256(actor.id.encode()).hexdigest()
        first = (await db.followups.find_one({'id': 'source'}))['pending_call_ids'][actor_key]
        async def overlap(query, update):
            if 'latest_response' in update.get('$set', {}):
                db.followups.before_update = None
                await routes.contact_followup('source', FollowupContactPayload(channel='call'), actor)
        db.followups.before_update = overlap
        await routes.log_call('source', FollowupCallOutcomePayload(outcome='no_answer'), actor)
        row = await db.followups.find_one({'id': 'source'})
        assert row['contact_attempts'] == row['call_attempts'] == 2
        assert row['pending_call_ids'][actor_key] != first
        await routes.log_call('source', FollowupCallOutcomePayload(outcome='no_answer'), actor)
        row = await db.followups.find_one({'id': 'source'})
        assert row['contact_attempts'] == row['call_attempts'] == 2 and actor_key not in row['pending_call_ids']
    asyncio.run(run())


def test_create_retry_after_persisted_sibling_failure_finishes_one_group_and_rejects_changed_payload(monkeypatch):
    async def run():
        db = database()
        db.customers.rows = [{'id': 'customer', 'floor_id': 'first-floor', 'name': 'Customer', 'phone': '9876543210'}]
        actor = principal(floors=('first-floor',))
        monkeypatch.setattr(routes, 'db', db)
        events = AsyncMock()
        monkeypatch.setattr(routes, 'log_event', events)
        body = FollowupCreate(customer_id='customer', reason='Discuss samples', request_key='draft-one-123', interested_floor_ids=['first-floor', 'ground-floor'], assignments=[])
        async def fail_after_sibling(query, update):
            if update.get('$setOnInsert', {}).get('floor_id') == 'ground-floor':
                db.followups.after_update = None
                raise RuntimeError('Connection lost after the write')
        db.followups.after_update = fail_after_sibling
        with pytest.raises(RuntimeError):
            await routes.create_followup(body, actor)
        assert len(db.followups.rows) == 2
        created = await routes.create_followup(body, actor)
        replay = await routes.create_followup(body, actor)
        assert replay.id == created.id and len(db.followups.rows) == 2
        assert {row['lead_group_id'] for row in db.followups.rows} == {created.id}
        assert events.await_count == 1
        with pytest.raises(HTTPException) as changed:
            await routes.create_followup(body.model_copy(update={'reason': 'Another request'}), actor)
        assert changed.value.status_code == 409 and len(db.followups.rows) == 2
        different = await routes.create_followup(body, principal('another-owner', floors=('first-floor',)))
        assert different.id != created.id
    asyncio.run(run())


@pytest.mark.parametrize('action', ['add', 'remove'])
def test_foreign_regular_followup_floor_also_requires_its_update_grant(action):
    async def run():
        db = database()
        source = source_row()
        actor = principal('worker', custom=True, floors=('second-floor', 'ground-floor'))
        db.users.rows = [{'id': actor.id, 'floor_ids': actor.floor_ids,
                         'delegation_grants': [grant(actor.id, 'second-floor', 'notebook_walkins')]}]
        if action == 'remove':
            source.update(lead_group_id='shared', interested_floor_ids=['second-floor', 'ground-floor'])
            db.followups.rows.append({**source_row('ground-floor'), 'id': 'sibling', 'lead_group_id': 'shared'})
        db.followups.rows.append(source)
        floors = ['second-floor', 'ground-floor'] if action == 'add' else ['second-floor']
        with pytest.raises(HTTPException) as error:
            await lead_scope.update_interests(db, user=actor, source=source, floor_ids=floors, assignments=[])
        assert error.value.status_code == 403 and db.followups.writes == db.customers.writes == 0
    asyncio.run(run())


def test_assignee_needs_both_view_and_update_even_when_grants_are_separate():
    staff = {'id': 'worker', 'custom_access': True, 'role': 'worker', 'floor_ids': ['third-floor']}
    update = {**grant('worker', 'third-floor', 'notebook_quotations'), 'actions': ['update']}
    view = {**grant('worker', 'third-floor', 'notebook_quotations'), 'actions': ['view']}
    assert not lead_scope.can_assign({**staff, 'delegation_grants': [update]}, 'third-floor', notebook_converted=True)
    assert not lead_scope.can_assign({**staff, 'delegation_grants': [view]}, 'third-floor', notebook_converted=True)
    assert lead_scope.can_assign({**staff, 'delegation_grants': [view, update]}, 'third-floor', notebook_converted=True)


def test_unconfirmed_legacy_won_quotation_does_not_block_preorder_lead(monkeypatch):
    async def run():
        db = database()
        db.customers.rows = [{'id': 'customer', 'floor_id': 'first-floor', 'name': 'Customer', 'phone': '9876543210'}]
        db.quotations.rows = [{'id': 'legacy-won', 'customer_id': 'customer', 'floor_id': 'first-floor', 'status': 'won'}]
        monkeypatch.setattr(routes, 'db', db)
        monkeypatch.setattr(routes, 'log_event', AsyncMock())
        body = FollowupCreate(customer_id='customer', quotation_id='legacy-won', reason='Confirm selection',
                              request_key='unconfirmed-won-draft', interested_floor_ids=['first-floor'], assignments=[])
        row = await routes.create_followup(body, principal(floors=('first-floor',)))
        assert row.status == 'open' and row.quotation_id == 'legacy-won'
        assert db.quotations.rows[0]['status'] == 'won'
    asyncio.run(run())


@pytest.mark.parametrize('floor', ['second-floor', 'third-floor'])
def test_generic_manual_create_directs_notebook_floors_to_canonical_route(monkeypatch, floor):
    db = database()
    monkeypatch.setattr(routes, 'db', db)
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.create_followup(FollowupCreate(customer_id='customer', reason='Discuss'), principal(floors=(floor,))))
    assert error.value.status_code == 422 and 'notebook' in error.value.detail
    assert db.followups.writes == db.customers.writes == 0


def test_synthetic_phone_scope_discovers_existing_notebook_stage_on_its_own_floor():
    async def run():
        db = database()
        db.customers.rows = [{'id': 'kitchen', 'floor_id': 'second-floor', 'phone_normalized': '9876543210'}]
        db.followups.rows = [{'id': 'canonical', 'notebook_key': 'second-floor:kitchen', 'is_converted': True}]
        assert await lead_scope.notebook_stages(db, {'floor_id': 'second-floor', 'customer_phone': '9876543210'}, ['second-floor']) == {'second-floor': True}
    asyncio.run(run())
