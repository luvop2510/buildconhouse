from scripts.media_recovery_queue import displayed_hero, media_sort_key
import pytest
from services.catalog_service import _build_snapshot, hydrate_product
from services.media_service import _apply_media_to_product
from models import ProductMedia


def test_displayed_hero_matches_catalog_precedence_for_a_product():
    supplier_primary = {
        "id": "supplier-primary", "source_type": "supplier", "is_primary": True,
        "role": "hero", "public_url": "https://example.test/supplier", "sort_order": 0,
    }
    manufacturer_hero = {
        "id": "manufacturer-hero", "source_type": "manufacturer", "is_primary": True,
        "role": "hero", "public_url": "https://example.test/manufacturer", "sort_order": 0,
    }

    assert displayed_hero([supplier_primary, manufacturer_hero]) == manufacturer_hero


def test_displayed_hero_ignores_private_and_uses_first_public_fallback():
    private_primary = {
        "id": "private", "source_type": "manufacturer", "is_primary": True,
        "role": "hero", "public_url": None, "sort_order": 0,
    }
    public_gallery = {
        "id": "gallery", "source_type": "supplier", "is_primary": False,
        "role": "gallery", "public_url": "https://example.test/gallery", "sort_order": 10,
    }

    assert displayed_hero([private_primary, public_gallery]) == public_gallery


def test_media_sort_key_prefers_source_then_primary_then_explicit_order():
    assert media_sort_key({"source_type": "manufacturer", "is_primary": True, "sort_order": 50}) < media_sort_key({"source_type": "supplier", "is_primary": True, "sort_order": 0})
    assert media_sort_key({"source_type": "supplier", "is_primary": True, "sort_order": 50}) < media_sort_key({"source_type": "supplier", "is_primary": False, "sort_order": 0})


@pytest.mark.parametrize("roles,legacy", [
    (["dimension"], []),
    (["dimension", "seat-cover"], []),
    (["dimension", "gallery"], []),
    (["dimension", "seat-cover", "hero"], []),
    (["seat-cover"], ["https://example.test/legacy.jpg"]),
    ([], ["https://example.test/legacy.jpg"]),
    ([], [None, "https://example.test/legacy.jpg"]),
])
def test_recovery_audit_matches_runtime_supplementary_and_legacy_policy(roles, legacy):
    product = {"id": "p", "sku": "SKU", "brand_id": "b", "category_id": "c",
               "floor_id": "first-floor", "images": legacy, "image_quality": "good", "variants": []}
    rows = [{"id": f"m{i}", "product_id": "p", "brand_id": "b", "floor_id": "first-floor",
             "source_type": "supplier", "role": role, "is_primary": True, "sort_order": i,
             "public_url": f"https://example.test/{role}.jpg", "quality": "good",
             "bucket": "forge-products", "storage_key": f"m{i}.jpg", "sha1": f"hash{i}"}
            for i, role in enumerate(roles)]
    runtime = hydrate_product(product, _build_snapshot([product], rows, [], [], []))
    database_product = dict(product)
    _apply_media_to_product(database_product, [ProductMedia(**row) for row in rows])
    hero = displayed_hero(rows, product)
    assert (hero or {}).get("public_url") == runtime["hero_image_url"]
    assert database_product["hero_image_url"] == runtime["hero_image_url"]
    assert database_product["images"] == runtime["images"]
    assert database_product["image_quality"] == runtime["image_quality"]
