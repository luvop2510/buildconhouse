"""Lifecycle cleanup must run even when startup never reaches ``yield``."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from pymongo.errors import AutoReconnect

import server
from services.mutation_admission import admission


class _HealthyPreflight:
    checks = {"demo_accounts_detected": []}

    def require_healthy(self):
        return None


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_snapshot", [True, False])
async def test_startup_failure_after_worker_start_cleans_up_resources(monkeypatch, fail_snapshot):
    """Both normal shutdown and failed startup must release owned workers."""
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
        if fail_snapshot:
            raise RuntimeError("catalog readiness failed")
        return SimpleNamespace(products=[])

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
    monkeypatch.setattr(server, "_revoke_published_default_sessions", noop)
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
    monkeypatch.setattr(server, "ensure_quotation_share_indexes", noop)
    monkeypatch.setattr(server, "dispatch_pending", noop)
    monkeypatch.setattr(server, "outbox_worker", worker)
    monkeypatch.setattr(server, "followup_worker", worker)
    monkeypatch.setattr(server, "_seed_automation_rules", noop)
    monkeypatch.setattr(server.catalog_service, "refresh_catalog_snapshot", broken_snapshot)
    monkeypatch.setattr(server, "get_media_storage", lambda: Storage())
    monkeypatch.setattr(server, "client", Client())
    monkeypatch.setattr(server, "settings", SimpleNamespace(environment="test"))

    app = FastAPI()
    if fail_snapshot:
        with pytest.raises(RuntimeError, match="catalog readiness failed"):
            async with server.lifespan(app):
                pass
    else:
        async with server.lifespan(app):
            await asyncio.sleep(0)
            assert not app.state.optional_startup_tasks[1].done()
        assert app.state.optional_startup_tasks[1].cancelled()

    assert app.state.outbox_worker.cancelled()
    assert closed
    assert client_closed


@pytest.mark.asyncio
async def test_shutdown_waits_for_cancelled_request_and_retries_exact_release_before_closing_mongo(monkeypatch):
    entered = asyncio.Event()
    retrying = asyncio.Event()
    recover = asyncio.Event()
    events = []

    class Gate:
        writers = {"other-writer"}

        def with_options(self, **_options):
            return self

        async def update_one(self, query, update, **_options):
            if "$setOnInsert" in update:
                return
            if "$addToSet" in update:
                self.writers.add(update["$addToSet"]["writers"])
                return SimpleNamespace(matched_count=1)
            if not retrying.is_set():
                retrying.set()
                raise AutoReconnect("Temporary loss of the database connection")
            await recover.wait()
            self.writers.remove(query["writers"])
            events.append("release")

    gate = Gate()

    class Client:
        def close(self):
            events.append("close")

    monkeypatch.setattr(server, "client", Client())
    monkeypatch.setattr(server, "get_media_storage", lambda: object())

    async def request():
        async with admission(SimpleNamespace(settings=gate)):
            entered.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(request())
    await asyncio.wait_for(entered.wait(), 1)
    task.cancel()
    shutdown = asyncio.create_task(server._shutdown_resources(FastAPI()))
    try:
        await asyncio.wait_for(retrying.wait(), 1)
        with pytest.raises(asyncio.CancelledError):
            await task
        assert events == [] and len(gate.writers) == 2 and not shutdown.done()
    finally:
        recover.set()
        await asyncio.wait_for(shutdown, 1)
    assert events == ["release", "close"]
    assert gate.writers == {"other-writer"}
