"""Referrer directory (list + create) — the quotation builder's picker and
the Sales Data dashboard both depend on this being correct."""
from __future__ import annotations

import asyncio

from models import ReferrerCreate, ReferrerUpdate, UserPublic
from routes import referrer_routes


def _user(role="sales"):
    return UserPublic(id="user-1", email="s@forge.app", full_name="Sales", role=role, floor_ids=["first-floor"], active_floor_id="first-floor")


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    def sort(self, *_a, **_kw):
        return self

    async def to_list(self, _n):
        return self._docs


class _Collection:
    def __init__(self, docs):
        self._docs = docs
        self.inserted = None
        self.updated_selector = None

    def find(self, query, *_a, **_kw):
        def matches(doc):
            def matches_query(doc, clauses):
                for key, value in clauses.items():
                    if key == '$or':
                        if not any(matches_query(doc, clause) for clause in value): return False
                    elif key == '$and':
                        if not all(matches_query(doc, clause) for clause in value): return False
                    elif isinstance(value, dict) and '$in' in value:
                        if doc.get(key) not in value['$in']: return False
                    elif doc.get(key) != value: return False
                return True
            return matches_query(doc, query)
        matched = [d for d in self._docs if matches(d)]
        return _Cursor(matched)

    async def insert_one(self, doc):
        self.inserted = doc

    async def update_one(self, selector, _update):
        self.updated_selector = selector
        from types import SimpleNamespace
        doc = await self.find_one(selector)
        if doc: doc.update(_update.get('$set', {}))
        return SimpleNamespace(matched_count=int(doc is not None))

    async def find_one(self, selector, *_a, **_kw):
        docs = await self.find(selector).to_list(1)
        return docs[0] if docs else None


class _FakeDb:
    def __init__(self, docs):
        self.referrers = _Collection(docs)


def test_list_referrers_filters_by_type(monkeypatch):
    fake_db = _FakeDb([
        {"id": "r1", "name": "Rakesh Sharma", "type": "architect", "floor_id": "first-floor", "normalized_name": "rakesh sharma", "created_at": "t", "updated_at": "t", "created_by": "u"},
        {"id": "r2", "name": "Nikita Shah", "type": "interior_designer", "floor_id": "first-floor", "normalized_name": "nikita shah", "created_at": "t", "updated_at": "t", "created_by": "u"},
    ])
    monkeypatch.setattr(referrer_routes, "db", fake_db)

    result = asyncio.run(referrer_routes.list_referrers(type="architect", user=_user()))

    assert [r.id for r in result] == ["r1"]


def test_list_referrers_no_filter_returns_all(monkeypatch):
    fake_db = _FakeDb([
        {"id": "r1", "name": "Rakesh Sharma", "type": "architect", "floor_id": "first-floor", "normalized_name": "rakesh sharma", "created_at": "t", "updated_at": "t", "created_by": "u"},
        {"id": "r2", "name": "Nikita Shah", "type": "interior_designer", "floor_id": "first-floor", "normalized_name": "nikita shah", "created_at": "t", "updated_at": "t", "created_by": "u"},
    ])
    monkeypatch.setattr(referrer_routes, "db", fake_db)

    result = asyncio.run(referrer_routes.list_referrers(type=None, user=_user()))

    assert len(result) == 2


def test_create_referrer_stamps_created_by(monkeypatch):
    fake_db = _FakeDb([])
    monkeypatch.setattr(referrer_routes, "db", fake_db)

    body = ReferrerCreate(name="Studio Verve", type="interior_designer", phone="9909955755")
    result = asyncio.run(referrer_routes.create_referrer(body, user=_user()))

    assert result.created_by == "user-1"
    assert result.name == "Studio Verve"
    assert fake_db.referrers.inserted["name"] == "Studio Verve"


def test_create_referrer_with_new_name_creates_a_new_record(monkeypatch):
    fake_db = _FakeDb([
        {"id": "r1", "name": "Rakesh Sharma", "type": "architect", "floor_id": "first-floor", "normalized_name": "rakesh sharma", "created_at": "t", "updated_at": "t", "created_by": "u"},
    ])
    monkeypatch.setattr(referrer_routes, "db", fake_db)

    body = ReferrerCreate(name="Nikita Shah", type="architect", phone="9909955755")
    result = asyncio.run(referrer_routes.create_referrer(body, user=_user()))

    assert result.id != "r1"
    assert result.name == "Nikita Shah"
    assert fake_db.referrers.inserted is not None
    assert fake_db.referrers.inserted["name"] == "Nikita Shah"


def test_create_referrer_same_name_and_type_returns_existing_record_not_a_duplicate(monkeypatch):
    fake_db = _FakeDb([
        {"id": "r1", "name": "Rakesh Sharma", "type": "architect", "floor_id": "first-floor", "normalized_name": "rakesh sharma", "created_at": "t", "updated_at": "t", "created_by": "u"},
    ])
    monkeypatch.setattr(referrer_routes, "db", fake_db)

    # Different case, same underlying name, same type.
    body = ReferrerCreate(name="rakesh sharma", type="architect", phone="9909955755")
    result = asyncio.run(referrer_routes.create_referrer(body, user=_user()))

    assert result.id == "r1"
    assert fake_db.referrers.inserted is None  # nothing new was inserted


def test_create_referrer_same_name_different_type_creates_a_separate_record(monkeypatch):
    fake_db = _FakeDb([
        {"id": "r1", "name": "Rakesh Sharma", "type": "architect", "created_at": "t", "updated_at": "t", "created_by": "u"},
    ])
    monkeypatch.setattr(referrer_routes, "db", fake_db)

    body = ReferrerCreate(name="Rakesh Sharma", type="interior_designer", phone="9909955755")
    result = asyncio.run(referrer_routes.create_referrer(body, user=_user()))

    assert result.id != "r1"
    assert result.type == "interior_designer"
    assert fake_db.referrers.inserted is not None


def test_archive_referrer_write_stays_on_the_authorized_floor(monkeypatch):
    doc = {
        "id": "r1", "name": "Rakesh Sharma", "type": "architect", "floor_id": "first-floor",
        "normalized_name": "rakesh sharma", "created_at": "t", "updated_at": "t", "created_by": "u",
    }
    fake_db = _FakeDb([doc])
    monkeypatch.setattr(referrer_routes, "db", fake_db)

    async def authorized(*_args, **_kwargs):
        return doc

    monkeypatch.setattr(referrer_routes, "get_floor_scoped_or_404", authorized)
    asyncio.run(referrer_routes.archive_referrer("r1", active=False, user=_user()))

    assert fake_db.referrers.updated_selector == {"id": "r1", "floor_id": "first-floor"}


def test_shared_reference_is_reused_across_floors_without_exposing_private_entries(monkeypatch):
    shared = {'id': 'shared', 'name': 'One studio', 'type': 'architect', 'floor_id': 'second-floor', 'normalized_name': 'one studio', 'shared_across_floors': True, 'created_by': 'u'}
    private = {**shared, 'id': 'private', 'name': 'Private studio', 'shared_across_floors': False}
    fake_db = _FakeDb([shared, private])
    monkeypatch.setattr(referrer_routes, 'db', fake_db)
    result = asyncio.run(referrer_routes.list_referrers(type='architect', include_inactive=False, user=_user()))
    assert [row.id for row in result] == ['shared']
    existing = asyncio.run(referrer_routes.create_referrer(ReferrerCreate(name='ONE STUDIO', type='architect', phone="9909955755"), user=_user()))
    assert existing.id == 'shared'
    assert fake_db.referrers.inserted is None


def test_new_reference_is_shared_with_contact_details(monkeypatch):
    fake_db = _FakeDb([])
    monkeypatch.setattr(referrer_routes, 'db', fake_db)
    result = asyncio.run(referrer_routes.create_referrer(ReferrerCreate(name='Studio', type='architect', company='Company', phone='9909955755', email='studio@example.com', address='Address'), user=_user()))
    assert result.shared_across_floors is True
    assert result.company == 'Company' and result.email == 'studio@example.com'
    assert result.floor_id == 'first-floor'


def test_owner_edits_and_shares_existing_identity_with_concurrency_guard(monkeypatch):
    import pytest
    from fastapi import HTTPException
    doc = {'id': 'r1', 'name': 'Studio', 'type': 'architect', 'floor_id': 'first-floor', 'normalized_name': 'studio', 'updated_at': 'old', 'created_by': 'u'}
    fake_db = _FakeDb([doc])
    monkeypatch.setattr(referrer_routes, 'db', fake_db)
    body = ReferrerUpdate(name='Studio updated', type='architect', company='Company', phone='9909955755', updated_at='old')
    result = asyncio.run(referrer_routes.update_referrer('r1', body, user=_user('owner')))
    assert result.id == 'r1' and result.shared_across_floors is True
    assert result.floor_id == 'first-floor' and result.name == 'Studio updated'
    with pytest.raises(HTTPException) as stale:
        asyncio.run(referrer_routes.update_referrer('r1', body, user=_user('owner')))
    assert stale.value.status_code == 409
    with pytest.raises(HTTPException) as forbidden:
        asyncio.run(referrer_routes.update_referrer('r1', body, user=_user()))
    assert forbidden.value.status_code == 403


def test_shared_directory_requires_floor_access_and_owner_archive(monkeypatch):
    import pytest
    from fastapi import HTTPException
    doc = {'id': 'r1', 'name': 'Shared', 'type': 'architect', 'floor_id': 'first-floor', 'normalized_name': 'shared', 'shared_across_floors': True, 'created_by': 'u'}
    fake_db = _FakeDb([doc])
    monkeypatch.setattr(referrer_routes, 'db', fake_db)
    denied = _user()
    denied.floor_ids = []
    with pytest.raises(HTTPException) as no_floor:
        asyncio.run(referrer_routes.list_referrers(type=None, include_inactive=False, user=denied))
    assert no_floor.value.status_code == 403
    async def scoped(*_args, **_kwargs): return doc
    monkeypatch.setattr(referrer_routes, 'get_floor_scoped_or_404', scoped)
    with pytest.raises(HTTPException) as no_owner:
        asyncio.run(referrer_routes.archive_referrer('r1', active=False, user=_user()))
    assert no_owner.value.status_code == 403
    assert fake_db.referrers.updated_selector is None


def test_reference_write_requires_name_and_phone_with_optional_company_and_address():
    import pytest
    from pydantic import ValidationError
    for values in ({"name": "Nikita", "type": "architect"}, {"name": "Nikita", "phone": "123", "type": "architect"}, {"name": "  ", "phone": "9909955755", "type": "interior_designer"}):
        with pytest.raises(ValidationError):
            ReferrerCreate(**values)
    contact = ReferrerCreate(name=" Nikita Shah ", phone="990-995-57-55", type="architect")
    assert contact.name == "Nikita Shah" and contact.phone == "990-995-57-55"
    assert contact.company is None and contact.address is None
    edit = ReferrerUpdate(**contact.model_dump(), updated_at="v1")
    assert edit.phone == contact.phone
