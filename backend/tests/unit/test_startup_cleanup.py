"""Lifecycle cleanup must run even when startup never reaches ``yield``."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI

import server


class _HealthyPreflight:
    checks = {"demo_accounts_detected": []}

    def require_healthy(self):
        return None


@pytest.mark.asyncio
async def test_startup_failure_after_worker_start_cleans_up_resources(monkeypatch):
    """A failed readiness task must not leak the outbox worker or media client."""
    closed = False

    async def noop(*_args, **_kwargs):
        return None

    async def bootstrap(*_args, **_kwargs):
        return _HealthyPreflight()

    async def pending(*_args, **_kwargs):
        return []

    async def worker():
        await asyncio.Event().wait()

    async def broken_snapshot():
        raise RuntimeError("catalog readiness failed")

    class Storage:
        async def close(self):
            nonlocal closed
            closed = True

    client_closed = False

    class Client:
        def close(self):
            nonlocal client_closed
            client_closed = True

    monkeypatch.setattr(server, "run_bootstrap", bootstrap)
    monkeypatch.setattr(server, "pending_migrations", pending)
    monkeypatch.setattr(server, "run_migrations", noop)
    monkeypatch.setattr(server, "ensure_floor_scope", noop)
    monkeypatch.setattr(server, "seed_if_empty", noop)
    monkeypatch.setattr(server, "resync_catalog_if_needed", noop)
    monkeypatch.setattr(server, "ensure_outbox_indexes", noop)
    monkeypatch.setattr(server, "ensure_tile_order_indexes", noop)
    monkeypatch.setattr(server, "ensure_godown_stock_indexes", noop)
    monkeypatch.setattr(server, "ensure_transfer_indexes", noop)
    monkeypatch.setattr(server, "ensure_download_token_indexes", noop)
    monkeypatch.setattr(server, "ensure_access_grant_indexes", noop)
    monkeypatch.setattr(server, "dispatch_pending", noop)
    monkeypatch.setattr(server, "outbox_worker", worker)
    monkeypatch.setattr(server.catalog_service, "refresh_catalog_snapshot", broken_snapshot)
    monkeypatch.setattr(server, "get_media_storage", lambda: Storage())
    monkeypatch.setattr(server, "client", Client())
    monkeypatch.setattr(server, "settings", SimpleNamespace(environment="test"))

    app = FastAPI()
    with pytest.raises(RuntimeError, match="catalog readiness failed"):
        async with server.lifespan(app):
            pass

    assert app.state.outbox_worker.cancelled()
    assert closed
    assert client_closed
