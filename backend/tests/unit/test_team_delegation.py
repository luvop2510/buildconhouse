from unittest.mock import AsyncMock
"""Floor/page changes commit as one snapshot and never widen empty access."""
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import auth
from models import TeamCreatePayload, TeamUpdatePayload, UserPublic
from routes import access_grants_routes as routes, misc_routes
from services.access_grants import build_delegation_snapshot, grants_for_user, request_resource


FLOORS = ["ground-floor", "first-floor", "second-floor", "third-floor"]


class Users:
    def __init__(self, doc):
        self.doc = deepcopy(doc)
        self.updates = []

    async def find_one(self, query, *_args):
        if query.get("id") == self.doc.get("id"):
            return deepcopy(self.doc)
        return None

    async def update_one(self, query, update):
        assert query["id"] == self.doc["id"]
        self.updates.append(deepcopy(update))
        self.doc.update(deepcopy(update["$set"]))
        return SimpleNamespace(matched_count=1)

    async def insert_one(self, doc):
        self.doc = deepcopy(doc)


class Floors:
    async def find_one(self, query, *_args):
        return {"id": query["id"]} if query["id"] in FLOORS else None


def database():
    return SimpleNamespace(users=Users({"id": "staff", "email": "staff@example.com", "full_name": "Worker", "role": "worker", "floor_ids": ["first-floor"]}), floors=Floors())


def allocation(resource="payments", floor="ground-floor", actions=None):
    return {"resource": resource, "floor_id": floor, "actions": actions or ["view"]}


def owner():
    return UserPublic(id="owner", email="owner@example.com", full_name="Owner", role="owner")


@pytest.mark.asyncio
@pytest.mark.parametrize("floors,grants", [
    (["ground-floor"], [allocation()]),
    (["ground-floor", "first-floor"], [allocation(), allocation("catalog", "first-floor", ["view", "create"])]),
    (FLOORS, [allocation(), allocation("quotations", "first-floor"), allocation("notebook_walkins", "second-floor"), allocation("furniture_quotations", "third-floor", ["view", "export"])]),
    (["ground-floor"], []), ([], []),
])
async def test_replace_saves_floors_and_all_pages_in_one_atomic_user_write(monkeypatch, floors, grants):
    db = database()
    refreshed = []
    async def refresh(user_id):
        refreshed.append(user_id)
    monkeypatch.setattr(routes, "db", db)
    monkeypatch.setattr(routes, "_refresh_grant_subject", refresh)
    result = await routes.replace_access_grants("staff", routes.DelegationInput(floor_ids=floors, grants=grants), owner())
    assert len(db.users.updates) == 1
    saved = db.users.updates[0]["$set"]
    assert saved["floor_ids"] == floors
    assert saved["delegation_grants"] == result["grants"]
    assert saved["custom_access"] is True and saved["access_profile"] is None
    assert await grants_for_user(db, "staff") == result["grants"]
    assert refreshed == ["staff"]


@pytest.mark.asyncio
@pytest.mark.parametrize("floors,grants", [
    ([], [allocation()]),
    (["not-a-floor"], []),
    (["ground-floor", "ground-floor"], []),
    (["ground-floor"], [allocation("quotations")]),
    (["first-floor"], [allocation("tiles", "first-floor")]),
    (["ground-floor"], [allocation("typo")]),
    (["ground-floor"], [allocation(actions=["create"])]),
    (["ground-floor"], [allocation("dashboard", actions=["view", "delete"])]),
    (["ground-floor"], [allocation(), allocation()]),
])
async def test_invalid_draft_rejects_before_changing_any_floor_or_page(monkeypatch, floors, grants):
    db = database()
    monkeypatch.setattr(routes, "db", db)
    before = deepcopy(db.users.doc)
    with pytest.raises(HTTPException) as exc:
        await routes.replace_access_grants("staff", routes.DelegationInput(floor_ids=floors, grants=grants), owner())
    assert exc.value.status_code == 422
    assert db.users.doc == before and db.users.updates == []


@pytest.mark.asyncio
async def test_deleting_final_grant_keeps_default_deny_and_ignores_legacy_rows(monkeypatch):
    db = database()
    snapshot = await build_delegation_snapshot(db, user_id="staff", floor_ids=["ground-floor"], grants=[allocation()], actor_id="owner", actor_name="Owner")
    db.users.doc.update(custom_access=True, floor_ids=["ground-floor"], delegation_grants=snapshot)
    async def refresh(_user_id):
        pass
    monkeypatch.setattr(routes, "db", db)
    monkeypatch.setattr(routes, "_refresh_grant_subject", refresh)
    await routes.delete_access_grant("staff", snapshot[0]["id"], owner())
    assert db.users.doc["custom_access"] is True
    assert db.users.doc["delegation_grants"] == []
    assert await grants_for_user(db, "staff") == []


def test_custom_manager_floor_shell_never_inherits_unassigned_floors():
    manager = UserPublic(email="manager@example.com", full_name="Manager", role="manager", custom_access=True, floor_ids=["ground-floor"])
    assert auth.accessible_floor_ids(manager) == ["ground-floor"]
    manager.floor_ids = []
    assert auth.accessible_floor_ids(manager) == []


@pytest.mark.asyncio
async def test_persisted_delegation_snapshot_drops_unsupported_or_disabled_access():
    db = database()
    valid = {"id": "valid", "user_id": "staff", **allocation()}
    db.users.doc.update(floor_ids=["ground-floor", "first-floor"], delegation_grants=[
        valid,
        {**valid, "id": "wrong-owner", "user_id": "other"},
        {**valid, "id": "wrong-floor", "floor_id": "second-floor"},
        {**valid, "id": "wrong-page-floor", "resource": "tiles", "floor_id": "first-floor"},
        {**valid, "id": "unsupported-action", "actions": ["view", "delete"]},
        {**valid, "id": "no-view", "actions": ["update"]},
    ])
    assert await grants_for_user(db, "staff") == [valid]


@pytest.mark.asyncio
async def test_custom_team_create_can_have_no_enabled_floors_without_role_fallback(monkeypatch):
    db = database()
    async def log(**_kwargs):
        pass
    monkeypatch.setattr(misc_routes, "db", db)
    monkeypatch.setattr(misc_routes, "log_event", log)
    result = await misc_routes.create_team_member(TeamCreatePayload(email="new@example.com", full_name="New", role="worker", custom_access=True, floor_ids=[], access_grants=[], password="unique-password-123"), owner())
    assert result["custom_access"] is True and result["floor_ids"] == [] and result["delegation_grants"] == []


@pytest.mark.asyncio
async def test_team_patch_atomically_replaces_floors_and_grants_without_revoking_sessions(monkeypatch):
    db = database()
    revoked = []
    async def revoke(_kind, user_id):
        revoked.append(user_id)
    async def log(**_kwargs):
        pass
    monkeypatch.setattr(misc_routes, "db", db)
    monkeypatch.setattr(misc_routes, "revoke_all_sessions", revoke)
    monkeypatch.setattr(misc_routes, "log_event", log)
    result = await misc_routes.update_team_member("staff", TeamUpdatePayload(custom_access=True, floor_ids=["ground-floor", "third-floor"], access_grants=[allocation(), allocation("furniture_quotations", "third-floor")], team_role="Delivery lead"), owner())
    assert len(db.users.updates) == 1
    assert result["floor_ids"] == ["ground-floor", "third-floor"]
    assert result["team_role"] == "Delivery lead"
    assert len(result["delegation_grants"]) == 2
    assert result["access_profile"] is None and revoked == []


@pytest.mark.asyncio
@pytest.mark.parametrize("converted", [False, True])
async def test_notebook_row_permission_uses_stored_stage_not_forged_query(converted):
    class Rows:
        async def find_one(self, query, _projection):
            assert query == {"id": "row", "floor_id": "second-floor"}
            return {"is_converted": converted, "notebook_key": "second-floor:customer"}
    db = SimpleNamespace(followups=Rows())
    assert await request_resource(db, "/api/followups/notebook/second-floor/row", {"view": "quotation" if not converted else "followups"}) == ("notebook_quotations" if converted else "notebook_walkins")


@pytest.mark.asyncio
async def test_notebook_quotation_grant_cannot_open_walkin_list(monkeypatch):
    db = database()
    snapshot = await build_delegation_snapshot(db, user_id="staff", floor_ids=["second-floor"], grants=[allocation("notebook_quotations", "second-floor")], actor_id="owner", actor_name="Owner")
    async def grants(*_args):
        return snapshot
    monkeypatch.setattr(auth, "grants_for_user", grants)
    for view, allowed in [("quotation", True), ("followups", False)]:
        request = Request({"type": "http", "method": "GET", "path": "/api/followups/notebook/second-floor", "headers": [], "query_string": f"view={view}".encode(), "scheme": "http", "server": ("test", 80)})
        user = UserPublic(id="staff", email="staff@example.com", full_name="Worker", role="worker", custom_access=True, floor_ids=["second-floor"], active_floor_id="second-floor")
        if allowed:
            assert await auth.authorize_staff_request(user, request) is user
        else:
            with pytest.raises(HTTPException):
                await auth.authorize_staff_request(user, request)


@pytest.mark.asyncio
@pytest.mark.parametrize("suffix", ["", "/complete", "/log-call"])
async def test_generic_followup_urls_cannot_expand_notebook_grants_into_customer_history(suffix):
    class Rows:
        async def find_one(self, *_args):
            return {"notebook_key": "second-floor:customer", "is_converted": True}
    assert await request_resource(SimpleNamespace(followups=Rows()), f"/api/followups/row{suffix}") == "__notebook_route_required"


@pytest.mark.asyncio
async def test_notebook_contact_binds_stored_page_and_rechecks_stage_in_write(monkeypatch):
    from models import FollowupContactPayload
    from routes import followup_routes
    class Rows:
        async def find_one(self, query, _projection):
            identity = query["$and"][1] if "$and" in query else query
            assert identity["is_converted"] is False and identity["notebook_key"] == {"$type": "string"}
            return {"id": "row", "customer_name": "Customer", "customer_phone": "9999999999"}
        async def update_one(self, query, _update):
            identity = query["$and"][1] if "$and" in query else query
            assert identity["is_converted"] is False
            # A conversion occurred between the read and the write.
            return SimpleNamespace(matched_count=0)
    monkeypatch.setattr(followup_routes, "db", SimpleNamespace(followups=Rows()))
    user = UserPublic(id="staff", email="staff@example.com", full_name="Worker", role="worker", custom_access=True, floor_ids=["second-floor"], active_floor_id="second-floor")
    object.__setattr__(user, "_custom_notebook_converted", False)
    with pytest.raises(HTTPException) as exc:
        await followup_routes.contact_followup("row", FollowupContactPayload(channel="call"), user)
    assert exc.value.status_code == 409


@pytest.mark.asyncio
@pytest.mark.parametrize("converted,status", [(True, 403), (False, 409)])
async def test_readding_customer_cannot_change_existing_row_through_create(monkeypatch, converted, status):
    from models import NotebookFollowupCreatePayload
    from routes import followup_routes
    class Rows:
        async def find_one(self, *_args):
            return {"id": "existing", "is_converted": converted, "quotation_price": 200000}
    class Customers:
        async def update_one(self, *_args):
            pytest.fail("Existing lead must be rejected before changing its customer's partner")
    async def customer(*_args, **_kwargs):
        return {"id": "customer", "tier": "retail"}
    async def partner(*_args):
        return {"referrer_id": "partner", "referrer_name": "Partner"}
    monkeypatch.setattr(followup_routes, "db", SimpleNamespace(followups=Rows(), customers=Customers()))
    monkeypatch.setattr(followup_routes, "resolve_or_create_customer", customer)
    monkeypatch.setattr(followup_routes, "_notebook_referrer_fields", partner)
    monkeypatch.setattr(followup_routes.lead_scope, "validate_scope", AsyncMock())
    user = UserPublic(id="staff", email="staff@example.com", full_name="Worker", role="worker", custom_access=True, floor_ids=["second-floor"], active_floor_id="second-floor")
    body = NotebookFollowupCreatePayload(customer_name="Customer", customer_phone="9999999999", kitchen_type="GI", referrer_id="partner", assignments=[{"floor_id": "second-floor", "user_id": "staff"}])
    with pytest.raises(HTTPException) as exc:
        await followup_routes.create_notebook_row("second-floor", body, user)
    assert exc.value.status_code == status


def test_notebook_query_rechecks_authorized_stage_and_rejects_a_forged_stage_filter():
    from services.followup_notebook import notebook_query
    user = UserPublic(id="staff", email="staff@example.com", full_name="Worker", role="worker", custom_access=True, floor_ids=["second-floor"])
    object.__setattr__(user, "_custom_notebook_converted", False)
    assert notebook_query(user, "second-floor", {"id": "row", "is_converted": True})["is_converted"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("floor", FLOORS)
async def test_regular_walkin_grant_authorizes_its_picker_and_update_workflow_on_every_floor(monkeypatch, floor):
    from services.access_grants import action_for_api_request
    async def grants(*_args):
        return [{"user_id": "staff", "resource": "walkins", "floor_id": floor, "actions": ["view", "update"]}]
    monkeypatch.setattr(auth, "grants_for_user", grants)
    user = UserPublic(id="staff", email="staff@example.com", full_name="Worker", role="worker", custom_access=True,
                      floor_ids=[floor], active_floor_id=floor)
    for method, path in [("GET", "/api/walkins/config/assignees"), ("POST", "/api/walkins/lead/visit-showroom")]:
        request = Request({"type": "http", "method": method, "path": path, "headers": [], "query_string": b"",
                           "scheme": "http", "server": ("test", 80)})
        assert await auth.authorize_staff_request(user, request) is user
    assert action_for_api_request("POST", "/api/walkins/lead/visit-showroom") == "update"
    request = Request({"type": "http", "method": "GET", "path": "/api/followups/config/assignees", "headers": [],
                       "query_string": b"", "scheme": "http", "server": ("test", 80)})
    with pytest.raises(HTTPException):
        await auth.authorize_staff_request(user, request)
