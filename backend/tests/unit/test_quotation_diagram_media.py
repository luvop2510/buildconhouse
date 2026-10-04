"""Quotation PDF media follows the exact catalog product on the selected floor."""

import asyncio
from types import SimpleNamespace

from routes import quotation_routes


class _Products:
    def __init__(self, rows):
        self.rows = rows
        self.query = None

    def find(self, query, projection):
        self.query = query
        return self

    async def to_list(self, limit):
        return self.rows[:limit]


def test_diagram_media_is_attached_for_any_brand_but_never_a_changed_sku(monkeypatch):
    products = _Products([
        {"id": "basin", "sku": "B-1", "dimension_image_urls": ["https://cdn.test/basin.png"],
         "seat_cover_image_urls": []},
        {"id": "wc", "sku": "WC-NEW", "dimension_image_urls": ["https://cdn.test/new.png"],
         "seat_cover_image_urls": ["https://cdn.test/cover.png"]},
    ])
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(products=products))
    items = [
        {"product_id": "basin", "sku": "B-1"},
        {"product_id": "wc", "sku": "WC-OLD"},
    ]

    result = asyncio.run(quotation_routes._diagram_items(items, "first-floor"))

    assert products.query["floor_id"] == "first-floor"
    assert result[0]["dimension_image_urls"] == ["https://cdn.test/basin.png"]
    assert result[1]["dimension_image_urls"] == []
    assert result[1]["seat_cover_image_urls"] == []


def test_concealed_product_images_fill_missing_snapshots_only_for_exact_sku_and_floor(monkeypatch):
    products = _Products([
        {"id": "concealed", "sku": "ROUGH-1", "images": ["", "https://cdn.test/rough.png"]},
        {"id": "changed", "sku": "NEW", "images": ["https://cdn.test/new.png"]},
        {"id": "snapshot", "sku": "STORED", "images": ["https://cdn.test/replacement.png"]},
    ])
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(products=products))
    result = asyncio.run(quotation_routes._diagram_items([
        {"product_id": "concealed", "sku": "ROUGH-1", "image": None},
        {"product_id": "changed", "sku": "OLD", "image": None},
        {"product_id": "snapshot", "sku": "STORED", "image": "https://cdn.test/snapshot.png"},
    ], "first-floor"))
    assert products.query["floor_id"] == "first-floor"
    assert result[0]["image"] == "https://cdn.test/rough.png"
    assert result[1]["image"] is None
    assert result[2]["image"] == "https://cdn.test/snapshot.png"
