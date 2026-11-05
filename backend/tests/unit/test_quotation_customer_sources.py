import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from fastapi import HTTPException
from routes import quotation_customer_sources as routes
from models import UserPublic

def user(): return UserPublic(id="owner",email="owner@example.test",full_name="Owner",role="owner")
def test_contact_whitelist():
    row={"id":"lead","floor_id":"first-floor","customer_name":"Person","customer_phone":"123","address":"Road","notes":"private","password_hash":"secret"}
    result=routes.contact("walkin",row)
    assert result['name']=='Person' and result['phone']=='123' and result['address']=='Road'
    assert 'notes' not in result and 'password_hash' not in result

def test_reuse_denied_source_does_not_write(monkeypatch):
    monkeypatch.setattr(routes,'authorize_staff_resource',AsyncMock())
    monkeypatch.setattr(routes,'scopes',AsyncMock(return_value=[('walkin','ground-floor')]))
    write=AsyncMock()
    find=AsyncMock(return_value=None)
    monkeypatch.setattr(routes,'db',SimpleNamespace(walkins=SimpleNamespace(find_one=find),customers=SimpleNamespace(update_one=write)))
    with pytest.raises(HTTPException) as err: asyncio.run(routes.reuse_source(routes.Reuse(source_kind='walkin',source_id='foreign'),user()))
    assert err.value.status_code==404
    assert find.call_args.args[0]['floor_id']=={'$in':['ground-floor']}
    write.assert_not_awaited()

def test_reuse_existing_ground_identity_without_overwriting(monkeypatch):
    monkeypatch.setattr(routes,'authorize_staff_resource',AsyncMock())
    monkeypatch.setattr(routes,'scopes',AsyncMock(return_value=[('followup','first-floor')]))
    target={'id':'ground-person','floor_id':'ground-floor','name':'Current','phone':'9876543210','address':'Current address'}
    write=AsyncMock()
    monkeypatch.setattr(routes,'db',SimpleNamespace(followups=SimpleNamespace(find_one=AsyncMock(return_value={'id':'lead','floor_id':'first-floor','customer_name':'Old','customer_phone':'+91 98765 43210','reference_source':'Architect','referrer_id':'ref-1','referrer_name':'Architect A','referrer_type':'architect'})),customers=SimpleNamespace(find_one=AsyncMock(return_value=target),update_one=write)))
    result=asyncio.run(routes.reuse_source(routes.Reuse(source_kind='followup',source_id='lead'),user()))
    assert result['customer'].id=='ground-person' and result['customer'].address=='Current address'
    assert not result['created'];write.assert_not_awaited()
    assert result['source']['reference_source']=='Architect'
    assert result['source']['referrer_id']=='ref-1' and result['source']['referrer_name']=='Architect A'

def test_search_literal_and_bounded_contact_reads(monkeypatch):
    monkeypatch.setattr(routes,'scopes',AsyncMock(return_value=[('walkin','first-floor')]))
    calls=[]
    class Cursor:
        def sort(self,*args):return self
        def limit(self,n):assert n==1001;return self
        async def to_list(self,n):return [{'id':'lead','floor_id':'first-floor','customer_name':'A.*','customer_phone':'123'}]
    def find(query,projection):calls.append(query);assert 'notes' not in projection;return Cursor()
    monkeypatch.setattr(routes,'db',SimpleNamespace(walkins=SimpleNamespace(find=find)))
    result=asyncio.run(routes.search_sources('A.*',0,20,user()))
    assert result['items'][0]['name']=='A.*'
    assert calls[0]['$or'][0]['customer_name']['$regex']==r'A\.\*'
    assert calls[0]['floor_id']=={'$in':['first-floor']}

def test_owner_search_scopes_include_all_floors_and_source_kinds(monkeypatch):
    class Cursor:
        async def to_list(self,n):return [{'id':f} for f in ['ground-floor','first-floor','second-floor','third-floor']]
    monkeypatch.setattr(routes,'db',SimpleNamespace(floors=SimpleNamespace(find=lambda *args:Cursor())))
    check=AsyncMock();monkeypatch.setattr(routes,'authorize_staff_resource',check)
    allowed=asyncio.run(routes.scopes(user()))
    assert len(allowed)==12
    assert ('customer','third-floor') in allowed and ('walkin','second-floor') in allowed and ('followup','first-floor') in allowed

def test_foreign_source_creates_stable_ground_profile_without_changing_source(monkeypatch):
    monkeypatch.setattr(routes,'authorize_staff_resource',AsyncMock())
    monkeypatch.setattr(routes,'scopes',AsyncMock(return_value=[('walkin','first-floor')]))
    source={'id':'lead','floor_id':'first-floor','customer_name':'Person','customer_phone':'9876543210','address':'Saved address'}
    saved={}
    class Customers:
        async def find_one(self,query,*args):return saved.get(query.get('id'))
        async def update_one(self,query,update,**kw):
            assert kw['upsert'] and query['floor_id']=='ground-floor'
            saved.setdefault(query['id'],update['$setOnInsert'])
    monkeypatch.setattr(routes,'db',SimpleNamespace(walkins=SimpleNamespace(find_one=AsyncMock(return_value=source)),customers=Customers()))
    body=routes.Reuse(source_kind='walkin',source_id='lead')
    first=asyncio.run(routes.reuse_source(body,user()));again=asyncio.run(routes.reuse_source(body,user()))
    assert first['customer'].id==again['customer'].id
    assert len(saved)==1 and first['customer'].address=='Saved address'
    assert source['floor_id']=='first-floor' and source['id']=='lead'

def test_search_deduplicates_across_sources_and_pages(monkeypatch):
    monkeypatch.setattr(routes, 'scopes', AsyncMock(return_value=[
        (kind, floor) for kind in ('customer', 'followup', 'walkin')
        for floor in ('ground-floor', 'first-floor')
    ]))
    records = {
        'customers': [
            {'id': 'a', 'floor_id': 'ground-floor', 'name': 'Raj', 'phone': '9876543210'},
            {'id': 'b', 'floor_id': 'first-floor', 'name': 'Raj', 'phone': '+91 98765 43210'},
            {'id': 'c', 'floor_id': 'ground-floor', 'name': 'Another', 'phone': '9999999999'},
        ],
        'followups': [
            {'id': 'f', 'floor_id': 'ground-floor', 'customer_id': 'a', 'customer_name': 'Raj', 'customer_phone': '9876543210'},
            {'id': 'g', 'floor_id': 'ground-floor', 'customer_name': 'Third', 'customer_phone': '8888888888'},
        ],
        'walkins': [{'id': 'w', 'floor_id': 'first-floor', 'customer_name': 'Raj', 'customer_phone': '9876543210'}],
    }
    class Cursor:
        def __init__(self, rows): self.rows = rows
        def sort(self, *args): return self
        def limit(self, n): self.n = n; return self
        async def to_list(self, n): return self.rows[:n]
    class Collection:
        def __init__(self, rows): self.rows = rows
        def find(self, query, projection):
            after = query.get('id', {}).get('$gt', '')
            return Cursor([row for row in self.rows if row['id'] > after])
    monkeypatch.setattr(routes, 'db', SimpleNamespace(**{key: Collection(value) for key, value in records.items()}))
    first = asyncio.run(routes.search_sources('', 0, 1, user()))
    second = asyncio.run(routes.search_sources('', 1, 1, user()))
    third = asyncio.run(routes.search_sources('', 2, 1, user()))
    assert [page['items'][0]['name'] for page in (first, second, third)] == ['Raj', 'Another', 'Third']
    assert first['has_more'] and second['has_more'] and not third['has_more']


def test_identity_does_not_merge_namesakes_without_phone_or_link():
    assert routes.identity_keys({'source_kind': 'walkin', 'source_id': 'x', 'name': 'Raj', 'phone': ''}) == set()


def test_ground_followup_reuse_returns_assignee_without_overwriting_customer(monkeypatch):
    monkeypatch.setattr(routes, 'authorize_staff_resource', AsyncMock())
    monkeypatch.setattr(routes, 'scopes', AsyncMock(return_value=[('followup', 'ground-floor')]))
    source = {'id': 'follow', 'floor_id': 'ground-floor', 'customer_id': 'customer', 'customer_name': 'Person', 'customer_phone': '9876543210', 'assigned_to_name': 'Staff member'}
    customer = {'id': 'customer', 'floor_id': 'ground-floor', 'name': 'Person', 'phone': '9876543210'}
    write = AsyncMock()
    monkeypatch.setattr(routes, 'db', SimpleNamespace(followups=SimpleNamespace(find_one=AsyncMock(return_value=source)), customers=SimpleNamespace(find_one=AsyncMock(return_value=customer), update_one=write)))
    result = asyncio.run(routes.reuse_source(routes.Reuse(source_kind='followup', source_id='follow'), user()))
    assert result['source']['assigned_to_name'] == 'Staff member'
    write.assert_not_awaited()


def test_ground_customer_wins_and_late_bridge_joins_existing_groups(monkeypatch):
    monkeypatch.setattr(routes, 'scopes', AsyncMock(return_value=[('customer', 'ground-floor'), ('customer', 'first-floor'), ('followup', 'ground-floor')]))
    records = {
        'customers': [
            {'id': 'a', 'floor_id': 'first-floor', 'name': 'Foreign', 'phone': '9876543210'},
            {'id': 'b', 'floor_id': 'ground-floor', 'name': 'Ground', 'phone': '9876543210'},
            {'id': 'c', 'floor_id': 'ground-floor', 'name': 'Other phone', 'phone': '9999999999'},
        ],
        'followups': [
            {'id': 'f', 'floor_id': 'ground-floor', 'customer_id': 'c', 'customer_name': 'Bridge', 'customer_phone': '9876543210'},
        ],
    }
    class Cursor:
        def __init__(self, rows): self.rows = rows
        def sort(self, *args): return self
        def limit(self, n): return self
        async def to_list(self, n): return self.rows[:n]
    monkeypatch.setattr(routes, 'db', SimpleNamespace(**{key: SimpleNamespace(find=lambda query, projection, rows=value: Cursor(rows)) for key, value in records.items()}))
    result = asyncio.run(routes.search_sources('', 0, 20, user()))
    assert [row['name'] for row in result['items']] == ['Ground']
    assert not result['has_more']


def test_search_refuses_incomplete_identity_groups(monkeypatch):
    monkeypatch.setattr(routes, 'scopes', AsyncMock(return_value=[('customer', 'ground-floor')]))
    class Cursor:
        def sort(self, *args): return self
        def limit(self, n): assert n == 1001; return self
        async def to_list(self, n): return [{'id': str(i), 'floor_id': 'ground-floor', 'name': 'Person'} for i in range(n)]
    monkeypatch.setattr(routes, 'db', SimpleNamespace(customers=SimpleNamespace(find=lambda *args: Cursor())))
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.search_sources('', 0, 20, user()))
    assert error.value.status_code == 422 and 'Refine' in error.value.detail
