"""Real Mongo paging, history boundaries and payload measurements."""
import asyncio
import json
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient

from tests.integration.test_purchase_completion_mongo import mongo_url  # noqa: F401
from models import UserPublic
from routes import godown_stock_routes as route


def actor(floor="first-floor"):
    return UserPublic(id="paging-reader", email="reader@example.test", full_name="Reader", role="warehouse", floor_ids=[floor], active_floor_id=floor)


def rows():
    return [{"id": f"lot-{i:04}", "floor_id": "first-floor", "archived": i < 20,
             "name": "Literal [basin]" if i == 30 else f"Warehouse product {i}", "sku": f"SKU-{i}",
             "brand_id": f"brand-{i % 2}", "brand_name": "Grohe" if i % 2 == 0 else "Hansgrohe",
             "quantity_missing": 20 <= i < 40, "qty_received": 0 if i < 50 else 2, "available_qty": 0 if i < 50 else 2,
             "unit_price": None if i % 11 == 0 else 100, "image": "https://images.test/stock.png", "transferred_at": "2026-10-24T12:00:00Z",
             "source_provenance": {"private_source": "x" * 2048},
             "allocations": [{"id": f"a-{i}-{n}", "qty": 1, "quotation_id": "historical", "allocated_at": "2026-10-01T00:00:00Z"} for n in range(20)]}
            for i in range(1250)]


def test_paged_stock_preserves_global_totals_filtered_counts_and_complete_paging(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.stock_paging
        source = rows()
        expected = [r for r in source if not r["archived"]]
        try:
            await db.godown_stock.insert_many(source + [{**source[-1], "id": "foreign", "floor_id": "ground-floor", "available_qty": 99999}])
            # Any accidental history/catalog lookup fails: known lot images
            # should keep the list to the stock collection alone.
            monkeypatch.setattr(route, "db", SimpleNamespace(godown_stock=db.godown_stock))
            start = time.perf_counter()
            first = await route.list_stock(include_history=True, limit=60, user=actor())
            elapsed = time.perf_counter() - start
            assert len(first["lots"]) == 60 and first["next_offset"] == 60
            assert first["total_lots"] == len(expected) == 1230
            assert first["total_available_qty"] == sum(r["available_qty"] for r in expected if not r["quantity_missing"])
            assert first["total_stock_value"] == sum(r["available_qty"] * (r["unit_price"] or 0) for r in expected if not r["quantity_missing"])
            assert first["unknown_quantity_count"] == 20 and first["zero_lot_count"] == 10
            assert all("allocations" not in r and "source_provenance" not in r and r["history_loaded"] is False for r in first["lots"])
            found = await route.list_stock(include_history=True, q="SKU-1249", limit=60, user=actor())
            assert [r["sku"] for r in found["lots"]] == ["SKU-1249"]
            assert found["total_lots"] == 1 and found["total_available_qty"] == first["total_available_qty"]
            literal = await route.list_stock(include_history=True, q="[basin]", limit=60, user=actor())
            assert [r["id"] for r in literal["lots"]] == ["lot-0030"]
            brand = await route.list_stock(include_history=True, brands="brand-1", limit=60, user=actor())
            assert brand["total_lots"] == sum(r["brand_id"] == "brand-1" for r in expected)
            assert len(brand["brands"]) == 2
            visited = [r["id"] for r in first["lots"]]
            offset = first["next_offset"]
            while offset is not None:
                page = await route.list_stock(include_history=True, limit=100, offset=offset, user=actor())
                visited.extend(r["id"] for r in page["lots"])
                offset = page["next_offset"]
            assert len(visited) == len(set(visited)) == 1230
            assert set(visited) == {r["id"] for r in expected}
            monkeypatch.setattr(route, "db", db)
            full = await route.list_stock(include_history=True, user=actor())
            old_bytes, page_bytes = len(json.dumps(full)), len(json.dumps(first))
            assert page_bytes * 10 < old_bytes
            print(json.dumps({"first_page_lots": 60, "total_lots": 1230, "legacy_bytes": old_bytes, "paged_bytes": page_bytes, "local_page_ms": round(elapsed * 1000, 2)}))
        finally:
            client.close()
    asyncio.run(run())


def test_history_is_bounded_complete_and_floor_scoped(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.stock_history
        monkeypatch.setattr(route, "db", db)
        try:
            source = rows()[30]
            source["allocations"] = [{"id": f"allocation-{n}"} for n in range(75)]
            await db.godown_stock.insert_one(source)
            await db.godown_customer_transfers.insert_many([{"id": f"transfer-{n:03}", "stock_id": source["id"], "floor_id": "first-floor", "created_at": f"{n:03}"} for n in range(83)] + [{"id": "foreign-transfer", "stock_id": source["id"], "floor_id": "ground-floor"}])
            first = await route.stock_history(source["id"], user=actor())
            second = await route.stock_history(source["id"], offset=first["next_offset"], user=actor())
            assert len(first["allocations"]) == len(first["customer_transfers"]) == 60
            assert first["next_offset"] == 60 and second["next_offset"] is None
            assert len(second["allocations"]) == 15 and len(second["customer_transfers"]) == 23
            assert all(r["id"] != "foreign-transfer" for r in first["customer_transfers"] + second["customer_transfers"])
            with pytest.raises(HTTPException) as error:
                await route.stock_history(source["id"], user=actor("ground-floor"))
            assert error.value.status_code == 404
        finally:
            client.close()
    asyncio.run(run())


def test_catalog_fallback_survives_detail_price_and_quantity_updates(mongo_url, monkeypatch):
    from unittest.mock import AsyncMock
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.stock_images
        monkeypatch.setattr(route, "db", db)
        monkeypatch.setattr(route, "log_event", AsyncMock())
        try:
            base = {**rows()[30], "product_id": "exact-product", "image": None, "allocations": [], "updated_at": "v1"}
            await db.godown_stock.insert_one(base)
            await db.products.insert_many([
                {"id": "exact-product", "floor_id": "first-floor", "brand_id": "brand-0", "hero_image_url": "https://images.test/exact.png"},
                {"id": "exact-product", "floor_id": "ground-floor", "brand_id": "brand-0", "hero_image_url": "https://images.test/wrong-floor.png"},
            ])
            detail = await route.get_stock(base["id"], user=actor())
            assert detail["image"] == "https://images.test/exact.png"
            changed = await route.update_stock_details(base["id"], route.StockDetailsUpdate(unit_price=150, image=None), actor())
            assert changed["image"] == detail["image"]
            saved = await db.godown_stock.find_one({"id": base["id"]})
            assert saved["image"] is None
            counted = await route.record_missing_quantity(base["id"], route.MissingQuantityCount(qty=3, counted_on="2026-10-24", reason="Verified physical count", expected_updated_at=saved["updated_at"], idempotency_key="catalog-photo-count"), actor())
            assert counted["image"] == detail["image"]
            assert counted["available_qty"] == 3
        finally:
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("limit,offset", [(0, 0), (101, 0), (60, -1), (60, 100001)])
def test_invalid_page_bounds(limit, offset):
    with pytest.raises(HTTPException) as error:
        asyncio.run(route.list_stock(limit=limit, offset=offset, user=actor()))
    assert error.value.status_code == 422
