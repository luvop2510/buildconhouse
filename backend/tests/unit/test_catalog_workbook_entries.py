"""Workbook completeness, unique SKU cards, exact placement and source search."""
import asyncio
import copy

import pytest

from models import Product
from services import catalog_service as catalog


def entry(key, order, category="taps", **values):
    return {
        "entry_id": key, "source_catalog": "supplier.xlsx", "sheet_name": category,
        "sheet_order": 0 if category == "taps" else 1, "row_number": order + 3,
        "source_order": order, "serial_number": order + 1,
        "category_id": category, "category_name": category,
        "subcategory": None, "name": f"Supplier {key}", "description": None,
        "mrp": 100 + order, "price_status": "known", **values,
    }


def product(key, entries=None, **values):
    return {
        "id": key, "sku": key, "name": f"Canonical {key}", "brand_id": "supplier",
        "category_id": "taps", "floor_id": "first-floor", "images": [],
        "mrp": 100, "price": 100, "stock": 7, "active": True,
        "catalog_source": "supplier.xlsx" if entries else None,
        "catalog_entries": entries or [], "price_status": "known", **values,
    }


@pytest.fixture
def snapshot(monkeypatch):
    rows = [
        product("a", [entry("a0", 0), entry("a1", 4), entry("a2", 8, "showers", mrp=280)], family_key="finish-family", finish="Chrome", catalog_search_text="canonical words later-description extra-column exact note"),
        product("b", [entry("b0", 1)], family_key="finish-family", finish="Black"),
        product("missing", [entry("m0", 2, mrp=None, price_status="unspecified", name=None)], price_status="unspecified", price=0, mrp=0),
        product("existing", [entry("e0", 3, mrp=None, price_status="unspecified")], price_status="existing", price=450, mrp=450),
        product("retained", family_key="finish-family", catalog_search_text="legacy-absent"),
        product("other-floor", [entry("o0", 9)], floor_id="ground-floor"),
    ]
    brands = [{"id": "supplier", "name": "Supplier", "floor_id": "first-floor", "catalog_source": "supplier.xlsx", "catalog_order": 0, "catalog_authoritative": True}]
    categories = [{"id": key, "name": key, "floor_id": "first-floor", "brand_id": "supplier", "catalog_source": "supplier.xlsx", "catalog_order": order} for order, key in enumerate(["taps", "showers"])]
    categories.append({"id": "legacy", "name": "Legacy", "floor_id": "first-floor"})
    snap = catalog._build_snapshot(rows, [], brands, categories, [])
    async def get_snapshot():
        return snap
    monkeypatch.setattr(catalog, "get_catalog_snapshot", get_snapshot)
    return snap


def products(**kwargs):
    return asyncio.run(catalog.list_products_page(
        **{ "user_id": "staff", "q": None, "brand_id": "supplier", "category_id": None,
            "subcategory": None, "series": None, "family_key": None, "finish": None,
            "colour": None, "sort": "popular", "limit": 100, "skip": 0,
            "floor_ids": ["first-floor"], **kwargs },
    ))


def families(**kwargs):
    return asyncio.run(catalog.list_family_groups(
        **{"brand_id": "supplier", "category_id": None, "subcategory": None,
           "series": None, "q": None, "limit": 100, "skip": 0,
           "floor_ids": ["first-floor"], **kwargs},
    ))


def test_unique_cards_keep_supplier_order_and_missing_data(snapshot):
    before = copy.deepcopy(snapshot.products)
    result = products()
    assert result["total"] == 4
    assert [p["id"] for p in result["items"]] == ["a", "b", "missing", "existing"]
    assert products(skip=2, limit=2)["items"] == result["items"][2:]
    missing = result["items"][2]
    assert missing["name"] == "Canonical missing"
    assert missing["images"] == []
    assert missing["price_unknown"] is True
    assert missing["catalog_entry"]["mrp"] is None
    existing = result["items"][3]
    assert existing["price"] == 450
    assert existing["price_unknown"] is False
    assert existing["source_price_unspecified"] is True
    assert existing["price_source"] == "existing"
    assert snapshot.products == before


def test_secondary_category_and_price_do_not_change_canonical_id(snapshot):
    result = products(category_id="showers")
    assert result["total"] == 1
    row = result["items"][0]
    assert (row["id"], row["listing_id"], row["category_id"], row["mrp"], row["price"]) == ("a", "a2", "showers", 280, 280)
    detail = asyncio.run(catalog.product_by_id("a", ["first-floor"], "a2"))
    assert detail["category_id"] == "showers"
    assert len(detail["catalog_entries"]) == 3
    assert snapshot.product_by_id["a"]["category_id"] == "taps"
    assert asyncio.run(catalog.product_by_id("a", ["ground-floor"], "a2")) is None
    assert asyncio.run(catalog.product_by_id("a", ["first-floor"], "nonexistent")) is None


def test_family_cards_do_not_merge_source_skus_or_repeat_workbook_lines(snapshot):
    result = families()
    assert result["total"] == 4
    assert [r["sample_product_id"] for r in result["items"]] == ["a", "b", "missing", "existing"]
    assert [r["id"] for r in result["items"][0]["variants"]] == ["a", "b"]
    assert [r["id"] for r in result["items"][1]["variants"]] == ["b", "a"]
    assert result["items"][2]["price_unknown"] is True
    assert [r["id"] for r in families(category_id="showers")["items"][0]["variants"]] == ["a"]


@pytest.mark.parametrize("word", ["later-description", "extra-column", "exact note"])
def test_all_source_words_search_both_catalog_views(snapshot, word):
    assert [p["id"] for p in products(q=word)["items"]] == ["a"]
    assert [p["sample_product_id"] for p in families(q=word)["items"]] == ["a"]
    for group in [False, True]:
        found = asyncio.run(catalog.search_catalog(q=word, brand_id="supplier", category_id=None, subcategory=None, series=None, limit=100, group=group, floor_ids=["first-floor"]))
        assert found["total"] == 1
        assert found["items"][0].get("id", found["items"][0].get("sample_product_id")) == "a"


def test_authoritative_catalog_hides_extras_but_preserves_direct_detail(snapshot):
    assert products(q="legacy-absent")["total"] == 0
    assert families(q="legacy-absent")["total"] == 0
    assert asyncio.run(catalog.product_by_id("retained", ["first-floor"]))["id"] == "retained"
    brands = asyncio.run(catalog.list_brands_with_counts(["first-floor"]))
    assert brands[0]["product_count"] == 4
    categories = asyncio.run(catalog.list_categories_with_counts("supplier", ["first-floor"]))
    assert [(c["id"], c["product_count"]) for c in categories] == [("taps", 4), ("showers", 1)]
    rows, brands, _ = asyncio.run(catalog.hierarchy_rows(["first-floor"]))
    assert sum(r["product_count"] for r in rows) == 5
    assert brands["supplier"]["product_count"] == 4
    facets = asyncio.run(catalog.facet_buckets(brand_id="supplier", category_id=None, subcategory=None, series=None, floor_ids=["first-floor"]))
    assert facets["brands"] == [{"value": "supplier", "count": 4}]
    assert facets["price"]["min"] > 0


def test_model_retains_raw_source_words_and_notes(snapshot):
    raw = product("raw", [entry("r0", 0, source_status_note="DISCONTINUE limited quantity", source_cells={"D": "Do not omit this phrase"}, source_sku="01800187", article_raw=1800187)])
    model = Product(**raw)
    saved = model.model_dump()["catalog_entries"][0]
    assert saved["source_status_note"] == "DISCONTINUE limited quantity"
    assert saved["source_cells"]["D"] == "Do not omit this phrase"
    assert saved["article_raw"] == 1800187
