"""Media mutation must authorize the actual media owner, not a family label."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import HTTPException
import pytest

from models import ProductMedia, UserPublic
from routes import media_routes as routes
from services import media_service as service


def user():
    return UserPublic(id="staff", email="staff@example.com", full_name="Staff", role="purchase", floor_ids=["first-floor"], active_floor_id="first-floor")


@pytest.mark.asyncio
async def test_colliding_family_on_other_floor_cannot_authorize_media(monkeypatch):
    # Model a real DB filter rather than a mock returning a foreign document
    # unconditionally; this regression failed before the floor-scoped lookup.
    foreign = {"id": "foreign", "family_key": "same", "brand_id": "brand", "floor_id": "ground-floor"}
    async def find_media(query, projection):
        return foreign if "floor_id" not in query and "$and" not in query else None
    products = SimpleNamespace(find_one=AsyncMock(return_value={"id": "local"}))
    monkeypatch.setattr(routes, "db", SimpleNamespace(product_media=SimpleNamespace(find_one=find_media), products=products))
    with pytest.raises(HTTPException) as rejected:
        await routes._assert_media_access("foreign", user())
    assert rejected.value.status_code == 404
    products.find_one.assert_not_awaited()


@pytest.mark.asyncio
async def test_family_owner_lookup_includes_exact_floor_and_brand(monkeypatch):
    media = {"id": "local", "family_key": "same", "brand_id": "brand-a", "floor_id": "first-floor"}
    products = SimpleNamespace(find_one=AsyncMock(return_value={"id": "product"}))
    monkeypatch.setattr(routes, "db", SimpleNamespace(product_media=SimpleNamespace(find_one=AsyncMock(return_value=media)), products=products))
    assert await routes._assert_media_access("local", user()) == media
    query = products.find_one.call_args.args[0]
    base = query["$and"][1] if "$and" in query else query
    assert base["floor_id"] == "first-floor" and base["brand_id"] == "brand-a"


@pytest.mark.asyncio
async def test_demotion_cannot_touch_another_floor_or_brand(monkeypatch):
    update = AsyncMock()
    monkeypatch.setattr(service, "db", SimpleNamespace(product_media=SimpleNamespace(update_many=update)))
    await service._demote_other_primaries(product_id=None, family_key="same", keep_id="new", floor_id="first-floor", brand_id="brand-a")
    query = update.call_args.args[0]
    assert query["floor_id"] == "first-floor" and query["brand_id"] == "brand-a" and query["family_key"] == "same"


@pytest.mark.asyncio
async def test_family_dedup_binds_both_ownership_dimensions(monkeypatch):
    old = ProductMedia(family_key="same", brand_id="brand-a", floor_id="first-floor", bucket="public", storage_key="image.svg", role="hero", mime="image/svg+xml", sha1="hash").model_dump()
    find = AsyncMock(return_value=old)
    monkeypatch.setattr(service, "db", SimpleNamespace(product_media=SimpleNamespace(find_one=find)))
    monkeypatch.setattr(service, "get_media_storage", lambda: SimpleNamespace(exists=AsyncMock(return_value=True)))
    await service.upload_and_register(data=b"<svg/>", mime="image/svg+xml", brand_slug="brand", family_key="same", brand_id="brand-a", floor_id="first-floor", role="hero")
    query = find.call_args.args[0]
    assert query["floor_id"] == "first-floor" and query["brand_id"] == "brand-a"
