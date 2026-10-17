"""/api/health reports a monitoring-consumable degraded status when a staff
account is still on the historical default demo password (BACKEND_AUDIT_2026-07-17.md
Critical #1) — instead of only logging a warning at startup."""
from __future__ import annotations

import asyncio

import pytest

import server


class _FakeDb:
    async def command(self, *_args, **_kwargs):
        return {"ok": 1}


@pytest.fixture(autouse=True)
def reset_demo_check_cache():
    server._demo_check_cache["checked_at"] = None
    server._demo_check_cache["emails"] = []
    yield
    server._demo_check_cache["checked_at"] = None
    server._demo_check_cache["emails"] = []


def test_health_ok_when_no_demo_accounts_detected(monkeypatch):
    monkeypatch.setattr(server, "db", _FakeDb())

    async def _no_matches(_db):
        return []

    monkeypatch.setattr(server, "_check_demo_accounts", _no_matches)

    result = asyncio.run(server.health())
    assert result == {"status": "ok", "pdf_renderer_revision": server.PDF_RENDERER_REVISION}


def test_health_degraded_when_demo_account_still_on_default_password(monkeypatch):
    monkeypatch.setattr(server, "db", _FakeDb())

    async def _matches(_db):
        return ["owner@forge.app"]

    monkeypatch.setattr(server, "_check_demo_accounts", _matches)

    result = asyncio.run(server.health())
    assert result.status_code == 503
    assert b'"status":"degraded"' in result.body
    assert b"owner@forge.app" not in result.body


def test_readiness_stays_ok_when_health_only_has_a_security_warning(monkeypatch):
    """The deployment probe must not restart a working API over this warning."""
    monkeypatch.setattr(server, "db", _FakeDb())

    async def _storage_ready():
        return None

    monkeypatch.setattr("media_storage.supabase_driver.supabase_ready", _storage_ready)

    result = asyncio.run(server.readiness())
    assert result == {"status": "ok", "pdf_renderer_revision": server.PDF_RENDERER_REVISION}


def test_health_demo_check_is_ttl_cached(monkeypatch):
    monkeypatch.setattr(server, "db", _FakeDb())
    calls = {"count": 0}

    async def _counting_check(_db):
        calls["count"] += 1
        return []

    monkeypatch.setattr(server, "_check_demo_accounts", _counting_check)

    asyncio.run(server.health())
    asyncio.run(server.health())
    assert calls["count"] == 1  # second call served from the TTL cache, no re-check


def test_startup_bootstrap_result_primes_health_demo_cache(monkeypatch):
    server._cache_demo_check_from_bootstrap({"demo_accounts_detected": []})

    async def _should_not_run(_db):
        raise AssertionError("health should reuse the completed startup check")

    monkeypatch.setattr(server, "_check_demo_accounts", _should_not_run)
    monkeypatch.setattr(server, "db", _FakeDb())

    assert asyncio.run(server.health()) == {"status": "ok", "pdf_renderer_revision": server.PDF_RENDERER_REVISION}


@pytest.mark.parametrize("dependency", ["database", "storage"])
def test_readiness_names_the_failed_dependency_without_exposing_provider_details(monkeypatch, caplog, dependency):
    private = "provider-secret-and-private-customer-data"
    checks = []

    class Database:
        async def command(self, *_args):
            checks.append("database")
            if dependency == "database":
                raise RuntimeError(private)

    async def storage():
        checks.append("storage")
        raise RuntimeError(private)

    monkeypatch.setattr(server, "db", Database())
    monkeypatch.setattr("media_storage.supabase_driver.supabase_ready", storage)
    result = asyncio.run(server.readiness())
    assert result.status_code == 503
    assert result.body == ('{"status":"error","detail":"' + dependency + ' unavailable"}').encode()
    assert checks == (["database"] if dependency == "database" else ["database", "storage"])
    assert private not in result.body.decode() and private not in caplog.text
    assert f"Readiness dependency unavailable: {dependency} (RuntimeError)" in caplog.text
