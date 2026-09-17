"""Ground Floor collection extras preserve the original quotation total."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

import routes.payment_routes as payment_routes
from models import PaymentOrderExtraUpdate, UserPublic


def _user() -> UserPublic:
    return UserPublic(email="accounts@forge.app", full_name="Accounts", role="accounts", floor_ids=["ground-floor"], active_floor_id="ground-floor")


class _Quotations:
    def __init__(self, doc: dict):
        self.doc = doc
        self.update = None

    async def find_one(self, _query, _projection=None):
        return self.doc

    async def update_one(self, query, update):
        self.update = (query, update)


class _Db:
    def __init__(self, doc: dict):
        self.quotations = _Quotations(doc)


class _Cache:
    async def bump(self, _key):
        return None


def test_additional_cost_is_appended_and_added_to_collection_total(monkeypatch):
    user = _user()
    fake_db = _Db({"id": "q-1", "floor_id": "ground-floor", "grand_total": 1000, "status": "ordered"})
    monkeypatch.setattr(payment_routes, "db", fake_db)
    monkeypatch.setattr(payment_routes, "cache", _Cache())

    result = asyncio.run(payment_routes.update_ground_floor_manual_extra(
        "q-1", PaymentOrderExtraUpdate(amount=250.125, name="  Labour cost "), user=user,
    ))

    assert result["quotation_total"] == 1000.0
    assert result["manual_extra_amount"] == 250.12
    assert result["manual_extra_name"] == "Labour cost"
    assert result["grand_total"] == 1250.12
    assert result["additional_cost"]["name"] == "Labour cost"
    assert result["additional_cost"]["amount"] == 250.12
    assert result["additional_cost"]["note"] is None
    assert result["additional_cost"]["recorded_by"] == user.id
    assert result["additional_cost"]["recorded_by_name"] == "Accounts"
    assert fake_db.quotations.update[1]["$push"]["payment_extra_history"] == result["additional_cost"]
    assert fake_db.quotations.update[1]["$inc"]["payment_extra_amount"] == 250.12
    assert fake_db.quotations.update[1]["$set"]["payment_extra_name"] == "Labour cost"


def test_additional_cost_requires_a_name_at_schema_validation():
    with pytest.raises(ValueError, match="Field required"):
        PaymentOrderExtraUpdate(amount=100)
