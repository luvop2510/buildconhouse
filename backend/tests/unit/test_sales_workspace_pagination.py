"""Scalable owner reads preserve scope, balances and the existing response contract."""
import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from models import UserPublic
from routes import sales_workspace_routes as routes
from services.analytics.metrics import line_revenue_pipeline
from services.analytics.workspaces import gather_workspace, workspace_pipeline
from tests.unit.test_sales_reporting_regressions import matches


class Cursor:
    def __init__(self, docs):
        self.docs = docs

    def sort(self, fields):
        for key, direction in reversed(fields):
            self.docs.sort(key=lambda d: d.get(key) or "", reverse=direction < 0)
        return self

    def skip(self, offset):
        self.docs = self.docs[offset:]
        return self

    def limit(self, limit):
        self.docs = self.docs[:limit]
        return self

    async def to_list(self, limit):
        return self.docs[:limit] if limit is not None else self.docs


class Collection:
    def __init__(self, docs):
        self.docs = docs
        self.projections = []

    def find(self, query, projection):
        self.projections.append(projection)
        return Cursor([{k: d[k] for k, included in projection.items() if included and k in d}
                       for d in self.docs if matches(d, query)])

    async def count_documents(self, query):
        return sum(matches(d, query) for d in self.docs)


def owner():
    return UserPublic(id="owner", email="owner@example.com", full_name="Owner", role="owner")


def test_records_beyond_ten_thousand_remain_discoverable_with_stable_page_order(monkeypatch):
    # Keep the preset window aligned with this fixture after the calendar advances.
    resolve = routes.resolve
    monkeypatch.setattr(routes, "resolve", lambda *args: resolve(*args, now=datetime(2026, 9, 20, tzinfo=timezone.utc)))
    docs = [{"id": f"q-{i:05}", "status": "ordered", "floor_id": "ground-floor",
             "ordered_at": "2026-09-05T00:00:00+00:00", "grand_total": 100, "items": ["large-unused-payload"]}
            for i in range(10003)]
    docs += [{**docs[0], "id": "excluded", "floor_id": "first-floor"}, {**docs[0], "status": "draft"}]
    collection = Collection(docs)
    monkeypatch.setattr(routes, "db", SimpleNamespace(quotations=collection))
    collection_reads = []

    async def collected(database, orders):
        collection_reads.append([d["id"] for d in orders])
        return {"q-00002": 25}

    monkeypatch.setattr(routes, "gather_order_collections", collected)
    result = asyncio.run(routes.sales_records(floor_id="ground-floor", preset="this_month", offset=10000, limit=25, user=owner()))
    assert result["total"] == 10003
    assert [r["id"] for r in result["rows"]] == ["q-00002", "q-00001", "q-00000"]
    assert result["rows"][0]["outstanding"] == 75
    assert collection_reads == [["q-00002", "q-00001", "q-00000"]]
    assert "items" not in collection.projections[0]


def test_page_can_be_empty_without_losing_full_scope_count(monkeypatch):
    monkeypatch.setattr(routes, "db", SimpleNamespace(quotations=Collection([])))
    monkeypatch.setattr(routes, "gather_order_collections", AsyncMock(return_value={}))
    result = asyncio.run(routes.sales_records(offset=100, limit=25, user=owner()))
    assert result == {"rows": [], "total": 0, "offset": 100, "limit": 25}


def test_workspace_aggregates_all_matching_orders_before_limiting_rankings():
    match = {"status": "ordered", "floor_id": {"$in": ["ground-floor"]}}
    pipeline = workspace_pipeline(match, "architect")
    assert pipeline[0] == {"$match": match}
    assert not any("$limit" in stage for stage in pipeline)
    facets = pipeline[-1]["$facet"]
    assert not any("$limit" in stage for stage in facets["totals"])
    lookup = facets["totals"][0]["$lookup"]
    assert {"$eq": ["$status", "completed"]} in lookup["pipeline"][0]["$match"]["$expr"]["$and"]
    assert facets["totals"][2]["$group"]["outstanding"]["$sum"]["$max"][0] == 0
    assert facets["relationships"][0]["$match"]["referrer_type"] == "architect"
    assert facets["customers"][0].get("$group") is not None
    assert {"$limit": 100} in facets["customers"]


def test_unlimited_brand_rollup_retains_every_product_but_explicit_limits_still_work():
    assert not any("$limit" in s for s in line_revenue_pipeline({}, "items.product_id", limit=None))
    assert line_revenue_pipeline({}, "items.product_id", limit=12)[-1] == {"$limit": 12}


@pytest.mark.parametrize("raw,expected", [([], {"revenue": 0.0, "orders": 0, "outstanding": 0.0}),
    ([{"totals": [{"revenue": 1000100.125, "orders": 10001, "outstanding": 2.499}]}],
     {"revenue": 1000100.12, "orders": 10001, "outstanding": 2.5})])
def test_workspace_shapes_empty_and_large_aggregate_totals(raw, expected):
    db = SimpleNamespace(quotations=SimpleNamespace(aggregate=lambda pipeline: Cursor(raw)))
    result = asyncio.run(gather_workspace(db, {}))
    assert result["kpis"] == expected
    assert result["customers"] == []
