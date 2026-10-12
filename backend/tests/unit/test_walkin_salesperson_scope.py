"""Salesperson assignment must respect both role and floor ownership."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from routes import walkin_routes


class _Users:
    def __init__(self, rows: list[dict]):
        self.rows = {row["id"]: row for row in rows}

    async def find_one(self, query, *_args, **_kwargs):
        return self.rows.get(query["id"])


def _set_users(monkeypatch, rows: list[dict]):
    monkeypatch.setattr(walkin_routes, "db", type("Db", (), {"users": _Users(rows)})())


def test_salesperson_must_have_the_walkins_floor(monkeypatch):
    _set_users(monkeypatch, [{"id": "sanitary-sales", "full_name": "Sanitary Sales", "role": "sales", "active": True, "floor_ids": ["first-floor"]}])

    with pytest.raises(HTTPException, match="does not have access"):
        asyncio.run(walkin_routes._salesperson_for_floor("sanitary-sales", "ground-floor"))


def test_warehouse_staff_cannot_be_assigned_as_salesperson(monkeypatch):
    _set_users(monkeypatch, [{"id": "warehouse", "full_name": "Warehouse", "role": "warehouse", "active": True, "floor_ids": ["ground-floor"]}])

    with pytest.raises(HTTPException, match="cannot own sales"):
        asyncio.run(walkin_routes._salesperson_for_floor("warehouse", "ground-floor"))


def test_profile_bound_salesperson_uses_the_profiles_floor(monkeypatch):
    staff = {"id": "tile-sales", "full_name": "Tile Sales", "role": "sales", "active": True, "floor_ids": ["first-floor"], "access_profile": "ground_tile_quotations_followups"}
    _set_users(monkeypatch, [staff])

    assert asyncio.run(walkin_routes._salesperson_for_floor("tile-sales", "ground-floor")) == staff


@pytest.mark.parametrize("floor", ["ground-floor", "first-floor", "second-floor", "third-floor"])
@pytest.mark.parametrize("actions,allowed", [(["view", "create"], True), (["view", "update"], True), (["view"], False)])
def test_delegated_worker_can_own_walkins_only_with_writable_floor_grant(monkeypatch, floor, actions, allowed):
    staff = {"id": "worker", "full_name": "Delegated Worker", "role": "worker", "active": True,
             "floor_ids": [floor], "custom_access": True}
    _set_users(monkeypatch, [staff])
    async def grants(*_args):
        return [{"user_id": "worker", "resource": "walkins", "floor_id": floor, "actions": actions}]
    monkeypatch.setattr(walkin_routes, "grants_for_user", grants)
    if allowed:
        assert asyncio.run(walkin_routes._salesperson_for_floor("worker", floor)) == staff
    else:
        with pytest.raises(HTTPException):
            asyncio.run(walkin_routes._salesperson_for_floor("worker", floor))


def test_custom_manager_does_not_inherit_sales_ownership_from_base_role(monkeypatch):
    staff = {"id": "manager", "full_name": "Delegated Manager", "role": "manager", "active": True,
             "floor_ids": ["second-floor"], "custom_access": True}
    _set_users(monkeypatch, [staff])
    async def grants(*_args):
        return [{"user_id": "manager", "resource": "payments", "floor_id": "second-floor", "actions": ["view", "update"]}]
    monkeypatch.setattr(walkin_routes, "grants_for_user", grants)
    with pytest.raises(HTTPException):
        asyncio.run(walkin_routes._salesperson_for_floor("manager", "second-floor"))


def test_assignee_picker_uses_same_floor_and_delegation_policy_as_submission(monkeypatch):
    from models import UserPublic
    class Cursor:
        def sort(self, *_args): return self
        async def to_list(self, _count): return rows
    rows = [
        {"id": "owner", "full_name": "Owner", "role": "owner", "active": True},
        {"id": "worker", "full_name": "Worker", "role": "worker", "active": True, "floor_ids": ["second-floor"], "custom_access": True},
        {"id": "sanitary", "full_name": "Sanitary", "role": "sales", "active": True, "floor_ids": ["first-floor"]},
        {"id": "viewer", "full_name": "Viewer", "role": "worker", "active": True, "floor_ids": ["second-floor"], "custom_access": True},
    ]
    class Users:
        def find(self, *_args): return Cursor()
    monkeypatch.setattr(walkin_routes, "db", type("Db", (), {"users": Users()})())
    async def grants(_db, user_id):
        return [{"user_id": user_id, "resource": "walkins", "floor_id": "second-floor", "actions": ["view", "create"] if user_id == "worker" else ["view"]}]
    monkeypatch.setattr(walkin_routes, "grants_for_user", grants)
    user = UserPublic(id="worker", email="worker@example.com", full_name="Worker", role="worker", custom_access=True,
                      floor_ids=["second-floor"], active_floor_id="second-floor")
    result = asyncio.run(walkin_routes.walkin_assignees(user))
    assert [row["id"] for row in result] == ["owner", "worker"]
    assert all(set(row) == {"id", "full_name", "role"} for row in result)


@pytest.mark.parametrize("floor", ["ground-floor", "first-floor", "second-floor", "third-floor"])
def test_delegated_worker_intake_creates_regular_walkin_with_chosen_floor_and_attribution(monkeypatch, floor):
    from types import SimpleNamespace
    from models import UserPublic
    from models_walkins import WalkInCreate
    from services import duplicate_detection
    worker = {"id": "worker", "full_name": "Delegated Worker", "role": "worker", "active": True,
              "floor_ids": [floor], "custom_access": True}
    inserted, customers, events = [], [], []
    class Floors:
        async def find_one(self, query, *_args): return {"id": query["id"]}
    class Walkins:
        async def insert_one(self, doc): inserted.append(doc)
    async def grants(*_args):
        return [{"user_id": "worker", "resource": "walkins", "floor_id": floor, "actions": ["view", "create"]}]
    async def matches(**kwargs):
        assert kwargs["floor_ids"] == [floor]
        return {"high": [], "medium": [], "low": []}
    async def customer(**kwargs):
        customers.append(kwargs)
        return {"id": "customer", "name": kwargs["name"]}
    async def next_number(): return "WI-TEST"
    async def log(**kwargs): events.append(kwargs)
    async def reconcile(): pass
    monkeypatch.setattr(walkin_routes, "db", SimpleNamespace(users=_Users([worker]), floors=Floors(), walkins=Walkins()))
    monkeypatch.setattr(walkin_routes, "grants_for_user", grants)
    monkeypatch.setattr(duplicate_detection, "find_customer_matches", matches)
    monkeypatch.setattr(walkin_routes, "find_or_create_customer", customer)
    monkeypatch.setattr(walkin_routes, "_next_walkin_number", next_number)
    monkeypatch.setattr(walkin_routes, "log_event", log)
    monkeypatch.setattr(walkin_routes, "reconcile_followups", reconcile)
    user = UserPublic(id="worker", email="worker@example.com", full_name="Delegated Worker", role="worker",
                      custom_access=True, floor_ids=[floor], active_floor_id=floor)
    created = asyncio.run(walkin_routes.create_walkin(WalkInCreate(customer_name="Visitor", customer_phone="9876543210",
                      floor_id=floor, salesperson_id="worker", interested_products=["Tiles", "Bathroom fittings"]), user))
    assert created.floor_id == customers[0]["floor_id"] == inserted[0]["floor_id"] == floor
    assert created.salesperson_id == created.created_by == "worker"
    assert created.salesperson_name == "Delegated Worker"
    assert created.interested_products == ["Tiles", "Bathroom fittings"]
    assert len(events) == 1
