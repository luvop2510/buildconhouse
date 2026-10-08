"""Hermetic MFA proofs and lifecycle regressions; never contact a datastore."""
import asyncio
import base64
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import pyotp
import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from starlette.requests import Request
from models import LoginPayload, MFAProofPayload, UserPublic, UserCreate, TeamCreatePayload, CustomerCreate, ChangePasswordPayload
from routes import auth_routes as routes
from services import mfa


def value(doc, key):
    for part in key.split('.'):
        if not isinstance(doc, dict) or part not in doc: return None
        doc = doc[part]
    return doc


def matches(doc, query):
    for key, want in query.items():
        if key == '$or':
            if not any(matches(doc, q) for q in want): return False
            continue
        got=value(doc,key)
        if isinstance(want,dict):
            for op,w in want.items():
                if op=='$ne' and got==w: return False
                if op=='$lt' and (got is None or got>=w): return False
                if op=='$gt' and (got is None or got<=w): return False
                if op=='$exists' and (got is not None)!=w: return False
        elif isinstance(got,list):
            if want not in got: return False
        elif got!=want: return False
    return True


class Collection:
    def __init__(self,doc): self.doc=doc; self.updates=[]
    async def find_one(self,*a,**kw): return deepcopy(self.doc)
    async def update_one(self,q,u):
        self.updates.append((deepcopy(q),deepcopy(u)))
        if not matches(self.doc,q): return SimpleNamespace(matched_count=0,modified_count=0)
        for k,v in u.get('$set',{}).items(): self.doc[k]=v
        for k,v in u.get('$inc',{}).items(): self.doc[k]=self.doc.get(k,0)+v
        for k in u.get('$unset',{}): self.doc.pop(k,None)
        for k,v in u.get('$pull',{}).items(): self.doc[k]=[x for x in self.doc.get(k,[]) if x!=v]
        return SimpleNamespace(matched_count=1,modified_count=1)
    async def update_many(self,q,u): self.updates.append((q,u)); return SimpleNamespace(modified_count=1)


@pytest.fixture
def account(monkeypatch):
    users=Collection({'id':'u1','email':'owner@example.com','full_name':'Owner','role':'owner','active':True,'floor_ids':['first-floor'],'password_hash':'correct-password','mfa_enabled':False,'mfa_version':0})
    sessions=Collection({'id':'s1','user_id':'u1','user_type':'staff','revoked':False})
    fake=SimpleNamespace(users=users,user_sessions=sessions)
    monkeypatch.setattr(routes,'db',fake); monkeypatch.setattr(mfa,'db',fake)
    monkeypatch.setattr(routes,'verify_password',lambda value,hashed:value==hashed)
    reservations=[]
    async def reserve(ip,identifier): reservations.append(identifier)
    async def noop(*a,**kw): pass
    monkeypatch.setattr(routes,'reserve_login_attempt',reserve)
    monkeypatch.setattr(routes,'clear_login_attempts',noop); monkeypatch.setattr(routes,'log_event',noop)
    monkeypatch.setattr(routes,'invalidate_principal_cache',lambda *a:None)
    monkeypatch.setattr(mfa.time,'time',lambda:1700000010)
    req=Request({'type':'http','method':'POST','path':'/api/auth/mfa/confirm','headers':[],'client':('203.0.113.1',123)})
    return users,sessions,req,UserPublic(**users.doc,session_id='s1'),reservations


def proof(code=None,recovery=None,password='correct-password'):
    return MFAProofPayload(current_password=password,mfa_code=code,recovery_code=recovery)


def enable(users):
    secret=pyotp.random_base32(); codes,hashes=mfa.new_recovery_codes()
    users.doc.update(mfa_enabled=True,mfa_version=1,mfa_secret_encrypted=mfa.encrypt_secret(secret,'u1'),mfa_recovery_hashes=hashes)
    return secret,codes


@pytest.mark.parametrize('timestamp,expected',[(59,'287082'),(1111111109,'081804'),(1111111111,'050471'),(1234567890,'005924'),(2000000000,'279037'),(20000000000,'353130')])
def test_rfc6238_sha1_vectors(timestamp,expected):
    secret=base64.b32encode(b'12345678901234567890').decode()
    assert mfa.matching_counter(secret,expected,now=timestamp)==timestamp//30


def test_encrypted_secret_account_binding_and_corruption():
    secret=pyotp.random_base32(); encrypted=mfa.encrypt_secret(secret,'u1')
    assert secret not in encrypted and mfa.decrypt_secret(encrypted,'u1')==secret
    for ciphertext,uid in [(encrypted,'u2'),(encrypted[:-2]+'xx','u1')]:
        with pytest.raises(HTTPException): mfa.decrypt_secret(ciphertext,uid)


@pytest.mark.asyncio
@pytest.mark.parametrize('recovery',[False,True])
async def test_factor_atomic_single_use(account,recovery):
    users,*_=account; secret,codes=enable(users); snapshot=deepcopy(users.doc)
    code=None if recovery else pyotp.TOTP(secret).at(1700000010)
    saved=codes[0] if recovery else None
    outcomes=await asyncio.gather(mfa.consume_factor(snapshot,code,saved),mfa.consume_factor(snapshot,code,saved),return_exceptions=True)
    assert sum(isinstance(x,HTTPException) for x in outcomes)==1
    with pytest.raises(HTTPException): await mfa.consume_factor(users.doc,code,saved)
    assert all(c not in str(users.doc) for c in codes)


@pytest.mark.asyncio
async def test_expired_pending_and_wrong_password_cannot_enable(account):
    users,sessions,req,user,reservations=account
    with pytest.raises(HTTPException): await routes.mfa_enroll(proof(password='wrong'),req,user)
    setup=await routes.mfa_enroll(proof(),req,user)
    assert not users.doc['mfa_enabled'] and 'secret' not in users.doc['mfa_pending']
    users.doc['mfa_pending']['expires_at']=datetime.now(timezone.utc)-timedelta(seconds=1)
    with pytest.raises(HTTPException) as exc: await routes.mfa_confirm(proof(pyotp.TOTP(setup['secret']).at(1700000010)),req,user)
    assert exc.value.status_code==409 and not users.doc['mfa_enabled']


@pytest.mark.asyncio
async def test_confirm_sets_assurance_revokes_other_sessions_and_never_exposes_storage(account):
    users,sessions,req,user,_=account
    setup=await routes.mfa_enroll(proof(),req,user); code=pyotp.TOTP(setup['secret']).at(1700000010)
    result=await routes.mfa_confirm(proof(code),req,user)
    assert len(result['recovery_codes'])==10 and users.doc['mfa_enabled'] and users.doc['mfa_version']==1
    assert sessions.doc['mfa_verified'] and sessions.doc['mfa_version']==1
    assert sessions.updates[0][0]['id']=={'$ne':'s1'}
    assert 'mfa_pending' not in users.doc and all(c not in str(users.doc) for c in result['recovery_codes'])
    assert set(await routes.mfa_status(user))=={'enabled','recovery_codes_remaining'}
    assert not {'mfa_secret_encrypted','mfa_recovery_hashes','mfa_pending'}&set(UserPublic(**users.doc).model_dump())
    with pytest.raises(HTTPException): await mfa.consume_factor(users.doc,code)


@pytest.mark.asyncio
async def test_enrolled_owner_no_session_before_factor(account,monkeypatch):
    users,sessions,req,user,reservations=account; secret,codes=enable(users); issued=[]
    async def create(*a,**kw): issued.append(kw); return 's1'
    monkeypatch.setattr(routes,'create_session',create)
    with pytest.raises(HTTPException) as exc: await routes.staff_login(LoginPayload(email=user.email,password='correct-password'),req)
    assert exc.value.detail=='mfa_required' and not issued
    with pytest.raises(HTTPException): await routes.staff_login(LoginPayload(email=user.email,password='correct-password',mfa_code='bad'),req)
    result=await routes.staff_login(LoginPayload(email=user.email,password='correct-password',recovery_code=codes[0]),req)
    assert result.user.mfa_enabled and issued[0]['login_method']=='password+mfa'
    assert sessions.doc['mfa_verified'] and sessions.doc['mfa_version']==1 and len(reservations)==3


@pytest.mark.asyncio
@pytest.mark.parametrize('operation',[routes.mfa_disable,routes.mfa_recovery])
async def test_changes_require_both_factors_and_invalidate_old_proofs(account,operation):
    users,sessions,req,user,_=account; secret,codes=enable(users); old=list(users.doc['mfa_recovery_hashes'])
    with pytest.raises(HTTPException): await operation(proof(recovery=codes[0],password='wrong'),req,user)
    with pytest.raises(HTTPException): await operation(proof(),req,user)
    result=await operation(proof(recovery=codes[0]),req,user)
    assert users.doc['mfa_version']==2 and sessions.doc['mfa_version']==2
    if operation==routes.mfa_disable: assert not result['enabled'] and 'mfa_secret_encrypted' not in users.doc
    else:
        assert len(result['recovery_codes'])==10 and not set(old)&set(users.doc['mfa_recovery_hashes'])
        with pytest.raises(HTTPException): await mfa.consume_factor(users.doc,None,codes[1])


@pytest.mark.parametrize('model,payload,field',[(UserCreate,{'email':'p@example.com','full_name':'P','role':'sales'},'password'),(TeamCreatePayload,{'email':'p@example.com','full_name':'P','role':'sales','floor_ids':['first-floor']},'password'),(CustomerCreate,{'name':'Customer'},'password'),(ChangePasswordPayload,{'current_password':'correct-password'},'new_password')])
def test_new_password_utf8_limit(model,payload,field):
    with pytest.raises(ValidationError): model(**payload,**{field:'😀'*19})
    model(**payload,**{field:'😀'*18})

@pytest.mark.asyncio
@pytest.mark.parametrize('customer',[False,True])
async def test_published_default_never_reaches_password_lookup(account,monkeypatch,customer):
    from bootstrap import LEGACY_DEMO_PASSWORD
    from models import CustomerLoginPayload
    users,sessions,req,user,reservations=account
    async def forbidden(*a,**kw): raise AssertionError('Default credential reached database')
    monkeypatch.setattr(users,'find_one',forbidden)
    body=(CustomerLoginPayload if customer else LoginPayload)(email=user.email,password=LEGACY_DEMO_PASSWORD)
    with pytest.raises(HTTPException) as exc:
        await (routes.customer_login if customer else routes.staff_login)(body,req)
    assert exc.value.status_code==401 and exc.value.detail=='Invalid email or password'
    assert len(reservations)==1


def test_new_password_rejects_published_default():
    from bootstrap import LEGACY_DEMO_PASSWORD
    with pytest.raises(ValidationError):
        TeamCreatePayload(email='p@example.com',full_name='P',role='owner',password=LEGACY_DEMO_PASSWORD)


@pytest.mark.asyncio
async def test_stale_factor_version_and_revoked_current_session_never_revived(account):
    users,sessions,req,user,_=account
    secret,codes=enable(users); stale=deepcopy(users.doc)
    users.doc['mfa_version']=2
    with pytest.raises(HTTPException): await mfa.consume_factor(stale,None,codes[0])
    sessions.doc['revoked']=True
    await routes._mfa_sessions(user,2,True)
    assert sessions.doc['revoked'] and 'mfa_verified' not in sessions.doc

@pytest.mark.parametrize('bad_key',['not-a-key',base64.urlsafe_b64encode(b'x'*31).decode(),base64.urlsafe_b64encode(b'x'*33).decode(),'😀'*44])
def test_invalid_dedicated_encryption_key_fails_without_disclosing_key(bad_key):
    from settings import ConfigurationError, load_settings
    env={'MONGO_URL':'mongodb://127.0.0.1:27017','DB_NAME':'mfa_key_unit','JWT_SECRET':'x'*32,'SUPABASE_URL':'https://unit.supabase.co','SUPABASE_SERVICE_ROLE_KEY':'unit-key','SUPABASE_ANON_KEY':'unit-anon','SUPABASE_PUBLIC_BUCKET':'forge-products','SUPABASE_PRIVATE_BUCKET':'forge-private','MFA_ENCRYPTION_KEY':bad_key}
    with pytest.raises(ConfigurationError) as exc: load_settings(env,load_local_fallback=False)
    assert 'MFA_ENCRYPTION_KEY' in str(exc.value) and bad_key not in str(exc.value)


def test_dedicated_encryption_key_survives_jwt_rotation(monkeypatch):
    from cryptography.fernet import Fernet
    from dataclasses import replace
    configured=replace(mfa.settings,mfa_encryption_key=Fernet.generate_key().decode())
    monkeypatch.setattr(mfa,'settings',configured)
    secret=pyotp.random_base32(); encrypted=mfa.encrypt_secret(secret,'u1')
    monkeypatch.setattr(mfa,'settings',replace(configured,jwt_secret='different-jwt-signing-secret-32bytes'))
    assert mfa.decrypt_secret(encrypted,'u1')==secret


def test_fallback_to_dedicated_key_requires_migration(monkeypatch):
    from cryptography.fernet import Fernet
    from dataclasses import replace
    configured=replace(mfa.settings,mfa_encryption_key=None)
    monkeypatch.setattr(mfa,'settings',configured)
    encrypted=mfa.encrypt_secret(pyotp.random_base32(),'u1')
    monkeypatch.setattr(mfa,'settings',replace(configured,mfa_encryption_key=Fernet.generate_key().decode()))
    with pytest.raises(HTTPException) as exc: mfa.decrypt_secret(encrypted,'u1')
    assert exc.value.status_code==503
