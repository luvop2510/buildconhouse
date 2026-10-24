from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import routes.customer_routes as customer_routes
from models import UserPublic


class _Cursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, _limit):
        return list(self.rows)


class _Collection:
    def __init__(self, *, rows=None, count=0, deleted=0, modified=0, matched=1):
        self.rows = rows or []
        self.count = count
        self.deleted = deleted
        self.modified = modified
        self.calls = []
        self.matched = matched

    def find(self, query, projection=None):
        self.calls.append(("find", query, projection))
        return _Cursor(self.rows)

    async def count_documents(self, query):
        self.calls.append(("count", query))
        return self.count

    async def update_many(self, query, update):
        self.calls.append(("update_many", query, update))
        return SimpleNamespace(modified_count=self.modified)

    async def delete_many(self, query):
        self.calls.append(("delete_many", query))
        return SimpleNamespace(deleted_count=self.deleted)

    async def delete_one(self, query):
        self.calls.append(("delete_one", query))
        return SimpleNamespace(deleted_count=self.deleted)

    async def update_one(self, query, update):
        self.calls.append(("update_one", query, update))
        return SimpleNamespace(matched_count=self.matched)


def _manager() -> UserPublic:
    return UserPublic(
        email="manager@forge.app", full_name="Manager", role="manager",
        floor_ids=[], active_floor_id="first-floor",
    )


def _db(*, protected=False):
    return SimpleNamespace(
        customers=_Collection(deleted=1),
        quotations=_Collection(rows=[{"id": "q1"}], deleted=1, modified=1),
        purchase_orders=_Collection(count=1 if protected else 0),
        payments=_Collection(count=1 if protected else 0, deleted=1),
        walkins=_Collection(deleted=1, modified=1),
        followups=_Collection(deleted=1, modified=1),
        activity_events=_Collection(deleted=2),
    )


async def _customer(*args, **kwargs):
    return {"id": "c1", "name": "Customer", "floor_id": "first-floor"}


def test_delete_customer_cleans_disposable_records_across_quotation_links(monkeypatch):
    db = _db()
    monkeypatch.setattr(customer_routes, "db", db)
    monkeypatch.setattr(customer_routes, "get_floor_scoped_or_404", _customer)

    result = asyncio.run(customer_routes.delete_customer("c1", user=_manager()))

    assert result["ok"] is True
    assert result["deleted"]["customers"] == 1
    assert result["deleted"]["quotations"] == 1
    assert result["deleted"]["pending_payments"] == 1
    assert result["deleted"]["legacy_gender_fields"] == 3
    assert any(call[0] == "delete_many" for call in db.followups.calls)
    assert any(call[0] == "delete_one" for call in db.customers.calls)


def test_delete_customer_preserves_records_when_financial_data_exists(monkeypatch):
    db = _db(protected=True)
    monkeypatch.setattr(customer_routes, "db", db)
    monkeypatch.setattr(customer_routes, "get_floor_scoped_or_404", _customer)

    with pytest.raises(HTTPException) as error:
        asyncio.run(customer_routes.delete_customer("c1", user=_manager()))

    assert error.value.status_code == 409
    assert not any(call[0] == "delete_one" for call in db.customers.calls)
    assert not any(call[0] == "delete_many" for call in db.followups.calls)


def test_kitchen_customer_delete_requires_atomic_claim_before_cleanup(monkeypatch):
    db = _db()
    db.customers.matched = 0
    async def kitchen_customer(*args, **kwargs):
        return {"id": "c1", "name": "Customer", "floor_id": "second-floor"}
    monkeypatch.setattr(customer_routes, "db", db)
    monkeypatch.setattr(customer_routes, "get_floor_scoped_or_404", kitchen_customer)
    with pytest.raises(HTTPException) as error:
        asyncio.run(customer_routes.delete_customer("c1", user=_manager()))
    assert error.value.status_code == 409
    query = db.customers.calls[0][1]
    assert query["kitchen_reference_reserved"] == {"$ne": True}
    assert query["kitchen_delete_token"] == {"$exists": False}
    assert not db.followups.calls


def test_historical_kitchen_reference_blocks_delete_and_releases_own_claim(monkeypatch):
    db = _db()
    db.kitchen_projects = _Collection(count=1)
    async def kitchen_customer(*args, **kwargs):
        return {"id": "c1", "name": "Customer", "floor_id": "second-floor"}
    monkeypatch.setattr(customer_routes, "db", db)
    monkeypatch.setattr(customer_routes, "get_floor_scoped_or_404", kitchen_customer)
    with pytest.raises(HTTPException) as error:
        asyncio.run(customer_routes.delete_customer("c1", user=_manager()))
    assert error.value.status_code == 409
    claim, release = db.customers.calls
    token = claim[2]["$set"]["kitchen_delete_token"]
    assert release[1]["kitchen_delete_token"] == token
    assert not db.followups.calls
