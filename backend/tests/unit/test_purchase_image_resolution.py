import asyncio
from types import SimpleNamespace

from services import purchase_images
from services.catalog_service import _build_snapshot, product_hero_image
from routes import purchases_tracker as tracker


def test_purchase_images_refresh_exact_floor_sku_and_reuse_preview(monkeypatch):
    products = [
        {"id": "p1", "floor_id": "first-floor", "images": ["https://cdn/current.jpg"]},
        {"id": "p2", "floor_id": "ground-floor", "images": ["https://cdn/tile.jpg"]},
    ]
    snapshot = _build_snapshot(products, [], [], [], [])
    async def catalog(product_ids, floor_ids):
        return snapshot
    calls = []
    def preview(product, current):
        calls.append(product["id"])
        return product_hero_image(product, current)
    monkeypatch.setattr(purchase_images, "snapshot_for_product_ids", catalog)
    monkeypatch.setattr(purchase_images, "product_hero_image", preview)
    rows = [
        {"product_id": "p1", "floor_id": "first-floor", "image": "expired"},
        {"product_id": "p1", "floor_id": "first-floor", "image": None},
        {"product_id": "p2", "floor_id": "first-floor", "image": "original"},
        {"product_id": "manual-stock", "floor_id": "first-floor", "image": "manual"},
    ]
    asyncio.run(purchase_images.hydrate_purchase_images(rows))
    assert rows[0]["image"] == rows[1]["image"] == "https://cdn/current.jpg"
    assert rows[0]["image_snapshot"] == "expired"
    assert rows[2]["image"] == "original"
    assert rows[3]["image"] == "manual"
    assert calls == ["p1"]


def test_paged_tracker_projects_floor_for_image_lookup():
    pipeline = tracker._items_page_pipeline(
        view="stock", brand=None, customer=None, stage=None, q=None,
        product_id=None, floor_ids=["first-floor"], sla_days=7, skip=0, limit=30,
    )
    projection = next(part["$project"] for part in pipeline if "$project" in part)
    assert projection["floor_id"] == 1


def test_purchase_images_keep_selected_snapshot_when_catalog_sku_changes(monkeypatch):
    snapshot = _build_snapshot([
        {"id": "p1", "floor_id": "first-floor", "sku": "NEW-SKU", "images": ["https://cdn/new.jpg"]},
    ], [], [], [], [])
    async def catalog(product_ids, floor_ids):
        return snapshot
    monkeypatch.setattr(purchase_images, "snapshot_for_product_ids", catalog)
    rows = [
        {"product_id": "p1", "floor_id": "first-floor", "sku": "OLD-SKU", "image": "historic"},
        {"product_id": "p1", "floor_id": "first-floor", "sku": " NEW-SKU ", "image": "expired"},
        {"product_id": "p1", "floor_id": "first-floor", "sku": "new-sku", "image": "lowercase historic"},
    ]
    asyncio.run(purchase_images.hydrate_purchase_images(rows))
    assert rows[0]["image"] == "historic" and "image_snapshot" not in rows[0]
    assert rows[1]["image"] == "https://cdn/new.jpg"
    assert rows[2]["image"] == "lowercase historic" and "image_snapshot" not in rows[2]


def test_workspace_search_treats_parentheses_as_literal_and_retains_floor(monkeypatch):
    captured = []
    class Cursor:
        async def to_list(self, _limit):
            return []
    class Purchases:
        def aggregate(self, pipeline):
            captured.extend(pipeline)
            return Cursor()
    monkeypatch.setattr(tracker, "db", SimpleNamespace(purchase_orders=Purchases()))
    asyncio.run(tracker._iter_items("stock", None, None, None, " Tap (Chrome) ", 7, floor_ids=["first-floor"]))
    assert captured[0]["$match"]["$or"][0]["number"]["$regex"] == r"Tap\ \(Chrome\)"
    assert next(part["$project"] for part in captured if "$project" in part)["floor_id"] == 1


def test_purchase_images_keep_snapshots_when_preview_read_fails(monkeypatch, caplog):
    async def unavailable(*args):
        raise RuntimeError("catalog unavailable")
    monkeypatch.setattr(purchase_images, "snapshot_for_product_ids", unavailable)
    rows = [{"product_id": "p1", "floor_id": "first-floor", "image": "recorded"}]
    asyncio.run(purchase_images.hydrate_purchase_images(rows))
    assert rows == [{"product_id": "p1", "floor_id": "first-floor", "image": "recorded"}]
    assert "purchase_image_refresh_failed" in caplog.text


def test_purchase_images_cancel_slow_optional_read_and_keep_items(monkeypatch, caplog):
    cancelled = []
    async def slow(*args):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.append(True)
    monkeypatch.setattr(purchase_images, "snapshot_for_product_ids", slow)
    monkeypatch.setattr(purchase_images, "IMAGE_REFRESH_TIMEOUT_SECONDS", .01)
    rows = [{"product_id": "p1", "floor_id": "first-floor", "image": "recorded"}]
    asyncio.run(purchase_images.hydrate_purchase_images(rows))
    assert rows[0]["image"] == "recorded" and cancelled == [True]
    assert "TimeoutError" in caplog.text


def test_exact_product_snapshot_does_not_start_cold_catalog_warmup(monkeypatch):
    from services import catalog_service as catalog, catalog_database
    calls = []
    async def forbidden():
        raise AssertionError("full catalog warmup blocks purchases")
    async def context(products, *, product_ids, floor_ids):
        calls.append((products, product_ids, floor_ids))
        return "exact snapshot"
    monkeypatch.setattr(catalog, "_snapshot", None)
    monkeypatch.setattr(catalog, "get_catalog_snapshot", forbidden)
    monkeypatch.setattr(catalog_database, "context", context)
    assert asyncio.run(catalog.snapshot_for_product_ids(["p1"], ["first-floor"])) == "exact snapshot"
    assert calls == [([], ["p1"], ["first-floor"])]
