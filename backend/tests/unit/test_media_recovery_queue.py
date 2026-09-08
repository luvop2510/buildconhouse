from scripts.media_recovery_queue import displayed_hero, media_sort_key


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
