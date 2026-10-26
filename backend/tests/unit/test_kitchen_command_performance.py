"""Commands reuse their atomically pinned policy without redundant persistence."""
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
