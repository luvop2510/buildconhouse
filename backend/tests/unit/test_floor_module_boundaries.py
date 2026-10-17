"""Floor switching cannot expose another floor's follow-ups or Purchases."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import auth
from models import (
    FollowupCallOutcomePayload, FollowupCompletePayload, FollowupContactPayload,
    FollowupCreate, FollowupSnoozePayload, FollowupUpdate, UserPublic,
)
from routes import followup_routes
from services import lead_scope
from services.access_grants import granted_floor_ids, is_global_followup_admin_request, resource_supports


FLOORS = ["ground-floor", "first-floor", "second-floor", "third-floor"]


def user(floor, role="owner", custom=False):
    return UserPublic(id="staff", email="staff@example.com", full_name="Staff", role=role,
                      floor_ids=FLOORS if role != "owner" else [], active_floor_id=floor,
                      custom_access=custom)


def request(path, method="GET"):
    return Request({"type": "http", "method": method, "path": path, "headers": [],
                    "query_string": b"", "scheme": "http", "server": ("test", 80)})


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["owner", "manager", "purchase"])
@pytest.mark.parametrize("floor", FLOORS)
@pytest.mark.parametrize("path", ["/api/purchases/items", "/api/purchase-orders/po", "/api/suppliers"])
async def test_purchases_requests_are_exclusive_to_sanitary(role, floor, path):
    caller = user(floor, role)
    if floor == "first-floor":
        assert await auth.authorize_staff_request(caller, request(path)) is caller
        assert auth.accessible_floor_ids(caller) == ["first-floor"]
    else:
        with pytest.raises(HTTPException) as exc:
            await auth.authorize_staff_request(caller, request(path))
        assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_sanitary_purchase_request_cannot_open_another_floors_record():
    caller = user("first-floor")
    await auth.authorize_staff_request(caller, request("/api/purchase-orders/po"))

    class Orders:
        async def find_one(self, *_args, **_kwargs):
            return {"id": "po", "floor_id": "ground-floor"}

    with pytest.raises(HTTPException) as exc:
        await auth.get_floor_scoped_or_404(Orders(), "po", caller)
    assert exc.value.status_code == 404


def test_stale_global_purchase_grants_cannot_widen_the_module():
    grant = {"user_id": "staff", "resource": "purchases", "actions": ["view"], "floor_id": None}
    assert granted_floor_ids([grant], user_id="staff", path="/api/purchases/items", action="view") == ["first-floor"]
    for floor in FLOORS:
        assert resource_supports("purchases", floor, ["view"]) == (floor == "first-floor")
        assert resource_supports("followups", floor, ["view", "create", "update"])
    grant["floor_id"] = "third-floor"
    assert granted_floor_ids([grant], user_id="staff", path="/api/purchases/items", action="view") == []


def test_catalog_grants_are_limited_to_ground_and_sanitary():
    grant = {"user_id": "staff", "resource": "catalog", "actions": ["view"], "floor_id": None}
    assert granted_floor_ids([grant], user_id="staff", path="/api/catalog/search", action="view") == ["ground-floor", "first-floor"]
    for floor in FLOORS:
        assert resource_supports("catalog", floor, ["view"]) == (floor in {"ground-floor", "first-floor"})


def matches(row, query):
    if "$and" in query:
        return all(matches(row, clause) for clause in query["$and"])
    return all(row.get(key) in value["$in"] if isinstance(value, dict) and "$in" in value
               else row.get(key) == value for key, value in query.items())


class Followups:
    def __init__(self, row):
        self.row = row
        self.writes = []

    async def find_one(self, query, *_args, **_kwargs):
        return dict(self.row) if matches(self.row, query) else None

    async def update_one(self, *args, **kwargs):
        self.writes.append((args, kwargs))

    async def delete_one(self, *args, **kwargs):
        self.writes.append((args, kwargs))


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["owner", "manager", "sales"])
@pytest.mark.parametrize("active,target", [(floor, other) for floor in FLOORS for other in FLOORS if floor != other])
@pytest.mark.parametrize("action,body", [
    (followup_routes.get_detail, None), (followup_routes.delete_followup, None),
    (followup_routes.update_followup, FollowupUpdate(reason="Updated")),
    (followup_routes.snooze_followup, FollowupSnoozePayload(preset="1h")),
    (followup_routes.complete_followup, FollowupCompletePayload()),
    (followup_routes.contact_followup, FollowupContactPayload(channel="call")),
    (followup_routes.log_call, FollowupCallOutcomePayload(outcome="call_back")),
])
async def test_followup_links_and_actions_cannot_cross_selected_floor(monkeypatch, role, active, target, action, body):
    collection = Followups({"id": "other", "floor_id": target, "customer_id": "customer"})
    monkeypatch.setattr(followup_routes, "db", SimpleNamespace(followups=collection))
    kwargs = {"user": user(active, role)}
    if body is not None:
        kwargs["body"] = body
    if action is followup_routes.delete_followup:
        kwargs["notes"] = None
    with pytest.raises(HTTPException) as exc:
        await action("other", **kwargs)
    assert exc.value.status_code == 404
    assert exc.value.detail == "Follow-up not found"
    assert collection.writes == []


@pytest.mark.parametrize("active,target", [("third-floor", "second-floor"), ("second-floor", "third-floor")])
def test_legacy_notebook_urls_cannot_cross_selected_floor(active, target):
    with pytest.raises(HTTPException) as exc:
        followup_routes.require_notebook_floor(target, user(active))
    assert exc.value.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("floor", ["second-floor", "third-floor"])
@pytest.mark.parametrize("path,method", [("/api/followups", "GET"), ("/api/followups/row", "GET"), ("/api/followups/row/contact", "POST"), ("/api/followups/row/log-call", "POST")])
async def test_shared_followups_grants_manage_legacy_notebook_rows(monkeypatch, floor, path, method):
    async def grants(*_args):
        return [{"user_id": "staff", "resource": "followups", "floor_id": floor, "actions": ["view", "update"]}]

    async def no_notebook_lookup(*_args):
        raise AssertionError("A full Follow-ups grant must not fall back to notebook-only authorization")

    monkeypatch.setattr(auth, "grants_for_user", grants)
    monkeypatch.setattr(auth, "request_resource", no_notebook_lookup)
    caller = user(floor, "sales", custom=True)
    assert await auth.authorize_staff_request(caller, request(path, method)) is caller
    assert auth.floor_scope_ids(caller) == [floor]
    assert getattr(caller, "_custom_notebook_converted", None) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("floor", ["second-floor", "third-floor"])
async def test_shared_inbox_can_create_floor_local_followups(monkeypatch, floor):
    inserted = []

    class Rows:
        async def insert_one(self, row):
            inserted.append(row)

    class Customers:
        async def find_one(self, query, *_args):
            assert query["$and"][0] == {"floor_id": {"$in": [floor]}}
            return {"id": "customer", "floor_id": floor, "name": "Customer"}

    class Quotations:
        async def find_one(self, query, *_args):
            assert query["floor_id"] == floor
            return None

    async def log(**_kwargs):
        pass

    monkeypatch.setattr(followup_routes, "db", SimpleNamespace(followups=Rows(), customers=Customers(), quotations=Quotations()))
    monkeypatch.setattr(followup_routes, "log_event", log)
    monkeypatch.setattr(lead_scope, "update_interests", AsyncMock(side_effect=lambda *_args, **kwargs: kwargs["source"]))
    result = await followup_routes.create_followup(FollowupCreate(customer_id="customer", reason="Call customer", assignments=[{"floor_id": floor, "user_id": "worker"}]), user(floor))
    assert result.floor_id == floor
    assert len(inserted) == 1 and inserted[0]["floor_id"] == floor


@pytest.mark.parametrize("floor", ["second-floor", "third-floor"])
@pytest.mark.parametrize("converted", [False, True])
def test_shared_followups_staff_can_be_assigned_to_both_legacy_stages(floor, converted):
    staff = {"id": "staff", "role": "worker", "floor_ids": [floor], "custom_access": True,
             "delegation_grants": [{"user_id": "staff", "resource": "followups", "floor_id": floor, "actions": ["view", "update"]}]}
    assert lead_scope.can_assign(staff, floor, notebook_converted=converted)
    other = "third-floor" if floor == "second-floor" else "second-floor"
    assert not lead_scope.can_assign(staff, other, notebook_converted=converted)


@pytest.mark.asyncio
@pytest.mark.parametrize("path,method", [
    ("/api/followups/reconcile", "POST"),
    ("/api/followups/config/automation-rules/sales", "PUT"),
    ("/api/followups/config/workflow-transitions/selection", "PUT"),
])
@pytest.mark.parametrize("role", ["worker", "sales", "manager"])
async def test_floor_followup_grants_cannot_mutate_global_automation(monkeypatch, path, method, role):
    async def no_grant_read(*_args):
        raise AssertionError("A floor grant must never authorize a global automation command")

    monkeypatch.setattr(auth, "grants_for_user", no_grant_read)
    with pytest.raises(HTTPException) as exc:
        await auth.authorize_staff_request(user("second-floor", role, custom=True), request(path, method))
    assert exc.value.status_code == 403
    assert await auth.authorize_staff_request(user("second-floor", "manager"), request(path, method))
    assert await auth.authorize_staff_request(user("second-floor", "owner", custom=True), request(path, method))


@pytest.mark.parametrize("path,method", [
    ("/api/followups/config/automation-rules", "GET"),
    ("/api/followups/config/workflow-transitions", "GET"),
    ("/api/followups/row/contact", "POST"),
    ("/api/followups/row/log-call", "POST"),
    ("/api/followups/row", "PATCH"),
    ("/api/followups/reconcile-other", "POST"),
    ("/api/followups/config/automation-rules/sales/other", "PUT"),
])
def test_global_automation_restriction_matches_only_its_exact_commands(path, method):
    assert not is_global_followup_admin_request(method, path)
