"""Invalidation is automatic: a write bumps a collection version, the key
changes, and every dependent entry becomes unreachable. Nothing is ever
cleared by hand.

This suite has no pytest-asyncio; async code is driven with asyncio.run,
matching test_tile_orders_delivered.py.
"""
from __future__ import annotations

import asyncio

import pytest

from services.analytics import cache


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.setattr(cache, "_redis", lambda: None)
    cache.reset_memory_state()
    yield
    cache.reset_memory_state()


def test_key_is_stable_for_identical_inputs():
    async def go():
        a = await cache.cache_key("revenue", ["quotations"], "sig", ["ground-floor"])
        b = await cache.cache_key("revenue", ["quotations"], "sig", ["ground-floor"])
        assert a == b
    asyncio.run(go())


def test_key_changes_when_a_dependency_is_bumped():
    async def go():
        before = await cache.cache_key("revenue", ["quotations"], "sig", None)
        await cache.bump("quotations")
        assert await cache.cache_key("revenue", ["quotations"], "sig", None) != before
    asyncio.run(go())


def test_bumping_an_unrelated_collection_leaves_the_key_alone():
    async def go():
        before = await cache.cache_key("revenue", ["quotations"], "sig", None)
        await cache.bump("payments")
        assert await cache.cache_key("revenue", ["quotations"], "sig", None) == before
    asyncio.run(go())


def test_floor_scope_is_part_of_the_key():
    # Omitting this would serve one user's floor-scoped rows to another.
    async def go():
        ground = await cache.cache_key("revenue", ["quotations"], "sig", ["ground-floor"])
        first = await cache.cache_key("revenue", ["quotations"], "sig", ["first-floor"])
        assert ground != first
    asyncio.run(go())


def test_unrestricted_access_keys_differently_from_a_single_floor():
    async def go():
        unrestricted = await cache.cache_key("revenue", ["quotations"], "sig", None)
        scoped = await cache.cache_key("revenue", ["quotations"], "sig", ["ground-floor"])
        assert unrestricted != scoped
    asyncio.run(go())


def test_floor_order_does_not_change_the_key():
    async def go():
        a = await cache.cache_key("revenue", ["quotations"], "sig", ["ground-floor", "first-floor"])
        b = await cache.cache_key("revenue", ["quotations"], "sig", ["first-floor", "ground-floor"])
        assert a == b
    asyncio.run(go())


def test_a_restricted_caller_with_no_floors_is_not_treated_as_unrestricted():
    """[] means "sees nothing" and None means "sees everything" — sharing a
    cache entry between them would hand a locked-out account the full report."""
    async def go():
        empty = await cache.cache_key("revenue", ["quotations"], "sig", [])
        unrestricted = await cache.cache_key("revenue", ["quotations"], "sig", None)
        assert empty != unrestricted
    asyncio.run(go())


def test_loader_runs_once_then_the_value_is_served_from_cache():
    calls = []

    async def loader():
        calls.append(1)
        return {"revenue": 100}

    async def go():
        first = await cache.cached("revenue", ["quotations"], "sig", None, loader)
        second = await cache.cached("revenue", ["quotations"], "sig", None, loader)
        assert first == second == {"revenue": 100}
        assert len(calls) == 1
    asyncio.run(go())


def test_a_write_makes_the_loader_run_again():
    calls = []

    async def loader():
        calls.append(1)
        return {"revenue": len(calls)}

    async def go():
        await cache.cached("revenue", ["quotations"], "sig", None, loader)
        await cache.bump("quotations")
        result = await cache.cached("revenue", ["quotations"], "sig", None, loader)
        assert result == {"revenue": 2}
        assert len(calls) == 2
    asyncio.run(go())


def test_an_expired_entry_is_recomputed():
    calls = []

    async def loader():
        calls.append(1)
        return {"n": len(calls)}

    async def go():
        await cache.cached("revenue", ["quotations"], "sig", None, loader, ttl=0)
        again = await cache.cached("revenue", ["quotations"], "sig", None, loader, ttl=0)
        assert again == {"n": 2}
    asyncio.run(go())


def test_a_different_filter_signature_is_a_different_entry():
    calls = []

    async def loader():
        calls.append(1)
        return {"n": len(calls)}

    async def go():
        await cache.cached("revenue", ["quotations"], "july", None, loader)
        await cache.cached("revenue", ["quotations"], "august", None, loader)
        assert len(calls) == 2
    asyncio.run(go())


def test_memory_cache_evicts_old_filters_at_a_bounded_size(monkeypatch):
    monkeypatch.setattr(cache, "_MAX_MEMORY_ENTRIES", 3)

    async def loader():
        return {"value": 1}

    async def go():
        for i in range(10):
            await cache.cached("revenue", ["quotations"], str(i), None, loader)
        assert len(cache._memory_entries) == 3
    asyncio.run(go())


def test_concurrent_cold_requests_share_one_loader():
    async def go():
        calls = 0
        async def loader():
            nonlocal calls
            calls += 1
            await asyncio.sleep(0)
            return {"revenue": 100}
        values = await asyncio.gather(*(cache.cached("revenue", ["quotations"], "sig", None, loader) for _ in range(20)))
        assert calls == 1
        assert values == [{"revenue": 100}] * 20
        assert cache._inflight == {}
    asyncio.run(go())


def test_cancelling_one_caller_does_not_cancel_shared_metric():
    async def go():
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0
        async def loader():
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return {"value": 7}
        first = asyncio.create_task(cache.cached("revenue", ["quotations"], "sig", None, loader))
        await started.wait()
        second = asyncio.create_task(cache.cached("revenue", ["quotations"], "sig", None, loader))
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        release.set()
        assert await second == {"value": 7}
        assert calls == 1
    asyncio.run(go())


def test_write_during_shared_load_uses_a_new_version_for_later_callers():
    async def go():
        started = asyncio.Event()
        release = asyncio.Event()
        async def old_loader():
            started.set()
            await release.wait()
            return {"value": "before-write"}
        async def new_loader():
            return {"value": "after-write"}
        old = asyncio.create_task(cache.cached("revenue", ["quotations"], "sig", None, old_loader))
        await started.wait()
        await cache.bump("quotations")
        assert await cache.cached("revenue", ["quotations"], "sig", None, new_loader) == {"value": "after-write"}
        release.set()
        assert await old == {"value": "before-write"}
        assert await cache.cached("revenue", ["quotations"], "sig", None, new_loader) == {"value": "after-write"}
    asyncio.run(go())


def test_failed_shared_load_is_removed_and_can_be_retried():
    async def go():
        calls = 0
        async def loader():
            nonlocal calls
            calls += 1
            if calls == 1:
                await asyncio.sleep(0)
                raise RuntimeError("temporary failure")
            return {"value": 2}
        results = await asyncio.gather(*(cache.cached("revenue", ["quotations"], "sig", None, loader) for _ in range(5)), return_exceptions=True)
        assert calls == 1
        assert all(isinstance(result, RuntimeError) for result in results)
        assert cache._inflight == {}
        assert await cache.cached("revenue", ["quotations"], "sig", None, loader) == {"value": 2}
    asyncio.run(go())


def test_redis_versions_are_read_concurrently_and_burst_loader_is_shared(monkeypatch):
    async def go():
        class Redis:
            def __init__(self):
                self.versions_started = 0
                self.ready = asyncio.Event()
                self.values = {}
                self.writes = []

            async def get(self, key):
                if key.startswith("analytics:ver:"):
                    self.versions_started += 1
                    if self.versions_started >= 3:
                        self.ready.set()
                    await asyncio.wait_for(self.ready.wait(), 1)
                    return "1"
                return self.values.get(key)

            async def set(self, key, value, ex):
                self.values[key] = value
                self.writes.append((key, ex))

        redis = Redis()
        monkeypatch.setattr(cache, "_redis", lambda: redis)
        calls = 0
        async def loader():
            nonlocal calls
            calls += 1
            await asyncio.sleep(0)
            return {"value": 10}
        args = ("revenue", ["quotations", "products", "payments"], "sig", ["ground-floor"], loader)
        values = await asyncio.gather(*(cache.cached(*args, ttl=15) for _ in range(5)))
        assert values == [{"value": 10}] * 5
        assert calls == 1
        assert len(redis.writes) == 1
        assert redis.writes[0][1] == 15
        assert await cache.cached(*args) == {"value": 10}
        assert calls == 1
    asyncio.run(go())


def test_failed_redis_invalidation_bypasses_old_cache_until_repaired(monkeypatch):
    class Redis:
        def __init__(self):
            self.values = {}
            self.fail_incr = False

        async def get(self, key):
            return self.values.get(key)

        async def set(self, key, value, **_kwargs):
            self.values[key] = value

        async def incr(self, key):
            if self.fail_incr:
                await asyncio.Event().wait()
            self.values[key] = int(self.values.get(key, 0)) + 1
            return self.values[key]

    async def go():
        redis = Redis()
        monkeypatch.setattr(cache, "_redis", lambda: redis)
        monkeypatch.setattr(cache, "_REDIS_TIMEOUT_SECONDS", 0.01)
        value = 10
        calls = 0
        async def loader():
            nonlocal calls
            calls += 1
            return {"balance": value}
        args = ("balance", ["payments"], "", ["ground-floor"], loader)
        assert await cache.cached(*args) == {"balance": 10}
        value = 20  # Committed payment, followed by an unavailable Redis INCR.
        redis.fail_incr = True
        with pytest.raises(TimeoutError):
            await cache.bump("payments")
        assert await cache.cached(*args) == {"balance": 20}
        assert cache._pending_invalidations == {"payments": 1}
        redis.fail_incr = False
        assert await cache.cached(*args) == {"balance": 20}
        assert cache._pending_invalidations == {}
        assert await cache.cached(*args) == {"balance": 20}
        assert calls == 3  # Old fill, uncached outage read, repaired-version fill.
    asyncio.run(go())


def test_older_success_does_not_clear_a_newer_failed_invalidation(monkeypatch):
    async def go():
        started = asyncio.Event()
        release = asyncio.Event()
        class Redis:
            calls = 0
            async def incr(self, _key):
                self.calls += 1
                if self.calls == 1:
                    # Redis executed the older increment before the next write.
                    started.set()
                    await release.wait()
                    return 1
                raise ConnectionError("newer increment unavailable")
        redis = Redis()
        monkeypatch.setattr(cache, "_redis", lambda: redis)
        older = asyncio.create_task(cache.bump("payments"))
        await started.wait()
        with pytest.raises(ConnectionError):
            await cache.bump("payments")
        release.set()
        await older
        assert cache._pending_invalidations == {"payments": 2}
    asyncio.run(go())
