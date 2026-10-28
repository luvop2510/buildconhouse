"""Save validation reads current, scoped products in bounded batches."""
import asyncio
from types import SimpleNamespace

import pytest

from auth import floor_query as real_floor_query
from models import QuotationLineItem, UserPublic
from routes import quotation_routes as routes


def matches(row, query):
    return all(
        all(matches(row, clause) for clause in value) if key == "$and"
        else row.get(key) in value["$in"] if isinstance(value, dict)
        else row.get(key) == value
        for key, value in query.items()
    )


class Products:
    def __init__(self, rows):
        self.rows = rows
        self.queries = []

    def find(self, query, projection):
        self.queries.append(query)
        assert projection["id"] == 1
        rows = [dict(row) for row in reversed(self.rows) if matches(row, query)]

        async def to_list(length):
            assert length <= 500
            return rows[:length]

        return SimpleNamespace(to_list=to_list)


def line(product_id):
    return QuotationLineItem(product_id=product_id, sku=product_id, name="Tile", qty=1, unit_price=100)


@pytest.mark.parametrize("size,expected_calls", [(0, 0), (100, 1), (501, 2), (1001, 3)])
def test_validation_batches_unique_products_and_restores_input_order(monkeypatch, size, expected_calls):
    products = Products([{"id": f"p{i}", "floor_id": "ground-floor"} for i in range(size)])
    monkeypatch.setattr(routes, "db", SimpleNamespace(products=products))
    monkeypatch.setattr(routes, "floor_query", real_floor_query)
    user = UserPublic(id="sales", email="sales@test.example", full_name="Sales", role="sales",
                      floor_ids=["ground-floor"], active_floor_id="ground-floor")
    result = asyncio.run(routes._quotation_catalog_products([line(f"p{i}") for i in range(size)], user,
                                                           floor_id="ground-floor"))
    assert [row["id"] for row in result] == [f"p{i}" for i in range(size)]
    assert len(products.queries) == expected_calls


def test_validation_preserves_duplicates_missing_rows_and_floor_intersection(monkeypatch):
    products = Products([
        {"id": "ground", "floor_id": "ground-floor", "mrp": 125},
        {"id": "sanitary", "floor_id": "first-floor", "mrp": 900},
    ])
    monkeypatch.setattr(routes, "db", SimpleNamespace(products=products))
    monkeypatch.setattr(routes, "floor_query", real_floor_query)
    user = UserPublic(id="sales", email="sales@test.example", full_name="Sales", role="sales",
                      floor_ids=["ground-floor"], active_floor_id="ground-floor")
    lines = [line("ground"), line("missing"), line("ground"), line("sanitary")]
    result = asyncio.run(routes._quotation_catalog_products(lines, user))
    assert result == [products.rows[0], None, products.rows[0], None]
    assert len(products.queries) == 1
    assert result[0]["mrp"] == 125
    products.rows[0]["mrp"] = 200
    fresh = asyncio.run(routes._quotation_catalog_products(lines[:1], user))
    assert fresh[0]["mrp"] == 200
    forbidden = asyncio.run(routes._quotation_catalog_products(lines, user, floor_id="first-floor"))
    assert forbidden == [None, None, None, None]
