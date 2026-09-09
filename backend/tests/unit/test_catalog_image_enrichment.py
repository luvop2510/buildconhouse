from scripts.catalog_image_enrichment import (
    asset_urls,
    is_approved_ready_row,
    is_acceptable_asset,
    is_primary_hero_asset_url,
    normalized_sku,
    search_result_urls,
    storage_matches_registered_media,
    weak_media_to_remove,
)
from scripts.media_recovery_queue import meets_top_notch_media_standard


def test_normalized_sku_ignores_harmless_punctuation_but_not_content():
    assert normalized_sku("13 264 GN1") == "13264GN1"
    assert normalized_sku("13.264.GN1") == "13264GN1"
    assert normalized_sku("13 265 GN1") != "13264GN1"


def test_recovery_gate_requires_real_4k_rasters_or_svg_masters():
    assert is_acceptable_asset(3840, 2160)
    assert is_acceptable_asset(2160, 3840)
    assert not is_acceptable_asset(3839, 2160)
    assert not is_acceptable_asset(3840, 2159)
    assert is_acceptable_asset(1, 1, "image/svg+xml")


def test_search_results_keep_only_the_configured_first_party_domain():
    page = '''
      <a class="result__a" href="https://www.grohe.com/en/product/13264GN1">official</a>
      <a class="result__a" href="https://marketplace.example/13264GN1">seller</a>
    '''
    assert search_result_urls(page, "grohe.com") == ["https://www.grohe.com/en/product/13264GN1"]


def test_asset_extraction_accepts_only_sku_named_originals_and_ignores_data_urls():
    page = '''
      <meta property="og:image" content="/assets/thumbnail.jpg">
      <img src="data:image/png;base64,AAAA">
      <img src="https://cdn.example/13264GN1-master.jpg">
    '''
    assets = asset_urls(page, "https://www.grohe.com/product/13264GN1", "13264GN1", limit=10)
    assert assets == ["https://cdn.example/13264GN1-master.jpg"]


def test_technical_exact_sku_assets_are_not_valid_primary_heroes():
    assert not is_primary_hero_asset_url("https://cdn.cloud.grohe.com/PQCharts/lores/2/265/original/26566GN0.svg")
    assert is_primary_hero_asset_url("https://cdn.example/products/26566GN0-master.svg")


def test_weak_media_is_removed_only_after_a_usable_manufacturer_hero_exists():
    rows = [
        {"id": "official", "source_type": "manufacturer", "is_primary": True, "role": "hero", "public_url": "https://official", "width": 3840, "height": 2160, "quality": "excellent"},
        {"id": "legacy", "source_type": "supplier", "public_url": "https://legacy", "width": 120, "height": 120, "quality": "poor"},
    ]
    assert weak_media_to_remove(rows) == ["legacy"]


def test_weak_media_is_preserved_without_a_usable_official_hero():
    rows = [
        {"id": "supplier", "source_type": "supplier", "is_primary": True, "role": "hero", "public_url": "https://supplier", "width": 1000, "height": 800, "quality": "good"},
        {"id": "legacy", "source_type": "supplier", "public_url": "https://legacy", "width": 120, "height": 120, "quality": "poor"},
    ]
    assert weak_media_to_remove(rows) == []


def test_top_notch_queue_signal_is_independent_of_legacy_quality_label():
    assert not meets_top_notch_media_standard({
        "mime": "image/jpeg", "width": 1200, "height": 1200, "quality": "excellent",
    })
    assert meets_top_notch_media_standard({
        "mime": "image/jpeg", "width": 3840, "height": 2160, "quality": "excellent",
    })
    assert meets_top_notch_media_standard({"mime": "image/svg+xml", "width": None, "height": None})


def test_apply_requires_explicit_attributable_approval_for_ready_rows():
    row = {"outcome": "ready"}
    assert not is_approved_ready_row(row)
    assert not is_approved_ready_row({
        **row, "approval": {"status": "approved", "reviewer": "", "reviewed_at": "2026-09-09T00:00:00Z"},
    })
    assert is_approved_ready_row({
        **row, "approval": {"status": "approved", "reviewer": "catalog-review", "reviewed_at": "2026-09-09T00:00:00Z"},
    })


def test_storage_readback_must_match_registered_size_and_sha1():
    class Media:
        size_bytes = 3
        sha1 = "a9993e364706816aba3e25717850c26c9cd0d89d"

    assert storage_matches_registered_media(b"abc", Media())
    assert not storage_matches_registered_media(b"abd", Media())
