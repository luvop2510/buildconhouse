"""Commands reuse their atomically pinned policy without redundant persistence."""
import asyncio

import pytest
from fastapi import HTTPException

from services.kitchen_projects import POLICY_ID
from tests.unit.test_kitchen_projects import cmd, create_request, setup


@pytest.mark.asyncio
async def test_stage_move_reads_policy_once_without_duplicate_insert(setup, monkeypatch):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="performance-create"))
    reads = []
    find = database.kitchen_configuration.find_one
    async def find_policy(*args, **kwargs):
        reads.append(args[0])
        return await find(*args, **kwargs)
    async def duplicate_insert(_):
        raise AssertionError("An existing policy needs no baseline insert")
    monkeypatch.setattr(database.kitchen_configuration, "find_one", find_policy)
    monkeypatch.setattr(database.kitchen_configuration, "insert_one", duplicate_insert)
    moved = await service.command(owner, project["id"], cmd(project["version"], "move_stage", {"target_stage": "visit"}))
    assert moved["stage"] == "visit" and moved["version"] == project["version"] + 1
    assert reads == [{"_id": POLICY_ID}]
    assert database.kitchen_configuration.rows[0]["active_command_count"] == 0
    assert database.kitchen_configuration.rows[0]["command_admissions"] == {}


@pytest.mark.asyncio
async def test_stage_move_overlaps_project_read_with_policy_admission(setup, monkeypatch):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="overlap-create"))
    reading = asyncio.Event()
    admitted = asyncio.Event()
    find = database.kitchen_projects.find_one
    update = database.kitchen_configuration.update_one

    async def read_project(*args, **kwargs):
        reading.set()
        await admitted.wait()
        return await find(*args, **kwargs)

    async def admit(query, changes):
        if changes.get("$inc", {}).get("active_command_count") == 1:
            await reading.wait()
            admitted.set()
        return await update(query, changes)

    monkeypatch.setattr(database.kitchen_projects, "find_one", read_project)
    monkeypatch.setattr(database.kitchen_configuration, "update_one", admit)
    moved = await asyncio.wait_for(service.command(owner, project["id"],
        cmd(project["version"], "move_stage", {"target_stage": "visit"})), timeout=0.5)
    assert moved["stage"] == "visit"
    assert database.kitchen_configuration.rows[0]["active_command_count"] == 0


@pytest.mark.asyncio
async def test_failed_admission_cancels_overlapped_project_read(setup, monkeypatch):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="overlap-denied"))
    reading = asyncio.Event()
    cancelled = asyncio.Event()

    async def read_project(*_args, **_kwargs):
        reading.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async def failed_policy(**_kwargs):
        await reading.wait()
        raise HTTPException(503, "Policy unavailable")

    monkeypatch.setattr(database.kitchen_projects, "find_one", read_project)
    monkeypatch.setattr(service, "policy", failed_policy)
    with pytest.raises(HTTPException) as rejected:
        await service.command(owner, project["id"], cmd(project["version"], "move_stage", {"target_stage": "visit"}))
    assert rejected.value.status_code == 503
    assert cancelled.is_set()
    assert database.kitchen_projects.rows[0]["version"] == project["version"]


@pytest.mark.asyncio
async def test_project_changed_during_overlapped_admission_still_loses_cas(setup, monkeypatch):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="overlap-stale"))
    reading = asyncio.Event()
    admitted = asyncio.Event()
    find = database.kitchen_projects.find_one
    update = database.kitchen_configuration.update_one

    async def read_project(*args, **kwargs):
        snapshot = await find(*args, **kwargs)
        reading.set()
        await admitted.wait()
        return snapshot

    async def admit(query, changes):
        if changes.get("$inc", {}).get("active_command_count") == 1:
            await reading.wait()
            stored = database.kitchen_projects.rows[0]
            stored["version"] += 1
            stored["lead"]["site_location"] = "Updated by another member"
            admitted.set()
        return await update(query, changes)

    monkeypatch.setattr(database.kitchen_projects, "find_one", read_project)
    monkeypatch.setattr(database.kitchen_configuration, "update_one", admit)
    with pytest.raises(HTTPException) as rejected:
        await asyncio.wait_for(service.command(owner, project["id"],
            cmd(project["version"], "move_stage", {"target_stage": "visit"})), timeout=0.5)
    assert rejected.value.status_code == 409
    saved = database.kitchen_projects.rows[0]
    assert saved["stage"] == "lead" and saved["lead"]["site_location"] == "Updated by another member"
    assert len(saved["command_receipts"]) == 1
    assert database.kitchen_configuration.rows[0]["active_command_count"] == 0


@pytest.mark.asyncio
async def test_changed_policy_between_read_and_admission_still_rejects(setup, monkeypatch):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="policy-race-create"))
    original = database.kitchen_configuration.update_one
    async def changed_before_admission(query, update):
        if update.get("$inc", {}).get("active_command_count") == 1:
            database.kitchen_configuration.rows[0]["version"] += 1
        return await original(query, update)
    monkeypatch.setattr(database.kitchen_configuration, "update_one", changed_before_admission)
    with pytest.raises(HTTPException) as rejected:
        await service.command(owner, project["id"], cmd(project["version"], "move_stage", {"target_stage": "visit"}))
    assert rejected.value.status_code == 409
    assert database.kitchen_projects.rows[0]["stage"] == "lead"
    assert database.kitchen_configuration.rows[0]["active_command_count"] == 0


@pytest.mark.asyncio
async def test_project_detail_reuses_policy_and_preserves_duplicate_scope(setup, monkeypatch):
    database, service, owner = setup
    first = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="detail-first"))
    other = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="detail-other"))
    reads = []
    original = database.kitchen_configuration.find_one
    async def find_policy(*args, **kwargs):
        reads.append(args[0])
        return await original(*args, **kwargs)
    monkeypatch.setattr(database.kitchen_configuration, "find_one", find_policy)
    result = await service.get(owner, first["id"])
    assert reads == [{"_id": POLICY_ID}]
    assert result["permissions"]["can_update"]
    assert {row["id"] for row in result["duplicate_candidates"]} == {other["id"]}
    owner.active = False
    with pytest.raises(HTTPException) as rejected:
        await service.get(owner, first["id"])
    assert rejected.value.status_code == 403
