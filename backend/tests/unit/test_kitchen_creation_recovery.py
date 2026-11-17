"""Interrupted lead acknowledgements are reconciled by operation, never contact."""
import asyncio

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from auth import get_current_user
from models import UserPublic
from routes import kitchen_routes
from tests.unit.test_kitchen_projects import create_request, setup


@pytest.mark.asyncio
async def test_lost_create_response_can_be_confirmed_without_writing_or_taking_create_lock(setup, monkeypatch):
    database, service, owner = setup
    monkeypatch.setattr(kitchen_routes, "db", database)
    app = FastAPI()
    app.include_router(kitchen_routes.router)
    app.dependency_overrides[get_current_user] = lambda: owner
    body = {"customer_id": "customer-a", "idempotency_key": "lost-response-recovery"}

    class LostAcknowledgement(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            await httpx.ASGITransport(app=app).handle_async_request(request)
            raise httpx.ReadError("Synthetic connection loss after database commit", request=request)

    async with httpx.AsyncClient(transport=LostAcknowledgement(), base_url="http://test") as client:
        with pytest.raises(httpx.ReadError):
            await client.post("/kitchen-projects", json=body)
    assert len(database.kitchen_projects.rows) == 1
    assert database.kitchen_configuration.rows[0]["active_command_count"] == 0
    assert database.kitchen_configuration.rows[0]["command_admissions"] == {}
    # A separate active or crashed intake cannot hide this durable receipt.
    database.kitchen_configuration.rows[0]["active_create_token"] = "another-intake"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/kitchen-projects/creation-status", params={"key": body["idempotency_key"]})
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        recovered = response.json()["project"]
        assert recovered["id"] == database.kitchen_projects.rows[0]["id"] and recovered["replayed"]
        assert "creation_fingerprint" not in recovered and "command_receipts" not in recovered
        assert database.kitchen_configuration.rows[0]["active_create_token"] == "another-intake"
        del database.kitchen_configuration.rows[0]["active_create_token"]
        retry = await client.post("/kitchen-projects", json=body)
        assert retry.status_code == 200 and retry.json()["id"] == recovered["id"] and retry.json()["replayed"]
        changed = await client.post("/kitchen-projects", json={**body, "lead": {"notes": "Changed intent"}})
        assert changed.status_code == 409
        invalid_key = await client.get("/kitchen-projects/creation-status", params={"key": "invalid/key"})
        assert invalid_key.status_code == 422
    assert len(database.kitchen_projects.rows) == 1


@pytest.mark.asyncio
async def test_creation_status_absence_is_safe_while_original_request_can_still_commit(setup, monkeypatch):
    database, service, owner = setup
    body = create_request(customer_id="customer-a", idempotency_key="pending-response-recovery")
    inserting, finish = asyncio.Event(), asyncio.Event()
    original = database.kitchen_projects.insert_one

    async def paused_insert(document):
        inserting.set()
        await finish.wait()
        await original(document)

    monkeypatch.setattr(database.kitchen_projects, "insert_one", paused_insert)
    request = asyncio.create_task(service.create(owner, body))
    try:
        await asyncio.wait_for(inserting.wait(), 1)
        assert await service.creation_status(owner, body.idempotency_key) == {"project": None}
    finally:
        finish.set()
    result = await asyncio.wait_for(request, 1)
    confirmed = await service.creation_status(owner, body.idempotency_key)
    assert confirmed["project"]["id"] == result["id"]
    assert (await service.create(owner, body))["id"] == result["id"]
    assert len(database.kitchen_projects.rows) == 1


@pytest.mark.asyncio
async def test_creation_status_enforces_actor_floor_current_permissions_and_receipt(setup):
    database, service, owner = setup
    body = create_request(customer_id="customer-a", idempotency_key="private-response-recovery")
    first = await service.create(owner, body)
    other = UserPublic(id="other-owner", full_name="Other owner", role="owner", active_floor_id="second-floor")
    assert await service.creation_status(other, body.idempotency_key) == {"project": None}
    for updates in ({"active_floor_id": "first-floor"}, {"active": False}):
        with pytest.raises(HTTPException) as denied:
            await service.creation_status(owner.model_copy(update=updates), body.idempotency_key)
        assert denied.value.status_code == 403
    database.kitchen_projects.rows[0]["deleted_at"] = "2026-11-17T00:00:00Z"
    result = (await service.creation_status(owner, body.idempotency_key))["project"]
    assert result == {"id": first["id"], "stage": "lead", "version": 1, "access_handoff": True, "replayed": True}
    database.kitchen_projects.rows[0]["command_receipts"] = []
    with pytest.raises(HTTPException) as invalid:
        await service.creation_status(owner, body.idempotency_key)
    assert invalid.value.status_code == 409


@pytest.mark.asyncio
async def test_inline_customer_receipt_reuses_only_the_same_actor_operation_and_body(setup, monkeypatch):
    database, service, owner = setup
    body = create_request(customer={"name": "Same person label", "phone": "9000000000", "address": "Separate site"},
                          idempotency_key="new-contact-operation")
    original = database.kitchen_projects.insert_one

    async def interrupted(_document):
        raise ConnectionError("Synthetic project insert interruption")

    monkeypatch.setattr(database.kitchen_projects, "insert_one", interrupted)
    with pytest.raises(ConnectionError):
        await service.create(owner, body)
    assert len(database.customers.rows) == 2 and not database.kitchen_projects.rows
    customer_id = database.customers.rows[-1]["id"]
    changed = body.model_copy(update={"lead": body.lead.model_copy(update={"notes": "Changed after uncertain insert"})})
    with pytest.raises(HTTPException) as conflict:
        await service.create(owner, changed)
    assert conflict.value.status_code == 409 and len(database.customers.rows) == 2
    monkeypatch.setattr(database.kitchen_projects, "insert_one", original)
    first = await service.create(owner, body)
    assert first["customer_id"] == customer_id and len(database.customers.rows) == 2
    other = owner.model_copy(update={"id": "another-owner"})
    second = await service.create(other, body)
    assert second["id"] != first["id"] and second["customer_id"] != first["customer_id"]
    assert len(database.customers.rows) == 3
    assert "kitchen_creation_fingerprint" not in first["customer"]
    assert "kitchen_creation_project_id" not in first["customer"]
    explicit = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="existing-contact-operation"))
    assert explicit["customer_id"] == "customer-a" and len(database.customers.rows) == 3


@pytest.mark.asyncio
async def test_create_trace_is_correlatable_and_redacts_customer_key_and_exception_text(setup, monkeypatch, caplog):
    database, service, owner = setup
    monkeypatch.setattr(kitchen_routes, "db", database)
    caplog.set_level("INFO", logger="forge.kitchen")
    body = create_request(customer={"name": "Private customer name", "phone": "9005556677", "address": "Private address"},
                          idempotency_key="private-original-key")
    first = await kitchen_routes.create_project(body, user=owner)
    replay = await kitchen_routes.create_project(body, user=owner)
    assert first["id"] == replay["id"]
    messages = [row.getMessage() for row in caplog.records if row.name == "forge.kitchen"]
    assert len(messages) == 4
    identifiers = [message.split("operation=")[1].split()[0] for message in messages]
    assert len(set(identifiers)) == 1 and len(identifiers[0]) == 16
    assert "outcome=confirmed" in messages[1] and "replayed=True" in messages[3]

    async def unavailable(_document):
        raise ConnectionError("Private exception detail")

    monkeypatch.setattr(database.kitchen_projects, "insert_one", unavailable)
    with pytest.raises(ConnectionError):
        await kitchen_routes.create_project(body.model_copy(update={"idempotency_key": "another-private-key"}), user=owner)
    assert "outcome=unconfirmed" in caplog.records[-1].getMessage()
    assert "error_type=ConnectionError" in caplog.records[-1].getMessage()
    for secret in ("Private customer name", "9005556677", "Private address", "private-original-key", "another-private-key", "Private exception detail"):
        assert secret not in caplog.text
