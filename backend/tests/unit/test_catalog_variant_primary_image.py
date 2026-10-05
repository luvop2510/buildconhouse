"""Selected finish images must use that SKU's real primary media row."""
from services.catalog_service import _build_snapshot, hydrate_product
from services.catalog_service import _primary_product_image


def _product(product_id: str, sku: str) -> dict:
    return {
        "id": product_id, "sku": sku, "family_key": "finish-family",
        "floor_id": "first-floor", "brand_id": "brand", "category_id": "category",
        "images": [], "variants": [],
    }


def _media(media_id: str, product_id: str, url: str, *, primary: bool, sort_order: int) -> dict:
    return {
        "id": media_id, "product_id": product_id, "family_key": "finish-family",
        "brand_id": "brand", "floor_id": "first-floor", "source_type": "supplier",
        "role": "hero" if primary else "gallery", "bucket": "forge-products",
        "storage_key": f"{media_id}.jpg", "public_url": url, "quality": "good",
        "sha1": media_id, "is_primary": primary, "sort_order": sort_order,
    }


def test_variant_image_uses_its_primary_media_not_a_thumbnail_row():
    chrome = _product("chrome", "CHROME")
    brown_red = _product("brown-red", "BROWN-RED")
    snapshot = _build_snapshot(
        [chrome, brown_red],
        [
            _media("chrome-primary", "chrome", "https://cdn.example/chrome.jpg", primary=True, sort_order=1),
            _media("brown-thumb", "brown-red", "https://cdn.example/brown-thumb.jpg", primary=False, sort_order=0),
            _media("brown-primary", "brown-red", "https://cdn.example/brown-red.jpg", primary=True, sort_order=99),
        ],
        [], [], [],
    )

    hydrated = hydrate_product(chrome, snapshot)
    brown_variant = next(variant for variant in hydrated["variants"] if variant["sku"] == "BROWN-RED")

    assert brown_variant["image"] == "https://cdn.example/brown-red.jpg"


def test_variant_preview_matches_product_hero_when_internal_gallery_precedes_official_primary():
    product = _product("bronze", "BRONZE")
    internal = _media("internal-gallery", "bronze", "https://cdn.example/internal.jpg", primary=False, sort_order=0)
    internal["source_type"] = "internal"
    official = _media("official-hero", "bronze", "https://cdn.example/official.jpg", primary=True, sort_order=0)
    official["source_type"] = "manufacturer"
    snapshot = _build_snapshot([product], [internal, official], [], [], [])

    hydrated = hydrate_product(product, snapshot)
    assert hydrated["hero_image_url"] == official["public_url"]
    assert _primary_product_image(snapshot, "bronze") == hydrated["hero_image_url"]
