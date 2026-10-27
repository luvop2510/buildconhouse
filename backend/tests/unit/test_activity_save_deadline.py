"""A best-effort timeline outage must not hold a committed customer save."""
import asyncio
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from models import UserPublic
from routes import customer_routes
from services import activity_log


class Customers:
    def __init__(self):
        self.doc = {"id": "synthetic-customer", "name": "Before", "floor_id": "ground-floor"}
        self.writes = 0

    async def find_one(self, *_args, **_kwargs):
        return dict(self.doc)

    async def update_one(self, _query, update):
        self.writes += 1
        self.doc.update(update["$set"])


@pytest.mark.asyncio
async def test_committed_customer_patch_returns_during_activity_outage(monkeypatch):
    customers = Customers()
    cancelled = asyncio.Event()

    async def stalled_insert(_doc):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(customer_routes, "db", SimpleNamespace(customers=customers))
    monkeypatch.setattr(activity_log, "db", SimpleNamespace(activity_events=SimpleNamespace(insert_one=stalled_insert)))
    app = FastAPI()
    app.include_router(customer_routes.router)
    route = next(route for route in customer_routes.router.routes if getattr(route, "path", None) == "/customers/{customer_id}" and "PATCH" in route.methods)
    user = UserPublic(email="qa@example.com", full_name="Synthetic QA", role="owner", active_floor_id="ground-floor")
    app.dependency_overrides[route.dependant.dependencies[0].call] = lambda: user
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await asyncio.wait_for(client.patch("/customers/synthetic-customer", json={"name": "Saved"}), timeout=1.8)
    assert response.status_code == 200
    assert response.json()["name"] == customers.doc["name"] == "Saved"
    assert customers.writes == 1
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_activity_retains_success_and_does_not_swallow_cancellation(monkeypatch):
    rows = []

    async def insert(doc):
        rows.append(doc)

    monkeypatch.setattr(activity_log, "db", SimpleNamespace(activity_events=SimpleNamespace(insert_one=insert)))
    event = await activity_log.log_event(event_type="customer.updated", entity_type="customer", entity_id="synthetic", floor_id="ground-floor")
    assert event.id == rows[0]["id"]
    assert rows[0]["floor_id"] == "ground-floor"

    async def cancel(_doc):
        raise asyncio.CancelledError()

    monkeypatch.setattr(activity_log, "db", SimpleNamespace(activity_events=SimpleNamespace(insert_one=cancel)))
    with pytest.raises(asyncio.CancelledError):
        await activity_log.log_event(event_type="customer.updated", entity_type="customer", entity_id="synthetic")
