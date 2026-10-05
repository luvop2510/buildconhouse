"""Regression test: hydrate_variants_batch must forward `size` into the
sibling-variant data it builds for family-grouped tile products. Tile
products are modelled as separate Product documents grouped by
`family_key` (not embedded ProductVariant rows), so this is the actual
code path that populates variant chips for real tile products. Task 20's
`variantDescriptor()` helper joins finish+size+color, so `size` must
survive both the Mongo projection and the constructed variant dict."""
from __future__ import annotations

import asyncio

import services.media_service as media_service
from services.media_service import hydrate_variants_batch


class Cursor:
    def __init__(self, rows):
        self.rows = list(rows)

    async def to_list(self, _n):
        return self.rows


class Products:
    def __init__(self, rows):
        self.rows = rows

    def find(self, query, _projection):
        family_keys = set(query.get("family_key", {}).get("$in", []))
        rows = [r for r in self.rows if r.get("family_key") in family_keys]
        return Cursor(rows)


class ProductMedia:
    def find(self, _query, _projection):
        return Cursor([])


class Db:
    def __init__(self, product_rows):
        self.products = Products(product_rows)
        self.product_media = ProductMedia()


def test_hydrate_variants_batch_forwards_size(monkeypatch):
    siblings = [
        {"id": "p1", "sku": "SKU-1", "family_key": "fam-1", "finish": None,
         "colour": None, "color": None, "size": "600x600mm", "price": 100.0,
         "mrp": 120.0, "stock": 5, "name": "Tile A"},
        {"id": "p2", "sku": "SKU-2", "family_key": "fam-1", "finish": None,
         "colour": None, "color": None, "size": "300x600mm", "price": 90.0,
         "mrp": 110.0, "stock": 3, "name": "Tile B"},
    ]
    monkeypatch.setattr(media_service, "db", Db(siblings))

    target = {"id": "p2", "family_key": "fam-1", "variants": []}
    docs = [target]

    asyncio.run(hydrate_variants_batch(docs))

    assert target["variants"], "expected sibling variant to be populated"
    sizes = {v["id"]: v.get("size") for v in target["variants"]}
    assert sizes == {"p1": "600x600mm"}


def test_variant_preview_skips_dimension_and_internal_gallery_before_exact_hero(monkeypatch):
    from models import ProductMedia
    from types import SimpleNamespace
    def media(role, source, primary, url):
        return ProductMedia(product_id="sibling", floor_id="first-floor", role=role, source_type=source,
                            is_primary=primary, bucket="public", storage_key=url,
                            public_url=url, sha1="a" * 40, mime="image/png", size_bytes=1).model_dump()
    siblings = [
        {"id": "sibling", "sku": "EXACT", "family_key": "same", "floor_id": "first-floor", "brand_id": "brand"},
        {"id": "foreign", "sku": "FOREIGN", "family_key": "same", "floor_id": "ground-floor", "brand_id": "brand"},
    ]
    rows = [media("dimension", "internal", True, "diagram"),
            media("gallery", "internal", False, "internal-gallery"),
            media("hero", "manufacturer", True, "exact-hero")]
    class Media:
        def find(self, query, projection):
            return Cursor(rows)
    monkeypatch.setattr(media_service, "db", SimpleNamespace(products=Products(siblings), product_media=Media()))
    target = {"id": "target", "family_key": "same", "floor_id": "first-floor", "brand_id": "brand"}
    asyncio.run(hydrate_variants_batch([target]))
    assert [(v["id"], v["image"]) for v in target["variants"]] == [("sibling", "exact-hero")]


def test_variant_preview_uses_exact_seat_cover_but_never_dimensions(monkeypatch):
    from models import ProductMedia
    from types import SimpleNamespace
    siblings = [{"id": pid, "sku": pid, "family_key": "same"} for pid in ("cover", "dimension")]
    rows = [ProductMedia(product_id=pid, floor_id="first-floor", role=role, source_type="supplier", bucket="public", storage_key=pid,
                         public_url=pid, sha1="a"*40, mime="image/png", size_bytes=1).model_dump()
            for pid,role in (("cover","seat-cover"),("dimension","dimension"))]
    class Media:
        def find(self, query, projection):
            return Cursor(rows)
    monkeypatch.setattr(media_service, "db", SimpleNamespace(products=Products(siblings), product_media=Media()))
    target = {"id":"target", "family_key":"same"}
    asyncio.run(hydrate_variants_batch([target]))
    assert {v["id"]:v["image"] for v in target["variants"]} == {"cover":"cover", "dimension":None}
