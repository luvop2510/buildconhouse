"""Import the reviewed BIANA workbook into the Sanitary catalogue.

Run from backend with the approved environment: python -m scripts.run_biana_import
--source <workbook>. Add --database <name> for a live preview, --apply to
import, or --verify to check all saved products and original public images.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
from uuid import uuid4

from catalog_pipeline.biana_source import extract_rows

FLOOR = "first-floor"
SUPPLIER = "BIANA"
ACTOR = "system:biana-catalog-import"


def identity(name, size, finish):
    return tuple(re.sub(r"[\W_]+", "", str(value or "").casefold()) for value in (name, size, finish))


async def scope(database, rows):
    brands = await database.brands.find({
        "floor_id": FLOOR,
        "$or": [{"slug": {"$regex": "^biana$", "$options": "i"}},
                {"name": {"$regex": "^\\s*biana\\s*$", "$options": "i"}}],
    }, {"_id": 0}).to_list(2)
    if len(brands) > 1:
        raise ValueError("Multiple BIANA brands already exist on the Sanitary floor.")
    brand = brands[0] if brands else None
    if brand and brand["name"].strip().casefold() != "biana":
        raise ValueError("The BIANA slug is assigned to a different brand.")

    categories = await database.categories.find({"floor_id": FLOOR}, {"_id": 0}).to_list()
    labels = {row["category"] for row in rows}
    category_by_name = {}
    for label in labels:
        slug = re.sub(r"[^a-z0-9]+", "-", label.casefold()).strip("-")
        matches = [item for item in categories
                   if item["name"].strip().casefold() == label.casefold() or item.get("slug") == slug]
        if matches:
            if (len(matches) != 1 or matches[0]["name"].casefold() != label.casefold()
                    or matches[0].get("brand_id") not in (None, (brand or {}).get("id"))):
                raise ValueError(f"Ambiguous Sanitary category {label}.")
            category_by_name[label] = matches[0]

    existing = await database.products.find(
        {"floor_id": FLOOR, "brand_id": brand["id"]}, {"_id": 0},
    ).to_list() if brand else []
    by_sku = {item["sku"]: item for item in existing}
    by_identity = {}
    for item in existing:
        key = (item["category_id"], *identity(item["name"], item.get("size"), item.get("finish")))
        by_identity.setdefault(key, []).append(item)

    matched = {}
    for row in rows:
        category = category_by_name.get(row["category"], {}).get("id")
        natural = (category, *identity(row["name"], row["size"], row["finish"]))
        candidates = by_identity.get(natural, [])
        sku_match = by_sku.get(row["sku"])
        if sku_match and (sku_match["category_id"] != category
                          or identity(sku_match["size"], None, sku_match["finish"])
                          != identity(row["size"], None, row["finish"])):
            raise ValueError(f"Existing SKU belongs to a different variant: {row['sku']}.")
        if len(candidates) > 1 or (sku_match and candidates and candidates[0]["id"] != sku_match["id"]):
            raise ValueError(f"Multiple existing records match {row['sku']}.")
        item = sku_match or (candidates[0] if candidates else None)
        if item:
            row["sku"] = item["sku"]
            # Retain a separately recorded rate on a matching legacy product.
            if item.get("price") not in (None, item.get("mrp")):
                row["dealer_price"] = item["price"]
            matched[item["sku"]] = item
    if len({row["sku"] for row in rows}) != len(rows):
        raise ValueError("More than one source row resolved to the same SKU.")
    return brand, category_by_name, matched


def source_hashes(row):
    from PIL import Image
    from services.product_image_normalizer import normalize_product_image

    hashes = []
    for data_url in row["images"]:
        header, encoded = data_url.split(",", 1)
        body, _ = normalize_product_image(base64.b64decode(encoded, validate=True), header[5:].split(";", 1)[0])
        with Image.open(BytesIO(body)) as source_image:
            source_image.verify()
        hashes.append(hashlib.sha1(body).hexdigest())
    if not hashes or len(set(hashes)) != len(hashes):
        raise ValueError(f"Missing or repeated source image for {row['sku']}.")
    return hashes


async def verify(database, source_rows, *, public):
    import httpx

    brand, categories, matched = await scope(database, source_rows)
    if not brand or len(matched) != len(source_rows):
        raise ValueError(f"Only {len(matched)} of {len(source_rows)} BIANA variants are present.")
    ids = [item["id"] for item in matched.values()]
    media = await database.product_media.find({
        "floor_id": FLOOR, "brand_id": brand["id"], "product_id": {"$in": ids},
        "source_type": "supplier",
    }, {"_id": 0}).to_list()
    media_by_product = {}
    for image in media:
        media_by_product.setdefault(image["product_id"], []).append(image)
    urls = {}
    for row in source_rows:
        product = matched[row["sku"]]
        expected = {key: row[key] for key in ("name", "size", "finish", "finish_code", "mrp")}
        expected.update(category_id=categories[row["category"]]["id"], price=row.get("dealer_price", row["mrp"]), active=True)
        if any(product.get(key) != value for key, value in expected.items()):
            raise ValueError(f"Catalogue details differ for {row['sku']}.")
        hashes = source_hashes(row)
        assets = media_by_product.get(product["id"], [])
        actual = Counter(asset["sha1"] for asset in assets)
        if (any(actual[digest] != 1 for digest in hashes)
                or [asset["sha1"] for asset in assets if asset["is_primary"]] != hashes[:1]):
            raise ValueError(f"Supplier media differs for {row['sku']}.")
        for asset in assets:
            if asset["sha1"] in hashes:
                if not asset.get("public_url"):
                    raise ValueError(f"Missing public media URL for {row['sku']}.")
                urls[asset["public_url"]] = asset["sha1"]

    if public:
        limiter = asyncio.Semaphore(8)
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as web:
            async def check(url, digest):
                async with limiter:
                    response = await web.get(url)
                    response.raise_for_status()
                    if hashlib.sha1(response.content).hexdigest() != digest:
                        raise ValueError("A public BIANA image differs from its workbook asset.")
            await asyncio.gather(*(check(url, digest) for url, digest in urls.items()))
    return {"brand_id": brand["id"], "variants_verified": len(matched), "public_image_urls": len(urls),
            "supplier_image_associations": len(media), "public_bytes_verified": public}


async def run(args, rows, workbook):
    from db import db

    if db.name != args.database:
        raise ValueError("The configured database differs from the explicitly selected database.")
    if args.verify:
        print(json.dumps(await verify(db, rows, public=True)))
        return
    brand, _, matched = await scope(db, deepcopy(rows))
    print(json.dumps({"database": db.name, "floor": FLOOR, "brand_exists": bool(brand),
                      "existing_variant_matches": len(matched), "new_variants": len(rows) - len(matched)}))
    if not args.apply:
        return

    await apply(db, args.source.name, workbook, rows)


async def apply(db, filename, workbook, rows):
    from catalog_pipeline.orchestrator import _offload_row_images, import_accepted
    from media_storage.factory import get_media_storage, private_bucket
    from models import CatalogImportJob
    from pymongo.errors import DuplicateKeyError
    from routes.catalog_import_routes import _store_import_source

    for collection, fields in (
        (db.brands, {"floor_id", "slug"}),
        (db.categories, {"floor_id", "slug"}),
        (db.products, {"floor_id", "brand_id", "sku"}),
    ):
        indexes = await collection.index_information()
        if not any(index.get("unique") and set(dict(index["key"])) == fields for index in indexes.values()):
            raise ValueError(f"Expected the existing unique catalogue scope index on {collection.name}.")
    for row in rows:
        source_hashes(row)
    await get_media_storage().require_private_bucket(private_bucket())

    # Serialize this catalogue migration across machines. If the operator was
    # killed, verify it has stopped before removing this scoped lock document.
    lock = {"_id": "biana:first-floor", "owner": str(uuid4())}
    try:
        await db.schema_migration_locks.insert_one({**lock, "started_at": datetime.now(timezone.utc)})
    except DuplicateKeyError:
        raise ValueError("A Sanitary BIANA import holds the migration lock.") from None
    try:
        brand, categories, _ = await scope(db, rows)
        supplier = brand["name"] if brand else SUPPLIER
        staged = deepcopy(rows)
        source = await _store_import_source(SUPPLIER, filename, workbook)
        await _offload_row_images(staged)
        job = CatalogImportJob(
            filename=filename, source_type="excel", supplier_name=supplier, floor_id=FLOOR,
            created_by=ACTOR, total_rows=len(rows), accepted_rows=len(rows), rows=staged,
            status="reviewed", **source,
        ).model_dump()
        await db.catalog_imports.insert_one(dict(job))
        try:
            result = await import_accepted(
                job, ACTOR, floor_id=FLOOR, category_docs=list(categories.values()),
                supplier_asset_scope=f"{FLOOR}-workbook-assets",
            )
            print(json.dumps({"job_id": job["id"], **{k: v for k, v in result.items() if k != "attempted_row_ids"}}))
            if result["failed"] or result["skipped"]:
                raise ValueError("BIANA import was incomplete. Review the row errors before retrying.")
            evidence = await verify(db, rows, public=True)
        except Exception as exc:
            await db.catalog_imports.update_one({"id": job["id"]}, {"$set": {"status": "failed", "error": str(exc)}})
            raise
        await db.catalog_imports.update_one({"id": job["id"]}, {"$set": {"status": "imported"}})
        print(json.dumps(evidence))
    finally:
        await db.schema_migration_locks.delete_one(lock)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--database")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--apply", action="store_true")
    action.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if (args.apply or args.verify) and not args.database:
        parser.error("--apply and --verify require the expected --database")
    workbook = args.source.read_bytes()
    rows = extract_rows(args.source)
    print(json.dumps({"source_sha256": hashlib.sha256(workbook).hexdigest(),
                      "families": Counter(row["category"] for row in rows),
                      "variants": len(rows), "with_images": sum(bool(row["images"]) for row in rows)}))
    if args.database:
        asyncio.run(run(args, rows, workbook))
