"""Owner workload never substitutes assignee status for recorded actor effort."""
import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI, HTTPException, Response
from fastapi.testclient import TestClient

from auth import get_current_user
from models import UserPublic
from routes import sales_analytics_routes as routes
from services.analytics.owner_operations import owner_operations, summarize_operations
from services.analytics.unified import Query
from services.analytics.filters import FloorAccessError

NOW = datetime(2026, 10, 29, 10, tzinfo=timezone.utc)


def followup(identity, **changes):
    return {'id': identity, 'floor_id': 'ground-floor', 'status': 'open', 'due_at': '2026-10-28T12:00:00+00:00',
            'assigned_to': 'worker-a', 'assigned_to_name': 'Worker A', **changes}


def event(identity, **changes):
    return {'id': identity, 'entity_id': 'one', 'actor_id': 'worker-b', 'created_at': '2026-10-28T12:00:00+00:00',
            'event_type': 'followup.contacted', 'payload': {}, **changes}


def test_current_counts_include_snoozes_and_separate_dismissed_with_india_day_boundary():
    rows = [followup('one'), followup('today', due_at='2026-10-28T19:00:00+00:00'),
            followup('snoozed', status='snoozed', snoozed_until='2026-10-30T00:00:00+00:00'),
            followup('awake', status='snoozed', snoozed_until='2026-10-28T00:00:00+00:00'),
            followup('done', status='done'), followup('dismissed', status='dismissed'),
            followup('undated', due_at=None, assigned_to=None), followup('owner', assigned_to='owner')]
    result = summarize_operations(rows, [], [{'id': 'owner', 'role': 'owner'}], NOW)
    assert {key: result[key] for key in result if key != 'team'} == {
        'open_followups': 6, 'overdue_followups': 3, 'completed_followups': 1,
        'dismissed_followups': 1, 'unassigned_followups': 2,
    }
    assert result['team'][0]['open'] == 4 and result['team'][0]['overdue'] == 2
    assert result['team'][0]['completed'] == 1
    assert not any(row['id'] == 'owner' for row in result['team'])


def test_contacts_count_actual_actor_dedupe_calls_and_exclude_out_of_scope_or_old_events():
    rows = [followup('one', assignments=[{'floor_id': 'ground-floor', 'user_id': 'worker-a', 'user_name': 'A'},
                                       {'floor_id': 'first-floor', 'user_id': 'foreign-worker', 'user_name': 'Foreign'}])]
    events = [event('contact', payload={'attempt_id': 'attempt', 'channel': 'call'}),
              event('call', event_type='followup.call_logged', payload={'attempt_id': 'attempt'}),
              event('second'), event('foreign', entity_id='foreign'), event('old', created_at='2026-08-28T12:00:00+00:00'),
              event('future', created_at='2026-10-30T12:00:00+00:00'), event('owner-event', actor_id='owner')]
    result = summarize_operations(rows, events, [{'id': 'owner', 'role': 'owner'}, {'id': 'worker-b', 'full_name': 'Actual actor'}], NOW)
    workers = {worker['id']: worker for worker in result['team']}
    assert workers['worker-a']['open'] == 1 and workers['worker-a']['contacts'] == 0
    assert workers['worker-b']['contacts'] == 2 and workers['worker-b']['calls'] == 1 and workers['worker-b']['open'] == 0
    assert workers['worker-b']['name'] == 'Actual actor'
    assert set(workers) == {'worker-a', 'worker-b'}


def test_data_queries_keep_exact_floor_and_only_minimal_fields():
    captures = {}
    class Cursor:
        def __init__(self, rows): self.rows = rows
        async def to_list(self, length): return self.rows
    class Collection:
        def __init__(self, name, rows): self.name, self.rows = name, rows
        def find(self, query, fields):
            captures[self.name] = (query, fields)
            return Cursor(self.rows)
    class DB:
        followups = Collection('followups', [followup('one')])
        activity_events = Collection('events', [event('one')])
        users = Collection('users', [{'id': 'worker-a', 'full_name': 'A'}])
    result = asyncio.run(owner_operations(DB(), Query(floor_id='ground-floor', preset='all', customer_id='irrelevant-sales-filter'), ['ground-floor'], NOW))
    assert result['floor_ids'] == ['ground-floor'] and result['open_followups'] == 1
    assert captures['followups'][0]['floor_id'] == captures['events'][0]['floor_id'] == {'$in': ['ground-floor']}
    assert captures['followups'][0]['is_deleted'] == {'$ne': True}
    assert 'payment' in captures['followups'][0]['category']['$nin']
    assert captures['events'][0]['entity_id'] == {'$in': ['one']}
    assert captures['users'][0] == {'id': {'$in': ['worker-a', 'worker-b']}}
    assert not any(key in captures['followups'][1] for key in ('customer_name', 'customer_phone', 'phone'))
    assert not any(key in captures['users'][1] for key in ('password', 'email', 'phone'))


def test_unauthorized_floor_fails_before_reads_and_caps_fail_without_partial_counts():
    class ForbiddenDB:
        def __getattr__(self, name): raise AssertionError('Read before authorization')
    with pytest.raises(FloorAccessError):
        asyncio.run(owner_operations(ForbiddenDB(), Query(floor_id='third-floor'), ['ground-floor'], NOW))
    class Cursor:
        async def to_list(self, length): return [{}] * length
    class Collection:
        def find(self, query, fields): return Cursor()
    class DB:
        followups = Collection()
    with pytest.raises(HTTPException) as failure:
        asyncio.run(owner_operations(DB(), Query(floor_id='ground-floor'), ['ground-floor'], NOW))
    assert failure.value.status_code == 422


def test_endpoint_is_owner_only_and_read_only(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router, prefix='/api')
    current = {'role': 'admin'}
    async def principal():
        return UserPublic(id='principal', email='test@example.test', full_name='Principal', role=current['role'], floor_ids=['ground-floor'])
    app.dependency_overrides[get_current_user] = principal
    class Cursor:
        async def to_list(self, length): return []
    class Collection:
        def find(self, query, fields): return Cursor()
    class DB:
        followups = Collection()
    monkeypatch.setattr(routes, 'db', DB())
    with TestClient(app) as client:
        assert client.get('/api/sales-analytics/owner-operations').status_code == 403
        current['role'] = 'owner'
        response = client.get('/api/sales-analytics/owner-operations?floor_id=ground-floor')
        assert response.status_code == 200 and response.headers['cache-control'] == 'no-store'
        assert response.json()['floor_ids'] == ['ground-floor'] and response.json()['team'] == []
        assert client.post('/api/sales-analytics/owner-operations').status_code == 405


def test_workflow_snapshot_reuses_kitchen_rules_and_pins_authorized_floor(monkeypatch):
    from services.analytics.owner_operations import workflow_snapshot
    from services.kitchen_projects import KitchenProjectService
    calls = []
    async def dashboard(self, user):
        calls.append(user.active_floor_id)
        return {'total_projects': 7, 'active_projects': 4, 'stage_counts': {'lead': 2, 'production': 2, 'completed': 2},
                'on_hold_projects': 1, 'completion_overdue_projects': 1,
                'workload': [{'assignee_id': 'worker', 'assignee_name': 'Worker', 'project_count': 3}]}
    monkeypatch.setattr(KitchenProjectService, 'dashboard', dashboard)
    user = UserPublic(id='owner', email='owner@example.test', full_name='Owner', role='owner', active_floor_id='ground-floor')
    assert asyncio.run(workflow_snapshot(None, ['ground-floor'], user)) == [] and calls == []
    result = asyncio.run(workflow_snapshot(None, ['second-floor'], user))
    assert calls == ['second-floor'] and user.active_floor_id == 'ground-floor'
    assert result[0]['active'] == 4 and result[0]['completed'] == 2 and result[0]['overdue'] == 1
    assert len(result[0]['stages']) == 9 and result[0]['workload'][0]['count'] == 3


def test_furniture_workflow_reports_ledger_state_without_inventing_fulfillment():
    from services.analytics.owner_operations import workflow_snapshot
    captures = []
    class Cursor:
        async def to_list(self, length): return [{'_id': 'final', 'count': 5}, {'_id': 'draft', 'count': 2}]
    class Collection:
        def aggregate(self, pipeline, **kwargs):
            captures.append((pipeline, kwargs))
            return Cursor()
    class DB:
        furniture_quotations = Collection()
    result = asyncio.run(workflow_snapshot(DB(), ['third-floor'], None))
    assert result[0]['total'] == 7 and result[0]['active'] is None and result[0]['completed'] is None
    assert result[0]['stages'] == [{'id': 'draft', 'name': 'Draft', 'count': 2}, {'id': 'final', 'name': 'Final', 'count': 5}]
    assert captures[0][0][0]['$match'] == {'floor_id': 'third-floor', 'is_deleted': {'$ne': True}}
    assert captures[0][1]['maxTimeMS'] == 5000


def test_currency_route_filter_validates_and_does_not_broaden_floor(monkeypatch):
    from services.analytics import unified as sales
    app = FastAPI()
    app.include_router(routes.router, prefix='/api')
    async def principal():
        return UserPublic(id='admin', email='admin@example.test', full_name='Admin', role='admin', floor_ids=['ground-floor'])
    app.dependency_overrides[get_current_user] = principal
    catalog = sales.normalize('catalog', {'id': 'inr', 'floor_id': 'ground-floor', 'status': 'ordered',
        'ordered_at': '2026-10-01T10:00:00+00:00', 'grand_total': 100}, {}, {}, [])
    captures = []
    async def load_model(db, q, floors):
        captures.append((q.currency, floors))
        return [catalog]
    monkeypatch.setattr(routes, 'load_model', load_model)
    with TestClient(app) as client:
        assert client.get('/api/sales-analytics/records?currency=USD').status_code == 422
        assert not captures
        assert client.get('/api/sales-analytics/records?floor_id=third-floor&currency=RNB').status_code == 403
        assert not captures
        response = client.get('/api/sales-analytics/records?floor_id=ground-floor&currency=RNB&preset=all')
        assert response.status_code == 200 and response.json()['items'] == []
        assert captures == [('RNB', ['ground-floor'])]
        response = client.get('/api/sales-analytics/records?floor_id=ground-floor&currency=INR&preset=all')
        assert response.json()['items'][0]['id'] == 'inr'
