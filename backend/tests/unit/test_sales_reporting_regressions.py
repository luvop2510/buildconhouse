"""Reporting regressions exercised against records, never a live database."""
import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from routes import sales_workspace_routes as workspaces
from services.analytics import gather_breakdowns
from services.analytics.filters import AnalyticsFilter, FloorAccessError, build_match
from services.analytics.periods import buckets


def matches(doc, query):
    for key, expected in query.items():
        value = ([item.get("product_id") for item in doc.get("items", [])]
                 if key == "items.product_id" else doc.get(key))
        if not isinstance(expected, dict):
            if value != expected:
                return False
        else:
            for op, bound in expected.items():
                if op == "$in" and not (any(v in bound for v in value) if isinstance(value, list) else value in bound):
                    return False
                if op == "$gte" and (value is None or value < bound):
                    return False
                if op == "$lt" and (value is None or value >= bound):
                    return False
    return True


class Cursor:
    def __init__(self, docs):
        self.docs = docs

    async def to_list(self, limit=None):
        return self.docs[:limit] if limit is not None else self.docs


class Collection:
    def __init__(self, docs):
        self.docs = docs
        self.queries = []

    def find(self, query, projection=None):
        self.queries.append(query)
        return Cursor([doc for doc in self.docs if matches(doc, query)])

    def aggregate(self, pipeline):
        query = pipeline[0]["$match"]
        self.queries.append(query)
        totals = {}
        for doc in self.docs:
            if matches(doc, query):
                month = doc["ordered_at"][:7]
                totals[month] = totals.get(month, 0) + float(doc.get("grand_total") or 0)
        return Cursor([{"_id": month, "total": total} for month, total in totals.items()])


def order(month, total=100, **overrides):
    return {
        "id": str(month), "status": "ordered", "ordered_at": f"2026-{month:02d}-01T00:00:00+00:00",
        "floor_id": "ground-floor", "created_by": "sales-1", "grand_total": total,
        "items": [{"product_id": "p1"}], **overrides,
    }


def test_adjacent_chart_buckets_count_a_midnight_order_once():
    periods = buckets("2026-06-01T00:00:00+00:00", "2026-09-01T00:00:00+00:00", "month")
    counts = [int(matches(order(7), build_match(AnalyticsFilter(), None, (p.start, p.end)))) for p in periods]
    assert counts == [0, 1, 0]


@pytest.mark.parametrize("months,expected", [([], None), ([6], None), ([6, 7], None), ([6, 7, 8], 100)])
def test_forecast_requires_observed_history(monkeypatch, months, expected):
    database = SimpleNamespace(quotations=Collection([order(month) for month in months]))
    monkeypatch.setattr(workspaces, "db", database)
    result = asyncio.run(workspaces._forecast(AnalyticsFilter(), None, datetime(2026, 9, 5, tzinfo=timezone.utc)))
    assert result["forecast"] == expected
    assert result["months_used"] == len(months)
    assert result["history_state"] == ("ok" if expected is not None else "insufficient_history")


def test_forecast_excludes_current_month_other_staff_and_floors(monkeypatch):
    docs = [order(month, month * 100) for month in (6, 7, 8)]
    docs += [order(9, 99999), order(6, 99999, created_by="sales-2"), order(7, 99999, floor_id="first-floor")]
    monkeypatch.setattr(workspaces, "db", SimpleNamespace(quotations=Collection(docs)))
    result = asyncio.run(workspaces._forecast(
        AnalyticsFilter(floor_id="ground-floor", salesperson_id="sales-1"), ["ground-floor"],
        datetime(2026, 9, 5, tzinfo=timezone.utc),
    ))
    assert result["monthly_history"] == [600, 700, 800]
    assert result["forecast"] == 700


def test_forecast_resolves_brand_once_and_keeps_zero_revenue_months(monkeypatch):
    database = SimpleNamespace(
        products=Collection([{"id": "p1", "brand_id": "b1", "floor_id": "ground-floor"}]),
        quotations=Collection([order(month, 0) for month in (6, 7, 8)] +
                              [order(8, 9999, items=[{"product_id": "p2"}])]),
    )
    monkeypatch.setattr(workspaces, "db", database)
    result = asyncio.run(workspaces._forecast(
        AnalyticsFilter(floor_id="ground-floor", brand_id="b1"), ["ground-floor"],
        datetime(2026, 9, 5, tzinfo=timezone.utc),
    ))
    assert result["monthly_history"] == [0, 0, 0]
    assert result["months_used"] == 3
    assert result["forecast"] == 0
    assert len(database.products.queries) == len(database.quotations.queries) == 1


def test_breakdown_and_order_filters_include_the_same_orders():
    database = SimpleNamespace(
        products=Collection([{"id": "p1", "brand_id": "b1", "floor_id": "ground-floor"}]),
        quotations=Collection([order(6), order(7, created_by="sales-2"), order(8, items=[{"product_id": "p2"}])]),
    )
    f = AnalyticsFilter(floor_id="ground-floor", salesperson_id="sales-1", brand_id="b1")
    rows = asyncio.run(gather_breakdowns.gather_confirmed_orders(database, f, ["ground-floor"], (None, None)))
    assert [row["id"] for row in rows] == ["6"]
    assert database.products.queries[0]["floor_id"] == {"$in": ["ground-floor"]}


def test_breakdown_missing_brand_matches_nothing():
    database = SimpleNamespace(products=Collection([]), quotations=Collection([order(6)]))
    rows = asyncio.run(gather_breakdowns.gather_confirmed_orders(database, AnalyticsFilter(brand_id="missing"), None, (None, None)))
    assert rows == []


def test_breakdown_forbidden_floor_refused_before_catalog_lookup():
    database = SimpleNamespace(products=Collection([]))
    with pytest.raises(FloorAccessError):
        asyncio.run(gather_breakdowns.gather_confirmed_orders(
            database, AnalyticsFilter(floor_id="first-floor", brand_id="b1"), ["ground-floor"], (None, None),
        ))
    assert database.products.queries == []
