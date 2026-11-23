"""Manual products remain visible through both catalogue read modes."""
import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from motor.motor_asyncio import AsyncIOMotorClient

from auth import get_current_user
from models import UserPublic
from routes import catalog_routes, quotation_routes
from services import activity_log, catalog_database, catalog_service, media_service, sequence
from tests.integration.test_purchase_completion_mongo import mongo_url  # noqa: F401


@pytest.mark.parametrize("floor", ["first-floor", "ground-floor"])
@pytest.mark.parametrize("database_backed", [False, True])
def test_manual_product_visible_and_quotable_after_save(mongo_url, monkeypatch, floor, database_backed):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.manual_products
        user = UserPublic(id="first-staff", email="staff@example.test", full_name="Staff", role="purchase",
                          floor_ids=[floor], active_floor_id=floor)
        for module in (catalog_routes, quotation_routes, activity_log, catalog_database, catalog_service, media_service, sequence):
            monkeypatch.setattr(module, "db", db)
        monkeypatch.setattr(catalog_service, "_snapshot", None)
        monkeypatch.setattr(catalog_service, "_background_refresh", None)
        if database_backed:
            monkeypatch.setattr(catalog_service, "_SNAPSHOT_ROW_LIMITS", {**catalog_service._SNAPSHOT_ROW_LIMITS, "products": 1})
        monkeypatch.setattr(quotation_routes, "_track_product_usage", AsyncMock())
        monkeypatch.setattr(quotation_routes, "reconcile_followups", AsyncMock())
        app = FastAPI()
        for router in (catalog_routes.router, quotation_routes.router):
            app.include_router(router, prefix="/api")
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            await db.brands.insert_one({"id": "supplier", "name": "Supplier", "slug": "supplier", "floor_id": floor,
                                        "catalog_authoritative": True, "catalog_source": "supplier.xlsx"})
            await db.categories.insert_one({"id": "category", "name": "Category", "brand_id": "supplier", "floor_id": floor})
            await db.customers.insert_one({"id": "buyer", "name": "Disposable buyer", "floor_id": floor})
            base = {"price": 450, "mrp": 600, "floor_id": floor, "brand_id": "supplier", "category_id": "category"}
            await db.products.insert_many([
                {**base, "id": "obsolete", "sku": "OLD", "name": "Obsolete supplier product", "active": True},
                {**base, "id": "previous", "sku": "PREVIOUS", "name": "Previously added manually", "active": True,
                 "is_custom": True, "custom_created_by": "staff", "custom_keep_in_catalog": True},
                {**base, "id": "one-off", "sku": "ONE-OFF", "name": "Quote-only product", "active": False,
                 "is_custom": True, "custom_created_by": "staff", "custom_keep_in_catalog": False},
            ])
            assert (await catalog_service.refresh_catalog_snapshot()).database_backed is database_backed
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as api:
                body = {"name": "Disposable manual sample", "sku": "MANUAL-001", "price": 450, "mrp": 600,
                        "size": "50 cm", "finish": "White",
                        "brand_id": "supplier", "category_id": "category", "request_id": "disposable-manual-add"}
                response = await api.post("/api/products/catalog-custom", json=body)
                assert response.status_code == 200, response.text
                product = response.json()
                stored = await db.products.find_one({"id": product["id"]})
                assert stored and stored["active"] and stored["floor_id"] == floor
                assert stored["price"] == 450 and stored["mrp"] == 600
                assert stored["size"] == "50 cm" and stored["finish"] == "White"
                # The existing UI uses families; the quote picker and ranked search also
                # need the same persisted product immediately after the save.
                for endpoint, query in (("products", product["sku"]), ("products/families", "Disposable manual"), ("catalog/search", product["sku"])):
                    found = await api.get(f"/api/{endpoint}", params={"q": query, "brand_id": "supplier", "category_id": "category"})
                    assert found.status_code == 200, found.text
                    assert found.json()["total"] == 1, found.text
                catalogue = await api.get("/api/products", params={"brand_id": "supplier"})
                assert {item["id"] for item in catalogue.json()["items"]} == {"previous", product["id"]}
                assert all("custom_created_by" not in item and "custom_request_fingerprint" not in item
                           for item in catalogue.json()["items"])
                retry = await api.post("/api/products/catalog-custom", json=body)
                assert retry.json()["id"] == product["id"]
                failed = await api.post("/api/products/catalog-custom", json={**body, "category_id": "wrong"})
                assert failed.status_code == 400
                conflict = await api.post("/api/products/catalog-custom", json={**body, "mrp": 999})
                assert conflict.status_code == 409 and "changed" in conflict.json()["detail"]
                assert await db.products.count_documents({"sku": product["sku"]}) == 1
                quote = await api.post("/api/quotations", json={"customer_id": "buyer", "rooms": ["Room"], "items": [
                    {"id": "manual-line", "product_id": product["id"], "sku": product["sku"], "name": product["name"],
                     "unit_price": 450, "qty": 1, "room": "Room"},
                ]})
                assert quote.status_code == 200, quote.text
                assert quote.json()["items"][0]["product_id"] == product["id"]

            # Another authenticated client after a cold catalogue refresh.
            user = user.model_copy(update={"id": "other-staff"})
            monkeypatch.setattr(catalog_service, "_snapshot", None)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as fresh:
                reloaded = await fresh.get("/api/catalog/search", params={"q": product["sku"], "group": "false"})
                assert reloaded.json()["items"][0]["id"] == product["id"]
        finally:
            await catalog_service.stop_catalog_refresh()
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())
