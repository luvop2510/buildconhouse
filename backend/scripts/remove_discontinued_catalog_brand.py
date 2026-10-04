"""Remove one explicitly named catalog brand and its owned photos.

This operator command is intentionally separate from startup migrations. It
never matches products by description, collection, family name or search text:
other brands can mention the removed brand and must remain unchanged. Shared
categories and financial/stock/history documents are preserved. Before-images
and photo bytes are saved in the ignored local backups directory before writes.
Run without --apply for a read-only plan.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import httpx
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bson import json_util
from db import client, db
from media_storage import get_media_storage, StorageError
from migrations.runner import pending_migrations


def string_values(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from string_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from string_values(item)


def fingerprint(doc):
    return hashlib.sha256(json_util.dumps(doc, sort_keys=True).encode()).hexdigest()


async def run(brand_name: str, apply: bool):
    brands = await db.brands.find({"name": {"$regex": f"^{re.escape(brand_name)}$", "$options": "i"}}).to_list(None)
    brand_ids = [row["id"] for row in brands]
    if not brand_ids:
        print(json.dumps({"brand_found": False, "products_removed": 0}), flush=True)
        return
    products = await db.products.find({"brand_id": {"$in": brand_ids}}).to_list(None)
    product_ids = [row["id"] for row in products]
    media = await db.product_media.find({"$or": [{"brand_id": {"$in": brand_ids}}, {"product_id": {"$in": product_ids}}]}).to_list(None)
    media = [row for row in media if not row.get("product_id") or row["product_id"] in set(product_ids)]
    media_ids = {row["id"] for row in media}
    all_media = await db.product_media.find({}, {"id": 1, "bucket": 1, "storage_key": 1}).to_list(None)
    other_products = await db.products.find({"brand_id": {"$nin": brand_ids}}).to_list(None)
    before_other = {row["id"]: fingerprint(row) for row in other_products}
    category_candidates = await db.categories.find({"brand_id": {"$in": brand_ids}}).to_list(None)
    categories = []
    for row in category_candidates:
        if not await db.products.count_documents({"category_id": row["id"], "brand_id": {"$nin": brand_ids}}):
            categories.append(row)
    protected = {(row.get("bucket"), row.get("storage_key")) for row in all_media if row["id"] not in media_ids}
    direct_references = {}
    for row in media:
        pair = (row["bucket"], row["storage_key"])
        direct_references[row["storage_key"]] = pair
        if row.get("public_url"):
            direct_references[row["public_url"]] = pair
    for product in other_products:
        for value in string_values(product):
            pair = direct_references.get(value.split("?", 1)[0])
            if pair:
                protected.add(pair)
    objects = {(row["bucket"], row["storage_key"]) for row in media if (row["bucket"], row["storage_key"]) not in protected}
    summary = {"brand_count": len(brands), "products": len(products), "media_rows": len(media), "exclusive_categories": len(categories), "photo_objects": len(objects), "shared_objects_preserved": len({(row["bucket"],row["storage_key"]) for row in media} & protected), "other_brand_products": len(before_other), "pending_migrations": await pending_migrations(db)}
    print(json.dumps(summary), flush=True)
    if not apply:
        return
    backup = Path(__file__).resolve().parents[1] / "backups" / ("catalog-removal-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    backup.mkdir(mode=0o700)
    os.chmod(backup, 0o700)
    for name, rows in [("brands", brands), ("products", products), ("product_media", media), ("categories", categories)]:
        path = backup / (name + ".json")
        path.write_text(json_util.dumps(rows))
        path.chmod(0o600)
    (backup / "other-product-fingerprints.json").write_text(json.dumps(before_other))
    (backup / "other-product-fingerprints.json").chmod(0o600)
    storage = get_media_storage()
    sem = asyncio.Semaphore(8)
    manifest = []
    async def save_object(bucket, key):
        async with sem:
            # Abort before database writes if an existing photo cannot be saved.
            for attempt in range(3):
                try:
                    data = await storage.download(bucket=bucket, key=key)
                    break
                except StorageError as exc:
                    if "[404]" in str(exc):
                        manifest.append({"bucket": bucket, "key": key, "already_missing": True})
                        return
                    if attempt == 2:
                        raise
                    await asyncio.sleep(attempt + 1)
                except httpx.HTTPError:
                    if attempt == 2:
                        raise
                    await asyncio.sleep(attempt + 1)
            digest = hashlib.sha256(data).hexdigest()
            path = backup / digest
            path.write_bytes(data)
            path.chmod(0o600)
            manifest.append({"bucket": bucket, "key": key, "backup": digest, "bytes": len(data)})
            if len(manifest) % 100 == 0:
                print(json.dumps({"photos_backed_up": len(manifest)}), flush=True)
    await asyncio.gather(*(save_object(b,k) for b,k in sorted(objects)))
    (backup / "objects.json").write_text(json.dumps(manifest))
    (backup / "objects.json").chmod(0o600)
    print(json.dumps({"backup_complete": True, "objects_backed_up": sum(not r.get('already_missing') for r in manifest)}), flush=True)
    async with await client.start_session() as session:
        async with session.start_transaction():
            # Brand ownership is rechecked inside the deletion transaction.
            current = await db.products.find({"brand_id": {"$in": brand_ids}}, session=session).to_list(None)
            current_media = await db.product_media.find({"$or": [{"brand_id": {"$in": brand_ids}}, {"product_id": {"$in": product_ids}}]}, session=session).to_list(None)
            if {row["id"]: fingerprint(row) for row in current} != {row["id"]: fingerprint(row) for row in products} or {row["id"]: fingerprint(row) for row in current_media} != {row["id"]: fingerprint(row) for row in media}:
                raise RuntimeError("Brand catalog changed during backup; rerun cleanup")
            await db.product_media.delete_many({"id": {"$in": list(media_ids)}}, session=session)
            await db.products.delete_many({"id": {"$in": product_ids}, "brand_id": {"$in": brand_ids}}, session=session)
            await db.categories.delete_many({"id": {"$in": [r['id'] for r in categories]}}, session=session)
            await db.brands.delete_many({"id": {"$in": brand_ids}}, session=session)
    async def delete_object(bucket, key):
        async with sem:
            if await db.product_media.count_documents({"bucket": bucket, "storage_key": key}):
                raise RuntimeError("New shared photo reference detected; retained object")
            for attempt in range(3):
                try:
                    await storage.delete(bucket=bucket, key=key)
                    if await storage.exists(bucket=bucket, key=key):
                        raise StorageError("Deleted photo is still present")
                    break
                except (httpx.HTTPError, StorageError):
                    if attempt == 2:
                        raise
                    await asyncio.sleep(attempt + 1)
    await asyncio.gather(*(delete_object(b,k) for b,k in sorted(objects)))
    after = await db.products.find({"brand_id": {"$nin": brand_ids}}).to_list(None)
    after_other = {row["id"]: fingerprint(row) for row in after}
    if before_other != after_other:
        raise RuntimeError("Other-brand catalog changed during cleanup; inspect fingerprints")
    result = {**summary, "applied": True, "remaining_brand_products": await db.products.count_documents({"brand_id": {"$in": brand_ids}}), "other_brands_unchanged": True, "deleted_photo_objects": len(objects)}
    (backup / "result.json").write_text(json.dumps(result))
    (backup / "result.json").chmod(0o600)
    print(json.dumps(result), flush=True)
    await storage.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("brand_name")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        asyncio.run(run(args.brand_name, args.apply))
    finally:
        client.close()
