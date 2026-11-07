"""Catalog card hydration must scale with the requested page, not catalog size."""
import asyncio

from services import catalog_service as catalog


def test_family_page_only_hydrates_requested_groups(monkeypatch):
    products = [{
        "id": f"p{index:04d}", "sku": f"SKU{index:04d}", "name": f"Product {index:04d}",
        "family_key": f"family{index:04d}", "brand_id": "brand", "category_id": "category",
        "floor_id": "first-floor", "price": 100, "active": True,
    } for index in range(1000)]
    snapshot = catalog._build_snapshot(products, [], [], [], [])

    async def get_snapshot():
        return snapshot

    monkeypatch.setattr(catalog, "get_catalog_snapshot", get_snapshot)
    calls = []
    original = catalog._variant_summary

    def summary(product, context):
        calls.append(product["id"])
        return original(product, context)

    monkeypatch.setattr(catalog, "_variant_summary", summary)

    async def check():
        page = await catalog.list_family_groups(brand_id=None, category_id=None, subcategory=None,
            series=None, q=None, limit=3, skip=5, floor_ids=["first-floor"])
        assert page["total"] == 1000
        assert [row["sample_product_id"] for row in page["items"]] == ["p0005", "p0006", "p0007"]
        assert calls == ["p0005", "p0006", "p0007"]
        page["items"][0]["variants"][0]["specs"]["test"] = True
        assert "test" not in snapshot.product_by_id["p0005"].get("specs", {})
        calls.clear()
        empty = await catalog.list_family_groups(brand_id=None, category_id=None, subcategory=None,
            series=None, q=None, limit=3, skip=1000, floor_ids=["first-floor"])
        assert empty == {"total": 1000, "items": []}
        assert calls == []

    asyncio.run(check())


def test_grouped_search_hydrates_only_visible_families(monkeypatch):
    products = [{
        "id": f"p{index:04d}", "sku": f"SKU{index:04d}", "name": f"Product {index:04d}",
        "family_key": f"family{index // 10:04d}", "brand_id": "brand", "category_id": "category",
        "floor_id": "first-floor", "price": 100, "active": True,
    } for index in range(1000)]
    snapshot = catalog._build_snapshot(products, [], [], [], [])
    monkeypatch.setattr(catalog, "_snapshot", snapshot)
    calls = []
    original = catalog._variant_summary

    def summary(product, context):
        calls.append(product["id"])
        return original(product, context)

    monkeypatch.setattr(catalog, "_variant_summary", summary)
    page = asyncio.run(catalog.search_catalog(
        q="product", brand_id=None, category_id=None, subcategory=None,
        series=None, limit=3, group=True, floor_ids=["first-floor"],
    ))
    assert page["total"] == 100
    assert [row["sample_product_id"] for row in page["items"]] == ["p0000", "p0010", "p0020"]
    assert calls == [f"p{index:04d}" for index in range(30)]
    assert [row["product_count"] for row in page["items"]] == [10, 10, 10]


def test_workbook_detail_only_projects_the_selected_product(monkeypatch):
    products = [{
        "id": f"p{index}", "sku": f"SKU{index}", "name": f"Product {index}",
        "brand_id": "brand", "category_id": "category", "floor_id": "first-floor",
        "price": 100, "active": True,
        "catalog_entries": [{"entry_id": f"entry{index}", "category_id": "other", "mrp": 120}],
    } for index in range(1000)]
    snapshot = catalog._build_snapshot(products, [], [], [], [])
    monkeypatch.setattr(catalog, "_snapshot", snapshot)
    calls = []
    project = catalog._product_listing

    def listing(product, entry):
        calls.append(product["id"])
        return project(product, entry)

    monkeypatch.setattr(catalog, "_product_listing", listing)
    result = asyncio.run(catalog.product_by_id("p999", ["first-floor"], "entry999"))
    assert (result["id"], result["category_id"], result["price"]) == ("p999", "other", 120)
    assert calls == ["p999"]
    assert asyncio.run(catalog.product_by_id("p999", ["ground-floor"], "entry999")) is None
    assert asyncio.run(catalog.product_by_id("p999", ["first-floor"], "entry0")) is None
