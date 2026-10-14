"""Regression test: product-by-ID endpoints must authorize by the product's
own floor, not the caller's ambient active-floor header, and alternates/
complete-the-set must scope their candidate pool to the SOURCE product's
floor rather than the caller's ambient state."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi.exceptions import HTTPException

import routes.catalog_routes as catalog_routes
from models import UserPublic


def _user(active_floor_id: str = "first-floor", floor_ids: list[str] | None = None) -> UserPublic:
    if floor_ids is None:
        floor_ids = ["ground-floor", "first-floor"]
    return UserPublic(
        email="sales@forge.app", full_name="Sales", role="sales",
        floor_ids=floor_ids, active_floor_id=active_floor_id,
    )


class _FakeProducts:
    def __init__(self, doc: dict):
        self._doc = doc

    async def find_one(self, query, projection=None, session=None):
        if query.get("id") != self._doc["id"]:
            return None

        # If no projection or only exclusions like {"_id": 0}, return full doc
        if not projection:
            return self._doc

        # Check if this is an inclusion projection (has at least one key set to 1)
        # that isn't just "_id"
        has_inclusion = any(k != "_id" and v == 1 for k, v in projection.items())

        if not has_inclusion:
            # Pure exclusion projection (e.g., {"_id": 0}), return full doc
            return self._doc

        # Inclusion projection: return only the specified fields
        # Always include "id" if query matched on it
        result = {}
        if "id" in projection and projection["id"] == 1:
            result["id"] = self._doc.get("id")
        if "floor_id" in projection and projection["floor_id"] == 1:
            result["floor_id"] = self._doc.get("floor_id")

        return result


class _FakeDb:
    def __init__(self, doc: dict):
        self.products = _FakeProducts(doc)


def test_get_product_ignores_ambient_floor_mismatch(monkeypatch):
    doc = {"id": "p1", "floor_id": "ground-floor"}
    monkeypatch.setattr(catalog_routes, "db", _FakeDb(doc))
    fake = AsyncMock(return_value={"id": "p1"})
    monkeypatch.setattr(catalog_routes.catalog_service, "product_by_id", fake)
    hydrate = AsyncMock(side_effect=lambda product: product)
    monkeypatch.setattr(catalog_routes.media_service, "hydrate_product_media", hydrate)

    result = asyncio.run(catalog_routes.get_product("p1", user=_user(active_floor_id="first-floor")))

    assert result == {"id": "p1", "floor_id": "ground-floor", "images": []}
    fake.assert_awaited_once_with("p1", floor_ids=None)


def test_alternates_scope_pool_to_source_floor_not_ambient(monkeypatch):
    doc = {"id": "p1", "floor_id": "ground-floor"}
    monkeypatch.setattr(catalog_routes, "db", _FakeDb(doc))
    fake = AsyncMock(return_value={"source_product_id": "p1", "items": []})
    monkeypatch.setattr(catalog_routes.catalog_service, "alternate_products", fake)

    asyncio.run(catalog_routes.product_alternates("p1", user=_user(active_floor_id="first-floor")))

    _, kwargs = fake.await_args
    assert kwargs["floor_ids"] == ["ground-floor"]


def test_get_product_denies_access_when_user_lacks_floor_access(monkeypatch):
    """Regression: Verify that get_product denies access when the user doesn't
    have access to the product's floor. This catches the bug where a missing
    floor_id in the projection falls back to hardcoded "first-floor" and
    incorrectly allows access. Must mock the service to isolate authorization.

    Cross-unit access 404s, not 403s (owner decision 2026-08-02): a 403
    would confirm "this id exists, just not for you", an existence oracle
    across the business-unit boundary. See test_auth_get_floor_scoped_or_404.py."""
    doc = {"id": "p1", "floor_id": "ground-floor"}
    monkeypatch.setattr(catalog_routes, "db", _FakeDb(doc))
    # Mock service to prevent 404 from service call; auth should fail first
    fake = AsyncMock(return_value={"id": "p1"})
    monkeypatch.setattr(catalog_routes.catalog_service, "product_by_id", fake)

    # User only has first-floor access, product is on ground-floor
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(catalog_routes.get_product(
            "p1",
            user=_user(active_floor_id="first-floor", floor_ids=["first-floor"]),
        ))

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "Product not found"


def test_complete_the_set_scopes_pool_to_source_floor_not_ambient(monkeypatch):
    """Verify that complete-the-set scopes its candidate pool to the SOURCE
    product's floor, not the caller's ambient state."""
    doc = {"id": "p1", "floor_id": "ground-floor"}
    monkeypatch.setattr(catalog_routes, "db", _FakeDb(doc))
    fake = AsyncMock(return_value={"source_product_id": "p1", "items": []})
    monkeypatch.setattr(catalog_routes.catalog_service, "complete_set_products", fake)

    asyncio.run(catalog_routes.complete_the_set("p1", user=_user(active_floor_id="first-floor")))

    _, kwargs = fake.await_args
    assert kwargs["floor_ids"] == ["ground-floor"]
