"""Outbox dispatch must atomically claim a pending event before processing it."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest

import services.domain_outbox as domain_outbox


def test_claim_event_uses_compare_and_set_pending_filter(monkeypatch):
    captured = {}

    class _Events:
        async def find_one_and_update(self, query, update, **kwargs):
            captured.update(query=query, update=update, kwargs=kwargs)
            return {"id": "evt-1", "claim_id": "claim-1", "status": "processing"}

    class _FakeDb:
        event_outbox = _Events()

    monkeypatch.setattr(domain_outbox, "db", _FakeDb())

    claimed = asyncio.run(domain_outbox._claim_event("evt-1"))

    assert claimed["claim_id"] == "claim-1"
    assert captured["query"]["id"] == "evt-1"
    assert {"status": "pending"} in captured["query"]["$or"]
    assert captured["update"]["$set"]["status"] == "processing"
    assert captured["kwargs"]["return_document"] == domain_outbox.ReturnDocument.AFTER


@pytest.mark.parametrize("reclaimed", [False, True])
def test_failed_dispatch_only_updates_its_own_claim(monkeypatch, reclaimed):
    """An expired worker must not dead-letter the worker that replaced it."""
    row = {"id": "evt-1", "status": "processing", "claim_id": "mine", "attempts": 7}
    writes = []

    class Events:
        def find(self, *_args):
            return self

        def sort(self, *_args):
            return self

        async def to_list(self, _limit):
            # Snapshot precedes the claim; it can contain an older attempt count.
            return [{"id": "evt-1", "attempts": 0}]

        async def update_one(self, query, update):
            writes.append(query)
            if all(row.get(key) == value for key, value in query.items()):
                row.update(update["$set"])
                row["attempts"] += update["$inc"]["attempts"]

    async def claim(_event_id):
        return deepcopy(row)

    async def fail(_event_id, *, claim_id):
        assert claim_id == "mine"
        if reclaimed:
            row["claim_id"] = "replacement"
        raise RuntimeError("interrupted handler")

    monkeypatch.setattr(domain_outbox, "db", SimpleNamespace(event_outbox=Events()))
    monkeypatch.setattr(domain_outbox, "_claim_event", claim)
    monkeypatch.setattr(domain_outbox, "dispatch_event", fail)
    assert asyncio.run(domain_outbox.dispatch_pending()) == []
    assert writes == [{"id": "evt-1", "status": "processing", "claim_id": "mine"}]
    assert row["attempts"] == (7 if reclaimed else 8)
    assert row["status"] == ("processing" if reclaimed else "dead_letter")


def test_failed_claim_does_not_change_an_unowned_event(monkeypatch):
    class Events:
        def find(self, *_args):
            return self

        def sort(self, *_args):
            return self

        async def to_list(self, _limit):
            return [{"id": "evt-1", "attempts": 7}]

        async def update_one(self, *_args):
            pytest.fail("A worker that never acquired the claim cannot alter the event")

    async def fail_claim(_event_id):
        raise RuntimeError("ambiguous database claim failure")

    monkeypatch.setattr(domain_outbox, "db", SimpleNamespace(event_outbox=Events()))
    monkeypatch.setattr(domain_outbox, "_claim_event", fail_claim)
    assert asyncio.run(domain_outbox.dispatch_pending()) == []
