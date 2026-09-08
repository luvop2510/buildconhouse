"""PDF image resolution must not drop a quotation's stored image snapshot."""
from __future__ import annotations

import asyncio

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
