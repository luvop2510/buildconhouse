"""Warehouse replacement cannot make superseded or uncounted lots reusable."""
import asyncio
from types import SimpleNamespace

from models import QuotationLineItem, UserPublic
from routes import quotation_routes as routes


def actor():
    return UserPublic(id="stock-owner", email="stock@example.test", full_name="Stock Owner",
                      role="owner", floor_ids=["first-floor"], active_floor_id="first-floor")


def test_imported_stock_identity_is_allowed_without_inventing_a_catalog_product(monkeypatch):
    class Lots:
        async def find_one(self, query, *_args):
            scoped = query.get("$and", [query])[-1]
            assert scoped["source_type"] == {"$in": ["manual", "warehouse_import"]}
            assert scoped["id"] == "imported-lot"
            assert scoped["product_id"] == "godown:imported-lot"
            assert scoped["floor_id"] == "first-floor"
            return {"floor_id": "first-floor", "category_id": None}

    monkeypatch.setattr(routes, "db", SimpleNamespace(godown_stock=Lots()))
    line = QuotationLineItem(product_id="godown:imported-lot", godown_stock_id="imported-lot",
                             sku="UNKNOWN", name="Unmatched supplied stock")
    assert asyncio.run(routes._manual_stock_line(line, actor(), floor_id="first-floor"))
    forged = line.model_copy(update={"godown_stock_id": "different-lot"})
    assert asyncio.run(routes._manual_stock_line(forged, actor())) is None


def test_quotation_stock_suggestions_exclude_archived_and_uncounted_inventory(monkeypatch):
    class Cursor:
        def sort(self, *_args):
            return self

        async def to_list(self, _limit):
            return [{"id": "live", "product_id": "basin", "available_qty": 3, "loaned_out_qty": 1}]

    class Lots:
        def find(self, query, *_args):
            assert query["floor_id"] == "first-floor"
            assert query["archived"] == {"$ne": True}
            assert query["quantity_missing"] == {"$ne": True}
            assert query["available_qty"] == {"$gt": 0}
            return Cursor()

    monkeypatch.setattr(routes, "db", SimpleNamespace(godown_stock=Lots()))
    quote = {"floor_id": "first-floor", "items": [{"id": "line", "product_id": "basin", "qty": 4}]}
    matches = asyncio.run(routes._godown_matches(quote))
    assert matches[0]["available_qty"] == 2
    assert matches[0]["replaceable_qty"] == 2
    assert asyncio.run(routes._godown_matches({**quote, "floor_id": "ground-floor"})) == []
