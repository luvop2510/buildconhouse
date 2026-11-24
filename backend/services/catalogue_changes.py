"""Preview and apply exactly the catalogue fields authorized by an import."""
from __future__ import annotations

from collections import Counter, defaultdict
from hashlib import sha256
from re import I, escape, sub
from uuid import uuid4

from fastapi import HTTPException
from pymongo import UpdateOne

from catalog_policy import MANUAL_CATALOG_SOURCE, removed_brand_document
from catalog_pipeline.self_service_files import new_product_issues
from models import Brand, Category, Product

TEXT_FIELDS = frozenset((
    "name", "subcategory", "series", "collection", "description", "finish", "finish_code",
    "colour", "size", "dimensions", "material", "warranty", "family_name", "family_key", "variant_label",
))
PRODUCT_FIELDS = TEXT_FIELDS | {"category", "mrp", "price", "specs", "concealed_skus", "accessory_skus"}
MATCH_FIELDS = {"id", "sku", "active", "updated_at", "catalog_version", "category_id", "mrp", "price",
                "catalog_mrp_override", "catalog_mrp_only_override", "catalog_entries.mrp"}
LISTING_FIELDS = {"name", "description", "subcategory"}


def slug_for(name: str) -> str:
    return sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or sha256(name.encode()).hexdigest()[:16]


def category_scope(floor: str, brand: dict, name: str) -> dict:
    return {"floor_id": floor, "slug": f"{brand['slug']}--{slug_for(name)}"}


def effective_mrp(product: dict) -> float | None:
    if product.get("catalog_mrp_override") or product.get("catalog_mrp_only_override"):
        return product.get("mrp")
    entry_values = {entry["mrp"] for entry in product.get("catalog_entries") or [] if entry.get("mrp") is not None}
    if len(entry_values) > 1:
        return None
    return next(iter(entry_values), product.get("mrp"))


def preview_rows(job: dict, rows: list[dict], existing: dict, categories: dict, grants: set[str]) -> list[dict]:
    """Build an immutable, exact SKU plan with row-level validation outcomes."""
    operation = job["operation"]
    duplicates = Counter(row["sku"] for row in rows if row["sku"])
    changes = []
    for index, row in enumerate(rows):
        sku = row["sku"]
        product = existing.get(sku)
        fields = row["fields"]
        errors = list(row["errors"])
        action = "unchanged"
        delta = {}
        category = None
        photos = list(dict.fromkeys(row.get("image_hashes", [])))
        if duplicates[sku] > 1:
            errors.append("Duplicate article number in the source.")
        if not sku:
            errors.append("Article number is required.")
        if product and product.get("active") is False:
            errors.append("Article number belongs to an inactive product.")
        if not product and operation in {"prices", "update", "images"}:
            errors.append("Article number has no matching product in this brand.")
        if operation == "prices" and product and "new_mrp" in fields:
            previous_mrp = effective_mrp(product)
            if previous_mrp is None:
                errors.append("This article has conflicting catalogue placement prices.")
            elif "current_mrp" in fields and previous_mrp != fields["current_mrp"]:
                errors.append("Current MRP changed since this workbook was exported.")
            elif previous_mrp != fields["new_mrp"]:
                delta = {"mrp": fields["new_mrp"], "catalog_mrp_only_override": True}
                action = "price"
            photos = []
        if operation == "images":
            if not photos:
                errors.append("No verified image was found for this row.")
            elif product:
                action = "image"
        if operation in {"add", "sync", "update"}:
            if product and operation == "add":
                photos = []
            elif not errors:
                delta = {key: value for key, value in fields.items() if key in PRODUCT_FIELDS}
                label = delta.pop("category", None)
                if label:
                    category = categories.get(label.casefold())
                    if category is None:
                        if job.get("create_categories") and "catalogue_categories" in grants:
                            category = {"name": label}
                        else:
                            errors.append("Category does not exist for this brand.")
                if not product:
                    errors.extend(new_product_issues(fields, job["floor_id"]))
                    action = "add"
                else:
                    if "mrp" in delta and effective_mrp(product) == delta["mrp"]:
                        delta.pop("mrp")
                    if "specs" in delta:
                        delta["specs"] = {**(product.get("specs") or {}), **delta["specs"]}
                    if category and category.get("id") == product.get("category_id"):
                        category = None
                    delta = {key: value for key, value in delta.items()
                             if key in {"mrp", "price"} or product.get(key) != value}
                    if "price" in delta and product.get("price") == delta["price"] and (
                        not product.get("has_catalogue_placements") or product.get("catalog_offer_override")
                        or product.get("catalog_mrp_override")
                    ):
                        delta.pop("price")
                    if {"mrp", "price"} & delta.keys() and "catalogue_prices" not in grants:
                        errors.append("Updating prices requires Update Prices permission.")
                    if "mrp" in delta:
                        delta["catalog_mrp_only_override"] = True
                    if "price" in delta and product.get("has_catalogue_placements"):
                        delta["catalog_offer_override"] = True
                    for key in LISTING_FIELDS & delta.keys():
                        values = {entry.get(key, product.get(key)) for entry in product.get("catalog_entries") or []}
                        if len(values) > 1:
                            errors.append(f"Catalogue placements have different {key} values. Review them individually.")
                    if category and len({entry.get("category_id") for entry in product.get("catalog_entries") or []}) > 1:
                        errors.append("This article has placements under several categories. Review them individually.")
                    if delta or category or photos:
                        action = "update"
        if photos and "catalogue_images" not in grants:
            errors.append("Importing images requires Manage Product Images permission.")
        if errors:
            action = "rejected"
        changes.append({
            "_id": f"{job['_id']}:{index}", "job_id": job["_id"], "index": index,
            "sku": sku, "sheet": row["sheet"], "row": row["row"], "action": action,
            "errors": list(dict.fromkeys(errors)), "category": category,
            "product_id": product.get("id") if product else None,
            "previous_mrp": effective_mrp(product) if product and "mrp" in delta else None,
            "expected_updated_at": product.get("updated_at") if product else None,
            "expected_version": product.get("catalog_version") if product else None,
            "delta": delta, "image_hashes": photos,
        })
    return changes


async def scoped_brand(database, floor: str, *, brand_id: str | None = None, name: str | None = None, session=None):
    identity = {"id": brand_id} if brand_id else {"slug": slug_for(name or "")}
    return await database.brands.find_one({"floor_id": floor, **identity}, {"_id": 0}, session=session)


async def get_or_create_brand(database, floor: str, name: str, session=None) -> dict:
    identity = {"floor_id": floor, "slug": slug_for(name)}
    if removed_brand_document({"name": name, **identity}):
        raise HTTPException(422, "This brand is no longer distributed.")
    brand = Brand(name=name, **identity).model_dump()
    await database.brands.update_one(identity, {"$setOnInsert": brand}, upsert=True, session=session)
    result = await database.brands.find_one(identity, {"_id": 0}, session=session)
    if result["name"].casefold() != name.casefold():
        raise HTTPException(409, "A different brand already uses this name or slug.")
    return result


async def get_or_create_category(database, floor: str, brand: dict, name: str, session=None) -> dict:
    same_name = {"floor_id": floor, "brand_id": brand["id"], "name": {"$regex": f"^{escape(name)}$", "$options": "i"}}
    existing = await database.categories.find_one(same_name, {"_id": 0}, session=session)
    if existing:
        return existing
    identity = category_scope(floor, brand, name)
    category = Category(name=name, brand_id=brand["id"], **identity).model_dump()
    await database.categories.update_one(identity, {"$setOnInsert": category}, upsert=True, session=session)
    result = await database.categories.find_one(identity, {"_id": 0}, session=session)
    if result["name"].casefold() != name.casefold() or result.get("brand_id") != brand["id"]:
        raise HTTPException(409, "A different category already uses this name or slug.")
    return result


async def matching_products(database, floor: str, brand_id: str, skus: list[str], operation: str) -> dict:
    fields = MATCH_FIELDS | (TEXT_FIELDS | {"specs", "concealed_skus", "catalog_offer_override",
        "catalog_entries.category_id", *[f"catalog_entries.{key}" for key in LISTING_FIELDS]}
        if operation in {"update", "sync"} else set())
    if operation in {"update", "sync", "images"}:
        fields |= {"catalogue_image_key", "dimension_image_urls"}
    projection = {"_id": 0, **dict.fromkeys(fields, 1)}
    found = {}
    for start in range(0, len(skus), 250):
        batch = skus[start:start + 250]
        cursor = database.products.find({"floor_id": floor, "brand_id": brand_id, "sku": {"$in": batch}}, projection)
        async for product in cursor:
            product["has_catalogue_placements"] = bool(product.get("catalog_entries"))
            found[product["sku"]] = product
    return found


def _tile_identity(row: dict) -> tuple[str, str, str]:
    name = row.get("name") or ""
    size = row.get("size") or ""
    if size:
        name = sub(r"\s*\(\d+\s*[x×]\s*\d+(?:\s*mm)?\)\s*$", "", name, flags=I)
    return tuple(sub(r"[^a-z0-9]+", "", value.casefold()) for value in (name, size, row.get("finish") or ""))


async def resolve_reviewed_tile_identities(database, floor: str, brand_id: str, rows: list[dict]) -> None:
    """Resolve an article-less reviewed MCM row to a single existing identity."""
    reviewed = [row for row in rows if "legacy_identity" in row]
    if not reviewed:
        return
    identities = defaultdict(list)
    by_name = defaultdict(list)
    by_sku = {}
    async for product in database.products.find({"floor_id": floor, "brand_id": brand_id}, {
        "_id": 0, "sku": 1, "name": 1, "size": 1, "finish": 1, "variants.sku": 1,
    }):
        key = _tile_identity(product)
        identities[key].append(product)
        by_name[key[0]].append(product)
        by_sku[product["sku"]] = key
    for row in reviewed:
        key = _tile_identity(row["legacy_identity"])
        matches = identities[key]
        same_sku = by_sku.get(row["sku"])
        if not all(key) or len(matches) > 1 or same_sku and same_sku != key or (
            not matches and any(not all(_tile_identity(product)) or product.get("variants") for product in by_name[key[0]])
        ):
            row["errors"].append("This supplier variant has an ambiguous saved identity. Use its exact catalogue article number.")
        elif matches:
            row["sku"] = matches[0]["sku"]


async def applicable_categories(database, floor: str, brand_id: str | None) -> dict:
    cursor = database.categories.find({"floor_id": floor, "brand_id": {"$in": [None, brand_id]}}, {"_id": 0})
    rows = await cursor.to_list(2000)
    return {row["name"].casefold(): row for row in sorted(rows, key=lambda row: bool(row.get("brand_id")))}


def new_product(floor: str, brand: str, category: str, sku: str, fields: dict, *, product_id=None) -> dict:
    payload = dict(fields)
    payload.setdefault("price", payload["mrp"])
    return Product(
        **payload, id=product_id or str(uuid4()), floor_id=floor, brand_id=brand, category_id=category,
        sku=sku, catalog_source=MANUAL_CATALOG_SOURCE,
    ).model_dump()


def before_values(product: dict, fields: dict) -> tuple[dict, list[str]]:
    return ({key: product[key] for key in fields if key in product}, [key for key in fields if key not in product])


async def save_preview(database, changes: list[dict]):
    for start in range(0, len(changes), 100):
        await database.catalogue_import_rows.bulk_write(
            [UpdateOne({"_id": row["_id"]}, {"$set": row}, upsert=True) for row in changes[start:start + 100]],
            ordered=False,
        )
