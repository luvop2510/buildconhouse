"""Referrer directory (list + create) — the quotation builder's picker and
the Sales Data dashboard both depend on this being correct."""
from __future__ import annotations

import asyncio

from models import ReferrerCreate, UserPublic
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
            for key, value in query.items():
                if isinstance(value, dict) and "$in" in value:
                    if doc.get(key) not in value["$in"]:
                        return False
                elif doc.get(key) != value:
                    return False
            return True
        matched = [d for d in self._docs if matches(d)]
        return _Cursor(matched)

    async def insert_one(self, doc):
        self.inserted = doc

    async def update_one(self, selector, _update):
        self.updated_selector = selector

    async def find_one(self, selector, *_a, **_kw):
        for doc in self._docs:
            if all(doc.get(key) == value for key, value in selector.items()):
                return doc
        return None


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

    body = ReferrerCreate(name="Studio Verve", type="interior_designer")
    result = asyncio.run(referrer_routes.create_referrer(body, user=_user()))

    assert result.created_by == "user-1"
    assert result.name == "Studio Verve"
    assert fake_db.referrers.inserted["name"] == "Studio Verve"


def test_create_referrer_with_new_name_creates_a_new_record(monkeypatch):
    fake_db = _FakeDb([
        {"id": "r1", "name": "Rakesh Sharma", "type": "architect", "floor_id": "first-floor", "normalized_name": "rakesh sharma", "created_at": "t", "updated_at": "t", "created_by": "u"},
    ])
    monkeypatch.setattr(referrer_routes, "db", fake_db)

    body = ReferrerCreate(name="Nikita Shah", type="architect")
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
    body = ReferrerCreate(name="rakesh sharma", type="architect")
    result = asyncio.run(referrer_routes.create_referrer(body, user=_user()))

    assert result.id == "r1"
    assert fake_db.referrers.inserted is None  # nothing new was inserted


def test_create_referrer_same_name_different_type_creates_a_separate_record(monkeypatch):
    fake_db = _FakeDb([
        {"id": "r1", "name": "Rakesh Sharma", "type": "architect", "created_at": "t", "updated_at": "t", "created_by": "u"},
    ])
    monkeypatch.setattr(referrer_routes, "db", fake_db)

    body = ReferrerCreate(name="Rakesh Sharma", type="interior_designer")
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
