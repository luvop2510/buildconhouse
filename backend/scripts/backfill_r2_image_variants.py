"""Generate public R2 display copies without rewriting originals or Mongo rows.

Defaults to measuring one page without writes. Run from backend with the
production R2 environment, --apply to publish, and --after from the previous
JSON report to resume. No application bootstrap or migration runner is imported.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.product_image_variants import MIN_BYTES, create_image_variants, variant_key


async def backfill_page(db, storage, *, bucket, collection, after="", limit=100, apply=False):
    if collection not in {"product_media", "godown_stock_media"} or not 1 <= limit <= 500:
        raise ValueError("Choose a registered public image collection and limit 1–500")
    query = {"bucket": bucket, "mime": {"$in": ["image/png", "image/jpeg", "image/webp"]},
             "size_bytes": {"$gte": MIN_BYTES}, "storage_key": {"$gt": after, "$not": {"$regex": "^_image_variants/"}}}
    pipeline = [{"$match": query}, {"$group": {"_id": "$storage_key", "mime": {"$first": "$mime"},
        "sha1": {"$first": "$sha1"}, "sha256": {"$first": "$sha256"}}}, {"$sort": {"_id": 1}}, {"$limit": limit}]
    rows = await db[collection].aggregate(pipeline).to_list(limit)
    report = {"collection": collection, "apply": apply, "processed": 0, "uploaded": 0,
              "existing": 0, "skipped": 0, "source_bytes": 0, "display_320_bytes": 0, "after": after, "has_more": len(rows) == limit}
    for row in rows:
        key = row["_id"]
        data = await storage.download(bucket=bucket, key=key)
        # Fail closed on stale metadata instead of rendering a different source.
        for algorithm in ("sha1", "sha256"):
            if row.get(algorithm) and hashlib.new(algorithm, data).hexdigest() != row[algorithm]:
                raise ValueError("Original image checksum differs from registered metadata")
        variants = await asyncio.to_thread(create_image_variants, data, row["mime"])
        report["processed"] += 1; report["source_bytes"] += len(data)
        report["display_320_bytes"] += len(variants.get(320, data))
        if not variants: report["skipped"] += 1
        if apply:
            # One object at a time bounds CPU, memory and storage round trips.
            for width, encoded in variants.items():
                target = variant_key(key, width)
                if await storage.exists(bucket=bucket, key=target):
                    report["existing"] += 1; continue
                await storage.upload(bucket=bucket, key=target, data=encoded, content_type="image/webp", upsert=False)
                report["uploaded"] += 1
        report["after"] = key
    return report


async def main(args):
    from motor.motor_asyncio import AsyncIOMotorClient
    from settings import settings
    from media_storage.r2_driver import R2StorageDriver
    if settings.media_storage_driver != "r2":
        raise ValueError("This command requires the configured Cloudflare R2 store")
    client = AsyncIOMotorClient(settings.mongo_url, serverSelectionTimeoutMS=8000, socketTimeoutMS=15000)
    storage = R2StorageDriver()
    try:
        report = await backfill_page(client[settings.db_name], storage, bucket=settings.supabase_public_bucket,
            collection=args.collection, after=args.after, limit=args.limit, apply=args.apply)
        Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))
    finally:
        await storage.close(); client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--collection", choices=["product_media", "godown_stock_media"], default="product_media")
    parser.add_argument("--after", default="")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--report", default="r2-image-variant-report.json")
    args = parser.parse_args()
    try:
        asyncio.run(main(args))
    except Exception as error:
        print(f"R2 image backfill failed ({type(error).__name__}); original images are unchanged", file=sys.stderr)
        raise SystemExit(1)
