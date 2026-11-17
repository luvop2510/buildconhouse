"""Stage interactions: preserve projects, ordered persistence and authorization."""
import asyncio
import copy
import importlib
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError

from models import UserPublic
from models_kitchen import STAGES
from services import kitchen_access as access
from services.kitchen_stage_followups import CreateStageFollowup, KitchenStageFollowups


def matches(row, selector):
    return all(row.get(key) in value["$in"] if isinstance(value, dict) and "$in" in value
               else row.get(key) == value for key, value in selector.items())


class Cursor:
    def __init__(self, rows):
        self.rows = copy.deepcopy(rows)
    def sort(self, order):
        for key, direction in reversed(order):
            self.rows.sort(key=lambda row: row[key], reverse=direction < 0)
        return self
    def skip(self, count):
        self.rows = self.rows[count:]
        return self
    def limit(self, count):
        self.rows = self.rows[:count]
        return self
    def max_time_ms(self, _):
        return self
    async def to_list(self, count):
        return self.rows[:count]


class Collection:
    def __init__(self, rows=()):
        self.rows = list(copy.deepcopy(rows))
    async def find_one(self, selector, sort=None):
        rows = [row for row in self.rows if matches(row, selector)]
        if sort:
            rows = Cursor(rows).sort(sort).rows
        await asyncio.sleep(0)
        return copy.deepcopy(rows[0]) if rows else None
    def find(self, selector, _projection=None):
        return Cursor([row for row in self.rows if matches(row, selector)])
    async def count_documents(self, selector, **_):
        return sum(matches(row, selector) for row in self.rows)
    async def insert_one(self, row):
        await asyncio.sleep(0)
        if any(existing["_id"] == row["_id"] or
               (existing["project_id"], existing["stage"], existing["number"]) ==
               (row["project_id"], row["stage"], row["number"]) for existing in self.rows):
            raise DuplicateKeyError("concurrent entry")
        self.rows.append(copy.deepcopy(row))
        row["_id"] = "driver-mutated-object-id"


@pytest.fixture
def env(monkeypatch):
    @asynccontextmanager
    async def admission(self, user, action, **kwargs):
        yield {}
    monkeypatch.setattr("services.kitchen_projects.KitchenProjectService.admission", admission)
    project = {"id": "project-a", "customer_id": "customer-a", "floor_id": "second-floor", "stage": "lead", "version": 7}
    database = SimpleNamespace(kitchen_projects=Collection([project]), kitchen_stage_followups=Collection())
    user = UserPublic(id="owner", full_name="Owner", role="owner", active_floor_id="second-floor")
    return KitchenStageFollowups(database), database, user


def body(stage="lead", key="followup:1", **changes):
    return CreateStageFollowup(stage=stage, date="2026-10-02", interaction_type="Call", notes="Called about materials", idempotency_key=key, **changes)


@pytest.mark.asyncio
async def test_every_stage_persists_independent_sequential_entries_without_changing_project(env):
    service, database, user = env
    original = copy.deepcopy(database.kitchen_projects.rows)
    for stage in STAGES:
        for number in range(1, 4):
            record = await service.create(user, "project-a", body(stage, f"followup:{stage}:{number}"))
            assert record["number"] == number
            assert record["date"] == "2026-10-02"
            assert record["notes"] == "Called about materials"
            assert record["interaction_type"] == "Call"
            assert record["customer_id"] == "customer-a"
            assert "request_fingerprint" not in record and "_id" not in record
        history = await service.list(user, "project-a", stage=stage)
        assert history["total"] == 3
        assert [row["number"] for row in history["rows"]] == [3, 2, 1]
    assert database.kitchen_projects.rows == original
    database.kitchen_projects.rows[0]["stage"] = "completed"
    assert (await service.list(user, "project-a"))["total"] == len(STAGES) * 3


@pytest.mark.asyncio
async def test_uncertain_retry_and_concurrent_clicks_do_not_duplicate_or_overwrite(env):
    service, database, user = env
    same = await asyncio.gather(*(service.create(user, "project-a", body()) for _ in range(5)))
    assert {row["number"] for row in same} == {1}
    assert len(database.kitchen_stage_followups.rows) == 1
    different = await asyncio.gather(*(service.create(user, "project-a", body(key=f"followup:other:{n}")) for n in range(5)))
    assert sorted(row["number"] for row in different) == [2, 3, 4, 5, 6]
    changed = body().model_copy(update={"notes": "Changed after uncertain response"})
    with pytest.raises(HTTPException) as error:
        await service.create(user, "project-a", changed)
    assert error.value.status_code == 409
    assert len(database.kitchen_stage_followups.rows) == 6


@pytest.mark.asyncio
async def test_pagination_retains_all_records_and_customer_project_isolation(env):
    service, database, user = env
    for index in range(35):
        await service.create(user, "project-a", body(key=f"followup:{index}"))
    first = await service.list(user, "project-a", stage="lead", limit=30)
    second = await service.list(user, "project-a", stage="lead", page=2, limit=30)
    assert first["total"] == second["total"] == 35
    assert len({row["id"] for row in first["rows"] + second["rows"]}) == 35
    database.kitchen_projects.rows.append({"id": "project-b", "customer_id": "customer-b", "floor_id": "second-floor", "stage": "lead"})
    assert (await service.list(user, "project-b"))["total"] == 0


@pytest.mark.asyncio
async def test_other_floor_and_missing_project_are_denied(env):
    service, _, user = env
    with pytest.raises(HTTPException) as error:
        await service.create(user.model_copy(update={"active_floor_id": "first-floor"}), "project-a", body())
    assert error.value.status_code == 403
    with pytest.raises(HTTPException) as error:
        await service.list(user, "unknown")
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_stage_scopes_and_restricted_notes_apply_to_direct_reads_and_writes(env, monkeypatch):
    service, database, owner = env
    await service.create(owner, "project-a", body())
    await service.create(owner, "project-a", body("design", "followup:design"))
    staff = owner.model_copy(update={"role": "sales", "custom_access": True})
    async def capability(db, user, action, stage=None):
        object.__setattr__(user, "_kitchen_stage_actions", {"view": ["lead"], "update": ["lead"]})
        object.__setattr__(user, "_kitchen_semantic_actions", {"view": ["lead"], "update": ["lead"]})
        object.__setattr__(user, "_kitchen_restricted", True)
        return True
    monkeypatch.setattr(access, "capability", capability)
    history = await service.list(staff, "project-a")
    assert history["total"] == 1 and history["rows"][0]["notes"] is None
    for operation in (service.list(staff, "project-a", stage="design"), service.create(staff, "project-a", body("design", "followup:denied"))):
        with pytest.raises(HTTPException) as error:
            await operation
        assert error.value.status_code == 403
    assert len(database.kitchen_stage_followups.rows) == 2


@pytest.mark.parametrize("patch", [{"date": ""}, {"date": "2026-02-30"}, {"date": None}, {"interaction_type": "WhatsApp"}, {"notes": "two\nlines"}, {"notes": "a" * 251}, {"number": 8}, {"customer_id": "forged"}])
def test_validation_requires_explicit_calendar_date_and_exact_interaction_types(patch):
    values = {"stage": "lead", "date": "2026-10-02", "notes": "", "interaction_type": "Visit", "idempotency_key": "followup:1"}
    with pytest.raises(ValidationError):
        CreateStageFollowup(**{**values, **patch})


@pytest.mark.asyncio
async def test_migration_is_additive_and_repeat_safe():
    indexes = {}
    async def create_index(keys, **options):
        indexes[options["name"]] = (keys, options)
    database = SimpleNamespace(kitchen_stage_followups=SimpleNamespace(create_index=create_index))
    migration = importlib.import_module("migrations.0045_kitchen_stage_followups")
    await migration.up(database)
    await migration.up(database)
    assert len(indexes) == 3
    assert indexes["kitchen_followups_sequence"][1]["unique"] is True
