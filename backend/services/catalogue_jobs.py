"""Resumable catalogue uploads, previews, and guarded application of reviewed rows."""
from __future__ import annotations

import asyncio
from collections import Counter
from datetime import datetime, timedelta, timezone
from hashlib import sha1, sha256
import json
import logging
import math
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from uuid import uuid4

from fastapi import HTTPException
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from catalog_pipeline.isolated_parser import _stop_parser
from catalog_policy import removed_brand_document
from db import db
from media_storage import get_media_storage
from media_storage.factory import private_bucket, public_bucket
from models import Product, ProductMedia, now_iso
from services import catalog_service
from services.catalogue_changes import (
    LISTING_FIELDS, MATCH_FIELDS, applicable_categories, before_values, effective_mrp, get_or_create_brand, get_or_create_category,
    matching_products, new_product, preview_rows, resolve_reviewed_tile_identities, save_preview, scoped_brand,
)
from services.catalogue_permissions import OPERATION_PERMISSIONS, require_capabilities
from services.mutation_admission import AdmissionBusy, AdmissionUnavailable, admission, finish_on_cancel
from services.mutation_scopes import CATALOG

logger = logging.getLogger("forge.catalogue_management")
PART_BYTES = 512 * 1024
LEASE = timedelta(minutes=6)
UPLOAD_TTL = timedelta(days=2)
WORK_PHASES = ("queued", "applying", "rolling_back")
_jobs = {}
_worker = asyncio.Semaphore(1)


def now():
    return datetime.now(timezone.utc)


def number_of_parts(job: dict) -> int:
    return math.ceil(job["size_bytes"] / PART_BYTES)


def part_id(job: dict, index: int) -> str:
    return f"{job['_id']}:{index}"


async def store_part(job: dict, index: int, data: bytes) -> None:
    if not 0 <= index < number_of_parts(job):
        raise HTTPException(422, "File part is outside the upload.")
    expected = min(PART_BYTES, job["size_bytes"] - index * PART_BYTES)
    if len(data) != expected:
        raise HTTPException(422, "File part has the wrong length.")
    identifier = part_id(job, index)
    digest = sha256(data).hexdigest()
    try:
        await db.catalogue_import_parts.insert_one({
            "_id": identifier, "job_id": job["_id"], "index": index, "data": data,
            "sha256": digest, "expires_at": now() + UPLOAD_TTL,
        })
    except DuplicateKeyError:
        existing = await db.catalogue_import_parts.find_one({"_id": identifier}, {"sha256": 1})
        if not existing or existing["sha256"] != digest:
            raise HTTPException(409, "This file part was already uploaded with different contents.")


async def _assemble(job: dict, destination: Path) -> str:
    digest = sha256()
    with destination.open("wb") as target:
        for index in range(number_of_parts(job)):
            part = await db.catalogue_import_parts.find_one({"_id": part_id(job, index)}, {"data": 1})
            if not part:
                raise ValueError("An uploaded file part has expired. Start a new upload.")
            target.write(part["data"])
            digest.update(part["data"])
    return digest.hexdigest()


async def _extract(job: dict, directory: Path) -> dict:
    source = directory / ("source" + Path(job["filename"]).suffix.lower())
    source_hash = await _assemble(job, source)
    settings = {key: job[key] for key in ("floor_id", "operation", "sheet", "physical_pages", "printed_pages") if job.get(key)}
    settings.update(source=source.name, brand=job["brand_name"],
                    include_images=job["operation"] != "prices")
    (directory / "input.json").write_text(json.dumps(settings))
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "catalog_pipeline.self_service_worker", str(directory),
        cwd=str(Path(__file__).resolve().parents[1]), start_new_session=os.name == "posix",
        env={**{key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR") if key in os.environ},
             "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"},
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        await asyncio.wait_for(process.wait(), 240)
    except TimeoutError:
        raise ValueError("File processing timed out. Select fewer sheets or pages.") from None
    finally:
        await _stop_parser(process)
    result_file = directory / "result.json"
    if process.returncode or not result_file.is_file() or result_file.stat().st_size > 40 * 1024 * 1024:
        raise ValueError("The file exceeded the processing budget. Try fewer sheets or pages.")
    result = await asyncio.to_thread(lambda: json.loads(result_file.read_bytes()))
    if result.get("error"):
        raise ValueError(result["error"])
    result["source_sha256"] = source_hash
    return result


async def _stage_media(directory: Path, images: dict, used: set[str]) -> dict:
    if not used:
        return {}
    storage = get_media_storage()
    bucket = private_bucket()
    stored = {}
    for digest in sorted(used):
        metadata = images[digest]
        data = (directory / digest).read_bytes()
        if sha256(data).hexdigest() != digest:
            raise ValueError("An extracted image failed its integrity check.")
        key = _asset_key(digest, metadata["mime"])
        if not await storage.exists(bucket=bucket, key=key):
            await storage.upload(bucket=bucket, key=key, data=data, content_type=metadata["mime"])
        stored[digest] = {**metadata, "digest": digest, "storage_key": key,
                          "size_bytes": len(data), "sha1": sha1(data).hexdigest()}
    return stored


def _asset_key(digest: str, mime: str) -> str:
    extension = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[mime]
    return f"catalogue-management/{digest[:2]}/{digest}.{extension}"


async def _audit_image_rows(job: dict, changes: list[dict], rows: list[dict], products: dict, images: dict) -> None:
    if job["operation"] not in {"images", "update", "sync"}:
        return
    ready = [row for row in changes if row["action"] in {"image", "update"} and row["image_hashes"]]
    if not ready:
        return
    storage = get_media_storage()
    bucket = public_bucket()
    registered = set()
    for start in range(0, len(ready), 250):
        chunk = ready[start:start + 250]
        async for asset in db.product_media.find({"floor_id": job["floor_id"], "product_id": {"$in": [r["product_id"] for r in chunk]}},
                {"product_id": 1, "storage_key": 1, "bucket": 1}):
            if asset.get("bucket") == bucket:
                registered.add((asset["product_id"], asset["storage_key"]))
    checked = {}
    for row in ready:
        source = rows[row["index"]]
        product = products[row["sku"]]
        roles = source.get("image_roles") or {}
        keys = {digest: _asset_key(digest, images[digest]["mime"]) for digest in row["image_hashes"]}
        photo = next((key for digest, key in keys.items() if roles.get(digest) != "dimension"), None)
        present = set(product.get("dimension_image_urls") or [])
        already_linked = (
            (not photo or photo == product.get("catalogue_image_key"))
            and all(storage.get_public_url(bucket=bucket, key=key) in present
                    for digest, key in keys.items() if roles.get(digest) == "dimension")
            and all((product["id"], key) in registered for key in keys.values())
        )
        if already_linked:
            for key in keys.values():
                if key not in checked:
                    checked[key] = await storage.exists(bucket=bucket, key=key)
            if all(checked[key] for key in keys.values()):
                row["image_hashes"] = []
                if not row["delta"] and not row.get("category"):
                    row["action"] = "unchanged"


async def _publish_media(assets: list[dict]) -> list[dict]:
    storage = get_media_storage()
    bucket = public_bucket()
    published = []
    for asset in assets:
        key = asset["storage_key"]
        if await storage.exists(bucket=bucket, key=key):
            url = storage.get_public_url(bucket=bucket, key=key)
        else:
            data = await storage.download(bucket=private_bucket(), key=key)
            if sha256(data).hexdigest() != asset["digest"]:
                raise ValueError("An imported image failed its integrity check.")
            uploaded = await storage.upload(bucket=bucket, key=key, data=data, content_type=asset["mime"])
            url = uploaded.public_url
        if not url:
            raise ValueError("Image storage did not return a catalogue URL.")
        published.append({**asset, "bucket": bucket, "public_url": url})
    return published


async def _preview(job: dict, selector: dict, grants: set[str]) -> dict:
    floor_id = job["floor_id"]
    brand = await scoped_brand(db, floor_id, brand_id=job.get("brand_id"), name=job["brand_name"])
    if brand and removed_brand_document(brand):
        raise ValueError("This brand is no longer distributed.")
    if brand and not job.get("brand_id") and brand["name"].casefold() != job["brand_name"].casefold():
        raise ValueError("A different brand already uses this name or slug.")
    if not brand and (not job.get("create_brand") or "catalogue_brands" not in grants):
        raise ValueError("The selected brand is unavailable in this department.")
    with TemporaryDirectory(prefix="buildcon-catalogue-") as temporary:
        directory = Path(temporary)
        result = await _extract(job, directory)
        await db.catalogue_imports.update_one(selector, {"$set": {"stage": "validating", "lease_until": now() + LEASE}})
        rows = result["rows"]
        if brand and floor_id == "ground-floor" and job["operation"] != "prices":
            await resolve_reviewed_tile_identities(db, floor_id, brand["id"], rows)
        skus = sorted({row["sku"] for row in rows if row["sku"]})
        existing = await matching_products(db, floor_id, brand["id"], skus, job["operation"]) if brand else {}
        categories = await applicable_categories(db, floor_id, brand["id"] if brand else None)
        preview_id = job["claim"]
        changes = preview_rows({**job, "_id": f"{job['_id']}:{preview_id}"}, rows, existing, categories, grants)
        await _audit_image_rows(job, changes, rows, existing, result["images"])
        allowed = [row for row in changes if row["action"] not in {"rejected", "unchanged"}]
        if any(row["image_hashes"] for row in allowed):
            await db.catalogue_imports.update_one(selector, {"$set": {"stage": "processing_images", "lease_until": now() + LEASE}})
        staged = await _stage_media(directory, result["images"], {digest for row in allowed for digest in row["image_hashes"]})
        for row, source in zip(changes, rows, strict=True):
            row.update(job_id=job["_id"], preview_id=preview_id)
            hashes = row.pop("image_hashes")
            row["assets"] = [{**staged[digest], "role": source.get("image_roles", {}).get(digest, "hero")}
                             for digest in hashes if row["action"] not in {"rejected", "unchanged"}]
        await save_preview(db, changes)
    missing = []
    missing_total = 0
    if job["operation"] == "sync" and brand:
        missing_filter = {"floor_id": floor_id, "brand_id": brand["id"], "active": {"$ne": False}, "sku": {"$nin": skus}}
        missing_total = await db.products.count_documents(missing_filter)
        cursor = db.products.find(missing_filter, {"_id": 0, "sku": 1}).sort("sku", 1).limit(10000)
        missing = [product["sku"] async for product in cursor]
    return {
        "status": "preview", "stage": "ready", "preview_id": preview_id,
        "brand_id": brand["id"] if brand else None, "warnings": result["warnings"],
        "source_sha256": result["source_sha256"], "categories_to_create": len({
            row["category"]["name"] for row in allowed if row.get("category") and not row["category"].get("id")
        }),
        "summary": dict(Counter(row["action"] for row in changes)),
        "assets_to_attach": sum(len(row["assets"]) for row in allowed),
        "missing_from_source": missing, "missing_from_source_total": missing_total,
    }


async def _with_transaction(action):
    async with await db.client.start_session() as session:
        return await session.with_transaction(action)


async def _fence(selector: dict, session) -> None:
    updated = await db.catalogue_imports.update_one(selector, {"$set": {"lease_until": now() + LEASE}}, session=session)
    if not updated.matched_count:
        raise RuntimeError("Catalogue job claim is no longer current.")


async def _add_assets(row: dict, product: dict, job: dict, session) -> tuple[list[str], dict]:
    created_ids = []
    dimensions = []
    hero_key = None
    for index, asset in enumerate(row.get("assets", [])):
        role = asset["role"]
        if role == "dimension":
            dimensions.append(asset["public_url"])
            primary = False
        else:
            primary = hero_key is None
            if primary:
                hero_key = asset["storage_key"]
            role = "hero" if primary else "gallery"
        match = {"product_id": product["id"], "floor_id": job["floor_id"], "source_type": "supplier",
                 "sha1": asset["sha1"], "storage_key": asset["storage_key"], "role": role}
        if await db.product_media.find_one(match, {"id": 1}, session=session):
            continue
        metadata = ProductMedia(
            **{**asset, **match},
            brand_id=product["brand_id"], family_key=product.get("family_key"),
            is_primary=primary, sort_order=index * 10, uploaded_by=job["created_by"],
        ).model_dump()
        await db.product_media.insert_one(metadata, session=session)
        created_ids.append({key: metadata[key] for key in ("id", "updated_at", "is_primary", "sort_order")})
    fields = {"dimension_image_urls": list(dict.fromkeys(dimensions))} if dimensions else {}
    if hero_key:
        fields["catalogue_image_key"] = hero_key
    return created_ids, fields


async def _apply_row(job: dict, selector: dict, row: dict, brand: dict, session):
    await _fence(selector, session)
    floor = job["floor_id"]
    identity = {"floor_id": floor, "brand_id": brand["id"], "sku": row["sku"]}
    is_price = row["action"] == "price"
    price_fields = MATCH_FIELDS | catalog_service.CATALOGUE_PRICE_FIELDS
    projection = {"_id": 0, **(dict.fromkeys(price_fields, 1) if is_price else {})}
    old = await db.products.find_one(identity, projection, session=session)
    is_new = row["action"] == "add"
    if (is_new and old) or (not is_new and (
        not old or old.get("active") is False or old["id"] != row["product_id"]
        or old.get("updated_at") != row["expected_updated_at"]
        or old.get("catalog_version") != row.get("expected_version")
        or is_price and effective_mrp(old) != row["previous_mrp"]
    )):
        await db.catalogue_import_rows.update_one({"_id": row["_id"]}, {"$set": {
            "outcome": "conflict", "error": "Product changed after preview. Preview it again before applying."
        }}, session=session)
        return
    delta = dict(row["delta"])
    if delta.get("concealed_skus"):
        delta["concealed_sku"] = delta["concealed_skus"][0]
        delta["must_buy_concealed"] = True
    accessory_skus = delta.pop("accessory_skus", [])
    if accessory_skus:
        options = await db.products.find({"floor_id": floor, "brand_id": brand["id"], "sku": {"$in": accessory_skus},
                                        "active": {"$ne": False}}, {"id": 1, "sku": 1}, session=session).to_list(len(accessory_skus))
        by_sku = {option["sku"]: option["id"] for option in options}
        if not set(accessory_skus) <= by_sku.keys() or row["sku"] in accessory_skus:
            raise HTTPException(422, "An accessory must reference an existing article in this brand.")
        delta["accessory_ids"] = [by_sku[sku] for sku in dict.fromkeys(accessory_skus)]
    category = row.get("category")
    if category:
        category_id = category.get("id")
        if category_id:
            current = await db.categories.find_one({"id": category_id, "floor_id": floor,
                "brand_id": {"$in": [None, brand["id"]]}}, session=session)
            if not current:
                raise HTTPException(409, "The selected category was removed.")
        else:
            current = await get_or_create_category(db, floor, brand, category["name"], session)
            category_id = current["id"]
        delta["category_id"] = category_id
    if old and old.get("catalog_entries"):
        listing = {key: delta[key] for key in LISTING_FIELDS & delta.keys()}
        if category:
            listing.update(category_id=category_id, category_name=current["name"])
        if listing:
            delta["catalog_entries"] = [{**entry, **listing} for entry in old["catalog_entries"]]
    if is_new:
        product = new_product(floor, brand["id"], delta.pop("category_id"), row["sku"], delta)
    else:
        product = {**old, **delta}
        if not is_price:
            Product.model_validate(product)
    ids, media_delta = await _add_assets(row, product, job, session)
    delta.update(media_delta)
    if not is_new:
        delta = {key: value for key, value in delta.items() if old.get(key) != value}
        if not delta and not ids:
            await db.catalogue_import_rows.update_one({"_id": row["_id"]}, {"$set": {"outcome": "unchanged"}}, session=session)
            return
    changed_at = now_iso()
    version = 1 if is_new else int(old.get("catalog_version") or 0) + 1
    changes = {"updated_at": changed_at, "catalog_updated_by": job["created_by"]}
    if {"mrp", "price"} & delta.keys():
        changes["catalog_price_updated_at"] = changed_at
    previous, absent = before_values(old or {}, {**delta, **changes})
    if is_new:
        await db.products.insert_one({**product, **media_delta, **changes, "catalog_version": version}, session=session)
    else:
        await db.products.update_one(identity, {"$set": {**delta, **changes, "catalog_version": version}}, session=session)
    await db.catalogue_import_rows.update_one({"_id": row["_id"]}, {"$set": {
        "outcome": "applied", "applied_product_id": product["id"], "applied_at": changed_at, "applied_version": version,
        "previous": previous, "absent_before": absent, "created_media": ids,
    }}, session=session)


async def _undo_row(job: dict, selector: dict, row: dict, session):
    await _fence(selector, session)
    identity = {"floor_id": job["floor_id"], "id": row["applied_product_id"], "updated_at": row["applied_at"],
                "catalog_version": row["applied_version"]}
    current = await db.products.find_one(identity, {"catalog_version": 1}, session=session)
    for media in row.get("created_media", []):
        unchanged = await db.product_media.find_one(media, {"_id": 1}, session=session)
        if not unchanged:
            current = None
            break
    if not current:
        await db.catalogue_import_rows.update_one({"_id": row["_id"]}, {"$set": {"rollback": "conflict"}}, session=session)
        return
    patch = {"$set": {"updated_at": now_iso(), "catalog_version": int(current.get("catalog_version") or 0) + 1}}
    if row["action"] == "add":
        # Retain the original ID for quotations created since this import.
        patch["$set"]["active"] = False
    else:
        patch["$set"].update({key: value for key, value in row["previous"].items() if key != "updated_at"})
        patch["$unset"] = {key: "" for key in row["absent_before"] if key != "updated_at"}
    result = await db.products.update_one(identity, patch, session=session)
    if result.matched_count:
        for media in row.get("created_media", []):
            await db.product_media.delete_one(media, session=session)
    await db.catalogue_import_rows.update_one({"_id": row["_id"]}, {"$set": {
        "rollback": "restored" if result.matched_count else "conflict",
    }}, session=session)


async def _apply(job: dict, selector: dict, *, undo: bool) -> dict:
    actor = job["rollback_by"] if undo else job["created_by"]
    required = ("catalogue_rollback",) if undo else OPERATION_PERMISSIONS[job["operation"]]
    grants = await require_capabilities(db, actor, job["floor_id"], *required)
    brand = await scoped_brand(db, job["floor_id"], brand_id=job.get("brand_id"), name=job["brand_name"])
    if not brand and not undo:
        if not job.get("create_brand") or job.get("brand_id"):
            raise HTTPException(409, "The previewed brand is no longer available.")
        await require_capabilities(db, actor, job["floor_id"], "catalogue_brands")
        if not (job["summary"].get("add") or job["summary"].get("update")):
            return {"status": "complete", "stage": "complete", "result": {}}
        async def create_brand(session):
            await _fence(selector, session)
            created = await get_or_create_brand(db, job["floor_id"], job["brand_name"], session)
            await db.catalogue_imports.update_one(selector, {"$set": {"brand_id": created["id"]}}, session=session)
            return created

        async with admission(db, operation="catalogue-management", scope=CATALOG):
            brand = await finish_on_cancel(_with_transaction(create_brand))
    filters = {"job_id": job["_id"], "preview_id": job["preview_id"]}
    if undo:
        pending = {**filters, "outcome": "applied", "rollback": {"$exists": False}}
    else:
        pending = {**filters, "action": {"$nin": ["rejected", "unchanged"]}, "outcome": {"$exists": False}}
    index = -1
    while True:
        rows = await db.catalogue_import_rows.find({**pending, "index": {"$gt": index}}).sort("index", 1).limit(20).to_list(20)
        if not rows:
            break
        grants = await require_capabilities(db, actor, job["floor_id"], *required)
        async with admission(db, operation="catalogue-management", scope=CATALOG):
            for row in rows:
                try:
                    if undo:
                        await finish_on_cancel(_with_transaction(lambda session: _undo_row(job, selector, row, session)))
                    else:
                        extras = set()
                        if row.get("assets"):
                            extras.add("catalogue_images")
                        if row.get("category") and not row["category"].get("id"):
                            extras.add("catalogue_categories")
                        if row["action"] != "add" and {"price", "mrp"} & row["delta"].keys():
                            extras.add("catalogue_prices")
                        if not extras <= grants:
                            raise HTTPException(403, "Permission changed since the preview.")
                        assets = await _publish_media(row["assets"]) if row.get("assets") else []
                        await finish_on_cancel(_with_transaction(lambda session: _apply_row(job, selector, {**row, "assets": assets}, brand, session)))
                except (HTTPException, DuplicateKeyError, ValueError) as exc:
                    message = exc.detail if isinstance(exc, HTTPException) else "The change conflicts with current catalogue data."
                    await db.catalogue_import_rows.update_one({"_id": row["_id"]}, {"$set": {
                        "outcome": "rejected", "error": message,
                    }})
                index = row["index"]
        await db.catalogue_imports.update_one(selector, {"$set": {"processed_through": index, "lease_until": now() + LEASE}})
    if job["operation"] == "prices":
        cursor = db.catalogue_import_rows.find({**filters, "outcome": "applied"}, {"applied_product_id": 1})
        product_ids = [row["applied_product_id"] async for row in cursor]
        for start in range(0, len(product_ids), 250):
            changed = db.products.find({"floor_id": job["floor_id"], "id": {"$in": product_ids[start:start + 250]}},
                {key: 1 for key in catalog_service.CATALOGUE_PRICE_FIELDS | {"id"}})
            catalog_service.patch_catalogue_price_rows([row async for row in changed])
    else:
        await catalog_service.refresh_after_product_creation()
    outcome = "$rollback" if undo else "$outcome"
    counts = {row["_id"]: row["count"] async for row in db.catalogue_import_rows.aggregate([
        {"$match": filters}, {"$group": {"_id": outcome, "count": {"$sum": 1}}},
    ]) if row["_id"]}
    if not undo:
        counts.update({row["_id"]: row["count"] async for row in db.catalogue_import_rows.aggregate([
            {"$match": {**filters, "outcome": "applied"}}, {"$group": {"_id": "$action", "count": {"$sum": 1}}},
        ])})
    return {"status": "rolled_back" if undo else "complete", "stage": "complete", "rollback_result" if undo else "result": counts}


async def _work(job_id: str):
    try:
        async with _worker:
            claim = str(uuid4())
            job = await db.catalogue_imports.find_one_and_update(
                {"_id": job_id, "status": {"$in": WORK_PHASES},
                 "$or": [{"lease_until": {"$lte": now()}}, {"lease_until": {"$exists": False}}]},
                {"$set": {"claim": claim, "lease_until": now() + LEASE}}, return_document=ReturnDocument.AFTER,
            )
            if not job:
                return
            selector = {"_id": job_id, "claim": claim, "status": job["status"]}
            try:
                if job["status"] == "queued":
                    grants = await require_capabilities(db, job["created_by"], job["floor_id"], *OPERATION_PERMISSIONS[job["operation"]])
                    await db.catalogue_imports.update_one(selector, {"$set": {"stage": "reading"}})
                    result = await _preview(job, selector, grants)
                else:
                    result = await _apply(job, selector, undo=job["status"] == "rolling_back")
            except (AdmissionBusy, AdmissionUnavailable):
                await db.catalogue_imports.update_one(selector, {"$set": {"lease_until": now() + timedelta(seconds=10)}})
                return
            except Exception as exc:
                logger.warning("catalogue_import_interrupted job=%s phase=%s error_type=%s", job_id, job["status"], type(exc).__name__)
                error = exc.detail if isinstance(exc, HTTPException) else str(exc) if isinstance(exc, ValueError) else "Import interrupted. Resume this job to continue."
                result = {"status": "failed", "failed_phase": job["status"], "error": error}
            await db.catalogue_imports.update_one(selector, {
                "$set": {**result, "updated_at": now_iso()}, "$unset": {"claim": "", "lease_until": ""},
            })
    finally:
        _jobs.pop(job_id, None)


def enqueue(job_id: str) -> None:
    if job_id not in _jobs:
        _jobs[job_id] = asyncio.create_task(_work(job_id), name=f"catalogue-import-{job_id}")


async def catalogue_worker() -> None:
    while True:
        try:
            pending = await db.catalogue_imports.find({
                "status": {"$in": WORK_PHASES},
                "$or": [{"lease_until": {"$lte": now()}}, {"lease_until": {"$exists": False}}],
            }, {"_id": 1}).limit(10).to_list(10)
            for job in pending:
                enqueue(job["_id"])
        except Exception as exc:
            logger.warning("catalogue_import_poll_failed error_type=%s", type(exc).__name__)
        await asyncio.sleep(15)


async def stop_catalogue_workers() -> None:
    tasks = tuple(_jobs.values())
    if tasks:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
