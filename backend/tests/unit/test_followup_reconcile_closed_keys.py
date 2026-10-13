"""A closed automated follow-up must not abort reconciliation.

`followups.source_key` is uniquely indexed across every status, but the
reconciler only read `open`/`snoozed` rows before deciding what to insert. Any
trigger whose condition still held after a human marked the card done therefore
produced a duplicate insert, E11000 propagated out of
`_reconcile_followups_locked`, and the whole pass died — no cards created, none
auto-resolved. All 15 mutation routes fire this fire-and-forget, so the only
visible symptom was one startup WARNING:

    Initial follow-up reconciliation skipped: E11000 duplicate key error
    collection: buildcon_house.followups index: followups_source_key_unique
    dup key: { source_key: "quotation_new:f9552cd6-..." }

Reproduced against live `buildcon_house`, which had 83 completed automated
follow-ups holding source keys at the time.
"""
from __future__ import annotations

import asyncio

from pymongo.errors import DuplicateKeyError

import services.followup_engine as engine


class _FakeFollowups:
    """Enforces the real unique index on `source_key`."""

    def __init__(self, rows: list[dict]):
        self.rows = rows

    def find(self, query, projection=None):
        return _Cursor([r for r in self.rows if _matches(r, query)])

    async def insert_one(self, doc, session=None):
        if any(r.get("source_key") == doc.get("source_key") for r in self.rows):
            raise DuplicateKeyError(
                f"E11000 duplicate key error ... source_key: {doc.get('source_key')!r}"
            )
        self.rows.append(doc)

    async def update_one(self, query, update, session=None):
        for row in self.rows:
            if _matches(row, query):
                row.update(update.get("$set", {}))
                return

    async def update_many(self, query, update, session=None):
        return None


def _matches(row: dict, query: dict) -> bool:
    for key, want in query.items():
        have = row.get(key)
        if isinstance(want, dict):
            if "$in" in want and have not in want["$in"]:
                return False
            if "$nin" in want and have in want["$nin"]:
                return False
            if "$ne" in want and have == want["$ne"]:
                return False
        elif have != want:
            return False
    return True


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    async def to_list(self, _limit):
        return list(self._rows)

    def __aiter__(self):
        async def gen():
            for row in list(self._rows):
                yield row
        return gen()


def _patch_engine(monkeypatch, followups: _FakeFollowups):
    """Drives only the persist half of the reconciler — the desired-state half
    needs the entire quotation/payment/purchase corpus and is covered elsewhere."""
    class _Empty:
        def find(self, *_a, **_k):
            return _Cursor([])

        async def count_documents(self, *_a, **_k):
            return 0

    class _Db:
        def __init__(self):
            self.followups = followups
            self.customers = _Empty()
            self.quotations = _Empty()
            self.purchase_orders = _Empty()
            self.walkins = _Empty()
            self.purchase_shortages = _Empty()

    monkeypatch.setattr(engine, "db", _Db())


DESIRED_FIELDS = {
    "customer_id": "c1", "customer_name": "Menon", "quotation_id": "q1",
    "rule_type": "quotation_new", "reason": "Discuss quotation",
    "category": "quotation", "priority_level": "medium", "floor_id": "ground-floor",
    "next_action": "Call", "channel": "call",
    "due_at": "2026-08-05T00:00:00+00:00",
}


def test_closed_source_key_is_skipped_not_reinserted(monkeypatch):
    followups = _FakeFollowups([
        {"id": "f-old", "source_key": "quotation_new:q1", "is_automated": True,
         "status": "done", "customer_id": "c1"},
    ])
    _patch_engine(monkeypatch, followups)

    result = asyncio.run(engine._persist_desired_followups(
        {"quotation_new:q1": dict(DESIRED_FIELDS)},
        quotation_created_by={},
    ))

    assert result["created"] == 0, "must not try to recreate a completed follow-up"
    assert len(followups.rows) == 1
    assert followups.rows[0]["status"] == "done", "the human's completion must survive"


def test_a_genuinely_new_key_is_still_created(monkeypatch):
    followups = _FakeFollowups([])
    _patch_engine(monkeypatch, followups)

    result = asyncio.run(engine._persist_desired_followups(
        {"quotation_new:q2": dict(DESIRED_FIELDS)},
        quotation_created_by={},
    ))

    assert result["created"] == 1
    assert followups.rows[0]["source_key"] == "quotation_new:q2"


def test_one_duplicate_does_not_abort_the_remaining_cards(monkeypatch):
    """The regression that mattered: a single bad key used to kill the pass."""
    followups = _FakeFollowups([
        {"id": "f-old", "source_key": "quotation_new:q1", "is_automated": True,
         "status": "done", "customer_id": "c1"},
    ])
    _patch_engine(monkeypatch, followups)

    result = asyncio.run(engine._persist_desired_followups(
        {
            "quotation_new:q1": dict(DESIRED_FIELDS),
            "quotation_new:q2": dict(DESIRED_FIELDS),
            "quotation_new:q3": dict(DESIRED_FIELDS),
        },
        quotation_created_by={},
    ))

    assert result["created"] == 2
    created_keys = {r["source_key"] for r in followups.rows}
    assert created_keys == {
        "quotation_new:q1", "quotation_new:q2", "quotation_new:q3",
    }


def test_open_row_is_refreshed_rather_than_duplicated(monkeypatch):
    followups = _FakeFollowups([
        {"id": "f-open", "source_key": "quotation_new:q1", "is_automated": True,
         "status": "open", "reason": "stale reason"},
    ])
    _patch_engine(monkeypatch, followups)

    result = asyncio.run(engine._persist_desired_followups(
        {"quotation_new:q1": dict(DESIRED_FIELDS)},
        quotation_created_by={},
    ))

    assert result["created"] == 0 and result["updated"] == 1
    assert followups.rows[0]["reason"] == "Discuss quotation"


def test_snoozed_row_is_left_completely_alone(monkeypatch):
    followups = _FakeFollowups([
        {"id": "f-snz", "source_key": "quotation_new:q1", "is_automated": True,
         "status": "snoozed", "reason": "stale reason"},
    ])
    _patch_engine(monkeypatch, followups)

    result = asyncio.run(engine._persist_desired_followups(
        {"quotation_new:q1": dict(DESIRED_FIELDS)},
        quotation_created_by={},
    ))

    assert result["created"] == 0 and result["updated"] == 0
    assert followups.rows[0]["reason"] == "stale reason"


def test_a_concurrent_insert_race_is_swallowed_not_propagated(monkeypatch):
    """Belt and braces: even if the closed-key read misses a row written a
    microsecond later, one card must not take the pass down."""
    followups = _FakeFollowups([])

    original_insert = followups.insert_one
    state = {"first": True}

    async def racing_insert(doc, session=None):
        if state["first"]:
            state["first"] = False
            raise DuplicateKeyError("E11000 raced")
        await original_insert(doc)

    followups.insert_one = racing_insert  # type: ignore[method-assign]
    _patch_engine(monkeypatch, followups)

    result = asyncio.run(engine._persist_desired_followups(
        {"a:1": dict(DESIRED_FIELDS), "b:2": dict(DESIRED_FIELDS)},
        quotation_created_by={},
    ))

    assert result["created"] == 1
