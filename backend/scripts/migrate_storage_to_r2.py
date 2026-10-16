"""Copy Supabase objects to R2, verify bytes, then separately migrate public URLs.

Default is read-only inventory. This command never deletes source objects or
changes runtime configuration. Freeze application uploads/edits for the final
copy, reference plan and cutover. All manifests, archives and journals are private.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from bson import json_util
from scripts.media_object_snapshot import (filename, identity, key_ok, read_regular,
                                           safe_directory, write_private)
from scripts.verify_backup_source import source_fingerprint

FORMAT = "forge-r2-migration-v1"
MAX_BYTES = 8_000_000_000  # Headroom below 10 GB; account-wide usage still needs checking.
MAX_OBJECT_BYTES = 128 * 1024 * 1024
# Current application media references only; audit/import/session records are
# immutable evidence, even when they contain a historical public image URL.
REFERENCE_COLLECTIONS = frozenset({
    "products", "product_media", "godown_stock", "godown_stock_media",
    "quotations", "quotation_shares", "settings", "brands",
    "furniture_quotations", "purchase_orders",
})


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_record(path, value):
    write_private(path, json_util.dumps(value, json_options=json_util.CANONICAL_JSON_OPTIONS).encode())


def read_record(path):
    return json_util.loads(read_regular(path))


async def inventory(source, buckets, private_bucket):
    await source.require_private_bucket(private_bucket)
    rows, seen = [], set()
    for bucket in buckets:
        async for row in source.iter_objects(bucket=bucket):
            pair = identity(row)
            if pair[0] != bucket or pair in seen:
                raise ValueError("Invalid source inventory")
            if type(row.get("size_bytes")) is not int or not 0 <= row["size_bytes"] <= MAX_OBJECT_BYTES:
                raise ValueError("Object exceeds bounded migration size")
            seen.add(pair)
            rows.append(row)
    if sum(row["size_bytes"] for row in rows) > MAX_BYTES:
        raise ValueError("Migration exceeds storage safety budget")
    return sorted(rows, key=identity)


def binding(cfg):
    # Credential rotation must not change identity, but moving to a different
    # Mongo cluster/database must invalidate every inventory/reference plan.
    # Select the target identity consistently before and after driver cutover.
    fingerprint = source_fingerprint({
        "MONGO_URL": cfg.mongo_url, "DB_NAME": cfg.db_name,
        "MEDIA_STORAGE_DRIVER": "r2", "R2_ACCOUNT_ID": cfg.r2_account_id,
        "SUPABASE_PUBLIC_BUCKET": cfg.supabase_public_bucket,
        "SUPABASE_PRIVATE_BUCKET": cfg.supabase_private_bucket,
    })
    return {"source_fingerprint": fingerprint, "source": cfg.supabase_url, "account": cfg.r2_account_id,
            "public_url": cfg.r2_public_url,
            "buckets": [cfg.supabase_public_bucket, cfg.supabase_private_bucket]}


async def copy_objects(source, target, cfg, directory, *, source_budget_bytes=MAX_BYTES):
    safe_directory(directory)
    plan = read_record(directory / "inventory.json")
    if plan.get("format") != FORMAT or plan.get("binding") != binding(cfg):
        raise ValueError("Inventory belongs to a different migration")
    await target.ready()
    buckets = plan["binding"]["buckets"]
    current = await inventory(source, buckets, cfg.supabase_private_bucket)
    if plan["objects"] != current:
        raise ValueError("Source changed; create a fresh inventory")
    if type(source_budget_bytes) is not int or not 0 < source_budget_bytes <= MAX_BYTES:
        raise ValueError("Invalid source download budget")
    pending_bytes = sum(row["size_bytes"] for row in current
                        if not (directory / (filename(row) + ".receipt.json")).exists())
    if pending_bytes > source_budget_bytes:
        raise ValueError("Copy would exceed the confirmed source egress budget")
    existing_bytes = 0
    for bucket in buckets:
        async for row in target.iter_objects(bucket=bucket):
            existing_bytes += row["size_bytes"]
    # Conservative: includes duplicated existing keys to avoid understating use.
    if existing_bytes + sum(row["size_bytes"] for row in current) > MAX_BYTES:
        raise ValueError("Destination exceeds conservative storage safety budget")
    verified = []
    for row in current:
        bucket, key = identity(row)
        name = filename(row)
        local = directory / name
        receipt_path = directory / (name + ".receipt.json")
        if receipt_path.exists():
            receipt = read_record(receipt_path)
            data = read_regular(local)
            if receipt.get("source") != row or digest(data) != receipt.get("sha256") or len(data) != row["size_bytes"]:
                raise ValueError("Local archive receipt verification failed")
        else:
            data = await source.download(bucket=bucket, key=key)
            if len(data) != row["size_bytes"]:
                raise ValueError("Source size changed during download")
            if local.exists():
                if read_regular(local) != data:
                    raise ValueError("Existing local archive differs from source")
            else:
                write_private(local, data)
            write_record(receipt_path, {"source": row, "sha256": digest(data)})
        if not await target.exists(bucket=bucket, key=key):
            await target.upload(bucket=bucket, key=key, data=data,
                                content_type=row["content_type"], upsert=False)
        if digest(await target.download(bucket=bucket, key=key)) != digest(data):
            raise ValueError("R2 bytes differ; existing objects will not be overwritten")
        info = await target._call("head_object", Bucket=bucket, Key=key)
        if info.get("ContentLength") != len(data) or info.get("ContentType") != row["content_type"]:
            raise ValueError("R2 size or content type mismatch")
        if bucket == cfg.supabase_public_bucket:
            import httpx
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.get(target.get_public_url(bucket=bucket, key=key))
            if response.status_code != 200 or digest(response.content) != digest(data):
                raise ValueError("Public R2 delivery failed byte verification")
        verified.append({**row, "file": name, "sha256": digest(data)})
        if len(verified) % 100 == 0:
            print(json.dumps({"verified_objects": len(verified), "total_objects": len(current)}), flush=True)
    if await inventory(source, buckets, cfg.supabase_private_bucket) != current:
        raise ValueError("Source inventory changed during copy")
    result = {"format": FORMAT, "binding": binding(cfg), "copy_complete": True,
              "objects": verified, "object_count": len(verified),
              "total_bytes": sum(row["size_bytes"] for row in verified)}
    write_record(directory / "copy-complete.json", result)
    return result


def rewrite(value, cfg, verified):
    """Replace exact public object URL values, including nested quotation snapshots.

    Private signed URLs are never made public. Unrelated external links and
    text containing links are left intact. Missing referenced objects block.
    """
    if isinstance(value, str):
        prefix = f"{cfg.supabase_url}/storage/v1/object/public/{cfg.supabase_public_bucket}/"
        if not value.startswith(prefix):
            return value
        parsed = urlsplit(value)
        key = unquote(parsed.path[len(urlsplit(prefix).path):])
        if not key_ok(key) or (cfg.supabase_public_bucket, key) not in verified:
            raise ValueError("A database URL has no verified destination object")
        return cfg.r2_public_url.rstrip("/") + "/" + quote(key, safe="/")
    if isinstance(value, list):
        return [rewrite(item, cfg, verified) for item in value]
    if isinstance(value, dict):
        return {key: rewrite(item, cfg, verified) for key, item in value.items()}
    return value


async def plan_references(database, cfg, directory):
    safe_directory(directory)
    copied = read_record(directory / "copy-complete.json")
    if copied.get("format") != FORMAT or copied.get("copy_complete") is not True or copied.get("binding") != binding(cfg):
        raise ValueError("No matching completed copy")
    verified = set()
    for row in copied["objects"]:
        if digest(read_regular(directory / row["file"])) != row["sha256"]:
            raise ValueError("Local archive verification failed")
        verified.add(identity(row))
    changes = []
    cursor = await database.list_collections()
    async for collection in cursor:
        name = collection["name"]
        if name not in REFERENCE_COLLECTIONS or collection.get("type") == "view":
            continue
        async for doc in database[name].find({}).batch_size(200):
            before, after = {}, {}
            for field, value in doc.items():
                if field == "_id":
                    continue
                changed = rewrite(value, cfg, verified)
                if changed != value:
                    if field.startswith("$") or "." in field:
                        raise ValueError("Unsupported database field")
                    before[field], after[field] = value, changed
            if after:
                changes.append({"collection": name, "id": doc["_id"], "before": before, "after": after})
    plan = {"format": FORMAT, "binding": binding(cfg), "database": database.name,
            "copy_sha256": digest(read_regular(directory / "copy-complete.json")), "changes": changes}
    write_record(directory / "references.json", plan)
    return plan


async def apply_references(database, cfg, directory, *, rollback=False):
    safe_directory(directory)
    plan = read_record(directory / "references.json")
    if (plan.get("format") != FORMAT or plan.get("binding") != binding(cfg) or plan.get("database") != database.name
            or plan.get("copy_sha256") != digest(read_regular(directory / "copy-complete.json"))):
        raise ValueError("Reference plan identity mismatch")
    # Before/after values are durable before the first write. Each conditional
    # update preserves unrelated fields and refuses concurrent edits. Reruns and
    # rollback accept only exact pre/post states, including interrupted runs.
    if any(row.get("collection") not in REFERENCE_COLLECTIONS for row in plan["changes"]):
        # Validate the complete journal before the first mutation, in both
        # directions; never partially apply a plan containing historical rows.
        raise ValueError("Reference plan contains a protected collection")
    changes = list(reversed(plan["changes"])) if rollback else plan["changes"]
    for row in changes:
        old, new = (row["after"], row["before"]) if rollback else (row["before"], row["after"])
        collection = database[row["collection"]]
        result = await collection.update_one({"_id": row["id"], **old}, {"$set": new})
        if result.matched_count != 1 and not await collection.find_one({"_id": row["id"], **new}, {"_id": 1}):
            raise ValueError("Concurrent edit or removed record; inspect private journal")
    return len(changes)


async def verify_cutover(source, target, cfg, directory):
    """Recheck source stability and destination bytes immediately before link writes."""
    copied = read_record(directory / "copy-complete.json")
    if copied.get("copy_complete") is not True or copied.get("binding") != binding(cfg):
        raise ValueError("No matching completed copy")
    await target.ready()
    source_rows = await inventory(source, copied["binding"]["buckets"], cfg.supabase_private_bucket)
    expected = [{k: v for k, v in row.items() if k not in {"file", "sha256"}} for row in copied["objects"]]
    if expected != source_rows:
        raise ValueError("Source changed after copy; repeat migration with a fresh inventory")
    for row in copied["objects"]:
        data = await target.download(bucket=row["bucket"], key=row["key"])
        if digest(data) != row["sha256"]:
            raise ValueError("Destination changed after copy")


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["inventory", "copy", "plan-references", "apply-references", "rollback-references"])
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--confirm-database", help="Required for database writes; exact DB_NAME")
    parser.add_argument("--source-budget-bytes", type=int,
                        help="Required for copy: remaining Supabase egress allowance minus safety headroom")
    args = parser.parse_args()
    from settings import settings, load_settings
    from media_storage.supabase_driver import SupabaseStorageDriver
    directory = args.directory.resolve()
    if args.command == "inventory":
        source = SupabaseStorageDriver()
        try:
            rows = await inventory(source, [settings.supabase_public_bucket, settings.supabase_private_bucket],
                                   settings.supabase_private_bucket)
            directory.mkdir(mode=0o700, parents=False, exist_ok=False)
            write_record(directory / "inventory.json", {"format": FORMAT, "binding": binding(settings), "objects": rows})
            print(json.dumps({"inventory_complete": True, "objects": len(rows),
                              "bytes": sum(row["size_bytes"] for row in rows)}))
        finally:
            await source.close()
        return
    # Explicit target validation, without changing the running application's driver.
    cfg = load_settings({**os.environ, "MEDIA_STORAGE_DRIVER": "r2"}, load_local_fallback=False)
    safe_directory(directory)
    if args.command == "copy":
        if args.source_budget_bytes is None:
            raise ValueError("Copy requires an explicit source egress budget")
        from media_storage.r2_driver import R2StorageDriver
        source, target = SupabaseStorageDriver(), R2StorageDriver(cfg=cfg)
        try:
            result = await copy_objects(source, target, cfg, directory, source_budget_bytes=args.source_budget_bytes)
            print(json.dumps({"copy_complete": True, "objects": result["object_count"], "bytes": result["total_bytes"]}))
        finally:
            await source.close()
            await target.close()
    else:
        from motor.motor_asyncio import AsyncIOMotorClient
        client = AsyncIOMotorClient(cfg.mongo_url, serverSelectionTimeoutMS=10000)
        try:
            database = client[cfg.db_name]
            if args.command == "plan-references":
                plan = await plan_references(database, cfg, directory)
                print(json.dumps({"reference_plan_complete": True, "documents": len(plan["changes"])}))
            else:
                if args.confirm_database != cfg.db_name:
                    raise ValueError("Exact database confirmation required")
                if args.command == "apply-references":
                    from media_storage.r2_driver import R2StorageDriver
                    source, target = SupabaseStorageDriver(), R2StorageDriver(cfg=cfg)
                    try:
                        await verify_cutover(source, target, cfg, directory)
                    finally:
                        await source.close()
                        await target.close()
                count = await apply_references(database, cfg, directory,
                                               rollback=args.command == "rollback-references")
                print(json.dumps({"references_complete": True, "documents": count,
                                  "rollback": args.command == "rollback-references"}))
        finally:
            client.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(json.dumps({"complete": False, "exception_type": type(exc).__name__}), file=sys.stderr)
        raise SystemExit(1) from None
