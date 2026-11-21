"""Quotation photos follow the exact catalogue SKU through PDF rendering."""
from __future__ import annotations

import asyncio
from base64 import b64encode
from io import BytesIO
from unittest.mock import AsyncMock

from PIL import Image
from pypdf import PdfReader
import pytest

import pdf_generator
import routes.quotation_routes as quotation_routes
from services import catalog_service


def _product(product_id, sku, *, floor_id="first-floor", **fields):
    return {"id": product_id, "sku": sku, "floor_id": floor_id, **fields}


def _media(product, url, **fields):
    return {
        "id": f"{product['id']}:{url}", "product_id": product["id"], "floor_id": product["floor_id"],
        "public_url": url, "bucket": "forge-products", "storage_key": url, "sha1": url,
        **fields,
    }


def _set_catalogue(monkeypatch, products, media):
    snapshot = catalog_service._build_snapshot(products, media, [], [], [])
    exact_products = AsyncMock(return_value=snapshot)
    monkeypatch.setattr(catalog_service, "snapshot_for_product_ids", exact_products)
    return snapshot, exact_products


def _resolve(items):
    return asyncio.run(quotation_routes._canonicalize_item_images(items, "first-floor", include_candidates=True))


def test_catalogue_hero_and_alternates_precede_snapshot_for_the_exact_variant(monkeypatch):
    white = _product("white", "7535B403H7216", family_key="metropole-600")
    black = _product("black", "7535B483H7216", family_key=white["family_key"])
    snapshot, _ = _set_catalogue(monkeypatch, [white, black], [
        _media(white, "https://cdn.test/white.png", role="hero", is_primary=True),
        _media(white, "https://cdn.test/white-angle.png", role="gallery"),
        _media(white, "https://cdn.test/white-dimensions.png", role="dimension"),
        _media(black, "https://cdn.test/black.png", role="hero", is_primary=True),
    ])
    row = {"product_id": white["id"], "sku": white["sku"], "image": "https://cdn.test/saved-white.png"}
    resolved, = _resolve([row])
    assert resolved["image"] == catalog_service.product_hero_image(white, snapshot)
    assert resolved["image_candidates"] == ["https://cdn.test/white-angle.png", row["image"]]
    assert row["image"] == "https://cdn.test/saved-white.png"


def test_photo_order_matches_catalogue_quality_and_resolution_rules(monkeypatch):
    basin = _product("basin", "7536B403H7216", family_key="metropole-800")
    primary = "https://cdn.test/white-thumbnail.png"
    gallery = "https://cdn.test/white-high-detail.png"
    _set_catalogue(monkeypatch, [basin], [
        _media(basin, primary, family_key=basin["family_key"], role="hero", is_primary=True, quality="poor"),
        _media(basin, gallery, family_key=basin["family_key"], role="gallery", quality="good", width=1200, height=800),
    ])
    row, = _resolve([{"product_id": basin["id"], "sku": basin["sku"]}])
    assert row["image"] == gallery
    assert row["image_candidates"] == [primary]


@pytest.mark.parametrize("registered_as", ["media", "legacy"])
def test_old_picker_snapshot_only_registered_to_a_sibling_is_not_displayed(monkeypatch, registered_as):
    family = {"family_key": "metropole-800", "brand_id": "vitra"}
    white = _product("white", "7536B403H7216", **family)
    black = _product("black", "7536B483H7216", **family)
    sibling_url = "https://cdn.test/black.png"
    media = [_media(black, sibling_url)] if registered_as == "media" else []
    if registered_as == "legacy":
        black["images"] = [sibling_url]
    _set_catalogue(monkeypatch, [white, black], media)
    saved = {"product_id": white["id"], "sku": white["sku"], "image": sibling_url}
    row, = _resolve([saved])
    assert row["image"] is None
    assert "image_candidates" not in row
    assert saved["image"] == sibling_url
    unchanged, = asyncio.run(quotation_routes._canonicalize_item_images([saved], "first-floor"))
    assert unchanged["image"] == sibling_url

    white_url = "https://cdn.test/white.png"
    _set_catalogue(monkeypatch, [white, black], [*media, _media(white, white_url)])
    row, historical = _resolve([saved, {**saved, "image": "https://cdn.test/undocumented-white.png"}])
    assert row["image"] == white_url and "image_candidates" not in row
    assert historical["image_candidates"] == ["https://cdn.test/undocumented-white.png"]

    _set_catalogue(monkeypatch, [white, black], [*media, _media(white, sibling_url)])
    shared, = _resolve([saved])
    assert shared["image"] == sibling_url


def test_foreign_catalogue_rows_clear_photo_and_do_not_receive_alternates(monkeypatch):
    foreign = _product("foreign", "FOREIGN", floor_id="ground-floor")
    changed = _product("changed", "NEW")
    _set_catalogue(monkeypatch, [foreign, changed], [
        _media(foreign, "https://cdn.test/foreign.png"),
        _media(changed, "https://cdn.test/renamed.png"),
    ])
    rows = _resolve([
        {"product_id": "foreign", "sku": "FOREIGN", "image": "foreign-snapshot", "seat_cover_image_urls": ["foreign-seat"]},
        {"product_id": "changed", "sku": "OLD", "image": "old-snapshot"},
        {"product_id": "retired", "sku": "RETIRED", "image": "historical-snapshot"},
        {"product_id": "godown:manual", "sku": "MANUAL", "image": "manual-snapshot"},
    ])
    assert rows[0]["image"] is None
    assert rows[0]["seat_cover_image_urls"] == rows[0]["dimension_image_urls"] == []
    assert [row["image"] for row in rows[1:]] == ["old-snapshot", "historical-snapshot", "manual-snapshot"]
    assert all("image_candidates" not in row for row in rows)


def test_cold_document_media_uses_the_exact_product_batch_and_existing_legacy_and_cover_fields(monkeypatch):
    legacy_url = "https://cdn.test/legacy.png"
    cover_url = "https://cdn.test/cover.png"
    legacy = _product("legacy", "LEGACY", images=[legacy_url])
    cover = _product("cover", "COVER")
    _, exact = _set_catalogue(monkeypatch, [legacy, cover], [_media(cover, cover_url, role="seat-cover")])
    monkeypatch.setattr(catalog_service, "get_catalog_snapshot", AsyncMock(side_effect=AssertionError("full catalogue read")))
    rows = _resolve([
        {"product_id": "legacy", "sku": "LEGACY", "image": "https://cdn.test/stale.png"},
        {"product_id": "legacy", "sku": "LEGACY", "image": None},
        {"product_id": "cover", "sku": "COVER", "image": None},
    ])
    exact.assert_awaited_once()
    assert set(exact.await_args.args[0]) == {"legacy", "cover"}
    assert [row["image"] for row in rows] == [legacy_url, legacy_url, cover_url]


def _png(size):
    output = BytesIO()
    Image.new("RGB", size, "#89a7c4").save(output, format="PNG")
    return output.getvalue()


@pytest.mark.parametrize(("floor", "doc_type"), [("first-floor", "standard"), ("ground-floor", "tiles_quotation")])
def test_downloaded_pdf_embeds_available_photos_when_the_catalogue_hero_fails(monkeypatch, floor, doc_type):
    # The two affected Vitra sizes exercise exact-SKU current/legacy handling.
    # A different brand exercises fallback from unavailable bytes to a snapshot.
    tile = doc_type == "tiles_quotation"
    sku_600, sku_800 = ("TILE-600", "TILE-800") if tile else ("7535B403H7216", "7536B403H7216")
    hero = "https://cdn.test/unavailable.png"
    alternate = "https://cdn.test/alternate.png"
    snapshot_url = "https://cdn.test/old-brand.png"
    legacy = f"data:image/png;base64,{b64encode(_png((31, 19))).decode()}"
    product_600 = _product("600", sku_600, floor_id=floor, brand_id="vitra")
    product_800 = _product("800", sku_800, floor_id=floor, brand_id="vitra", images=[legacy])
    mixer = _product("mixer", "MIXER", floor_id=floor, brand_id="other-brand")
    _set_catalogue(monkeypatch, [product_600, product_800, mixer], [
        _media(product_600, hero, role="hero", is_primary=True),
        _media(product_600, alternate),
        _media(mixer, hero, role="hero", is_primary=True),
    ])
    remote = {alternate: _png((37, 23)), snapshot_url: _png((40, 25))}
    requests = []

    def request(url):
        requests.append(url)
        return remote.get(url)

    monkeypatch.setattr(pdf_generator, "_remote_image_bytes", request)
    monkeypatch.setattr(quotation_routes, "_pdf_branding", AsyncMock(return_value={}))
    monkeypatch.setattr(quotation_routes, "_diagram_items", AsyncMock(side_effect=lambda items, _: items))
    items = [
        {"name": sku_600, "sku": sku_600, "product_id": "600", "qty": 2, "unit_price": 1200},
        {"name": sku_800, "sku": sku_800, "product_id": "800", "qty": 1, "unit_price": 1500},
        {"name": "Mixer", "sku": "MIXER", "product_id": "mixer", "image": snapshot_url, "qty": 2, "unit_price": 600},
    ]
    doc = {
        "floor_id": floor, "doc_type": doc_type, "number": "TEST",
        "customer_name": "Test", "address_snapshot": "Test address", "items": items,
        "subtotal": 5100, "grand_total": 5100,
    }
    data, _ = asyncio.run(quotation_routes._build_quotation_file(doc, {"name": "Test"}))
    reader = PdfReader(BytesIO(data))
    assert "Image unavailable" not in " ".join(page.extract_text() or "" for page in reader.pages)
    assert {(37, 23), (31, 19), (40, 25)} <= {file.image.size for page in reader.pages for file in page.images}
    assert sorted(requests) == sorted((hero, alternate, snapshot_url))
    assert "image" not in items[0] and items[2]["image"] == snapshot_url


def test_pdf_reports_a_genuinely_missing_exact_sku(caplog, monkeypatch):
    white = _product("white", "7536B403H7216", family_key="metropole-800")
    black = _product("black", "7536B483H7216", family_key=white["family_key"])
    _set_catalogue(monkeypatch, [white, black], [_media(black, "https://cdn.test/black.png", role="hero")])
    resolved, = _resolve([{"product_id": white["id"], "sku": white["sku"], "name": "Vitra White", "qty": 1, "unit_price": 1200}])
    pdf = pdf_generator.build_quotation_pdf({"items": [resolved]}, {"name": "Test"})
    assert "Image unavailable" in (PdfReader(BytesIO(pdf)).pages[-1].extract_text() or "")
    assert "product_id=white sku=7536B403H7216 reason=missing_reference" in caplog.text
