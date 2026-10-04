"""PDF image resolution must not drop a quotation's stored image snapshot."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import routes.quotation_routes as quotation_routes


class _Cursor:
    def __init__(self, rows: list[dict]):
        self.rows = rows

    async def to_list(self, _limit: int) -> list[dict]:
        return self.rows


class _ProductMedia:
    def __init__(self, rows: list[dict]):
        self.rows = rows

    def find(self, *_args, **_kwargs) -> _Cursor:
        return _Cursor(self.rows)


class _Db:
    def __init__(self, rows: list[dict]):
        self.product_media = _ProductMedia(rows)


def test_pdf_image_resolution_keeps_snapshot_when_current_media_is_missing(monkeypatch):
    monkeypatch.setattr(quotation_routes, "db", _Db([]))

    resolved = asyncio.run(quotation_routes._canonicalize_item_images([
        {"product_id": "retired-product", "image": "https://cdn.example.test/snapshot.jpg"},
    ]))

    assert resolved[0]["image"] == "https://cdn.example.test/snapshot.jpg"


def test_pdf_image_resolution_uses_exact_seat_cover_photo_when_no_hero(monkeypatch):
    monkeypatch.setattr(quotation_routes, "db", _Db([
        {"product_id": "cover", "role": "seat-cover", "public_url": "https://cdn.example.test/cover.png"},
    ]))
    resolved = asyncio.run(quotation_routes._canonicalize_item_images([
        {"product_id": "cover", "image": None},
    ]))
    assert resolved[0]["image"] == "https://cdn.example.test/cover.png"


def test_pdf_image_resolution_prefers_current_primary_media(monkeypatch):
    monkeypatch.setattr(quotation_routes, "db", _Db([
        {"product_id": "p1", "public_url": "https://cdn.example.test/secondary.jpg", "is_primary": False},
        {"product_id": "p1", "public_url": "https://cdn.example.test/current.jpg", "is_primary": True},
    ]))

    resolved = asyncio.run(quotation_routes._canonicalize_item_images([
        {"product_id": "p1", "image": "https://cdn.example.test/snapshot.jpg"},
    ]))

    assert resolved[0]["image"] == "https://cdn.example.test/current.jpg"


def test_pdf_image_resolution_prefers_a_higher_quality_current_image(monkeypatch):
    monkeypatch.setattr(quotation_routes, "db", _Db([
        {"product_id": "p1", "public_url": "https://cdn.example.test/thumbnail.jpg", "is_primary": True, "quality": "poor"},
        {"product_id": "p1", "public_url": "https://cdn.example.test/original.jpg", "is_primary": False, "quality": "excellent"},
    ]))

    resolved = asyncio.run(quotation_routes._canonicalize_item_images([
        {"product_id": "p1", "image": "https://cdn.example.test/snapshot.jpg"},
    ]))

    assert resolved[0]["image"] == "https://cdn.example.test/original.jpg"


def test_pdf_image_resolution_keeps_the_selected_variant_not_family_representative(monkeypatch):
    monkeypatch.setattr(quotation_routes, "db", _Db([
        {"product_id": "representative-a", "public_url": "https://cdn.example.test/a.jpg", "is_primary": True},
        {"product_id": "variant-b", "public_url": "https://cdn.example.test/b.jpg", "is_primary": True},
    ]))

    resolved = asyncio.run(quotation_routes._canonicalize_item_images([
        {"product_id": "variant-b", "sku": "B-SKU", "image": "https://cdn.example.test/b-snapshot.jpg"},
    ]))

    assert resolved[0]["product_id"] == "variant-b"
    assert resolved[0]["sku"] == "B-SKU"
    assert resolved[0]["image"] == "https://cdn.example.test/b.jpg"


def test_document_media_is_proven_by_exact_floor_and_sku_without_database_roundtrips(monkeypatch):
    products = {
        "same": {"id": "same", "floor_id": "first-floor", "sku": "SAME"},
        "foreign": {"id": "foreign", "floor_id": "ground-floor", "sku": "FOREIGN"},
        "changed": {"id": "changed", "floor_id": "first-floor", "sku": "NEW"},
    }
    async def snapshot():
        return SimpleNamespace(product_by_id=products, media_rows_by_product={
            key: [{"product_id": key, "public_url": f"https://cdn.test/{key}-current.png", "is_primary": True}]
            for key in products
        })
    monkeypatch.setattr(quotation_routes.catalog_service, "get_catalog_snapshot", snapshot)
    monkeypatch.setattr(quotation_routes, "db", object())  # no DB reads permitted
    rows = asyncio.run(quotation_routes._canonicalize_item_images([
        {"product_id": "same", "sku": "SAME", "image": "same-snapshot"},
        {"product_id": "foreign", "sku": "FOREIGN", "image": "foreign-snapshot", "seat_cover_image_urls": ["foreign-seat"]},
        {"product_id": "changed", "sku": "OLD", "image": "old-snapshot"},
        {"product_id": "retired", "sku": "RETIRED", "image": "historical-snapshot"},
        {"product_id": "godown:manual", "sku": "MANUAL", "image": "manual-snapshot"},
    ], "first-floor"))
    assert rows[0]["image"] == "https://cdn.test/same-current.png"
    assert rows[1]["image"] is None
    assert rows[1]["seat_cover_image_urls"] == rows[1]["dimension_image_urls"] == []
    assert [row["image"] for row in rows[2:]] == ["old-snapshot", "historical-snapshot", "manual-snapshot"]


def test_pdf_rows_never_include_a_foreign_floor_hero_or_snapshot(monkeypatch):
    async def snapshot():
        return SimpleNamespace(product_by_id={"foreign": {"id": "foreign", "floor_id": "ground-floor", "sku": "F"}},
                               media_rows_by_product={"foreign": [{"product_id": "foreign", "public_url": "https://cdn.test/foreign.png"}]})
    monkeypatch.setattr(quotation_routes.catalog_service, "get_catalog_snapshot", snapshot)
    items = asyncio.run(quotation_routes._pdf_items({"floor_id": "first-floor", "items": [
        {"product_id": "foreign", "sku": "F", "name": "Foreign product", "image": "https://cdn.test/foreign-snapshot.png"},
    ]}))
    assert items[0]["image"] is None
