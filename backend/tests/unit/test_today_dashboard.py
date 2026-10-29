"""Today is a fresh floor-local work projection, never an analytics grant."""
from datetime import datetime, timezone

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from starlette.requests import Request

import auth
from models import UserPublic
from routes import dashboard_routes, payment_routes
from services import today_dashboard as service
from services.access_grants import delegation_resource_catalog

NOW = datetime(2026, 10, 29, 0, 15, tzinfo=timezone.utc)


def user(role="sales", floor="first-floor", **kwargs):
    return UserPublic(id="staff", full_name="Staff", email="staff@example.com", role=role,
                      floor_ids=["first-floor", "ground-floor", "second-floor", "third-floor"], active_floor_id=floor, **kwargs)


def grant(resource, floor="first-floor", **kwargs):
    return {"user_id": "staff", "resource": resource, "floor_id": floor, "actions": ["view"], **kwargs}


def request(path, method="GET"):
    return Request({"type": "http", "method": method, "path": path, "headers": [], "query_string": b""})


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["admin", "manager", "accounts", "sales", "worker"])
@pytest.mark.parametrize("path", ["/api/sales-analytics/dashboard", "/api/sales-analytics/export.xlsx", "/api/sales-data/summary",
                                  "/api/executive-analytics/dashboard", "/api/analytics/workspaces/sales", "/api/dashboard/stats"])
async def test_direct_sales_urls_are_owner_only_even_with_custom_access(role, path):
    with pytest.raises(HTTPException) as error:
        await auth.authorize_staff_request(user(role, custom_access=True), request(path))
    assert error.value.status_code == 403
    assert await auth.authorize_staff_request(user("owner"), request(path))


@pytest.mark.asyncio
async def test_profile_and_custom_users_can_open_only_safe_today(monkeypatch):
    actor = user("worker", custom_access=True)
    assert await auth.authorize_staff_request(actor, request("/api/dashboard/today")) is actor
    async def grants(*args): return []
    monkeypatch.setattr(auth, "grants_for_user", grants)
    with pytest.raises(HTTPException):
        await auth.authorize_staff_request(actor, request("/api/dashboard/anything-else"))


@pytest.mark.asyncio
async def test_full_floor_requires_every_current_department_on_same_floor(monkeypatch):
    actor = user("worker", custom_access=True)
    grants = [grant(resource) for resource in service.floor_resources("first-floor")]
    async def saved(*args): return grants
    monkeypatch.setattr(service, "grants_for_user", saved)
    enabled, full = await service.access_for(None, actor, "first-floor")
    assert full and "payments" in enabled and "sales_data" not in enabled
    profiled = actor.model_copy(update={"access_profile": "sanitary_purchases"})
    assert await service.access_for(None, profiled, "first-floor") == ({"purchases"}, False)
    grants[:] = [row for row in grants if row["resource"] != "payments"]
    assert not (await service.access_for(None, actor, "first-floor"))[1]
    grants.extend([grant("payments", "ground-floor"), grant("payments", expires_at="2000-01-01T00:00:00Z")])
    assert not (await service.access_for(None, actor, "first-floor"))[1]


@pytest.mark.asyncio
async def test_floor_and_profile_boundaries_fail_closed():
    actor = user("sales").model_copy(update={"floor_ids": ["first-floor"]})
    with pytest.raises(HTTPException): await service.access_for(None, actor, "ground-floor")
    with pytest.raises(HTTPException): service.selected_floor(actor.model_copy(update={"active_floor_id": "ground-floor"}))
    with pytest.raises(HTTPException): service.selected_floor(user("owner", floor=None))
    assert await service.access_for(None, user("manager", access_profile="sanitary_purchases"), "first-floor") == ({"purchases"}, False)
    assert await service.access_for(None, user("sales", floor="second-floor"), "second-floor") == ({"kitchen_projects"}, False)


class Cursor:
    def __init__(self, value): self.value = value
    async def to_list(self, limit): return self.value


class Collection:
    def __init__(self, name, calls): self.name, self.calls = name, calls
    def aggregate(self, pipeline, **kwargs):
        self.calls.append((self.name, pipeline, kwargs))
        assert pipeline[0]["$match"]["floor_id"] == "first-floor"
        if "$facet" not in pipeline[-1]:
            return Cursor([{"_id": "open", "count": 5}]) if self.name != "payments" else Cursor([{"received": 125.5, "count": 2}])
        return Cursor([{"open": [{"count": 100}], "overdue": [{"count": 3}], "due_today": [{"count": 2}], "completed_today": [{"count": 4}],
                        "tasks": [{"id": self.name + str(i), "status": "open", "customer_name": "Work", "due_at": NOW,
                                   "amount": 999, "value": 999, "customer_phone": "private"} for i in range(25)]}])


class Database:
    def __init__(self): self.calls = []
    def __getitem__(self, key): return Collection(key, self.calls)
    def __getattr__(self, key): return self[key]


@pytest.mark.asyncio
async def test_department_dto_has_only_permitted_tasks_and_complete_counts(monkeypatch):
    async def grants(*args): return [grant("purchases")]
    monkeypatch.setattr(service, "grants_for_user", grants)
    db = Database()
    result = await service.today_dashboard(db, user("worker", custom_access=True), NOW)
    assert not result["full_floor_access"] and result["payments"] is None and result["workflows"] == []
    assert result["task_summary"] == {"open": 200, "overdue": 6, "due_today": 4, "completed_today": 8}
    assert result["truncated"] and len(result["tasks"]) == 24
    assert [name for name, _, _ in db.calls] == ["purchase_orders", "purchase_shortages"]
    assert all(task["resource"] == "purchases" and "amount" not in task and "customer_phone" not in task for task in result["tasks"])
    assert "assigned_to" not in db.calls[0][1][0]["$match"]
    assert db.calls[0][2] == {"maxTimeMS": 5000}
    due_filter = db.calls[0][1][-1]["$facet"]["due_today"][0]["$match"]["due_at"]
    assert due_filter == {"$gte": datetime(2026, 10, 28, 18, 30, tzinfo=timezone.utc), "$lt": datetime(2026, 10, 29, 18, 30, tzinfo=timezone.utc)}


@pytest.mark.asyncio
async def test_owner_summary_sums_all_queues_but_preview_stays_bounded():
    db = Database()
    result = await service.today_dashboard(db, user("owner"), NOW)
    assert result["full_floor_access"] and result["task_summary"]["open"] == 700
    assert len(result["tasks"]) == 24
    assert result["payments"] is None
    overview = await service.today_overview(db, user("owner"), NOW)
    assert overview["payments"] == {"currency": "INR", "received_today": 125.5, "receipt_count": 2}
    assert result["unavailable_sections"] == []
    assert all(pipeline[0]["$match"]["floor_id"] == "first-floor" for _, pipeline, _ in db.calls)


@pytest.mark.asyncio
async def test_optional_financial_failure_keeps_tasks_without_fake_zero(monkeypatch):
    async def fail(*args): raise RuntimeError("unavailable")
    monkeypatch.setattr(service, "receipt_totals", fail)
    result = await service.today_overview(Database(), user("owner"), NOW)
    assert result["payments"] is None and result["unavailable_sections"] == ["payments"]


@pytest.mark.asyncio
async def test_kitchen_dates_and_progress_are_projected_without_history(monkeypatch):
    db = Database()
    def aggregate(self, pipeline, **kwargs):
        db.calls.append((self.name, pipeline, kwargs))
        return Cursor([{"tasks": [{"id": "project", "stage": "cad", "cad": {"progress": 43}, "customer": {"name": "Kitchen customer"}, "due_at": NOW}], "open": [{"count": 1}]}])
    monkeypatch.setattr(Collection, "aggregate", aggregate)
    result = await service.today_dashboard(db, user("sales", "second-floor"), NOW)
    assert result["tasks"][0]["progress"] == 43 and result["tasks"][0]["href"] == "/kitchen/project/stages/cad"
    assert result["task_summary"]["open"] == 1
    pipeline = db.calls[0][1]
    assert pipeline[0]["$match"]["floor_id"] == "second-floor"
    assert pipeline[1]["$set"]["due_at"]["$dateFromString"]["timezone"] == "Asia/Kolkata"
    projection = pipeline[-1]["$facet"]["tasks"][-1]["$project"]
    assert "orders" not in projection and "attachments" not in projection and result["payments"] is None


@pytest.mark.asyncio
async def test_http_today_enforces_auth_floor_and_no_store(monkeypatch):
    app = FastAPI()
    app.include_router(dashboard_routes.router, prefix="/api")
    role = ["sales"]
    async def principal(*args, **kwargs): return user(role[0]).model_dump() | {"floor_ids": ["first-floor"]}
    monkeypatch.setattr(auth, "decode_token", lambda token: {"sub": "staff", "kind": "staff", "session_id": "session"})
    monkeypatch.setattr(auth, "_load_active_principal", principal)
    monkeypatch.setattr(dashboard_routes, "db", Database())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        denied = await client.get("/api/dashboard/today", headers={"Authorization": "Bearer test", "X-Floor-Id": "ground-floor"})
        assert denied.status_code == 403
        result = await client.get("/api/dashboard/today", headers={"Authorization": "Bearer test", "X-Floor-Id": "first-floor"})
        assert result.status_code == 200, result.text
        assert result.headers["cache-control"] == "no-store" and result.json()["floor_id"] == "first-floor"
        assert result.json()["payments"] is None
        overview = await client.get("/api/dashboard/today/overview", headers={"Authorization": "Bearer test", "X-Floor-Id": "first-floor"})
        assert overview.status_code == 403
        denied = await client.get("/api/dashboard/stats", headers={"Authorization": "Bearer test", "X-Floor-Id": "first-floor"})
        assert denied.status_code == 403
        role[0] = "owner"
        overview = await client.get("/api/dashboard/today/overview", headers={"Authorization": "Bearer test", "X-Floor-Id": "first-floor"})
        assert overview.status_code == 200 and overview.headers["cache-control"] == "no-store"
        assert overview.json()["floor_id"] == "first-floor" and overview.json()["payments"]["currency"] == "INR"


def test_payment_workspace_does_not_union_another_assigned_floor():
    assert payment_routes._payment_scope_query(user("manager"), {"status": "ordered"}) == {
        "$and": [{"floor_id": {"$in": ["first-floor"]}}, {"status": "ordered"}]}


def test_sales_data_cannot_be_newly_assigned():
    resource = next(row for row in delegation_resource_catalog(["first-floor"]) if row["key"] == "sales_data")
    assert resource["assignable_floor_ids"] == []


@pytest.mark.asyncio
async def test_owner_payment_history_without_selected_floor_is_422(monkeypatch):
    app = FastAPI()
    app.include_router(payment_routes.router, prefix="/api")
    async def principal(*args, **kwargs): return user("owner", floor=None).model_dump()
    monkeypatch.setattr(auth, "decode_token", lambda token: {"sub": "staff", "kind": "staff", "session_id": "session"})
    monkeypatch.setattr(auth, "_load_active_principal", principal)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        result = await client.get("/api/payments/history", headers={"Authorization": "Bearer test"})
    assert result.status_code == 422
    assert result.json()["detail"] == "Choose a floor to view its payments"


@pytest.mark.asyncio
async def test_primary_tasks_never_wait_for_optional_overview(monkeypatch):
    async def forbidden(*args): raise AssertionError("Primary tasks must not read optional totals")
    monkeypatch.setattr(service, "workflow_counts", forbidden)
    monkeypatch.setattr(service, "receipt_totals", forbidden)
    assert (await service.today_dashboard(Database(), user("owner"), NOW))["tasks"]
    with pytest.raises(HTTPException) as error:
        await service.today_overview(Database(), user("sales"), NOW)
    assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_accounts_and_stock_grants_have_safe_actionable_queues(monkeypatch):
    actor = user("worker", custom_access=True)
    for resource, collection in [("payments", "quotations"), ("godown_stock", "purchase_transfers")]:
        async def grants(*args): return [grant(resource)]
        monkeypatch.setattr(service, "grants_for_user", grants)
        db = Database()
        result = await service.today_dashboard(db, actor, NOW)
        assert result["tasks"] and {task["resource"] for task in result["tasks"]} == {resource}
        assert [name for name, _, _ in db.calls] == [collection]
        assert result["payments"] is None and result["workflows"] == []
        assert all("collection_paid" not in task and "collection_total" not in task for task in result["tasks"])
