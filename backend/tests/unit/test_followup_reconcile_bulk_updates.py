"""Bound refresh commands without moving insert or audit side effects."""
from __future__ import annotations

import asyncio

import pytest
from pymongo.errors import BulkWriteError, DuplicateKeyError

import services.followup_engine as engine
from tests.unit.test_followup_reconcile_closed_keys import (
    DESIRED_FIELDS, _FakeFollowups, _patch_engine,
)


def open_row(key: str, **fields) -> dict:
    return {
        "id": f"followup-{key}", "source_key": key, "is_automated": True,
        "status": "open", "reason": "Recorded reason", "due_at": "original-due",
        "assigned_to": "assigned-worker", "floor_id": "ground-floor", **fields,
    }


class ObservedFollowups(_FakeFollowups):
    def __init__(self, rows):
        super().__init__(rows)
        self.batch_sizes = []
        self.events = []

    async def bulk_write(self, operations, ordered=True):
        self.batch_sizes.append(len(operations))
        self.events.append(("refresh", [operation._filter["id"] for operation in operations]))
        return await super().bulk_write(operations, ordered=ordered)

    async def insert_one(self, doc, session=None):
        self.events.append(("insert", doc["source_key"]))
        return await super().insert_one(doc, session=session)

    async def update_one(self, query, update, session=None):
        if "status" not in query:
            self.events.append(("resolve", query["id"]))
        return await super().update_one(query, update, session=session)


@pytest.mark.parametrize("count", [0, 100, 500, 501, 1001])
def test_open_refreshes_use_ordered_chunks_and_preserve_human_fields(monkeypatch, count):
    rows = [open_row(str(index)) for index in range(count)]
    followups = ObservedFollowups(rows)
    _patch_engine(monkeypatch, followups)

    result = asyncio.run(engine._persist_desired_followups({
        str(index): dict(DESIRED_FIELDS) for index in range(count)
    }))

    assert followups.batch_sizes == [min(500, count - start) for start in range(0, count, 500)]
    assert result == {"created": 0, "updated": count, "auto_resolved": 0, "active": count}
    for row in rows:
        assert row["reason"] == DESIRED_FIELDS["reason"]
        assert row["due_at"] == "original-due"
        assert row["assigned_to"] == "assigned-worker"
        assert row["floor_id"] == "ground-floor"


@pytest.mark.parametrize("status", ["done", "snoozed"])
def test_human_status_change_after_snapshot_prevents_refresh(monkeypatch, status):
    row = open_row("human")
    followups = ObservedFollowups([row])
    original_bulk = followups.bulk_write

    async def change_status_before_write(operations, ordered=True):
        row["status"] = status
        row["reason"] = "Human-owned reason"
        return await original_bulk(operations, ordered=ordered)

    followups.bulk_write = change_status_before_write
    _patch_engine(monkeypatch, followups)
    result = asyncio.run(engine._persist_desired_followups({"human": dict(DESIRED_FIELDS)}))

    assert result["updated"] == 0
    assert row["status"] == status
    assert row["reason"] == "Human-owned reason"
    assert row["due_at"] == "original-due"
    assert row["assigned_to"] == "assigned-worker"


def test_mixed_writes_keep_duplicate_and_notification_and_resolution_ownership(monkeypatch):
    followups = ObservedFollowups([
        open_row("a"), open_row("b"), open_row("c"),
        open_row("snoozed", status="snoozed"), open_row("closed", status="done"),
        open_row("obsolete", customer_id="old-customer", quotation_id="old-quote"),
    ])
    _patch_engine(monkeypatch, followups)
    original_insert = followups.insert_one

    async def racing_insert(doc, session=None):
        if doc["source_key"] == "raced":
            followups.events.append(("insert", "raced"))
            raise DuplicateKeyError("Concurrent source key insert")
        return await original_insert(doc, session=session)

    async def notify(recipient, _title, **fields):
        followups.events.append(("notify", recipient, fields["floor_id"]))

    async def log_event(**fields):
        followups.events.append(("event", fields["entity_id"], fields["customer_id"], fields["floor_id"]))

    followups.insert_one = racing_insert
    monkeypatch.setattr(engine, "notify", notify)
    monkeypatch.setattr(engine, "log_event", log_event)
    desired = {key: {**DESIRED_FIELDS, "priority_level": "high"}
               for key in ["a", "snoozed", "closed", "raced", "b", "new", "c"]}
    result = asyncio.run(engine._persist_desired_followups(desired, {"q1": "quotation-owner"}))

    assert result == {"created": 1, "updated": 3, "auto_resolved": 1, "active": 7}
    assert followups.events == [
        ("refresh", ["followup-a"]), ("insert", "raced"),
        ("refresh", ["followup-b"]), ("insert", "new"),
        ("notify", "quotation-owner", "ground-floor"),
        ("refresh", ["followup-c"]), ("resolve", "followup-obsolete"),
        ("event", "followup-obsolete", "old-customer", "ground-floor"),
    ]
    assert followups.rows[3]["status"] == "snoozed"
    assert followups.rows[3]["reason"] == "Recorded reason"
    assert followups.rows[4]["status"] == "done"
    assert followups.rows[4]["reason"] == "Recorded reason"


def test_ordered_bulk_failure_preserves_written_prefix_and_stops_later_effects(monkeypatch):
    followups = ObservedFollowups([open_row("a"), open_row("b"), open_row("obsolete")])
    _patch_engine(monkeypatch, followups)

    async def fail_second_write(operations, ordered=True):
        assert ordered is True
        assert len(operations) == 2
        await followups.update_one(operations[0]._filter, operations[0]._doc)
        raise BulkWriteError({"writeErrors": [{"index": 1, "code": 121, "errmsg": "Rejected fixture update"}]})

    async def unexpected_effect(*_args, **_fields):
        pytest.fail("No notification or audit event may precede a successful owning write")

    followups.bulk_write = fail_second_write
    monkeypatch.setattr(engine, "notify", unexpected_effect)
    monkeypatch.setattr(engine, "log_event", unexpected_effect)
    desired = {key: {**DESIRED_FIELDS, "priority_level": "high"} for key in ["a", "b", "new"]}
    with pytest.raises(BulkWriteError):
        asyncio.run(engine._persist_desired_followups(desired, {"q1": "quotation-owner"}))

    assert followups.rows[0]["reason"] == DESIRED_FIELDS["reason"]
    assert followups.rows[1]["reason"] == "Recorded reason"
    assert followups.rows[2]["status"] == "open"
    assert len(followups.rows) == 3
    assert followups.events == []
