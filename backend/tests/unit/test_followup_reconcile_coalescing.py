"""A mutation after an in-flight snapshot must receive a fresh reconcile pass."""
import asyncio
import pytest

from services import followup_engine as engine


def test_elapsed_time_reminders_refresh_without_a_mutation_and_recover_from_errors(monkeypatch):
    async def scenario():
        calls, intervals = [], []

        async def reconcile():
            calls.append(len(calls))
            if len(calls) == 1:
                raise RuntimeError("transient database failure")

        async def sleep(seconds):
            intervals.append(seconds)
            if len(intervals) == 3:
                raise asyncio.CancelledError()

        monkeypatch.setattr(engine, "reconcile_followups", reconcile)
        monkeypatch.setattr(engine.asyncio, "sleep", sleep)
        with pytest.raises(asyncio.CancelledError):
            await engine.followup_worker()
        assert len(calls) == 3, "Due reminders must refresh without a business write"
        assert intervals == [300, 300, 300]
    asyncio.run(scenario())


def test_mutations_during_a_snapshot_are_coalesced_without_losing_late_documents(monkeypatch):
    async def scenario():
        monkeypatch.setattr(engine, "_reconcile_lock", asyncio.Lock())
        monkeypatch.setattr(engine, "_reconcile_requested", False, raising=False)
        monkeypatch.setattr(engine, "customer_reset_maintenance", lambda: False)
        snapshot_taken, finish_snapshot = asyncio.Event(), asyncio.Event()
        documents = ["initial"]
        persisted, snapshots = set(), []

        async def reconcile_snapshot():
            snapshot = list(documents)
            snapshots.append(snapshot)
            if len(snapshots) == 1:
                snapshot_taken.set()
                await finish_snapshot.wait()
            new = set(snapshot) - persisted
            persisted.update(snapshot)
            return {"created": len(new), "updated": 0, "auto_resolved": 0, "active": len(snapshot)}

        monkeypatch.setattr(engine, "_reconcile_followups_locked", reconcile_snapshot)
        running = asyncio.create_task(engine.reconcile_followups())
        await snapshot_taken.wait()
        documents.append("quotation-saved-after-snapshot")
        assert (await engine.reconcile_followups())["skipped"] is True
        documents.append("another-floor-quotation")
        await engine.reconcile_followups()
        finish_snapshot.set()
        await running
        assert persisted == set(documents)
        assert len(snapshots) == 2, "Concurrent mutations need one fresh pass, not one scan per caller"

        # A subsequent ordinary pass must be idempotent and release the lock.
        result = await engine.reconcile_followups()
        assert result["created"] == 0
        assert not engine._reconcile_lock.locked()

    asyncio.run(scenario())


def test_mutation_during_the_coalesced_pass_requests_another_fresh_snapshot(monkeypatch):
    async def scenario():
        monkeypatch.setattr(engine, "_reconcile_lock", asyncio.Lock())
        monkeypatch.setattr(engine, "_reconcile_requested", False, raising=False)
        monkeypatch.setattr(engine, "customer_reset_maintenance", lambda: False)
        calls = 0

        async def reconcile_snapshot():
            nonlocal calls
            calls += 1
            if calls <= 2:
                await engine.reconcile_followups()
            return {"created": 0, "updated": 0, "auto_resolved": 0, "active": calls}

        monkeypatch.setattr(engine, "_reconcile_followups_locked", reconcile_snapshot)
        result = await engine.reconcile_followups()
        assert calls == result["active"] == 3

    asyncio.run(scenario())
