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
