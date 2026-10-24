"""Real multipart routes, disposable Mongo and disk bytes; no live credentials."""
import asyncio
import hashlib
import io
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from motor.motor_asyncio import AsyncIOMotorClient
from PIL import Image

from auth import get_current_user
from models import UserPublic
from routes import catalog_routes, media_routes, quotation_routes
from services import activity_log, catalog_service, media_service, sequence
from tests.integration.test_purchase_completion_mongo import mongo_url  # noqa: F401


@pytest.mark.parametrize("keep", [True, False])
def test_photo_retry_real_bytes_and_quotation_reorder_reload(mongo_url, tmp_path, monkeypatch, keep):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.custom_media
        user = UserPublic(id="sales-photo", email="sales@example.test", full_name="Sales", role="sales", floor_ids=["first-floor"], active_floor_id="first-floor")
        for module in (catalog_routes, media_routes, quotation_routes, activity_log, media_service, sequence):
            monkeypatch.setattr(module, "db", db)
        monkeypatch.setattr(catalog_service, "schedule_catalog_refresh", lambda: None)
        monkeypatch.setattr(quotation_routes, "_track_product_usage", AsyncMock())
        monkeypatch.setattr(quotation_routes, "reconcile_followups", AsyncMock())

        async def snapshot():
            return catalog_service._build_snapshot(
                await db.products.find({"active": True}, {"_id": 0}).to_list(None),
                await db.product_media.find({}, {"_id": 0}).to_list(None),
                await db.brands.find({}, {"_id": 0}).to_list(None),
                await db.categories.find({}, {"_id": 0}).to_list(None), [],
            )
        monkeypatch.setattr(catalog_service, "get_catalog_snapshot", snapshot)
        class DiskStorage:
            async def upload(self, *, bucket, key, data, content_type, **kwargs):
                path = tmp_path / bucket / key
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                return SimpleNamespace(public_url=f"https://storage.example.test/{bucket}/{key}")
            async def exists(self, *, bucket, key):
                return (tmp_path / bucket / key).is_file()
            async def delete(self, *, bucket, key):
                (tmp_path / bucket / key).unlink(missing_ok=True)
        monkeypatch.setattr(media_service, "get_media_storage", DiskStorage)
        app = FastAPI()
        for router in (catalog_routes.router, media_routes.router, quotation_routes.router):
            app.include_router(router, prefix="/api")
        async def identity():
            return user
        app.dependency_overrides[get_current_user] = identity
        # Authentication uses a disposable identity; normal route role gates,
        # floor validation, multipart parsing and persistence remain active.
        try:
            await db.brands.insert_one({"id": "brand", "name": "Test", "slug": "test", "floor_id": "first-floor"})
            await db.categories.insert_one({"id": "category", "name": "Basins", "floor_id": "first-floor"})
            await db.customers.insert_one({"id": "customer", "name": "Disposable buyer", "floor_id": "first-floor"})
            await db.products.create_index([("floor_id", 1), ("brand_id", 1), ("sku", 1)], unique=True)
            output = io.BytesIO()
            Image.new("RGB", (640, 480), "navy").save(output, "PNG")
            photo = output.getvalue()
            body = {"name": "Test photo product", "sku": "PHOTO-1", "brand_id": "brand", "category_id": "category", "price": 450, "mrp": 450, "is_custom": True}
            data = {"product": json.dumps(body), "request_id": "photo-integration-1", "keep_in_catalog": str(keep).lower()}
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as api:
                async def upload():
                    response = await api.post("/api/products/custom-with-media", data=data, files={"file": ("photo.png", photo, "image/png")})
                    assert response.status_code == 200, response.text
                    return response.json()
                results = await asyncio.gather(upload(), upload())
                first = results[0]
                assert results[1]["id"] == first["id"]
                assert (await upload())["id"] == first["id"]
                assert await db.products.count_documents({}) == 1
                assert await db.product_media.count_documents({"product_id": first["id"]}) == 1
                media = await db.product_media.find_one({"product_id": first["id"]})
                stored = (tmp_path / media["bucket"] / media["storage_key"]).read_bytes()
                assert hashlib.sha1(stored).hexdigest() == media["sha1"]
                assert len(stored) == media["size_bytes"]
                assert media["is_primary"] is True and media["floor_id"] == "first-floor"
                assert (await db.products.find_one({"id": first["id"]}))["active"] is keep
                assert (first["id"] in (await snapshot()).product_by_id) is keep
                user = user.model_copy(update={"role": "purchase"})
                edited = await api.patch(f'/api/products/{first["id"]}', json={"description": "Edited after custom addition"})
                assert edited.status_code == 200, edited.text
                assert edited.json()["active"] is keep
                assert edited.json()["images"] == [media["public_url"]]
                assert edited.json()["description"] == "Edited after custom addition"
                # A one-off without media must also have a real product id:
                # otherwise the server rejects the builder's autosaved line.
                plain_response = await api.post("/api/products/custom", json={**body, "sku": "PLAIN-1", "name": "Plain one-off", "request_id": "plain-integration-1", "keep_in_catalog": False})
                assert plain_response.status_code == 200, plain_response.text
                plain = plain_response.json()
                assert (await db.products.find_one({"id": plain["id"]}))["active"] is False
                def line(product, number):
                    return {"id": f"line-{number}", "product_id": product["id"], "sku": product["sku"], "name": product["name"], "unit_price": 450, "qty": 1, "room": "Bath", "image": product.get("hero_image_url")}
                items = [line(first, 1), line(plain, 2)]
                created = await api.post("/api/quotations", json={"customer_id": "customer", "rooms": ["Bath"], "items": items})
                assert created.status_code == 200, created.text
                quote = created.json()
                changed = await api.patch(f'/api/quotations/{quote["id"]}', json={"items": list(reversed(items)), "rooms": ["Bath"], "silent": True})
                assert changed.status_code == 200, changed.text
                reloaded = await api.get(f'/api/quotations/{quote["id"]}')
                assert reloaded.status_code == 200, reloaded.text
                saved = reloaded.json()["items"]
                assert [item["id"] for item in saved] == ["line-2", "line-1"]
                assert saved[1]["image"] == media["public_url"]
                assert (await db.quotations.find_one({"id": quote["id"]}))["items"][1]["image"] == media["public_url"]
                assert quote["grand_total"] == reloaded.json()["grand_total"]
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())
