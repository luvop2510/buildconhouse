"""Isolated persistence, retry and privilege checks for the custom product workflow."""
import asyncio
import io
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.testclient import TestClient
from PIL import Image
from pymongo.errors import DuplicateKeyError
from starlette.datastructures import Headers
from auth import get_current_user
from models import ProductCreate, UserPublic
from routes import catalog_routes, media_routes
from services import media_service
from services.access_grants import granted_floor_ids
from access_profiles import profile_allows_request, SANITARY_QUOTATIONS_FOLLOWUPS, GROUND_TILE_QUOTATIONS_FOLLOWUPS

class Collection:
    def __init__(self, rows=()): self.rows = list(rows)
    @staticmethod
    def matches(row, query):
        if "$and" in query: return all(Collection.matches(row, clause) for clause in query["$and"])
        return all(row.get(k) in v["$in"] if isinstance(v, dict) and "$in" in v else
                   row.get(k) != v["$ne"] if isinstance(v, dict) and "$ne" in v else row.get(k) == v
                   for k, v in query.items())
    async def find_one(self, query, *_, **_kwargs): return next((dict(row) for row in self.rows if self.matches(row, query)), None)
    def find(self, query, *_):
        rows = [dict(row) for row in self.rows if self.matches(row, query)]
        class Cursor:
            async def to_list(self, limit): return rows[:limit]
        return Cursor()
    async def insert_one(self, row):
        if row.get("_id") and any(existing.get("_id") == row["_id"] for existing in self.rows): raise DuplicateKeyError("same request")
        self.rows.append(dict(row))
    async def update_one(self, query, update):
        for row in self.rows:
            if self.matches(row, query):
                row.update(update["$set"])
                return SimpleNamespace(matched_count=1)
        return SimpleNamespace(matched_count=0)
    async def update_many(self, query, update):
        for row in self.rows:
            if self.matches(row, query): row.update(update["$set"])

def staff(id="sales-1", floor="first-floor", role="sales"):
    return UserPublic(id=id, email=f"{id}@example.test", full_name="Sales", role=role,
                      floor_ids=["first-floor", "ground-floor"], active_floor_id=floor)
def body(**kwargs):
    return ProductCreate(**dict({"name": "Custom basin", "sku": "", "brand_id": "brand-1", "category_id": "cat-1",
                                "price": 900, "mrp": 1000, "is_custom": True, "request_id": "request-123456"}, **kwargs))
def image_bytes():
    stream = io.BytesIO(); Image.new("RGB", (600, 400), "red").save(stream, "PNG"); return stream.getvalue()
def upload(data=None):
    return UploadFile(io.BytesIO(image_bytes() if data is None else data), filename="basin.png", headers=Headers({"content-type": "image/png"}))

@pytest.fixture
def isolated(monkeypatch):
    database = SimpleNamespace(products=Collection(), product_media=Collection(),
                               brands=Collection([{"id": "brand-1", "floor_id": "first-floor", "slug": "custom-brand"}]),
                               categories=Collection([{"id": "cat-1", "floor_id": "first-floor"}]))
    objects = {}
    async def put(*, bucket, key, data, content_type):
        await asyncio.sleep(0); objects[(bucket, key)] = data
        return SimpleNamespace(public_url=f"https://storage.example.test/{bucket}/{key}")
    async def exists(*, bucket, key): return (bucket, key) in objects
    async def delete(*, bucket, key): objects.pop((bucket, key), None)
    storage = SimpleNamespace(upload=put, exists=exists, delete=delete)
    for module in (catalog_routes, media_routes, media_service): monkeypatch.setattr(module, "db", database)
    monkeypatch.setattr(media_service, "get_media_storage", lambda: storage)
    monkeypatch.setattr(media_service, "log_event", AsyncMock())
    monkeypatch.setattr(catalog_routes.catalog_service, "schedule_catalog_refresh", lambda: None)
    return database, objects, storage
async def create_photo(product=None, user=None, keep=True, request="request-123456", file=None):
    return await media_routes.create_custom_product_with_media(
        product=json.dumps((product or body()).model_dump()), request_id=request, keep_in_catalog=keep,
        file=file or upload(), user=user or staff())

@pytest.mark.asyncio
@pytest.mark.parametrize("keep", [True, False])
async def test_persists_photo_bytes_metadata_and_retry_identity(isolated, keep):
    database, objects, _ = isolated
    created = await create_photo(keep=keep); retried = await create_photo(keep=keep)
    assert created.id == retried.id and created.active is keep
    assert created.images == [created.hero_image_url]
    assert len(database.products.rows) == len(database.product_media.rows) == len(objects) == 1
    media = database.product_media.rows[0]
    assert media["product_id"] == created.id and media["floor_id"] == "first-floor" and media["uploaded_by"] == "sales-1"
    assert media["is_primary"] and objects[(media["bucket"], media["storage_key"])] == image_bytes()

@pytest.mark.asyncio
async def test_failed_upload_stays_hidden_and_retry_resumes_same_product(isolated):
    database, objects, storage = isolated; actual_upload = storage.upload
    storage.upload = AsyncMock(side_effect=RuntimeError("storage unavailable"))
    with pytest.raises(RuntimeError): await create_photo()
    assert len(database.products.rows) == 1 and database.products.rows[0]["active"] is False
    pending_id = database.products.rows[0]["id"]
    assert not database.product_media.rows and not objects
    storage.upload = actual_upload; resumed = await create_photo()
    assert resumed.id == pending_id and resumed.active
    assert len(database.products.rows) == len(database.product_media.rows) == 1

@pytest.mark.asyncio
async def test_simultaneous_retries_share_product_media_and_primary(isolated):
    first, second = await asyncio.gather(create_photo(), create_photo())
    assert first.id == second.id and first.hero_image_url == second.hero_image_url
    assert len(isolated[0].products.rows) == len(isolated[0].product_media.rows) == len(isolated[1]) == 1
    assert isolated[0].product_media.rows[0]["is_primary"] is True

@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [{"name": "Changed name"}, {"price": 800}, {"brand_id": ""}])
async def test_request_rejects_changed_product(isolated, changes):
    await create_photo(keep=False)
    with pytest.raises(HTTPException) as rejected: await create_photo(body(**changes), keep=False)
    assert rejected.value.status_code == 409
    assert len(isolated[0].products.rows) == len(isolated[0].product_media.rows) == 1

@pytest.mark.asyncio
async def test_request_rejects_changed_media_and_visibility(isolated):
    await create_photo()
    with pytest.raises(HTTPException) as rejected: await create_photo(keep=False)
    assert rejected.value.status_code == 409
    with pytest.raises(HTTPException) as rejected: await create_photo(file=upload(image_bytes() + b"different"))
    assert rejected.value.status_code == 409

@pytest.mark.asyncio
async def test_same_request_cannot_modify_another_creator_or_floor(isolated):
    first = await create_photo(); second = await create_photo(user=staff(id="sales-2"))
    assert first.id != second.id
    ground = await create_photo(body(brand_id="", category_id=""), user=staff(floor="ground-floor"), keep=False)
    assert ground.id != first.id and ground.floor_id == "ground-floor"
    assert isolated[0].products.rows[0]["custom_created_by"] == "sales-1"

@pytest.mark.asyncio
async def test_supplied_id_cannot_upload_to_regular_product(isolated):
    isolated[0].products.rows.append({"id": "regular", "floor_id": "first-floor", "is_custom": False})
    raw = {**body().model_dump(), "id": "regular", "floor_id": "ground-floor"}
    result = await media_routes.create_custom_product_with_media(json.dumps(raw), "request-123456", True, upload(), staff())
    assert result.id != "regular" and result.floor_id == "first-floor"
    assert isolated[0].product_media.rows[0]["product_id"] == result.id

@pytest.mark.asyncio
@pytest.mark.parametrize("brand,category", [("", ""), ("brand-1", ""), ("", "cat-1")])
async def test_photo_and_no_photo_one_off_allow_missing_references(isolated, brand, category):
    value = body(brand_id=brand, category_id=category, keep_in_catalog=False)
    no_photo = await catalog_routes.create_custom_product(value, staff())
    photo = await create_photo(value, keep=False, request="other-request-123")
    assert not no_photo.active and not photo.active and photo.images
    assert len(isolated[0].products.rows) == 2

@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["brand_id", "category_id"])
async def test_foreign_reference_rejected_before_write(isolated, field):
    with pytest.raises(HTTPException) as rejected: await create_photo(body(**{field: "foreign-id"}), keep=False)
    assert rejected.value.status_code == 400
    assert not isolated[0].products.rows and not isolated[0].product_media.rows and not isolated[1]

@pytest.mark.asyncio
async def test_invalid_media_cannot_write_product(isolated):
    with pytest.raises(HTTPException) as rejected: await create_photo(file=upload(b"not a PNG"))
    assert rejected.value.status_code == 400 and not isolated[0].products.rows

@pytest.mark.asyncio
async def test_inactive_custom_detail_and_media_read_saved_photo_before_refresh(isolated, monkeypatch):
    created = await create_photo(keep=False)
    monkeypatch.setattr(catalog_routes.catalog_service, "product_by_id", AsyncMock(return_value=None))
    detail = await catalog_routes.get_product(created.id, staff())
    gallery = await media_routes.list_product_media(created.id, staff())
    assert detail["images"] == [created.hero_image_url] and gallery[0].public_url == created.hero_image_url
    assert "custom_request_fingerprint" not in detail and detail["active"] is False

@pytest.mark.asyncio
async def test_detail_cannot_reuse_deleted_photo_from_stale_snapshot(isolated, monkeypatch):
    created = await create_photo()
    monkeypatch.setattr(catalog_routes.catalog_service, "product_by_id", AsyncMock(return_value=created.model_dump()))
    isolated[0].product_media.rows.clear()
    detail = await catalog_routes.get_product(created.id, staff())
    assert detail["images"] == [] and detail["hero_image_url"] is None and detail["gallery"] == []

@pytest.mark.asyncio
async def test_inactive_custom_editor_saves_fields_and_returns_persisted_media(isolated, monkeypatch):
    from models import ProductPatch
    created = await create_photo(keep=False)
    monkeypatch.setattr(catalog_routes.catalog_service, "product_by_id", AsyncMock(return_value=None))
    monkeypatch.setattr(catalog_routes.catalog_service, "patch_product_in_snapshot", lambda *_: None)
    monkeypatch.setattr(catalog_routes, "log_event", AsyncMock())
    updated = await catalog_routes.update_product(created.id, ProductPatch(description="Edited custom item"), staff(role="purchase"))
    assert updated.active is False and updated.description == "Edited custom item"
    assert updated.images == [created.hero_image_url]
    assert isolated[0].products.rows[0]["description"] == "Edited custom item"

@pytest.mark.asyncio
async def test_deletion_during_upload_is_not_reported_saved(isolated):
    actual = isolated[2].upload
    async def remove_product(**kwargs):
        result = await actual(**kwargs); isolated[0].products.rows.clear(); return result
    isolated[2].upload = remove_product
    with pytest.raises(HTTPException) as rejected: await create_photo()
    assert rejected.value.status_code == 404

def test_invalid_http_payload_and_low_role_rejected(isolated):
    app = FastAPI(); app.include_router(media_routes.router)
    app.dependency_overrides[get_current_user] = lambda: staff()
    with TestClient(app) as client:
        for product, key in (("bad JSON", "valid-request-1"), (json.dumps(body().model_dump()), "bad")):
            response = client.post("/products/custom-with-media", data={"product": product, "request_id": key}, files={"file": ("photo.png", image_bytes(), "image/png")})
            assert response.status_code == 422
        app.dependency_overrides[get_current_user] = lambda: staff(role="worker")
        response = client.post("/products/custom-with-media", data={"product": json.dumps(body().model_dump()), "request_id": "valid-request-1"}, files={"file": ("photo.png", image_bytes(), "image/png")})
        assert response.status_code == 403
    assert not isolated[0].products.rows

@pytest.mark.parametrize("path", ["/api/products/custom", "/api/products/custom-with-media"])
def test_exact_creation_grants_and_profiles(path):
    assert profile_allows_request(SANITARY_QUOTATIONS_FOLLOWUPS, "POST", path)
    assert profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "POST", path)
    for resource, floor in (("quotations", "first-floor"), ("tiles", "ground-floor")):
        grant = {"user_id": "sales-1", "resource": resource, "floor_id": floor, "actions": ["create"], "scope": "all"}
        assert granted_floor_ids([grant], user_id="sales-1", path=path, action="create", method="POST") == [floor]
        assert granted_floor_ids([grant], user_id="sales-1", path="/api/products/regular/media", action="create", method="POST") == []
        assert granted_floor_ids([grant], user_id="sales-1", path=path, action="delete", method="DELETE") == []
