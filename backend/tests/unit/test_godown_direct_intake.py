"""Direct godown intake and customer purchase visibility regression tests."""
import asyncio
from types import SimpleNamespace
from models import UserPublic

import pytest
from fastapi import HTTPException

from routes import godown_stock_routes as godown
from routes import purchases_tracker as tracker
from routes import quotation_routes as quotation


class Cursor:
    def __init__(self, rows): self.rows = rows
    def sort(self, *_args): return self
    async def to_list(self, _limit): return self.rows


class Products:
    def __init__(self, row=None): self.row = row; self.query = None
    async def find_one(self, query, *_args): self.query = query; return self.row
    def find(self, query, *_args): self.query = query; return Cursor([])


class Stock:
    def __init__(self): self.inserted = []
    async def insert_one(self, row): self.inserted.append(row)


def user():
    return UserPublic(id="u-1", email="warehouse@example.com", full_name="Warehouse", role="warehouse", floor_ids=["first-floor", "ground-floor"], active_floor_id="first-floor")


def test_direct_manual_intake_has_no_customer_source(monkeypatch):
    stock = Stock()
    monkeypatch.setattr(godown, "db", SimpleNamespace(products=Products(), godown_stock=stock))
    monkeypatch.setattr(godown, "log_event", lambda **_kwargs: asyncio.sleep(0))
    row = asyncio.run(godown.direct_intake(godown.DirectIntake(qty=3, sku="321", name="Valve", brand="Acme", image="https://example.com/valve.jpg", size="10mm", feature="brass", category="Fittings"), user()))
    assert row["floor_id"] == "first-floor"
    assert row["product_id"] == f"godown:{row['id']}"
    assert row["available_qty"] == 3
    assert row["source_type"] == "manual"
    assert "source_customer_id" not in row
    assert stock.inserted[0]["id"] == row["id"]


def test_direct_catalog_intake_uses_product_floor(monkeypatch):
    product = {"id": "p-1", "floor_id": "ground-floor", "sku": "334", "name": "Tile", "brand_id": "b-1", "images": ["https://example.com/tile.jpg"]}
    products = Products(product)
    monkeypatch.setattr(godown, "db", SimpleNamespace(products=products, godown_stock=Stock()))
    monkeypatch.setattr(godown, "log_event", lambda **_kwargs: asyncio.sleep(0))
    row = asyncio.run(godown.direct_intake(godown.DirectIntake(product_id="p-1", qty=2), user()))
    assert row["floor_id"] == "ground-floor"
    assert row["image"] == "https://example.com/tile.jpg"
    assert row["source_type"] == "catalog"
    assert products.query["$and"][1] == {"id": "p-1"}


def test_manual_intake_requires_sku_and_name(monkeypatch):
    monkeypatch.setattr(godown, "db", SimpleNamespace(products=Products(), godown_stock=Stock()))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(godown.direct_intake(godown.DirectIntake(qty=1, sku="321"), user()))
    assert exc.value.status_code == 422


def test_sku_suggestions_use_literal_floor_scoped_prefix(monkeypatch):
    products = Products()
    monkeypatch.setattr(godown, "db", SimpleNamespace(products=products))
    rows = asyncio.run(godown.sku_suggestions(prefix="3.*", user=user()))
    assert rows == []
    assert products.query["$and"][1]["sku"]["$regex"] == r"^3\.\*"


def test_customer_purchase_rows_subtract_transferred_quantity():
    po = {"id": "po-1", "floor_id": "first-floor"}
    row = tracker._flatten_item(po, {"id": "i-1", "name": "Valve", "qty": 5, "godown_transferred_qty": 2}, 7)
    assert row["qty"] == 3
    pipeline = tracker._items_page_pipeline(view="stock", brand=None, customer=None, stage=None, q=None, product_id=None, floor_ids=["first-floor"], sla_days=7, skip=0, limit=30)
    assert any(stage.get("$match", {}).get("$expr") for stage in pipeline)
    projected = next(stage["$project"] for stage in pipeline if "$project" in stage)
    assert projected["qty"] == {"$subtract": [{"$ifNull": ["$items.qty", 0]}, {"$ifNull": ["$items.godown_transferred_qty", 0]}]}


def test_stock_only_quotation_line_requires_matching_lot_and_floor(monkeypatch):
    class Lots:
        def __init__(self): self.query = None
        async def find_one(self, query, *_args):
            self.query = query
            return {"floor_id": "first-floor", "category_id": None}

    lots = Lots()
    monkeypatch.setattr(quotation, "db", SimpleNamespace(godown_stock=lots))
    matching = quotation.QuotationLineItem(product_id="godown:lot-1", godown_stock_id="lot-1", sku="321", name="Valve")
    row = asyncio.run(quotation._manual_stock_line(matching, user(), floor_id="first-floor"))
    assert row["floor_id"] == "first-floor"
    scoped = lots.query.get("$and", [None, lots.query])[-1]
    assert scoped == {"id": "lot-1", "product_id": "godown:lot-1", "source_type": "manual", "floor_id": "first-floor"}
    forged = matching.model_copy(update={"product_id": "godown:another-lot"})
    assert asyncio.run(quotation._manual_stock_line(forged, user())) is None
