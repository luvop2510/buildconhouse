"""Catalog rebuilds don't stall other requests, fan out failures or lose edits."""
import asyncio
import copy
import threading
from types import SimpleNamespace

import pytest

from services import catalog_service as catalog


class Sources:
    def __init__(self, *, fail=False):
        self.product = {"id": "p1", "name": "Before", "active": True}
        self.products = None
        self.fail = fail
        self.started = 0
        self.closed = 0
        self.all_started = asyncio.Event()
        self.release = asyncio.Event()

    def __getitem__(self, name):
        owner = self
        rows = copy.deepcopy(self.products if self.products is not None else [self.product]) if name == "products" else []

        class Cursor:
            def batch_size(self, _size):
                return self

            def __aiter__(self):
                async def iterate():
                    owner.started += 1
                    if owner.started >= 5:
                        owner.all_started.set()
                    await owner.release.wait()
                    if owner.fail and name == "products":
                        raise RuntimeError("simulated database outage")
                    for row in rows:
                        yield row
                return iterate()

            async def close(self):
                owner.closed += 1

        return SimpleNamespace(find=lambda *_args: Cursor())


@pytest.fixture
def clean_catalog(monkeypatch):
    monkeypatch.setattr(catalog, "_snapshot", None)
    monkeypatch.setattr(catalog, "_refresh_lock", asyncio.Lock())
    monkeypatch.setattr(catalog, "_background_refresh", None)
    monkeypatch.setattr(catalog, "_refresh_retry_at", 0.0)
    monkeypatch.setattr(catalog, "_refresh_generation", 0)


def test_cold_sources_run_together_and_build_off_event_loop(clean_catalog, monkeypatch):
    async def run():
        sources = Sources()
        monkeypatch.setattr(catalog, "db", sources)
        thread_ids = []
        build = catalog._build_snapshot
        def record_build(*args):
            thread_ids.append(threading.get_ident())
            return build(*args)
        monkeypatch.setattr(catalog, "_build_snapshot", record_build)
        caller_thread = threading.get_ident()
        requests = asyncio.create_task(catalog.get_catalog_snapshot())
        await asyncio.wait_for(sources.all_started.wait(), 1)
        assert sources.started == 5
        sources.release.set()
        result = await requests
        assert result.product_by_id["p1"]["name"] == "Before"
        assert sources.closed == 5
        assert thread_ids and all(identity != caller_thread for identity in thread_ids)
    asyncio.run(run())


def test_cancelling_one_cold_client_does_not_cancel_shared_warmup(clean_catalog, monkeypatch):
    async def run():
        sources = Sources()
        monkeypatch.setattr(catalog, "db", sources)
        abandoned = asyncio.create_task(catalog.get_catalog_snapshot())
        remaining = asyncio.create_task(catalog.get_catalog_snapshot())
        await asyncio.wait_for(sources.all_started.wait(), 1)
        abandoned.cancel()
        with pytest.raises(asyncio.CancelledError):
            await abandoned
        sources.release.set()
        assert (await remaining).product_by_id["p1"]["name"] == "Before"
        assert sources.started == sources.closed == 5
    asyncio.run(run())


def test_outage_is_shared_and_backed_off_then_can_recover(clean_catalog, monkeypatch):
    async def run():
        sources = Sources(fail=True)
        monkeypatch.setattr(catalog, "db", sources)
        requests = [asyncio.create_task(catalog.get_catalog_snapshot()) for _ in range(12)]
        await asyncio.wait_for(sources.all_started.wait(), 1)
        sources.release.set()
        failures = await asyncio.gather(*requests, return_exceptions=True)
        assert all(isinstance(error, ExceptionGroup) for error in failures)
        assert all(error is failures[0] for error in failures)
        assert sources.started == sources.closed == 5
        assert catalog._snapshot is None
        with pytest.raises(ExceptionGroup):
            await catalog.get_catalog_snapshot()
        assert sources.started == 5  # no 12 sequential retry storms
        sources.fail = False
        monkeypatch.setattr(catalog, "_refresh_retry_at", 0.0)
        assert (await catalog.get_catalog_snapshot()).product_by_id["p1"]["name"] == "Before"
        assert sources.started == sources.closed == 10
    asyncio.run(run())


def test_failed_background_refresh_keeps_warm_snapshot_without_retry_storm(clean_catalog, monkeypatch):
    async def run():
        sources = Sources(fail=True)
        monkeypatch.setattr(catalog, "db", sources)
        previous = catalog._build_snapshot([sources.product], [], [], [], [])
        previous.loaded_at -= catalog._SNAPSHOT_MAX_AGE_SECONDS + 1
        monkeypatch.setattr(catalog, "_snapshot", previous)
        assert await catalog.get_catalog_snapshot() is previous
        await asyncio.wait_for(sources.all_started.wait(), 1)
        sources.release.set()
        with pytest.raises(ExceptionGroup):
            await catalog._background_refresh
        for _ in range(12):
            assert await catalog.get_catalog_snapshot() is previous
        assert sources.started == sources.closed == 5
    asyncio.run(run())


def test_write_during_rebuild_is_reloaded_before_publication(clean_catalog, monkeypatch):
    async def run():
        sources = Sources()
        monkeypatch.setattr(catalog, "db", sources)
        previous = catalog._build_snapshot([copy.deepcopy(sources.product)], [], [], [], [])
        monkeypatch.setattr(catalog, "_snapshot", previous)
        catalog.schedule_catalog_refresh()
        await asyncio.wait_for(sources.all_started.wait(), 1)
        sources.product["name"] = "After"
        catalog.patch_product_in_snapshot("p1", {"name": "After"})
        sources.release.set()
        updated = await catalog._background_refresh
        assert previous.product_by_id["p1"]["name"] == "After"
        assert updated.product_by_id["p1"]["name"] == "After"
        assert sources.started == sources.closed == 10
    asyncio.run(run())


@pytest.mark.parametrize("megabytes,expected_mode", [(20, "memory"), (33, "database")])
def test_supplier_growth_keeps_normal_catalog_warm_and_oversize_bounded(clean_catalog, monkeypatch, megabytes, expected_mode):
    async def run():
        sources = Sources()
        # Production now retains ~19.7 MB of source BSON. A normal import must
        # never silently switch every page into remote aggregation requests.
        payload = "x" * (megabytes * 1024 * 1024 // 128)
        sources.products = [{"id": f"p{number}", "description": payload, "active": True} for number in range(128)]
        sources.release.set()
        monkeypatch.setattr(catalog, "db", sources)
        snapshot = await catalog.get_catalog_snapshot()
        assert snapshot.database_backed is (expected_mode == "database")
        assert bool(snapshot.products) is (expected_mode == "memory")
        assert sources.closed == 5
        diagnostic = catalog.catalog_diagnostics()
        assert diagnostic["mode"] == expected_mode
        assert diagnostic["source_bytes"] > min(megabytes, 32) * 1024 * 1024
        assert diagnostic["budget_bytes"] == 32 * 1024 * 1024
        assert diagnostic["source_rows"]["products"] == (128 if expected_mode == "memory" else None)
    asyncio.run(run())


def test_shared_product_family_media_is_validated_once():
    media = {"id": "photo", "product_id": "p1", "family_key": "style", "floor_id": "first-floor",
             "bucket": "forge-products", "storage_key": "photo.jpg", "sha1": "hash"}
    snapshot = catalog._build_snapshot([{"id": "p1", "family_key": "style"}], [media], [], [], [])
    assert snapshot.media_by_product["p1"][0] is snapshot.media_by_family["style"][0]


def test_database_fallback_uses_bounded_batches_and_closes_on_budget_failure(monkeypatch):
    from fastapi import HTTPException
    from services import catalog_database
    from tests.unit.test_backend_page_performance import CatalogCursor
    async def run():
        cursor = CatalogCursor([{"id": "p1"}, {"id": "p2"}])
        with pytest.raises(HTTPException) as error:
            await catalog_database.bounded(cursor, 1, "Test page")
        assert error.value.status_code == 413
        assert cursor.batch == 512
        assert cursor.closed
        aggregate_options = {}
        def aggregate(_pipeline, **options):
            aggregate_options.update(options)
            return cursor
        monkeypatch.setattr(catalog_database, "db", SimpleNamespace(products=SimpleNamespace(aggregate=aggregate)))
        assert catalog_database.aggregate([]) is cursor
        assert aggregate_options["batchSize"] == 512
        assert aggregate_options["maxTimeMS"] == catalog_database.MAX_QUERY_MS
    asyncio.run(run())


def test_admin_health_reports_fresh_catalog_mode_even_when_storage_checks_are_cached(monkeypatch):
    from time import monotonic
    from routes import misc_routes
    cached = {"backend": "running", "catalog": {"mode": "memory"}}
    monkeypatch.setattr(misc_routes, "_system_health_cache", (monotonic(), cached))
    monkeypatch.setattr(misc_routes, "catalog_diagnostics", lambda: {"mode": "database", "budget_bytes": 32 * 1024 * 1024})
    result = asyncio.run(misc_routes.health_system())
    assert result["catalog"]["mode"] == "database"
    assert result["catalog"]["budget_bytes"] == 32 * 1024 * 1024
    assert cached["catalog"]["mode"] == "memory"


def test_background_shutdown_closes_all_source_cursors(clean_catalog, monkeypatch):
    async def run():
        sources = Sources()
        monkeypatch.setattr(catalog, "db", sources)
        catalog.schedule_catalog_refresh()
        await asyncio.wait_for(sources.all_started.wait(), 1)
        await catalog.stop_catalog_refresh()
        assert catalog._background_refresh is None
        assert sources.closed == 5
        assert catalog._snapshot is None
    asyncio.run(run())


@pytest.mark.parametrize("database_mode", [False, True])
def test_read_only_benchmark_accepts_warm_catalog_and_rejects_silent_fallback(clean_catalog, monkeypatch, database_mode):
    from unittest.mock import AsyncMock
    from scripts import benchmark_catalog_performance as probe
    snapshot = catalog._build_snapshot([], [], [], [], [])
    snapshot.database_backed = database_mode
    monkeypatch.setattr(catalog, "_snapshot", snapshot)
    monkeypatch.setattr(catalog, "refresh_catalog_snapshot", AsyncMock(return_value=snapshot))
    monkeypatch.setattr(catalog, "list_family_groups", AsyncMock(return_value={"items": [], "total": 0}))
    monkeypatch.setattr(catalog, "hierarchy_rows", AsyncMock(return_value=([], {}, {})))
    monkeypatch.setattr(catalog, "list_brands_with_counts", AsyncMock(return_value=[]))
    monkeypatch.setattr(catalog, "list_categories_with_counts", AsyncMock(return_value=[]))
    result = asyncio.run(probe.benchmark(samples=1))
    assert result["passed"] is (not database_mode)
    assert len(result["floors"]) == 4
    assert len(result["failures"]) == int(database_mode)
    assert all(len(floor) == 4 for floor in result["floors"].values())


@pytest.mark.parametrize("route", ["list_floors", "get_floor_access"])
@pytest.mark.parametrize("role", ["owner", "sales"])
def test_workspace_hydration_reads_once_without_bootstrap_writes_and_keeps_access_scope(monkeypatch, route, role):
    from unittest.mock import AsyncMock
    from models import UserPublic
    from routes import misc_routes
    floors = [{"id": "ground-floor", "name": "Ground floor", "slug": "ground-floor"},
              {"id": "first-floor", "name": "Sanitary Bathroom", "slug": "first-floor"}]
    reads = []
    def find(query, projection):
        reads.append((query, projection))
        cursor = SimpleNamespace(to_list=AsyncMock(return_value=floors))
        cursor.sort = lambda *_args: cursor
        return cursor
    def forbidden_write(*_args, **_kwargs):
        raise AssertionError("Workspace access must not upsert defaults already created during startup")
    monkeypatch.setattr(misc_routes, "db", SimpleNamespace(floors=SimpleNamespace(find=find, update_one=forbidden_write)))
    user = UserPublic(id="staff", email="staff@example.test", full_name="Staff", role=role, floor_ids=["first-floor"])
    result = asyncio.run(getattr(misc_routes, route)(user))
    visible = result if route == "list_floors" else result["floors"]
    assert [floor["id"] for floor in visible] == (["ground-floor", "first-floor"] if role == "owner" else ["first-floor"])
    assert reads == [({"active": True}, {"_id": 0})]
    if route == "get_floor_access":
        assert result["all_floors"] is (role == "owner")
        assert result["floor_ids"] == [floor["id"] for floor in visible]


def test_unchanged_refresh_reuses_complete_catalog_objects_without_revalidation(clean_catalog, monkeypatch):
    async def run():
        sources = Sources()
        sources.release.set()
        monkeypatch.setattr(catalog, "db", sources)
        first = await catalog.get_catalog_snapshot()
        assert first.source_signatures
        # Rebuilding even the same source doubles decoded catalog/model memory.
        def unexpected_rebuild(*_args):
            raise AssertionError("unchanged source must retain its existing models")
        monkeypatch.setattr(catalog, "_build_snapshot", unexpected_rebuild)
        refreshed = await catalog.refresh_catalog_snapshot()
        assert refreshed is not first
        assert refreshed.products is first.products
        assert refreshed.product_by_id is first.product_by_id
        assert refreshed.source_signatures == first.source_signatures
        assert refreshed.loaded_at >= first.loaded_at
        assert refreshed.product_by_id["p1"]["name"] == "Before"
        assert sources.started == sources.closed == 10
    asyncio.run(run())


def test_changed_source_refresh_rebuilds_and_retains_new_fields(clean_catalog, monkeypatch):
    async def run():
        sources = Sources()
        sources.release.set()
        monkeypatch.setattr(catalog, "db", sources)
        first = await catalog.get_catalog_snapshot()
        sources.product["name"] = "Changed outside this process"
        sources.product["price"] = 1234
        refreshed = await catalog.refresh_catalog_snapshot()
        assert refreshed.product_by_id["p1"]["name"] == "Changed outside this process"
        assert refreshed.product_by_id["p1"]["price"] == 1234
        assert first.product_by_id["p1"]["name"] == "Before"
        assert refreshed.source_signatures != first.source_signatures
        assert sources.started == sources.closed == 15
    asyncio.run(run())


@pytest.mark.parametrize("constraint", ["rows", "bytes"])
def test_warm_signature_scan_keeps_budget_and_falls_back_without_partial_results(clean_catalog, monkeypatch, constraint):
    async def run():
        sources = Sources()
        sources.release.set()
        monkeypatch.setattr(catalog, "db", sources)
        await catalog.get_catalog_snapshot()
        sources.products = [{"id": "p1", "active": True}, {"id": "p2", "active": True}]
        if constraint == "rows":
            monkeypatch.setattr(catalog, "_SNAPSHOT_ROW_LIMITS", {**catalog._SNAPSHOT_ROW_LIMITS, "products": 1})
        else:
            monkeypatch.setattr(catalog, "_SNAPSHOT_MAX_BYTES", 1)
        refreshed = await catalog.refresh_catalog_snapshot()
        assert refreshed.database_backed
        assert refreshed.products == ()
        assert refreshed.product_by_id == {}
        assert sources.started == sources.closed == 15
    asyncio.run(run())


def test_write_during_warm_signature_scan_cannot_refresh_stale_state(clean_catalog, monkeypatch):
    async def run():
        sources = Sources()
        sources.release.set()
        monkeypatch.setattr(catalog, "db", sources)
        await catalog.get_catalog_snapshot()
        sources.release.clear()
        sources.all_started = asyncio.Event()
        refresh = asyncio.create_task(catalog.refresh_catalog_snapshot())
        await asyncio.wait_for(sources.all_started.wait(), 1)
        sources.product["name"] = "Write during comparison"
        catalog._refresh_generation += 1
        sources.release.set()
        refreshed = await refresh
        assert refreshed.product_by_id["p1"]["name"] == "Write during comparison"
        assert sources.started == sources.closed
    asyncio.run(run())
