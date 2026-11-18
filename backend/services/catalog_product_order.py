"""Persist shared product order for a floor-scoped catalog selection."""
from __future__ import annotations

from typing import Annotated

from fastapi import HTTPException
from pydantic import BaseModel, Field, StringConstraints, field_validator
from pymongo.errors import DuplicateKeyError

from catalog_policy import removed_brand_document
from models import now_iso
from services.access_grants import grant_allows, grants_for_user


MAX_ORDER_PRODUCTS = 10_000
CATALOG_FLOORS = {"first-floor", "ground-floor"}
REORDER_RESOURCE = "catalog_product_reorder"
ORDER_PATH = "/catalog/product-order"


class CatalogProductOrderUpdate(BaseModel):
    expected_version: int = Field(ge=0, strict=True)
    product_ids: list[Annotated[str, StringConstraints(min_length=1, max_length=200)]] = Field(
        min_length=1, max_length=MAX_ORDER_PRODUCTS,
    )

    @field_validator("product_ids")
    @classmethod
    def unique_products(cls, product_ids: list[str]) -> list[str]:
        if len(set(product_ids)) != len(product_ids):
            raise ValueError("Product IDs must be unique")
        return product_ids


def scope_key(floor_id: str, brand_id: str | None, category_id: str | None) -> dict:
    # MongoDB's built-in unique _id index protects the very first save as well.
    # Null means All Brands or All Products. Retain the original category IDs.
    return {"floor_id": floor_id, "brand_id": brand_id, "category_id": category_id}


def selected_scope(floor_ids, brand_id, category_id) -> dict | None:
    def single(value):
        if isinstance(value, (list, tuple)):
            return value[0] if value else None
        return value

    if any(isinstance(value, (list, tuple)) and len(value) > 1 for value in (brand_id, category_id)):
        return None
    brand, category = single(brand_id), single(category_id)
    if floor_ids and len(floor_ids) == 1 and floor_ids[0] in CATALOG_FLOORS:
        return scope_key(floor_ids[0], brand, category)
    return None


async def read_order(database, scope: dict) -> dict:
    return await database.catalog_product_orders.find_one(
        {"_id": scope}, {"_id": 0, "version": 1, "product_ids": 1},
    ) or {}


async def require_catalog_scope(database, scope: dict) -> None:
    floor_id = scope["floor_id"]
    if scope["brand_id"] is not None:
        brand = await database.brands.find_one(
            {"id": scope["brand_id"], "floor_id": floor_id}, {"_id": 0, "name": 1, "slug": 1},
        )
        if not brand or removed_brand_document(brand):
            raise HTTPException(404, "Catalog brand not found on this floor")
    if scope["category_id"] is not None:
        category = await database.categories.find_one(
            {"id": scope["category_id"], "floor_id": floor_id}, {"_id": 0, "id": 1},
        )
        if not category:
            raise HTTPException(404, "Catalog category not found on this floor")


async def can_reorder_products(database, user, floor_id: str) -> bool:
    from auth import accessible_floor_ids

    principal = await database.users.find_one({"id": user.id}, {
        "_id": 0, "role": 1, "floor_ids": 1, "access_profile": 1, "custom_access": 1,
        "active": 1, "deleted_at": 1, "is_deleted": 1,
    })
    if (floor_id not in CATALOG_FLOORS or not principal or principal.get("active") is False
            or principal.get("deleted_at") or principal.get("is_deleted")):
        return False
    current = user.model_copy(update={
        "role": principal.get("role", "worker"), "floor_ids": principal.get("floor_ids") or [],
        "access_profile": principal.get("access_profile"), "custom_access": bool(principal.get("custom_access")),
    })
    floors = accessible_floor_ids(current)
    if floors is not None and floor_id not in floors:
        return False
    if current.role == "owner":
        return True
    grants = await grants_for_user(database, user.id)
    return any(grant_allows(grant, user_id=user.id, resource=resource, action="update", floor_id=floor_id)
               for grant in grants for resource in ("catalog", REORDER_RESOURCE))


async def save_order(database, scope: dict, body: CatalogProductOrderUpdate, actor_id: str) -> int:
    from services.catalog_database import ordered_scope_members

    current = await read_order(database, scope)
    if current.get("version", 0) not in {body.expected_version, body.expected_version + 1}:
        raise HTTPException(409, "The catalog order changed. Reload it before saving again.")

    cards = await ordered_scope_members(scope)
    if set(body.product_ids) != cards.keys():
        raise HTTPException(409, "The products in this catalog view changed. Reload the catalog before saving again.")

    # Rank all underlying member IDs together. A card keeps its position if
    # its leading finish is replaced or removed from the supplier catalog.
    product_ids = [product_id for representative in body.product_ids for product_id in cards[representative]]
    version = body.expected_version + 1
    update = {"version": version, "product_ids": product_ids, "updated_at": now_iso(), "updated_by": actor_id}
    orders = database.catalog_product_orders
    if current.get("version", 0) == body.expected_version:
        if not body.expected_version:
            try:
                await orders.insert_one({"_id": scope, **update})
                return version
            except DuplicateKeyError:
                pass
        else:
            result = await orders.update_one({"_id": scope, "version": body.expected_version}, {"$set": update})
            if result.matched_count:
                return version
        current = await read_order(database, scope)
    # A lost response can be retried safely after the same order committed.
    if current.get("version") == version and current.get("product_ids") == product_ids:
        return version
    raise HTTPException(409, "The catalog order changed. Reload it before saving again.")
