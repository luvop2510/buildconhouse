"""Regression coverage for Kitchen/Furniture quotation-follow-up pricing."""
from __future__ import annotations

import asyncio

import pytest
from pydantic import ValidationError

from models import UserPublic
from models_walkins import WalkInUpdate
from routes import walkin_routes


class _Result:
    matched_count = 1


class _Walkins:
    def __init__(self, row: dict):
        self.row = row
        self.find_queries: list[dict] = []

    async def find_one(self, query, _projection=None):
        self.find_queries.append(query)
        return dict(self.row) if self.row["id"] == "wi-kitchen" else None

    async def update_one(self, query, update):
        assert query == {"id": "wi-kitchen"}
        self.row.update(update["$set"])
        return _Result()


def _user() -> UserPublic:
    return UserPublic(
        email="sales@forge.app", full_name="Kitchen Sales", role="sales",
        floor_ids=["second-floor"], active_floor_id="second-floor",
    )


def _row() -> dict:
    return {
        "id": "wi-kitchen", "number": "WI-2026-0001", "customer_id": "c1",
        "customer_name": "Asha", "visited_at": "2026-08-01T00:00:00+00:00",
        "floor_id": "second-floor", "status": "converted", "is_deleted": False,
        "interested_products": [], "created_at": "2026-08-01T00:00:00+00:00",
        "updated_at": "2026-08-01T00:00:00+00:00",
    }


def test_walkin_quotation_price_is_optional_and_non_negative():
    assert WalkInUpdate(quotation_price=125000).quotation_price == 125000
    assert WalkInUpdate(quotation_price=None).quotation_price is None
    with pytest.raises(ValidationError):
        WalkInUpdate(quotation_price=-1)


def test_quotation_price_update_reads_the_active_floor_then_persists(monkeypatch):
    walkins = _Walkins(_row())
    monkeypatch.setattr(walkin_routes, "db", type("Db", (), {"walkins": walkins})())

    updated = asyncio.run(walkin_routes.update_walkin(
        "wi-kitchen", WalkInUpdate(quotation_price=98000), user=_user(),
    ))

    assert walkins.find_queries[0] == {
        "$and": [{"floor_id": {"$in": ["second-floor"]}}, {"id": "wi-kitchen", "$or": [{"floor_id": {"$nin": ["first-floor", "ground-floor"]}}, {"is_deleted": {"$ne": True}}]}],
    }
    assert walkins.row["quotation_price"] == 98000
    assert updated.quotation_price == 98000
