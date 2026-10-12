"""Version-keyed analytics cache.

Invalidation is structural rather than procedural: each source collection has
a version counter, every cached metric declares which collections it reads,
and the version numbers are part of the cache key. A write bumps the counter,
the key changes, and every dependent entry becomes unreachable at once —
there is no delete to forget and no stale entry to clear by hand.

Uses Redis when REDIS_URL is set so all workers agree (the app ships
--workers 2 and process-local caches are already a known incoherence
source); falls back to process memory otherwise, exactly like
services/rate_limit.py.
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Awaitable, Callable, Optional, Sequence

_DEFAULT_TTL = 60
_MAX_MEMORY_ENTRIES = 256

_memory_versions: dict[str, int] = {}
_memory_entries: dict[str, tuple[float, object]] = {}
_inflight: dict[str, asyncio.Task] = {}


def reset_memory_state() -> None:
    """Test helper — clears the in-process fallback."""
    _memory_versions.clear()
    _memory_entries.clear()
    _inflight.clear()


def _redis():
    """Reuse the rate limiter's optional client so there is one Redis setup."""
    try:
        from services.rate_limit import _redis_client
        return _redis_client()
    except Exception:
        return None


async def _version(collection: str) -> int:
    client = _redis()
    if client is not None:
        raw = await client.get(f"analytics:ver:{collection}")
        return int(raw) if raw else 0
    return _memory_versions.get(collection, 0)


async def bump(collection: str) -> None:
    """Called from a write path. Invalidates every metric reading this
    collection, without touching any cache entry."""
    client = _redis()
    if client is not None:
        await client.incr(f"analytics:ver:{collection}")
        return
    _memory_versions[collection] = _memory_versions.get(collection, 0) + 1


async def cache_key(
    metric_id: str,
    collections: Sequence[str],
    filter_signature: str,
    floors: Optional[Sequence[str]],
) -> str:
    """floors is part of the key on purpose — leaving it out would serve one
    user's floor-scoped rows to another. Sorted so equivalent scopes share an
    entry.

    None (unrestricted) and [] (restricted to nothing) must not collide, so
    the empty list keys as "none" rather than as an empty string.
    """
    # Resolve independent Redis version reads together, then compose a stable
    # ordered key. A cache hit should not pay one network round trip per source.
    names = sorted(collections)
    values = await asyncio.gather(*(_version(name) for name in names))
    versions = ".".join(f"{name}{value}" for name, value in zip(names, values))
    scope = "all" if floors is None else (",".join(sorted(floors)) or "none")
    return f"analytics:{metric_id}:{versions}:{filter_signature}:{scope}"


async def cached(
    metric_id: str,
    collections: Sequence[str],
    filter_signature: str,
    floors: Optional[Sequence[str]],
    loader: Callable[[], Awaitable[object]],
    ttl: int = _DEFAULT_TTL,
) -> object:
    """Return the cached aggregate or compute and store it."""
    key = await cache_key(metric_id, collections, filter_signature, floors)

    client = _redis()
    if client is not None:
        hit = await client.get(key)
        if hit is not None:
            return json.loads(hit)
    else:
        entry = _memory_entries.get(key)
        if entry and entry[0] > time.monotonic():
            return entry[1]

    async def load_and_store():
        value = await loader()
        if client is not None:
            await client.set(key, json.dumps(value, default=str), ex=ttl)
        else:
            # Version invalidation changes keys without removing old entries.
            now = time.monotonic()
            for stale_key, (expires_at, _) in list(_memory_entries.items()):
                if expires_at <= now:
                    del _memory_entries[stale_key]
            while len(_memory_entries) >= _MAX_MEMORY_ENTRIES:
                del _memory_entries[next(iter(_memory_entries))]
            _memory_entries[key] = (time.monotonic() + ttl, value)
        return value

    # Burst requests for an expired metric should run its database pipeline
    # once. The version/floor/filter key preserves invalidation and isolation.
    # Shield the shared read so closing one page does not cancel other callers.
    task = _inflight.get(key)
    if task is None or task.get_loop() is not asyncio.get_running_loop():
        task = asyncio.create_task(load_and_store())
        _inflight[key] = task

        def finished(done):
            if _inflight.get(key) is done:
                _inflight.pop(key, None)
            if not done.cancelled():
                done.exception()  # observe failures even if all callers left

        task.add_done_callback(finished)
    return await asyncio.shield(task)
