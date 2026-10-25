"""Shared contacts remain visible while executive financial reads stay scoped."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from models import UserPublic
from routes import executive_analytics_routes as routes


def _matches(document, query):
    for key, value in query.items():
        if key == '$or':
            if not any(_matches(document, clause) for clause in value): return False
        elif isinstance(value, dict) and '$in' in value:
            if document.get(key) not in value['$in']: return False
        elif document.get(key) != value: return False
    return True


class Collection:
    def __init__(self, documents=()): self.documents = list(documents)
    def find(self, query, *_args):
        return Cursor([row for row in self.documents if _matches(row, query)])
    async def find_one(self, query, *_args):
        return next((row for row in self.documents if _matches(row, query)), None)


class Cursor:
    def __init__(self, rows): self.rows = rows
    def sort(self, *_args): return self
    async def to_list(self, _limit): return self.rows


def test_executive_filters_and_profile_resolve_shared_reference_across_floors(monkeypatch):
    shared = {'id': 'shared', 'name': 'Shared architect', 'floor_id': 'first-floor', 'shared_across_floors': True}
    private = {'id': 'private', 'name': 'Private architect', 'floor_id': 'first-floor'}
    database = SimpleNamespace(referrers=Collection([shared, private]), floors=Collection(), brands=Collection(), users=Collection())
    monkeypatch.setattr(routes, 'db', database)
    worker = UserPublic(id='manager', full_name='Manager', role='admin', floor_ids=['ground-floor'], active_floor_id='ground-floor')
    seen = []
    async def dashboard(**kwargs):
        seen.append(kwargs)
        return {'revenue': 0}
    monkeypatch.setattr(routes, 'dashboard', dashboard)
    filters = asyncio.run(routes.filters(floor_id='ground-floor', user=worker))
    assert filters['referrers'] == [shared]
    profile = asyncio.run(routes.referrer_detail('shared', floor_id='ground-floor', user=worker))
    assert profile['referrer']['id'] == 'shared'
    assert seen[0]['floor_id'] == 'ground-floor' and seen[0]['referrer_id'] == 'shared'
    with pytest.raises(HTTPException) as hidden:
        asyncio.run(routes.referrer_detail('private', floor_id='ground-floor', user=worker))
    assert hidden.value.status_code == 404
    assert len(seen) == 1


def test_directory_client_history_opens_shared_identity_on_another_floor(monkeypatch):
    from routes import sales_data_routes as sales
    shared = {'id': 'shared', 'name': 'Shared architect', 'type': 'architect', 'floor_id': 'first-floor', 'shared_across_floors': True}
    database = SimpleNamespace(referrers=Collection([shared]))
    monkeypatch.setattr(sales, 'db', database)
    scopes = []
    async def confirmed(floor_ids, *_args):
        assert floor_ids == ['ground-floor']
        return []
    async def kitchen(_database, query):
        scopes.append(query)
        return []
    monkeypatch.setattr(sales, '_confirmed_quotations', confirmed)
    monkeypatch.setattr(sales, 'kitchen_referral_records', kitchen)
    worker = UserPublic(id='admin', full_name='Admin', role='admin', floor_ids=['ground-floor'])
    result = asyncio.run(sales.referrer_detail('shared', floor_id='ground-floor', date_from=None, date_to=None, granularity='month', user=worker))
    assert result['referrer']['id'] == 'shared' and result['total_revenue'] == 0
    assert all(query['floor_id'] == {'$in': ['ground-floor']} for query in scopes)
