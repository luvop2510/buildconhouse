"""Real Mongo guards for reusable catalog intake and stock movement receipts."""
import asyncio

import pytest
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import ValidationError

from tests.integration.test_purchase_completion_mongo import mongo_url  # noqa: F401
from models import UserPublic
from routes import godown_stock_routes as route


def actor(**changes):
    return UserPublic(id="stock-manager", email="stock@example.test", full_name="Stock manager", role="warehouse",
                      floor_ids=["first-floor", "ground-floor"], active_floor_id="first-floor", **changes)


def movement(**changes):
    return route.StockMovement(**{"kind": "receipt", "qty": 4, "occurred_on": "2026-10-28", "reason": "Supplier delivery",
                                  "expected_updated_at": "v1", "idempotency_key": "movement-command-one", **changes})


def lot(**changes):
    return {"id": "lot", "floor_id": "first-floor", "name": "Basin", "sku": "BASIN", "qty_received": 5,
            "available_qty": 0, "updated_at": "v1", "unit_price": 100, "product_id": "existing-catalog-product", **changes}


def test_receipt_restocks_zero_lot_once_and_replay_keeps_later_balance(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.stock_receipts
        monkeypatch.setattr(route, "db", db)
        try:
            await db.godown_stock.insert_one(lot())
            first = await route.record_stock_movement("lot", movement(), actor())
            assert first["qty_received"] == 9 and first["available_qty"] == 4
            assert first["stock_value"] == 400
            assert "command_key" not in first["stock_movements"][0]
            assert "payload_sha256" not in first["stock_movements"][0]
            await db.godown_stock.update_one({"id": "lot"}, {"$inc": {"available_qty": -1}})
            replay = await route.record_stock_movement("lot", movement(), actor())
            assert replay["idempotent"] and replay["available_qty"] == 3
            assert len(replay["stock_movements"]) == 1
            with pytest.raises(HTTPException) as error:
                await route.record_stock_movement("lot", movement(qty=5), actor())
            assert error.value.status_code == 409
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("same", [True, False])
def test_simultaneous_receipts_cannot_duplicate_or_overwrite(mongo_url, monkeypatch, same):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.stock_races
        monkeypatch.setattr(route, "db", db)
        try:
            await db.godown_stock.insert_one(lot())
            results = await asyncio.gather(route.record_stock_movement("lot", movement(), actor()),
                route.record_stock_movement("lot", movement(idempotency_key="movement-command-one" if same else "movement-command-two"), actor()), return_exceptions=True)
            saved = await db.godown_stock.find_one({"id": "lot"})
            assert saved["available_qty"] == 4 and len(saved["stock_movements"]) == 1
            if same:
                assert all(isinstance(row, dict) for row in results)
            else:
                assert sum(isinstance(row, HTTPException) and row.status_code == 409 for row in results) == 1
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_adjustment_preserves_received_and_reserved_stock_and_rejects_stale_floor(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.stock_adjustments
        monkeypatch.setattr(route, "db", db)
        try:
            await db.godown_stock.insert_one(lot(available_qty=4, loaned_out_qty=2))
            for body in [movement(kind="adjustment_out", qty=3), movement(expected_updated_at="stale")]:
                with pytest.raises(HTTPException) as error:
                    await route.record_stock_movement("lot", body, actor())
                assert error.value.status_code == 409
            with pytest.raises(HTTPException) as error:
                await route.record_stock_movement("lot", movement(), actor().model_copy(update={"active_floor_id": "ground-floor", "floor_ids": ["ground-floor"]}))
            assert error.value.status_code == 404
            result = await route.record_stock_movement("lot", movement(kind="adjustment_out", qty=2), actor())
            assert result["available_qty"] == 2 and result["qty_received"] == 5 and result["transferable_qty"] == 0
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("changes", [{"archived": True}, {"quantity_missing": True}])
def test_no_movements_against_archived_or_uncounted_lots(mongo_url, monkeypatch, changes):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.stock_blocked
        monkeypatch.setattr(route, "db", db)
        try:
            await db.godown_stock.insert_one(lot(**changes))
            with pytest.raises(HTTPException) as error:
                await route.record_stock_movement("lot", movement(), actor())
            assert error.value.status_code == 409
            assert (await db.godown_stock.find_one({"id": "lot"}))["available_qty"] == 0
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_manual_intake_creates_catalog_identity_and_reuses_it_on_new_intake(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.stock_catalog
        monkeypatch.setattr(route, "db", db)
        monkeypatch.setattr(route.catalog_service, "schedule_catalog_refresh", lambda: None)
        async def log(**_kwargs): pass
        monkeypatch.setattr(route, "log_event", log)
        try:
            body = route.DirectIntake(qty=2, sku="GODOWN-123", name="Stock basin", brand="Acme", unit_price=150,
                                      category="Basins", idempotency_key="catalog-intake-one")
            first = await route.direct_intake(body, actor())
            second = await route.direct_intake(body.model_copy(update={"idempotency_key": "catalog-intake-two"}), actor())
            replay = await route.direct_intake(body, actor())
            assert first["product_id"] == second["product_id"] == replay["product_id"]
            assert not first["product_id"].startswith("godown:")
            assert first["source_type"] == "manual" and first["available_qty"] == 2
            product = await db.products.find_one({"id": first["product_id"]})
            assert product["active"] is True and product["floor_id"] == "first-floor" and product["mrp"] == 150
            assert await db.brands.count_documents({}) == await db.categories.count_documents({}) == await db.products.count_documents({}) == 1
            assert await db.godown_stock.count_documents({}) == 2 and replay["idempotent"]
            suggestions = await route.sku_suggestions(prefix="GODOWN-", user=actor())
            assert suggestions[0]["id"] == product["id"]
            from services import catalog_service as catalog, catalog_database
            from tests.integration.test_catalog_database_scale import list_arguments
            monkeypatch.setattr(catalog, "db", db)
            monkeypatch.setattr(catalog_database, "db", db)
            monkeypatch.setattr(catalog, "_snapshot", None)
            monkeypatch.setattr(catalog, "_background_refresh", None)
            await db.brands.update_one({"id": product["brand_id"]}, {"$set": {"catalog_authoritative": True, "catalog_source": "supplier"}})
            await catalog.refresh_catalog_snapshot()
            # A manually stocked SKU remains selectable even under a workbook-authoritative brand.
            page = await catalog.list_products_page(**list_arguments(q="GODOWN-123"))
            assert [row["id"] for row in page["items"]] == [product["id"]]
            monkeypatch.setattr(catalog, "_SNAPSHOT_ROW_LIMITS", {**catalog._SNAPSHOT_ROW_LIMITS, "products": 0})
            await catalog.refresh_catalog_snapshot()
            page = await catalog.list_products_page(**list_arguments(q="GODOWN-123"))
            assert [row["id"] for row in page["items"]] == [product["id"]]
            foreign = await route.sku_suggestions(prefix="GODOWN-", user=actor().model_copy(update={"active_floor_id": "ground-floor", "floor_ids": ["ground-floor"]}))
            assert foreign == []
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("changes", [{"qty": 0}, {"qty": float("nan")}, {"qty": float("inf")}, {"kind": "set_total"}, {"reason": "   "}, {"occurred_on": "2026-02-30"}])
def test_movement_boundary_validation(changes):
    with pytest.raises(ValidationError): movement(**changes)


def test_restock_legacy_manual_lot_creates_catalog_product_without_rebinding_saved_quotations(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.legacy_stock_catalog
        monkeypatch.setattr(route, "db", db)
        monkeypatch.setattr(route.catalog_service, "schedule_catalog_refresh", lambda: None)
        try:
            await db.godown_stock.insert_one(lot(product_id="godown:lot", unit_price=None))
            result = await route.record_stock_movement("lot", movement(), actor())
            assert result["product_id"] == "godown:lot"
            product = await db.products.find_one({"id": result["catalog_product_id"]})
            assert product["sku"] == "BASIN" and product["floor_id"] == "first-floor"
            assert product["price_status"] == "unspecified"
            assert result["unit_price"] is None and result["available_qty"] == 4
            replay = await route.record_stock_movement("lot", movement(), actor())
            assert replay["idempotent"] and await db.products.count_documents({}) == 1
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())
