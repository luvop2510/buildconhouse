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
    monkeypatch.setattr(routes,'db',SimpleNamespace(followups=SimpleNamespace(find_one=AsyncMock(return_value={'id':'lead','floor_id':'first-floor','customer_name':'Old','customer_phone':'+91 98765 43210'})),customers=SimpleNamespace(find_one=AsyncMock(return_value=target),update_one=write)))
    result=asyncio.run(routes.reuse_source(routes.Reuse(source_kind='followup',source_id='lead'),user()))
    assert result['customer'].id=='ground-person' and result['customer'].address=='Current address'
    assert not result['created'];write.assert_not_awaited()

def test_search_literal_and_bounded_contact_reads(monkeypatch):
    monkeypatch.setattr(routes,'scopes',AsyncMock(return_value=[('walkin','first-floor')]))
    calls=[]
    class Cursor:
        def sort(self,*args):return self
        def limit(self,n):assert n==21;return self
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
