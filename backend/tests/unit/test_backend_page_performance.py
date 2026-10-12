"""Hermetic regressions for page latency without production database access."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from routes import executive_overview_routes as overview
from services import catalog_service as catalog
from services.analytics import gather
from services.analytics.filters import AnalyticsFilter
from services.analytics.periods import resolve


class CatalogCursor:
    def __init__(self, rows):
        self.rows = rows
        self.batch = None
        self.closed = False

    def batch_size(self, size):
        self.batch = size
        return self

    def __aiter__(self):
        async def iterate():
            for row in self.rows:
                # Yield to competing cold callers, as a remote cursor does.
                await asyncio.sleep(0)
                yield row
        return iterate()

    async def close(self):
        self.closed = True


class CatalogDb:
    def __init__(self, rows=None):
        self.rows = rows or {}
        self.reads = []

    def __getitem__(self, name):
        def find(query, projection):
            cursor = CatalogCursor(self.rows.get(name, []))
            self.reads.append((name, query, cursor))
            return cursor
        return SimpleNamespace(find=find)


@pytest.fixture
def cold_catalog(monkeypatch):
    fake = CatalogDb({"products": [{"id": "p1", "active": True}]})
    monkeypatch.setattr(catalog, "db", fake)
    monkeypatch.setattr(catalog, "_snapshot", None)
    monkeypatch.setattr(catalog, "_refresh_lock", asyncio.Lock())
    monkeypatch.setattr(catalog, "_background_refresh", None)
    return fake


def test_concurrent_cold_catalog_requests_share_one_complete_snapshot(cold_catalog):
    async def run():
        snapshots = await asyncio.gather(*(catalog.get_catalog_snapshot() for _ in range(12)))
        assert all(snapshot is snapshots[0] for snapshot in snapshots)
        assert snapshots[0].product_by_id["p1"]["active"] is True
        assert len(cold_catalog.reads) == 5
        assert all(cursor.closed for _, _, cursor in cold_catalog.reads)
        assert all(cursor.batch == 512 for _, _, cursor in cold_catalog.reads)
        # An explicit post-mutation refresh still reloads all collections.
        refreshed = await catalog.refresh_catalog_snapshot()
        assert refreshed is not snapshots[0]
        assert len(cold_catalog.reads) == 10
    asyncio.run(run())


@pytest.mark.parametrize("constraint", ["rows", "bytes"])
def test_catalog_growth_limits_discard_partial_snapshot_and_close_cursor(cold_catalog, monkeypatch, constraint):
    cold_catalog.rows["products"] = [{"id": "p1"}, {"id": "p2"}]
    if constraint == "rows":
        monkeypatch.setattr(catalog, "_SNAPSHOT_ROW_LIMITS", {**catalog._SNAPSHOT_ROW_LIMITS, "products": 1})
    else:
        monkeypatch.setattr(catalog, "_SNAPSHOT_MAX_BYTES", 1)
    snapshot = asyncio.run(catalog.get_catalog_snapshot())
    assert snapshot.database_backed is True
    assert snapshot.products == ()
    assert len(cold_catalog.reads) == 1
    assert cold_catalog.reads[0][2].closed is True


class ParallelReads:
    """Gate reads until the required independent requests are in flight.

    A sequential regression times out, so this tests scheduling rather than
    asserting a fragile wall-clock performance deadline.
    """
    def __init__(self, expected, rows=None):
        self.expected = expected
        self.started = 0
        self.active = 0
        self.peak = 0
        self.ready = asyncio.Event()
        self.rows = rows or []
        self.pipelines = []

    async def read(self, rows=None):
        self.started += 1
        self.active += 1
        self.peak = max(self.peak, self.active)
        if self.started >= self.expected:
            self.ready.set()
        try:
            await asyncio.wait_for(self.ready.wait(), timeout=1)
            await asyncio.sleep(0)
            return self.rows if rows is None else rows
        finally:
            self.active -= 1

    def aggregate(self, pipeline):
        self.pipelines.append(pipeline)
        return SimpleNamespace(to_list=lambda _limit: self.read())


def test_kpis_run_independent_current_comparison_and_payment_reads_together(monkeypatch):
    async def run():
        reads = ParallelReads(3)
        monkeypatch.setattr(overview, "db", SimpleNamespace(quotations=reads))
        result = await overview._kpis(AnalyticsFilter(), None, resolve("this_month"))
        assert reads.started == reads.peak == 3
        assert result["revenue"] == 0
        assert result["outstanding"]["outstanding"] == 0
        assert result["previous_revenue"] == 0
    asyncio.run(run())


def test_floor_breakdown_only_fetches_revenue_and_caps_parallelism(monkeypatch):
    async def run():
        reads = ParallelReads(4, [{"revenue": 15, "orders": 2}])
        monkeypatch.setattr(overview, "db", SimpleNamespace(quotations=reads))
        floors = [f"floor-{number}" for number in range(9)]
        result = await overview._revenue_by_floor(AnalyticsFilter(), floors, resolve("this_month"))
        assert result == [{"floor_id": floor, "revenue": 15, "orders": 2} for floor in floors]
        assert reads.started == 9  # formerly 27 queries, including unused joins
        assert reads.peak == 4
        assert all(not any("$lookup" in stage for stage in pipeline) for pipeline in reads.pipelines)
        assert [pipeline[0]["$match"]["floor_id"] for pipeline in reads.pipelines] == [{"$in": [floor]} for floor in floors]
    asyncio.run(run())


def test_brief_runs_its_three_independent_aggregates_together(monkeypatch):
    async def run():
        reads = ParallelReads(3)
        monkeypatch.setattr(overview, "db", SimpleNamespace(quotations=reads))
        result = await overview._brief(AnalyticsFilter(), None, SimpleNamespace(full_name="Owner", role="owner"), recommended=[])
        assert reads.started == reads.peak == 3
        assert result["yesterday"]["revenue"] == 0
        assert result["yesterday"]["top_product_revenue"] is None
    asyncio.run(run())


def test_attention_fetches_independent_sources_together_without_changing_results(monkeypatch):
    async def run():
        reads = ParallelReads(6)
        async def source(*_args):
            return await reads.read()
        async def collected(*_args):
            return [{"id": "ordered", "grand_total": 90, "collected": 30}]
        monkeypatch.setattr(gather, "_open_quotations", source)
        monkeypatch.setattr(gather, "_ordered_quotations", source)
        monkeypatch.setattr(gather, "_with_collected", collected)
        monkeypatch.setattr(gather, "_ready_items", source)
        monkeypatch.setattr(gather, "_unreleased_items", source)
        monkeypatch.setattr(gather, "_salespeople", source)
        def find(*_args):
            return SimpleNamespace(to_list=lambda _limit: reads.read())
        db = SimpleNamespace(followups=SimpleNamespace(find=find), purchase_orders=SimpleNamespace(find=find))
        result = await gather.gather_attention(db, AnalyticsFilter(), None, (None, None), {})
        assert reads.peak == 6
        assert result.orders == [{"id": "ordered", "grand_total": 90, "collected": 30}]
        assert result.followups == result.ready_items == []
    asyncio.run(run())
