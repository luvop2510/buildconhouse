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
