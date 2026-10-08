"""Orchestrator wiring Extraction → Validation → Certification → Import."""
from __future__ import annotations
import logging
import re
import base64
import hashlib
from datetime import datetime, timezone

from auth import floor_inherit
from db import db
from media_storage import get_media_storage
from media_storage.factory import private_bucket
from models import Product

from .base import MISSING

logger = logging.getLogger("forge.catalog_pipeline")


# ---------------------------------------------------------------------------
# Image blob offload (keeps job doc under MongoDB's 16MB BSON cap)
# ---------------------------------------------------------------------------
async def _offload_row_images(rows: list[dict]) -> dict[str, str]:
    """Move every base64 data-URL out of ``rows[].images`` into private
    Supabase Storage, with a lightweight metadata record keyed by SHA-1.

    Mutates rows in-place: ``images`` becomes a list of ``blob:<sha1>`` refs.
    The original image bytes never enter the import-job JSON/BSON document,
    preventing both API bloat and MongoDB's 16MB-document limit.  The object
    path is immutable and content-addressed so retries are idempotent.

    Legacy rows with a ``data_url`` continue to resolve in ``_resolve_blob``;
    new imports are Supabase-backed exclusively.
    """
    blob_map: dict[str, str] = {}
    staged: dict[str, tuple[bytes, str]] = {}
    for r in rows:
        images = r.get("images") or []
        metas = r.get("image_meta") or []
        new_urls: list[str] = []
        for i, img in enumerate(images):
            if not img:
                continue
            if img.startswith("blob:") or not img.startswith("data:"):
                new_urls.append(img)
                continue
            try:
                header, encoded = img.split(",", 1)
                mime = header.split(";", 1)[0].removeprefix("data:").lower() or "image/png"
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, UnicodeEncodeError):
                # Leave an unexpected data URL alone for the existing import
                # error path; never claim it was safely persisted.
                new_urls.append(img)
                continue
            sha1 = hashlib.sha1(raw).hexdigest()
            staged.setdefault(sha1, (raw, mime))
            if i < len(metas) and isinstance(metas[i], dict):
                metas[i]["sha1"] = sha1
            new_urls.append(f"blob:{sha1}")
        r["images"] = new_urls

    if staged:
        storage = get_media_storage()
        bucket = private_bucket()
        for sha1, (raw, mime) in staged.items():
            ext = {"image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/svg+xml": "svg"}.get(mime, "bin")
            key = f"catalog-import-images/{sha1[:2]}/{sha1}.{ext}"
            existing = await db.catalog_image_blobs.find_one({"sha1": sha1}, {"_id": 0, "storage_key": 1})
            if not existing or not existing.get("storage_key"):
                # A content-addressed key makes this safe even if a prior
                # process completed the upload but crashed before MongoDB.
                if not await storage.exists(bucket=bucket, key=key):
                    await storage.upload(bucket=bucket, key=key, data=raw, content_type=mime)
                await db.catalog_image_blobs.update_one(
                    {"sha1": sha1},
                    {"$set": {
                        "sha1": sha1, "bucket": bucket, "storage_key": key,
                        "mime": mime, "size_bytes": len(raw),
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }, "$setOnInsert": {"created_at": datetime.now(timezone.utc).isoformat()}},
                    upsert=True,
                )
    return blob_map


async def _resolve_blob(ref: str, blob_map: dict[str, str] | None = None) -> str | None:
    """Resolve a ``blob:<sha1>`` ref for import, including legacy rows."""
    if not ref:
        return None
    if not ref.startswith("blob:"):
        return ref
    sha1 = ref[len("blob:"):]
    if blob_map and sha1 in blob_map:
        return blob_map[sha1]
    doc = await db.catalog_image_blobs.find_one(
        {"sha1": sha1}, {"_id": 0, "data_url": 1, "bucket": 1, "storage_key": 1, "mime": 1},
    )
    if not doc:
        return None
    if doc.get("data_url"):
        return doc["data_url"]
    if not doc.get("bucket") or not doc.get("storage_key"):
        return None
    try:
        raw = await get_media_storage().download(bucket=doc["bucket"], key=doc["storage_key"])
    except Exception as exc:  # noqa: BLE001
        logger.warning("Staged catalog image download failed error_type=%s", type(exc).__name__)
        return None
    mime = str(doc.get("mime") or "image/png")
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


async def run_pipeline(brand: str, filename: str, data: bytes) -> dict:
    """Extract + validate + certify. Returns everything the UI needs to render Review."""
    from .isolated_parser import extract_isolated
    return await extract_isolated(brand, filename, data)


async def import_accepted(
    job: dict,
    user_id: str,
    blob_map: dict[str, str] | None = None,
    floor_id: str | None = None,
    force_landscape_images: bool = False,
) -> dict:
    """Persist all rows in job['rows'] with status == 'accepted' into products.

    Idempotent: existing SKUs are updated (not duplicated). Never deletes anything.
    Skips rows missing category/mrp/price.

    Image blobs referenced as ``blob:<sha1>`` are resolved from the optional
    in-memory ``blob_map`` first (avoids a DB round-trip per image), then
    falls back to the ``catalog_image_blobs`` collection.
    """
    from catalog_policy import removed_brand_identity, removed_supplier_row
    supplier = job["supplier_name"]
    if removed_brand_identity(supplier):
        raise ValueError("This supplier is no longer distributed")
    force_landscape_images = force_landscape_images or bool(job.get("force_landscape_images"))
    floor_id = floor_id or floor_inherit(job)
    brand_doc = await db.brands.find_one({"name": supplier, "floor_id": floor_id}, {"_id": 0})
    if not brand_doc:
        # Autocreate brand if missing
        from models import Brand
        b = Brand(name=supplier, slug=supplier.lower(), country=None, floor_id=floor_id)
        await db.brands.insert_one(b.model_dump())
        brand_doc = b.model_dump()

    cats = await db.categories.find({"floor_id": floor_id}, {"_id": 0}).to_list(80)
    cat_by_name = {c["name"].lower(): c for c in cats}
    from models import Category

    imported = 0
    updated = 0
    skipped = 0
    failed = 0
    errors: list[dict] = []
    snapshots: list[dict] = []
    job_id = job.get("id")
    attempted_row_ids: list[str] = []

    def _clean(v):
        return None if v in (None, MISSING) else v

    for r in job.get("rows", []):
        if r.get("status") != "accepted":
            continue
        if removed_supplier_row(r):
            skipped += 1
            errors.append({"row_id": r.get("row_id"), "sku": r.get("sku"), "error": "Row belongs to a supplier no longer distributed"})
            continue
        if r.get("row_id") is not None:
            attempted_row_ids.append(str(r["row_id"]))
        if r.get("mrp") in (None, MISSING) or r.get("category") in (None, MISSING):
            skipped += 1
            errors.append({"row_id": r.get("row_id"), "sku": r.get("sku"), "error": "Accepted row is missing price or category"})
            continue

        try:
            cat = cat_by_name.get(str(r.get("category", "")).lower())
            if not cat:
                # Auto-create category from the row's supplier-provided label so
                # per-file categories (BM, Ceramic, Thermostat, kitchen, ...) work
                # without pre-seeding an allow-list.
                label = str(r.get("category", "")).strip()
                if not label:
                    skipped += 1
                    continue
                slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "misc"
                c = Category(name=label, slug=slug, floor_id=floor_id)
                await db.categories.insert_one(c.model_dump())
                cat = c.model_dump()
                cat_by_name[label.lower()] = cat

            mrp = float(r["mrp"])
            price_val = r.get("dealer_price") if r.get("dealer_price") not in (None, MISSING) else mrp
            price_val = float(price_val)

            # Hierarchy fields — never fabricate; missing supplier data stays null.
            subcategory = _clean(r.get("subcategory"))
            series = _clean(r.get("series"))
            collection = _clean(r.get("collection"))
            family_key = _clean(r.get("family_key"))
            variant_label = _clean(r.get("variant"))
            finish = _clean(r.get("finish"))
            finish_code = _clean(r.get("finish_code"))
            colour = _clean(r.get("colour"))
            description = _clean(r.get("description"))
            specs = r.get("specs") or {}
            image_meta = r.get("image_meta") or []
            image_quality = _clean(r.get("image_quality")) or "missing"

            # family_name is series + form: "Metropole · Wall Hung WC"
            family_name = None
            if series:
                series_clean = str(series).strip()
                if description and str(description).strip():
                    desc_clean = str(description).strip()
                    # Avoid pathological "SERIES · SERIES · DETAIL" duplication.
                    if desc_clean.lower().startswith(series_clean.lower()):
                        family_name = desc_clean
                    elif series_clean.lower() in desc_clean.lower():
                        family_name = desc_clean
                    else:
                        family_name = f"{series_clean} · {desc_clean}"
                else:
                    family_name = series_clean
            elif description:
                family_name = str(description).strip()

            # Resolve any blob:<sha1> references back to data URLs
            raw_images = r.get("images") or []
            resolved_images: list[str] = []
            for ref in raw_images:
                if not ref:
                    continue
                if ref.startswith("blob:"):
                    data_url = await _resolve_blob(ref, blob_map)
                    if data_url:
                        resolved_images.append(data_url)
                else:
                    resolved_images.append(ref)

            row_brand = brand_doc
            payload = {
                "name": str(r.get("name") or "Untitled")[:200],
                "brand_id": row_brand["id"],
                "category_id": cat["id"],
                "subcategory": subcategory,
                "series": series,
                "collection": collection,
                "family_key": family_key,
                "family_name": family_name,
                "variant_label": variant_label,
                "finish_code": finish_code,
                "colour": colour,
                "description": None if description is None else str(description),
                "finish": None if finish is None else str(finish),
                "material": _clean(r.get("material")),
                "dimensions": _clean(r.get("dimensions")),
                "size": _clean(r.get("size")),
                "warranty": _clean(r.get("warranty")),
                "mrp": mrp,
                "price": price_val,
                # Legacy fields kept empty — media now lives in product_media.
                "images": [],
                "image_meta": [],
                "image_quality": image_quality,
                "specs": specs if isinstance(specs, dict) else {},
                "must_buy_concealed": bool(r.get("must_buy_concealed")),
                "concealed_sku": _clean(r.get("concealed_sku")),
                "concealed_skus": [str(sku) for sku in (r.get("concealed_skus") or []) if sku],
                "tags": r.get("tags") or [
                    cat["name"].lower(), supplier.lower(),
                    (finish or "").lower(),
                    (series or "").lower(),
                ],
                "active": True,
                "floor_id": floor_id,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            # Drop any tags that ended up empty strings
            payload["tags"] = [t for t in payload["tags"] if t]

            sku = r.get("sku") or ""
            if not sku or sku == MISSING:
                skipped += 1
                continue

            # CRITICAL: scope the existing-product lookup by (sku, brand_id).
            # SKU is only guaranteed unique *within* a manufacturer — different
            # suppliers can and do reuse the same short numeric article code
            # (e.g. an 8-digit Hansgrohe/AXOR code coincidentally matching a
            # Grohe SKU). A global `{"sku": sku}` lookup would silently
            # overwrite a completely unrelated brand's product. Never again.
            existing = await db.products.find_one({"sku": sku, "brand_id": row_brand["id"], "floor_id": floor_id}, {"_id": 0})
            if existing:
                if job_id:
                    snapshots.append({
                        "job_id": job_id, "product_id": existing["id"], "was_new": False,
                        "previous": existing, "created_at": datetime.now(timezone.utc).isoformat(),
                    })
                await db.products.update_one(
                    {"sku": sku, "brand_id": row_brand["id"], "floor_id": floor_id}, {"$set": payload}
                )
                await _upload_supplier_images(
                    resolved_images, image_meta, image_quality,
                    product_id=existing["id"], family_key=family_key,
                    brand_id=row_brand["id"], brand_slug=row_brand.get("slug") or supplier.lower(), floor_id=floor_id,
                    force_landscape_images=force_landscape_images,
                )
                updated += 1
                continue

            payload["sku"] = sku
            p = Product(**payload)
            if job_id:
                snapshots.append({
                    "job_id": job_id, "product_id": p.id, "was_new": True,
                    "previous": None, "created_at": datetime.now(timezone.utc).isoformat(),
                })
            await db.products.insert_one(p.model_dump())
            await _upload_supplier_images(
                resolved_images, image_meta, image_quality,
                product_id=p.id, family_key=family_key,
                brand_id=row_brand["id"], brand_slug=row_brand.get("slug") or supplier.lower(), floor_id=floor_id,
                force_landscape_images=force_landscape_images,
            )
            imported += 1
        except Exception as e:  # noqa: BLE001
            # One malformed row (bad price, bad category) must never abort
            # the rest of a multi-hundred-row batch — record it and continue.
            failed += 1
            errors.append({"row_id": r.get("row_id"), "sku": r.get("sku"), "error": f"Catalog row could not be imported ({type(e).__name__})"})
            logger.warning("Catalog import row failed job=%s row=%s error_type=%s", job_id, r.get("row_id"), type(e).__name__)

    if snapshots:
        for i in range(0, len(snapshots), 200):
            await db.catalog_import_snapshots.insert_many(snapshots[i:i + 200])

    return {"imported": imported, "updated": updated, "skipped": skipped, "failed": failed, "errors": errors, "attempted_row_ids": attempted_row_ids}


async def _upload_supplier_images(
    images: list[str], metas: list[dict], quality: str, *,
    product_id: str, family_key: str | None, brand_id: str, brand_slug: str, floor_id: str,
    force_landscape_images: bool = False,
) -> None:
    """Import base64 supplier images into Supabase via the MediaStorage layer.

    Idempotent — the media_service dedupe layer skips uploads whose SHA-1
    already exists for this product+source_type.
    """
    if not images:
        return
    import base64
    from services.media_service import upload_and_register

    for i, ref in enumerate(images):
        if not ref:
            continue
        if ref.startswith("http"):
            # Already stored — nothing to do
            continue
        if not ref.startswith("data:"):
            continue
        try:
            head, b64 = ref.split(",", 1)
            mime = head.split(";", 1)[0].removeprefix("data:") or "image/png"
            data = base64.b64decode(b64)
        except Exception:  # noqa: BLE001
            continue
        role = "hero" if i == 0 else "gallery"
        try:
            await upload_and_register(
                data=data, mime=mime, brand_slug=brand_slug,
                product_id=product_id, family_key=family_key, brand_id=brand_id,
                floor_id=floor_id,
                source_type="supplier", role=role,
                is_primary=(i == 0), sort_order=i * 10,
                force_landscape=force_landscape_images,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("Supplier image upload failed product=%s index=%d error_type=%s", product_id, i, type(e).__name__)


async def rollback_job(job_id: str) -> dict:
    """Undo a job's product mutations using the snapshots `import_accepted`
    recorded before each write: rows it created are removed, rows it updated
    are restored to their pre-import state. Products referenced by a
    quotation/PO created *after* the import are still restored/removed —
    per spec this only touches product documents, never quotations/orders —
    so a rollback after downstream use can leave a quotation pointing at a
    product whose price/name just changed underneath it; that is a business
    trade-off (roll back a live catalog vs. preserve referential history),
    not something a full delete could avoid either.

    Note: supplier images uploaded to Supabase during the import are
    intentionally NOT deleted here — undoing storage objects safely (without
    risking an image another product still references) is out of scope for
    this pass; a rolled-back product's `product_media` rows remain, orphaned
    but harmless, until a manual cleanup pass."""
    snapshots = await db.catalog_import_snapshots.find({"job_id": job_id}, {"_id": 0}).to_list(20000)
    restored = 0
    removed = 0
    for snap in snapshots:
        pid = snap["product_id"]
        if snap["was_new"]:
            res = await db.products.delete_one({"id": pid})
            removed += res.deleted_count
        else:
            prev = snap.get("previous")
            if prev:
                prev = dict(prev)
                prev.pop("_id", None)
                res = await db.products.replace_one({"id": pid}, prev)
                restored += res.modified_count

    await db.catalog_imports.update_one({"id": job_id}, {"$set": {"status": "rolled_back"}})
    await db.catalog_import_snapshots.delete_many({"job_id": job_id})
    return {"products_removed": removed, "products_restored": restored}
