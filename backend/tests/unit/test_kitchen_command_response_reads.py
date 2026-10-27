"""Response enrichment cannot turn committed Next navigation into a timeout."""
import asyncio

import httpx
import pytest
from fastapi import FastAPI

from auth import get_current_user
from routes import kitchen_routes
from services import kitchen_projects
from tests.unit.test_kitchen_projects import create_request, setup


@pytest.mark.asyncio
@pytest.mark.parametrize(("stage", "target"), [
    ("quotation", "order"), ("order", "production"), ("production", "installation"),
])
async def test_next_response_hydration_times_out_before_commit_and_releases_admission(setup, monkeypatch, stage, target):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="next-read-create"))
    saved = database.kitchen_projects.rows[0]
    saved["stage"] = stage
    receipts = list(saved["command_receipts"])
    original_customers = kitchen_projects.KitchenProjectService._current_customers

    original_timeout = asyncio.timeout
    monkeypatch.setattr(kitchen_projects.asyncio, "timeout", lambda _seconds: original_timeout(0.025))

    async def stalled_customers(self, _ids):
        await asyncio.Event().wait()

    monkeypatch.setattr(kitchen_projects.KitchenProjectService, "_current_customers", stalled_customers)
    monkeypatch.setattr(kitchen_routes, "db", database)
    app = FastAPI()
    app.include_router(kitchen_routes.router)
    app.dependency_overrides[get_current_user] = lambda: owner
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await asyncio.wait_for(client.post(f"/kitchen-projects/{project['id']}/commands", json={
            "expected_version": project["version"], "idempotency_key": "next-read-command",
            "command": "move_stage", "payload": {"target_stage": target},
        }), timeout=0.3)
    assert response.status_code == 503
    assert database.kitchen_projects.rows[0]["stage"] == stage
    assert database.kitchen_projects.rows[0]["version"] == project["version"]
    assert database.kitchen_projects.rows[0]["command_receipts"] == receipts
    assert database.kitchen_configuration.rows[0]["active_command_count"] == 0
    assert database.kitchen_configuration.rows[0]["command_admissions"] == {}

    monkeypatch.setattr(kitchen_projects.KitchenProjectService, "_current_customers", original_customers)
    database.customers.rows[0]["name"] = "Current customer name"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        body = {"expected_version": project["version"], "idempotency_key": "next-read-command",
                "command": "move_stage", "payload": {"target_stage": target}}
        retry = await client.post(f"/kitchen-projects/{project['id']}/commands", json=body)
        replay = await client.post(f"/kitchen-projects/{project['id']}/commands", json=body)
    assert retry.status_code == replay.status_code == 200
    assert retry.json()["customer"]["name"] == "Current customer name"
    assert retry.json()["stage"] == replay.json()["stage"] == target
    assert retry.json()["version"] == replay.json()["version"] == project["version"] + 1
    assert replay.json()["replayed"]
    assert len(database.kitchen_projects.rows[0]["command_receipts"]) == len(receipts) + 1
