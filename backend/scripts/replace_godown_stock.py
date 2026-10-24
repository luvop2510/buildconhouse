"""Backup-first transactional warehouse workbook replacement.

Dry-run by default. Apply requires reviewed manifest SHA256, stock SHA256,
database name, and source byte verification. Existing lots are only archived;
their quantities, allocations, customer/order history and payments are preserved.
Images are staged idempotently before the stock transaction; failed applies can
leave registered immutable media for retry, but cannot expose half-replaced stock.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import mimetypes
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.godown_workbook_intake import fingerprint, identity  # noqa: E402


class ImportConflict(ValueError):
    pass


def clean(row):
    return {k: v for k, v in row.items() if k != "_id"}


def stock_fingerprint(rows):
    return fingerprint(sorted([clean(row) for row in rows], key=lambda row: row["id"]))


def private_json(path, payload):
    from bson import json_util
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(json_util.dumps(payload, indent=2, ensure_ascii=False))
        stream.flush()
        os.fsync(stream.fileno())


def validate_manifest(manifest):
    if manifest.get("version") != 1 or manifest.get("floor_id") != "first-floor":
        raise ImportConflict("Only first-floor manifest version 1 is supported")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", str(manifest.get("batch_id") or "")) or not manifest.get("actor_id"):
        raise ImportConflict("Stable batch and actor identities are required")
    if not re.fullmatch(r"[a-f0-9]{64}", manifest.get("expected_stock_sha256", "")):
        raise ImportConflict("Reviewed stock fingerprint is required")
    lots = manifest.get("lots")
    if not isinstance(lots, list) or not 1 <= len(lots) <= 2000:
        raise ImportConflict("Manifest needs between 1 and 2000 lots")
    ids = set()
    new_products = {r["id"]: r for r in manifest.get("new_products", [])}
    if len(new_products) != len(manifest.get("new_products", [])):
        raise ImportConflict("Duplicate new product identity")
    for row in lots:
        if row.get("floor_id") != "first-floor" or row.get("source_type") != "warehouse_import" or row.get("import_batch_id") != manifest["batch_id"] or row.get("archived") is not False:
            raise ImportConflict("Lot floor, source, batch or archive state is invalid")
        if not row.get("id") or row["id"] in ids or not row.get("product_id") or not row.get("source_provenance"):
            raise ImportConflict("Lot identity/provenance must be unique and present")
        ids.add(row["id"])
        for key in ("qty_received", "available_qty"):
            value = row.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ImportConflict("Lot quantities must be finite and nonnegative")
        if row["qty_received"] != row["available_qty"] or row.get("allocations") != []:
            raise ImportConflict("New import lots may not have prior allocations")
        if not isinstance(row.get("quantity_missing"), bool) or row["quantity_missing"] and row["available_qty"] != 0:
            raise ImportConflict("Unknown quantity must retain its zero technical placeholder and flag")
        for key in ("mrp", "unit_price"):
            value = row.get(key)
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0):
                raise ImportConflict("Lot prices must be null or finite and nonnegative")
        if row.get("brand_name") == "Duravit" and (row.get("mrp") is not None or row.get("unit_price") is not None):
            raise ImportConflict("Duravit prices must stay unspecified for later user entry")
        if row["product_id"].startswith("godown:") and row["product_id"] != f"godown:{row['id']}":
            raise ImportConflict("Stock-only product identity must refer to its own lot")
        image = row.get("image")
        if image and (not image.startswith("https://") or "@" in image.split("/", 3)[2]):
            raise ImportConflict("Image must use credential-free public HTTPS")
    for row in manifest.get("new_products", []):
        if row.get("floor_id") != "first-floor" or row.get("price_status") != "unspecified" or row.get("mrp") != 0 or row.get("price") != 0:
            raise ImportConflict("New Duravit catalog records need explicit unspecified price status")


def verify_source_files(manifest):
    root = Path(manifest["source_root"])
    for source in [*manifest["source_files"], *manifest.get("catalog_source_files", [])]:
        path = root / source["file"]
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != source["sha256"]:
            raise ImportConflict("Stock workbook differs from reviewed bytes")
    for row in manifest["lots"]:
        image = row.get("image_local")
        if image:
            path = Path(image["path"])
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != image["sha256"]:
                raise ImportConflict("Local source image differs from reviewed bytes")


async def prepare_plan(database, manifest, manifest_sha, *, session=None):
    validate_manifest(manifest)
    receipt_id = identity("receipt", manifest["batch_id"])
    receipt = await database.event_outbox.find_one({"id": receipt_id}, session=session)
    if receipt:
        if receipt.get("manifest_sha256") != manifest_sha or receipt.get("status") != "completed":
            raise ImportConflict("Batch identity already belongs to another manifest")
        rows = await database.godown_stock.find({"id": {"$in": receipt["stock_ids"]}, "floor_id": "first-floor", "import_batch_id": manifest["batch_id"]}, session=session).to_list(None)
        if {r["id"] for r in rows} != set(receipt["stock_ids"]):
            raise ImportConflict("Applied batch lot missing; refusing partial replay")
        return {"already_applied": True, "receipt": receipt}
    active = await database.godown_stock.find({"floor_id": "first-floor", "archived": {"$ne": True}}, session=session).to_list(None)
    if stock_fingerprint(active) != manifest["expected_stock_sha256"] or sorted(r["id"] for r in active) != manifest["expected_stock_ids"]:
        raise ImportConflict("Existing stock changed after review; regenerate manifest")
    if any(float(row.get("loaned_out_qty") or 0) > 0 for row in active):
        raise ImportConflict("Outstanding stock loans must be reconciled before replacement")
    actor = await database.users.find_one({"id": manifest["actor_id"], "active": {"$ne": False}}, session=session)
    if not actor or actor.get("role") != "owner":
        raise ImportConflict("An active owner must execute stock replacement")
    for row in manifest.get("new_brands", []):
        if row.get("floor_id") != "first-floor" or row.get("slug") != "duravit":
            raise ImportConflict("Only new first-floor Duravit brand is supported")
        if await database.brands.find_one({"$or": [{"id": row["id"]}, {"slug": row["slug"]}]}, session=session):
            raise ImportConflict("New brand identity/slug already exists outside batch")
    new_ids = {r["id"] for r in manifest.get("new_products", [])}
    new_brand_ids = {r["id"] for r in manifest.get("new_brands", [])}
    categories = {r["id"] for r in await database.categories.find({"floor_id": "first-floor"}, session=session).to_list(None)}
    brands = {r["id"] for r in await database.brands.find({"floor_id": "first-floor"}, session=session).to_list(None)} | new_brand_ids
    products = await database.products.find({"floor_id": "first-floor"}, projection={"id": 1, "sku": 1, "brand_id": 1, "category_id": 1, "floor_id": 1, "active": 1}, session=session).to_list(None)
    by_id = {r["id"]: r for r in products}
    by_sku = {(r["brand_id"], r["sku"]) for r in products}
    for product in manifest.get("new_products", []):
        if product["id"] in by_id or (product["brand_id"], product["sku"]) in by_sku:
            raise ImportConflict("New product identity/SKU already exists outside batch")
        if product["category_id"] not in categories or product["brand_id"] not in brands:
            raise ImportConflict("New product category/brand is not first-floor")
    for lot in manifest["lots"]:
        if not lot["product_id"].startswith("godown:") and lot["product_id"] not in new_ids:
            product = by_id.get(lot["product_id"])
            if not product or not product.get("active", True) or product["brand_id"] != lot["brand_id"]:
                raise ImportConflict("Matched catalog product disappeared or changed brand/floor")
    collisions = await database.godown_stock.find({"id": {"$in": [r["id"] for r in manifest["lots"]]}}, session=session).to_list(None)
    if collisions:
        raise ImportConflict("New lot identity already exists outside batch")
    return {"already_applied": False, "old_rows": active, "actor_name": actor.get("full_name", "Owner"), "stock_sha256": stock_fingerprint(active)}


async def backup_before_apply(database, output_dir):
    snapshot = {"database": database.name, "created_at": datetime.now(timezone.utc).isoformat(), "collections": {}}
    for name in ("godown_stock", "godown_customer_transfers", "godown_stock_media", "brands", "categories", "products", "product_media", "event_outbox"):
        snapshot["collections"][name] = await database[name].find({"floor_id": "first-floor"}).batch_size(50).to_list(None)
    path = output_dir / f"before-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}.json"
    private_json(path, snapshot)
    return path


async def stage_media(manifest):
    from services.godown_media_service import upload_stock_photo
    result = {}
    limit = asyncio.Semaphore(4)
    async def stage(lot):
        local = lot.get("image_local")
        if local:
            path = Path(local["path"])
            async with limit:
                result[lot["id"]] = await upload_stock_photo(data=path.read_bytes(), mime=mimetypes.guess_type(path.name)[0] or "image/png", lot=lot, actor_id=manifest["actor_id"])
    await asyncio.gather(*(stage(lot) for lot in manifest["lots"]))
    return result


async def apply_plan(database, mongo_client, manifest, manifest_sha, output_dir):
    plan = await prepare_plan(database, manifest, manifest_sha)
    if plan["already_applied"]:
        return {"already_applied": True, "lots": len(manifest["lots"])}
    backup = await backup_before_apply(database, output_dir)
    staged = await stage_media(manifest)
    async with await mongo_client.start_session() as session:
        async with session.start_transaction():
            current = await prepare_plan(database, manifest, manifest_sha, session=session)
            if current["already_applied"]:
                return {"already_applied": True, "lots": len(manifest["lots"])}
            if current["stock_sha256"] != plan["stock_sha256"]:
                raise ImportConflict("Stock changed while backing up/staging media")
            now = datetime.now(timezone.utc).isoformat()
            for old in current["old_rows"]:
                # Do not rewrite quantity or linked order/customer provenance.
                result = await database.godown_stock.update_one({"id": old["id"], "floor_id": "first-floor", "archived": {"$ne": True}}, {"$set": {"archived": True}}, session=session)
                if result.modified_count != 1:
                    raise ImportConflict("Old stock archive lost a concurrent race")
            for collection, field in (("brands", "new_brands"), ("products", "new_products")):
                documents = []
                for raw in manifest.get(field, []):
                    document = {**raw, "created_at": now, "updated_at": now}
                    if collection == "products":
                        matching = next((l for l in manifest["lots"] if l["product_id"] == raw["id"] and l["id"] in staged), None)
                        if matching:
                            document["images"] = [staged[matching["id"]]["public_url"]]
                    from models import Brand, Product
                    document = Product(**document).model_dump() if collection == "products" else Brand(**document).model_dump()
                    if collection == "products":
                        # Catalog snapshots read this explicit price marker;
                        # Product's numeric defaults alone must not assert ₹0.
                        document["price_status"] = raw["price_status"]
                    documents.append({"_id": raw["id"], **document})
                if documents:
                    await database[collection].insert_many(documents, session=session)
            documents = []
            for raw in manifest["lots"]:
                lot = {k: v for k, v in raw.items() if k != "image_local"}
                lot.update(created_at=now, updated_at=now, transferred_at=now, transferred_by=manifest["actor_id"], transferred_by_name=current["actor_name"])
                if raw["id"] in staged:
                    lot["image"] = staged[raw["id"]]["public_url"]
                    lot["image_media_id"] = staged[raw["id"]]["id"]
                documents.append({"_id": lot["id"], **lot})
            await database.godown_stock.insert_many(documents, session=session)
            receipt = {"id": identity("receipt", manifest["batch_id"]), "event_type": "GodownWorkbookReplacement", "idempotency_key": f"godown-workbook:{manifest['batch_id']}", "status": "completed", "manifest_sha256": manifest_sha, "floor_id": "first-floor", "created_at": now, "actor_id": manifest["actor_id"], "stock_ids": [r["id"] for r in manifest["lots"]], "archived_stock_ids": manifest["expected_stock_ids"], "previous_stock_sha256": plan["stock_sha256"], "new_product_ids": [r["id"] for r in manifest.get("new_products", [])], "summary": manifest.get("summary")}
            await database.event_outbox.insert_one({"_id": receipt["id"], **receipt}, session=session)
    private_json(output_dir / f"receipt-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}.json", receipt)
    return {"already_applied": False, "lots": len(manifest["lots"]), "archived": len(manifest["expected_stock_ids"]), "new_products": len(manifest.get("new_products", [])), "staged_images": len(staged), "backup": str(backup)}


async def run(args):
    from db import client, db
    raw = args.manifest.read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    manifest = json.loads(raw)
    validate_manifest(manifest)
    verify_source_files(manifest)
    if args.expected_database and db.name != args.expected_database:
        raise ImportConflict("Configured database does not match expected database")
    if args.apply:
        if args.expected_database != db.name or args.expected_manifest_sha256 != sha or args.expected_stock_sha256 != manifest["expected_stock_sha256"]:
            raise ImportConflict("Apply requires exact database, manifest SHA256 and stock SHA256")
        return await apply_plan(db, client, manifest, sha, args.output_dir)
    plan = await prepare_plan(db, manifest, sha)
    return {"dry_run": True, "already_applied": plan["already_applied"], "manifest_sha256": sha, "stock_sha256": manifest["expected_stock_sha256"], "summary": manifest["summary"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--expected-database")
    parser.add_argument("--expected-manifest-sha256")
    parser.add_argument("--expected-stock-sha256")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(asyncio.run(run(args)), indent=2))
    except ImportConflict as exc:
        parser.exit(2, f"Stock import rejected: {exc}\n")


if __name__ == "__main__":
    main()
