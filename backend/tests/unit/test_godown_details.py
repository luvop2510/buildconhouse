"""Floor-safe stock overrides, complete bounded reads, and registered photos."""
import asyncio
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, UploadFile
from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError
from starlette.datastructures import Headers

from models import UserPublic
from routes import godown_stock_routes as routes
from services import godown_media_service as media


def user():
    return UserPublic(id="staff", email="staff@example.com", full_name="Staff", role="warehouse",
                      floor_ids=["first-floor"], active_floor_id="first-floor")


class Cursor:
    def __init__(self, rows): self.rows = rows; self.limit = None
    def sort(self, *_args): return self
    async def to_list(self, limit): self.limit = limit; return self.rows[:limit]


class Collection:
    def __init__(self, rows): self.cursor = Cursor(rows); self.query = None
    def find(self, query, *_args): self.query = query; self.projection = _args[0] if _args else None; return self.cursor


@pytest.mark.parametrize("changes", [
    {"unit_price": None}, {"image": None}, {"unit_price": 0, "image": "https://example.com/new.png"},
    {"price_variants": [{"label": "Chrome", "price": 10}]},
])
def test_partial_details_preserve_omitted_fields_and_floor_scope(monkeypatch, changes):
    lot = {"id": "lot", "floor_id": "first-floor", "name": "Basin", "available_qty": 2,
           "unit_price": 30, "image": "https://example.com/old.png", "price_variants": []}
    captured = {}
    async def update(query, update, **_kwargs):
        captured.update(query=query, update=update)
        return {**lot, **update["$set"]}
    monkeypatch.setattr(routes, "db", SimpleNamespace(godown_stock=SimpleNamespace(find_one=AsyncMock(return_value=lot), find_one_and_update=update)))
    monkeypatch.setattr(routes, "log_event", AsyncMock())
    result = asyncio.run(routes.update_stock_details("lot", routes.StockDetailsUpdate(**changes), user()))
    assert captured["query"]["$and"][0] == {"floor_id": {"$in": ["first-floor"]}}
    guard = captured["query"]["$and"][1]
    assert guard == {"id": "lot", "archived": {"$ne": True}, **routes._stock_financial_guard(lot)}
    for key in ("unit_price", "image", "price_variants"):
        assert result[key] == changes.get(key, lot[key])
    if "image" in changes: assert captured["update"]["$set"]["image_media_id"] is None
    assert result["stock_value"] == (None if result["unit_price"] is None else result["unit_price"] * 2)


@pytest.mark.parametrize("changes", [
    {"image": "http://example.com/photo.png"}, {"image": "https://user:secret@example.com/a.png"},
    {"image": "javascript:alert(1)"}, {"unit_price": -1}, {"unit_price": float("inf")},
    {"price_variants": None}, {"quantity_missing": False},
])
def test_invalid_details_rejected(changes):
    with pytest.raises(ValidationError): routes.StockDetailsUpdate(**changes)


def test_empty_details_and_missing_lot_rejected(monkeypatch):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes.update_stock_details("lot", routes.StockDetailsUpdate(), user()))
    assert exc.value.status_code == 422
    monkeypatch.setattr(routes, "db", SimpleNamespace(godown_stock=SimpleNamespace(find_one=AsyncMock(return_value=None), find_one_and_update=AsyncMock(return_value=None))))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes.update_stock_details("lot", routes.StockDetailsUpdate(image=None), user()))
    assert exc.value.status_code == 404


def test_complete_stock_read_over_500_and_explicit_cap(monkeypatch):
    rows = [{"id": f"lot-{i}", "floor_id": "first-floor", "brand_name": "Grohe", "available_qty": 1, "unit_price": 2} for i in range(1003)]
    stock = Collection(rows)
    monkeypatch.setattr(routes, "db", SimpleNamespace(godown_stock=stock))
    result = asyncio.run(routes.list_stock(user=user()))
    assert len(result["lots"]) == 1003
    assert result["total_available_qty"] == 1003
    assert result["total_stock_value"] == 2006
    assert stock.query["archived"] == {"$ne": True}
    assert stock.cursor.limit == 2001
    stock.cursor.rows = rows * 2
    with pytest.raises(HTTPException) as exc: asyncio.run(routes.list_stock(user=user()))
    assert exc.value.status_code == 409


def test_catalog_image_hydration_uses_exact_floor_product_and_preserves_lot_images(monkeypatch):
    catalog_rows = [
        {"id": "shared-product", "floor_id": "first-floor", "brand_id": "brand-a",
         "hero_image_url": "https://catalog.example/first-floor.jpg"},
        # An identical product ID on another floor must not supply this lot's image.
        {"id": "other-floor-product", "floor_id": "ground-floor", "brand_id": "brand-a",
         "hero_image_url": "https://catalog.example/ground-floor.jpg"},
    ]
    captured = {}

    class Products:
        def find(self, query, *_args):
            captured["query"] = query
            wanted = {(row["floor_id"], row["id"]) for row in query["$or"]}
            rows = [row for row in catalog_rows if (row["floor_id"], row["id"]) in wanted]
            return Cursor(rows)

    lots = [
        {"id": "catalog-lot", "floor_id": "first-floor", "product_id": "shared-product", "image": None},
        {"id": "manual-override", "floor_id": "first-floor", "product_id": "shared-product",
         "image": "https://stock.example/override.jpg"},
        {"id": "wrong-floor", "floor_id": "first-floor", "product_id": "other-floor-product", "image": None},
        {"id": "warehouse-only", "floor_id": "first-floor", "product_id": "godown:warehouse-only", "image": None},
        {"id": "deleted-product", "floor_id": "first-floor", "product_id": "deleted-from-catalog", "image": None},
    ]
    monkeypatch.setattr(routes, "db", SimpleNamespace(products=Products()))

    asyncio.run(routes._hydrate_missing_stock_catalog_images(lots))

    assert lots[0]["image"] == "https://catalog.example/first-floor.jpg"
    assert lots[1]["image"] == "https://stock.example/override.jpg"
    assert lots[2]["image"] is None
    assert lots[3]["image"] is None
    assert lots[4]["image"] is None
    assert {tuple((row["floor_id"], row["id"])) for row in captured["query"]["$or"]} == {
        ("first-floor", "shared-product"),
        ("first-floor", "other-floor-product"),
        ("first-floor", "deleted-from-catalog"),
    }
def test_unknown_quantity_not_zero_or_usable_and_archived_excluded_with_history(monkeypatch):
    stock = Collection([{"id": "lot", "floor_id": "first-floor", "brand_name": "DuraVit", "quantity_missing": True,
                         "available_qty": 0, "unit_price": None}])
    monkeypatch.setattr(routes, "db", SimpleNamespace(godown_stock=stock, godown_customer_transfers=Collection([])))
    result = asyncio.run(routes.list_stock(include_history=True, user=user()))
    assert stock.query["archived"] == {"$ne": True}
    assert result["lots"][0]["stock_value"] is None
    assert result["lots"][0]["transferable_qty"] == 0
    assert result["unpriced_lot_count"] == 1


def test_direct_and_suggestions_hydrate_only_exact_product_media(monkeypatch):
    product = {"id": "p", "floor_id": "first-floor", "brand_id": "b", "sku": "123", "name": "Valve", "images": []}
    photos = Collection([
        {"product_id": "p", "floor_id": "ground-floor", "brand_id": "b", "public_url": "wrong-floor"},
        {"product_id": "p", "floor_id": "first-floor", "brand_id": "wrong", "public_url": "wrong-brand"},
        {"product_id": "other", "floor_id": "first-floor", "brand_id": "b", "public_url": "wrong-product"},
        {"product_id": "p", "floor_id": "first-floor", "brand_id": "b", "public_url": "https://example.com/exact.png"},
    ])
    products = Collection([product]); products.find_one = AsyncMock(return_value=product)
    monkeypatch.setattr(routes, "db", SimpleNamespace(products=products, product_media=photos, godown_stock=SimpleNamespace(insert_one=AsyncMock())))
    monkeypatch.setattr(routes, "log_event", AsyncMock())
    row = asyncio.run(routes.direct_intake(routes.DirectIntake(product_id="p", qty=2), user()))
    suggestions = asyncio.run(routes.sku_suggestions(prefix="1", user=user()))
    assert row["image"] == suggestions[0]["image"] == "https://example.com/exact.png"
    assert photos.query["$or"] == [{"product_id": "p", "floor_id": "first-floor", "brand_id": "b"}]


def test_upload_route_registers_then_updates_floor_scoped_stock(monkeypatch):
    lot = {"id": "lot", "floor_id": "first-floor", "name": "Basin", "available_qty": 2, "unit_price": None}
    update = AsyncMock(return_value={**lot, "image": "https://example.com/upload.png"})
    monkeypatch.setattr(routes, "db", SimpleNamespace(godown_stock=SimpleNamespace(find_one=AsyncMock(return_value=lot), find_one_and_update=update)))
    monkeypatch.setattr(routes, "_read_bounded_upload", AsyncMock(return_value=b"photo"))
    upload = AsyncMock(return_value={"id": "media", "public_url": "https://example.com/upload.png"})
    monkeypatch.setattr(routes.godown_media_service, "upload_stock_photo", upload)
    monkeypatch.setattr(routes, "log_event", AsyncMock())
    file = UploadFile(BytesIO(b"photo"), filename="a.png", headers=Headers({"content-type": "image/png"}))
    result = asyncio.run(routes.upload_stock_image("lot", file, user()))
    assert result["image"] == "https://example.com/upload.png"
    assert upload.call_args.kwargs["lot"] == lot
    assert update.call_args.args[0] == {"id": "lot", "floor_id": "first-floor", "archived": {"$ne": True}}
    assert update.call_args.args[1]["$set"]["image_media_id"] == "media"


@pytest.mark.parametrize("duplicate", [False, True])
def test_photos_use_separate_idempotent_media_metadata(monkeypatch, duplicate):
    rows = {}
    async def find(query): return rows.get(query["_id"])
    async def insert(row):
        rows[row["_id"]] = row
        if duplicate: raise DuplicateKeyError("race")
    storage = SimpleNamespace(upload=AsyncMock(return_value=SimpleNamespace(public_url="https://example.com/photo.png")),
                              exists=AsyncMock(return_value=True), delete=AsyncMock())
    monkeypatch.setattr(media, "db", SimpleNamespace(godown_stock_media=SimpleNamespace(find_one=find, insert_one=insert)))
    monkeypatch.setattr(media, "get_media_storage", lambda: storage)
    monkeypatch.setattr(media, "public_bucket", lambda: "forge-products")
    monkeypatch.setattr(media, "normalize_product_image", lambda data, mime: (data, mime))
    async def twice():
        a = await media.upload_stock_photo(data=b"photo", mime="image/png", lot={"id": "lot", "floor_id": "first-floor"}, actor_id="staff")
        b = await media.upload_stock_photo(data=b"photo", mime="image/png", lot={"id": "lot", "floor_id": "first-floor"}, actor_id="staff")
        return a, b
    a, b = asyncio.run(twice())
    assert a == b
    assert a["stock_id"] == "lot"
    assert storage.upload.call_count == 1
    storage.delete.assert_not_called()


def test_stock_photo_upload_requires_update_grant_for_exact_route():
    from services.access_grants import action_for_api_request, resource_for_api_path
    assert resource_for_api_path("/api/godown-stock/lot/image") == "godown_stock"
    assert action_for_api_request("POST", "/api/godown-stock/lot/image") == "update"
    assert action_for_api_request("POST", "/api/godown-stock/lot/quantity-count") == "update"
    assert action_for_api_request("POST", "/api/godown-stock/lot/quantity-count/unrelated") == "create"
    assert action_for_api_request("PATCH", "/api/godown-stock/lot/details") == "update"
    assert action_for_api_request("POST", "/api/godown-stock/lot/image/unrelated") == "create"


def test_unknown_quantity_skips_order_matching():
    for flag in ["archived", "quantity_missing"]:
        result = asyncio.run(routes._po_final_matches({flag: True}))
        assert result == {"matches": [], "total_ordered_qty": 0, "transferable_qty": 0}


def test_failed_metadata_insert_cleans_unowned_storage(monkeypatch):
    storage = SimpleNamespace(upload=AsyncMock(return_value=SimpleNamespace(public_url="https://example.com/a.png")),
                              delete=AsyncMock())
    monkeypatch.setattr(media, "db", SimpleNamespace(godown_stock_media=SimpleNamespace(find_one=AsyncMock(return_value=None), insert_one=AsyncMock(side_effect=RuntimeError("database unavailable")))))
    monkeypatch.setattr(media, "get_media_storage", lambda: storage)
    monkeypatch.setattr(media, "public_bucket", lambda: "forge-products")
    monkeypatch.setattr(media, "normalize_product_image", lambda data, mime: (data, mime))
    with pytest.raises(RuntimeError):
        asyncio.run(media.upload_stock_photo(data=b"photo", mime="image/png", lot={"id": "lot", "floor_id": "first-floor"}, actor_id="staff"))
    storage.delete.assert_awaited_once()
    assert storage.delete.call_args.kwargs["key"] == storage.upload.call_args.kwargs["key"]


@pytest.mark.parametrize("override, expected", [(None, None), (0, 0), (150, 150)])
@pytest.mark.parametrize("status_location", ["top_level", "specs"])
def test_direct_intake_respects_catalog_unknown_price_status(monkeypatch, override, expected, status_location):
    product = {"id": "p", "floor_id": "first-floor", "brand_id": "duravit", "sku": "0305490000", "name": "Basin",
               "images": ["https://example.com/basin.png"], "mrp": 0, "price": 0, "price_status": "unspecified"}
    if status_location == "specs": product["specs"] = {"price_status": product.pop("price_status")}
    monkeypatch.setattr(routes, "db", SimpleNamespace(products=SimpleNamespace(find_one=AsyncMock(return_value=product)),
                                                     godown_stock=SimpleNamespace(insert_one=AsyncMock())))
    monkeypatch.setattr(routes, "log_event", AsyncMock())
    row = asyncio.run(routes.direct_intake(routes.DirectIntake(product_id="p", qty=2, unit_price=override), user()))
    assert row["unit_price"] == expected
    assert row["mrp"] == expected
    assert row["stock_value"] == (None if expected is None else expected * 2)


def test_page_api_never_returns_private_workbook_cells_or_local_paths(monkeypatch):
    original = {"id": "lot", "floor_id": "first-floor", "name": "Valve", "available_qty": 2, "unit_price": 5,
                "source_provenance": [{"raw_cells": {"A": "private source"}, "embedded_images": [{"path": "/private/source.png"}]}],
                "catalog_provenance": [{"file": "private supplier workbook.xlsx"}],
                "image_local": {"path": "/private/source.png"}, "quantity_notes": ["Reviewed recorded OUT"]}
    stock = Collection([original])
    monkeypatch.setattr(routes, "db", SimpleNamespace(godown_stock=stock))
    result = asyncio.run(routes.list_stock(user=user()))
    assert stock.projection == {"_id": 0, "source_provenance": 0, "catalog_provenance": 0, "image_local": 0}
    for row in (result["lots"][0], routes._stock_view(original)):
        assert not any(field in row for field in ("source_provenance", "catalog_provenance", "image_local"))
        assert row["quantity_notes"] == ["Reviewed recorded OUT"]
    assert "source_provenance" in original  # Stored receipt/provenance is immutable.


def test_stock_movement_export_refuses_oversized_embedded_history(monkeypatch):
    stock = Collection([{"id": "lot", "floor_id": "first-floor", "image": "recorded", "stock_movements": [{}] * 2001}])
    monkeypatch.setattr(routes, "db", SimpleNamespace(godown_stock=stock))
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.list_stock(include_history=True, with_movements=True, user=user()))
    assert error.value.status_code == 409


def test_inventory_export_omits_embedded_movement_payloads(monkeypatch):
    stock = Collection([])
    monkeypatch.setattr(routes, "db", SimpleNamespace(godown_stock=stock))
    assert asyncio.run(routes.list_stock(include_history=True, with_movements=False, user=user()))["lots"] == []
    assert stock.projection["stock_movements"] == stock.projection["allocations"] == 0
