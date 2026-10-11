"""Family cards must retain product-specific media and namespace identity."""
from __future__ import annotations

import asyncio

from services.catalog_service import _build_snapshot, hydrate_product, list_family_groups
import services.catalog_service as catalog_service


def _product(product_id: str, *, floor_id="first-floor", brand_id="brand-a", category_id="cat-a") -> dict:
    return {
        "id": product_id, "sku": f"SKU-{product_id}", "name": "Basin Family",
        "family_key": "supplier:shared-family", "family_name": "Basin Family",
        "floor_id": floor_id, "brand_id": brand_id, "category_id": category_id,
        "price": 100 if product_id == "a" else 200, "mrp": 150 if product_id == "a" else 250,
        "finish": "White" if product_id == "a" else "Black", "images": [],
    }


def _media(product_id: str, floor_id="first-floor") -> dict:
    return {
        "id": f"media-{product_id}", "product_id": product_id, "family_key": "supplier:shared-family",
        "floor_id": floor_id, "brand_id": "brand-a", "source_type": "supplier", "role": "hero",
        "bucket": "products", "storage_key": f"{product_id}.jpg", "public_url": f"https://cdn.test/{product_id}.jpg",
        "quality": "good", "sha1": f"sha-{product_id}", "is_primary": True, "sort_order": 0,
    }


def test_family_card_variants_and_sample_use_each_products_own_primary_media(monkeypatch):
    a, b = _product("a"), _product("b")
    snapshot = _build_snapshot([a, b], [_media("a"), _media("b")], [], [], [])

    async def fake_snapshot():
        return snapshot

    monkeypatch.setattr(catalog_service, "get_catalog_snapshot", fake_snapshot)
    result = asyncio.run(list_family_groups(
        brand_id=None, category_id=None, subcategory=None, series=None, q=None,
        limit=10, skip=0,
    ))

    family = result["items"][0]
    assert family["sample_product_id"] == "a"
    assert family["sample_image"] == "https://cdn.test/a.jpg"
    assert {item["id"]: item["image"] for item in family["variants"]} == {
        "a": "https://cdn.test/a.jpg", "b": "https://cdn.test/b.jpg",
    }


def test_seat_cover_photo_is_exact_product_fallback_when_hero_is_missing():
    cover = _product("cover")
    other = _product("other")
    media = _media("cover")
    media.update(role="seat-cover", is_primary=False)
    snapshot = _build_snapshot([cover, other], [media], [], [], [])
    hydrated = hydrate_product(cover, snapshot)
    assert hydrated["hero_image_url"] == "https://cdn.test/cover.jpg"
    assert catalog_service._primary_product_image(snapshot, "cover") == "https://cdn.test/cover.jpg"
    assert catalog_service._primary_product_image(snapshot, "other") is None


def test_family_card_shows_uploaded_seat_cover_photo(monkeypatch):
    cover = _product("cover")
    media = _media("cover")
    media.update(role="seat-cover", is_primary=False)
    snapshot = _build_snapshot([cover], [media], [], [], [])

    async def fake_snapshot():
        return snapshot

    monkeypatch.setattr(catalog_service, "get_catalog_snapshot", fake_snapshot)
    family = asyncio.run(list_family_groups(
        brand_id=None, category_id=None, subcategory=None, series=None, q=None,
        limit=10, skip=0,
    ))["items"][0]
    assert family["sample_image"] == "https://cdn.test/cover.jpg"


def test_family_card_variant_switching_exposes_each_skus_business_fields(monkeypatch):
    a, b = _product("a"), _product("b")
    a.update({"stock": 3, "dimensions": "100 mm", "material": "Brass", "warranty": "5 years", "specs": {"flow": "5 l/min"}})
    b.update({"stock": 9, "dimensions": "220 mm", "material": "Steel", "warranty": "10 years", "specs": {"flow": "7 l/min"}})
    snapshot = _build_snapshot([a, b], [_media("a"), _media("b")], [], [], [])

    async def fake_snapshot():
        return snapshot

    monkeypatch.setattr(catalog_service, "get_catalog_snapshot", fake_snapshot)
    family = asyncio.run(list_family_groups(
        brand_id=None, category_id=None, subcategory=None, series=None, q=None,
        limit=10, skip=0,
    ))["items"][0]

    switched = next(item for item in family["variants"] if item["id"] == "b")
    assert switched == {
        "id": "b", "sku": "SKU-b", "name": "Basin Family", "finish": "Black",
        "finish_code": None, "variant_label": None, "size": "220 mm", "colour": None,
        "color": None, "price": 200, "mrp": 250, "stock": 9, "dimensions": "220 mm",
        "dimension_image_urls": [], "seat_cover_image_urls": [],
        "material": "Steel", "warranty": "10 years", "specs": {"flow": "7 l/min"}, "description": None,
        "image": "https://cdn.test/b.jpg", "image_quality": None, "configuration_options": [], "concealed_part": None,
    }


def test_variant_hydration_never_crosses_a_floor_or_catalog_namespace():
    a = _product("a")
    same = _product("b")
    other_floor = _product("ground", floor_id="ground-floor")
    other_brand = _product("other-brand", brand_id="brand-b")
    other_category = _product("other-category", category_id="cat-b")
    snapshot = _build_snapshot(
        [a, same, other_floor, other_brand, other_category],
        [_media("a"), _media("b"), _media("ground", "ground-floor"), _media("other-brand"), _media("other-category")],
        [], [], [],
    )

    hydrated = hydrate_product(a, snapshot)
    assert [variant["id"] for variant in hydrated["variants"]] == ["b"]
    assert [variant["id"] for variant in hydrated["family_variants"]] == ["a", "b"]


def test_variant_hydration_keeps_every_finish_in_a_large_family():
    products = [_product(f"finish-{index}") for index in range(11)]
    snapshot = _build_snapshot(products, [], [], [], [])

    hydrated = hydrate_product(products[0], snapshot)

    assert [variant["id"] for variant in hydrated["variants"]] == [
        f"finish-{index}" for index in range(1, 11)
    ]


def test_hydrated_product_uses_its_actual_hero_quality_not_stale_import_metadata():
    product = _product("a")
    product["image_quality"] = "poor"
    snapshot = _build_snapshot([product], [_media("a")], [], [], [])

    hydrated = hydrate_product(product, snapshot)

    assert hydrated["image_quality"] == "good"


def test_same_supplier_key_does_not_merge_family_cards_across_floor_brand_or_category(monkeypatch):
    products = [
        _product("floor-a"), _product("floor-b", floor_id="ground-floor"),
        _product("brand-b", brand_id="brand-b"), _product("category-b", category_id="cat-b"),
    ]
    snapshot = _build_snapshot(products, [_media(product["id"], product["floor_id"]) for product in products], [], [], [])

    async def fake_snapshot():
        return snapshot

    monkeypatch.setattr(catalog_service, "get_catalog_snapshot", fake_snapshot)
    result = asyncio.run(list_family_groups(
        brand_id=None, category_id=None, subcategory=None, series=None, q=None,
        limit=10, skip=0,
    ))
    assert result["total"] == 4
