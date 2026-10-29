"""Regression tests for atomic, bounded login rate limiting."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from services import rate_limit


@pytest.fixture(autouse=True)
def reset_rate_limiter(monkeypatch):
    rate_limit._attempts.clear()
    monkeypatch.setattr(rate_limit, "_redis", None)
    monkeypatch.setattr(rate_limit, "_redis_checked", True)
    yield
    rate_limit._attempts.clear()


class _AtomicRedis:
    """Small Redis EVAL double: a script call is one atomic transaction."""
    def __init__(self):
        self.values: dict[str, int] = {}

    async def eval(self, _script, key_count, *args):
        keys = args[:key_count]
        limits = [int(value) for value in args[key_count:key_count * 2]]
        if any(self.values.get(key, 0) >= limit for key, limit in zip(keys, limits)):
            return 0
        for key in keys:
            self.values[key] = self.values.get(key, 0) + 1
        return 1


@pytest.mark.asyncio
async def test_configured_redis_outage_cannot_reset_an_exhausted_budget(monkeypatch):
    redis = _AtomicRedis()
    monkeypatch.setattr(rate_limit, "_redis_client", lambda: redis)
    for _ in range(rate_limit._PER_KEY_LIMIT):
        await rate_limit.reserve_login_attempt("203.0.113.8", "fixture@example.test")
    with pytest.raises(HTTPException) as exhausted:
        await rate_limit.reserve_login_attempt("203.0.113.8", "fixture@example.test")
    assert exhausted.value.status_code == 429

    async def disconnected(*_args):
        raise ConnectionError("dummy Redis outage")

    monkeypatch.setattr(redis, "eval", disconnected)
    with pytest.raises(HTTPException) as unavailable:
        await rate_limit.reserve_login_attempt("203.0.113.8", "fixture@example.test")
    assert unavailable.value.status_code == 503
    assert unavailable.value.headers["Retry-After"] == "30"
    assert not rate_limit._attempts


def test_failed_redis_initialization_stays_closed_on_later_requests(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://dummy.invalid")
    # Models the state retained after a failed initialization, without any I/O.
    monkeypatch.setattr(rate_limit, "_redis", None)
    monkeypatch.setattr(rate_limit, "_redis_checked", True)
    for _ in range(2):
        with pytest.raises(HTTPException) as unavailable:
            rate_limit._redis_client()
        assert unavailable.value.status_code == 503


@pytest.mark.asyncio
async def test_redis_failure_record_is_atomic_at_the_limit(monkeypatch):
    redis = _AtomicRedis()
    monkeypatch.setattr(rate_limit, "_redis_client", lambda: redis)
    ip, identifier = "203.0.113.8", "person@example.test"

    await asyncio.gather(*[
        rate_limit.record_login_failure(ip, identifier)
        for _ in range(rate_limit._PER_KEY_LIMIT)
    ])

    with pytest.raises(HTTPException) as exc:
        await rate_limit.record_login_failure(ip, identifier)

    assert exc.value.status_code == 429
    key, _, _ = rate_limit._keys(ip, identifier)
    assert redis.values[key] == rate_limit._PER_KEY_LIMIT


@pytest.mark.asyncio
async def test_memory_failure_record_is_atomic_at_the_limit(monkeypatch):
    monkeypatch.setattr(rate_limit, "_redis_client", lambda: None)
    ip, identifier = "203.0.113.9", "local@example.test"

    outcomes = await asyncio.gather(*[
        rate_limit.record_login_failure(ip, identifier)
        for _ in range(rate_limit._PER_KEY_LIMIT + 1)
    ], return_exceptions=True)

    assert sum(isinstance(result, HTTPException) for result in outcomes) == 1
    key, _, _ = rate_limit._keys(ip, identifier)
    assert len(rate_limit._attempts[key]) == rate_limit._PER_KEY_LIMIT


def test_memory_fallback_never_exceeds_its_key_bound(monkeypatch):
    monkeypatch.setattr(rate_limit, "_MAX_TRACKED_KEYS", 2)

    rate_limit._record_memory(["one"])
    rate_limit._record_memory(["two"])
    rate_limit._record_memory(["three"])

    assert len(rate_limit._attempts) == 2
    assert "three" in rate_limit._attempts


@pytest.mark.asyncio
@pytest.mark.parametrize("shared", [False, True])
async def test_concurrent_logins_reserve_before_lookup_and_password_check(monkeypatch, shared):
    from routes import auth_routes
    from models import LoginPayload
    from starlette.requests import Request

    redis = _AtomicRedis() if shared else None
    monkeypatch.setattr(rate_limit, "_redis_client", lambda: redis)
    lookups = []
    comparisons = []

    class Users:
        async def find_one(self, query, projection):
            lookups.append(query)
            # All admitted requests suspend before their password is checked.
            await asyncio.sleep(0.01)
            return {"password_hash": "test-hash"}

    class Database:
        users = Users()

    monkeypatch.setattr(auth_routes, "db", Database())
    monkeypatch.setattr(auth_routes, "verify_password", lambda password, hashed: comparisons.append(password) or False)
    request = Request({"type": "http", "client": ("203.0.113.8", 1234), "headers": []})
    outcomes = await asyncio.gather(*[
        auth_routes.staff_login(LoginPayload(email="person@example.com", password=f"guess-{i}"), request)
        for i in range(64)
    ], return_exceptions=True)
    assert len(lookups) == len(comparisons) == rate_limit._PER_KEY_LIMIT
    assert sum(getattr(value, "status_code", None) == 401 for value in outcomes) == rate_limit._PER_KEY_LIMIT
    assert sum(getattr(value, "status_code", None) == 429 for value in outcomes) == 64 - rate_limit._PER_KEY_LIMIT


def test_new_identifier_prechecks_do_not_grow_memory():
    for index in range(rate_limit._MAX_TRACKED_KEYS + 10):
        rate_limit._check_memory([(f"never-recorded-{index}", 8)])
    assert rate_limit._attempts == {}
