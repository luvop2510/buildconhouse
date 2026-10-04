"""Preserve every supplier worksheet occurrence without duplicating stock identities.

Dry-run is the default. Execution requires a new backup directory and saves
before-images before a single transaction changes brands, categories, products.
No old product or media is deleted. Source-only catalog views preserve old
records for quotations, stock and audit history.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import io
import json
import re
import sys
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
FLOOR_ID = "first-floor"
DEFAULT_MANIFEST = ROOT / "catalog_pipeline/data/supplier_workbooks_2026_2027.json"
IDENTITY_ALIASES = {
    "1800187": "01800187", "1500180": "01500180", "1400180": "01400180",
}
# These article stems include distinct models/revisions in the source, rather
# than just finish variants. Keep their canonical SKU navigation independent.
GROHE_DISTINCT_MODEL_STEMS = {"27572", "22009", "19571", "19506", "32468", "13255"}


def canonical_article(row: dict) -> str:
    article = row.get("canonical_article") or row["article"]
    if row["brand"] == "Hansgrohe":
        return IDENTITY_ALIASES.get(article, article)
    return article


def category_slug(brand: str, sheet: str) -> str:
    label = re.sub(r"[^a-z0-9]+", "-", sheet.lower()).strip("-")
    # The hash distinguishes names differing only in space, case or Unicode.
    return f"{brand.lower()}-workbook-{label}-{hashlib.sha1(sheet.encode()).hexdigest()[:8]}"


def entry_for(row: dict, category_id: str) -> dict:
    return {
        "entry_id": row["occurrence_id"], "source_catalog": row["workbook"],
        "sheet_name": row["sheet"], "sheet_order": row["sheet_order"],
        "row_number": row["row"], "source_order": row["source_order"],
        "serial_number": row["serial_raw"], "source_sku": row["article"],
        "article_raw": row["article_raw"], "category_id": category_id,
        "category_name": row["category_exact"],
        "subcategory": row.get("section_heading_exact"),
        "name": row.get("description_exact"), "description": row.get("description_exact"),
        "mrp": row["price"], "price_status": "known" if row["price"] is not None else "unspecified",
        "price_raw": row.get("price_raw"), "price_candidates": row.get("price_candidates", []),
        "source_cells": row.get("source_cells", {}),
        "discontinued_source": bool(row.get("discontinued_source")),
        "source_status_note": row.get("source_status_note"),
    }


def product_payload(rows: list[dict], categories: dict, old: dict) -> dict:
    from catalog_pipeline.adapters.hansgrohe import _detect_collection, _detect_finish, _detect_series
    from scripts.grohe_xlsx_extract import _detect_finish as grohe_finish, _finish_from_sku_tail

    first = rows[0]
    sku = canonical_article(first)
    name = first.get("description_exact") or old.get("name") or f"Article {first['article']}"
    # First priced occurrence defines the canonical product's current price.
    # Every occurrence retains its own price in catalog_entries and listing views.
    priced = next((row for row in rows if row["price"] is not None), None)
    if priced:
        mrp, price, status = priced["price"], priced["price"], "known"
    elif old.get("mrp", 0) > 0 or old.get("price", 0) > 0:
        mrp, price, status = old.get("mrp", 0), old.get("price", old.get("mrp", 0)), "existing"
    else:
        mrp, price, status = 0, 0, "unspecified"
    if first["brand"] == "Hansgrohe":
        collection = _detect_collection(name)
        finish, finish_code = _detect_finish(name, sku)
        series = _detect_series(name) or old.get("series")
    else:
        collection = old.get("collection")
        finish = grohe_finish(name) or old.get("finish") or _finish_from_sku_tail(sku)
        finish_code = old.get("finish_code")
        series = old.get("series")
    candidate = first.get("variant_family_candidate")
    family_key = candidate or old.get("family_key") or f"{first['brand'].lower()}:article:{sku.lower()}"
    if first["brand"] == "Grohe" and sku[:5] in GROHE_DISTINCT_MODEL_STEMS:
        family_key = f"grohe:article:{sku.lower()}"
    specs = dict(old.get("specs") or {})
    specs.update({
        "source_catalog": first["workbook"], "source_price_status": status,
        "source_article_raw": first["article_raw"],
        "source_description_unspecified": first.get("description_exact") is None,
        "source_occurrence_count": len(rows),
        "source_family_candidate": candidate,
        "source_price_selection": "Grohe WC E first, F when E blank; otherwise supplier MRP",
    })
    source_text = "\n".join(
        str(value) for row in rows
        for value in [row["sheet"], row.get("section_heading_exact"), row["article"],
                      row.get("description_exact"), *[cell.get("value") for cell in row.get("source_cells", {}).values()]]
        if value is not None
    )
    return {
        "name": name, "description": first.get("description_exact") or old.get("description"),
        "category_id": categories[(first["brand"], first["sheet"])]["id"],
        "subcategory": first.get("section_heading_exact"), "sku": sku,
        "collection": collection, "series": series,
        "family_key": family_key, "family_name": old.get("family_name") or name,
        "variant_label": finish, "finish": finish, "colour": finish,
        "finish_code": finish_code, "variants": [],
        "mrp": mrp, "price": price, "price_status": status,
        "catalog_source": first["workbook"],
        "catalog_search_text": source_text,
        "catalog_entries": [entry_for(row, categories[(row["brand"], row["sheet"])]["id"]) for row in rows],
        "specs": specs, "active": True,
    }


def validate_manifest(manifest: dict) -> list[dict]:
    rows = manifest["ordered_occurrences"]
    if not rows or len({row["occurrence_id"] for row in rows}) != len(rows):
        raise ValueError("The source must contain unique nonempty occurrence IDs")
    if [row["brand_order"] for row in rows] != sorted(row["brand_order"] for row in rows):
        raise ValueError("Hansgrohe must precede Grohe")
    for brand in ("Hansgrohe", "Grohe"):
        scoped = [row for row in rows if row["brand"] == brand]
        if [row["source_order"] for row in scoped] != list(range(1, len(scoped) + 1)):
            raise ValueError(f"Source order is incomplete for {brand}")
        if any(not row["article"] or (row["price"] is not None and row["price"] < 0) for row in scoped):
            raise ValueError(f"Invalid article or supplier price for {brand}")
    return rows


def product_media_family_updates(updates: list[tuple[dict, dict]], media_rows: list[dict]) -> list[dict]:
    """Plan family metadata changes for exact existing product owners only.

    Supplier reconciliation changes family navigation without changing the
    product's stock identity or image bytes. Keep its explicitly owned media
    consistent, including stale metadata left by an earlier reconciliation.
    Family-only media and other products/brands/floors are never reassigned.
    """
    owners = {old["id"]: (old, payload) for old, payload in updates}
    changes = []
    for media in media_rows:
        owner = owners.get(media.get("product_id"))
        if not owner:
            continue
        old, payload = owner
        expected_family = payload.get("family_key")
        if not expected_family or media.get("family_key") == expected_family:
            continue
        if media.get("brand_id") != old.get("brand_id") or media.get("floor_id") != old.get("floor_id"):
            raise ValueError(f"Product-linked media has a different brand or floor: {media.get('id')}")
        changes.append({
            "media_id": media["id"], "product_id": old["id"],
            "brand_id": old.get("brand_id"), "floor_id": old.get("floor_id"),
            "before": {key: media.get(key) for key in ("family_key", "storage_key", "sha1", "width", "height")},
            "after": {"family_key": expected_family},
        })
    return changes


async def apply_product_media_family_updates(db, changes: list[dict], *, session, actor: str, created_at: str) -> None:
    """Apply a reviewed owner-scoped plan inside its catalog transaction."""
    from pymongo import UpdateOne

    if not changes:
        return
    media_ops = [UpdateOne({
        "id": change["media_id"], "product_id": change["product_id"],
        "brand_id": change["brand_id"], "floor_id": change["floor_id"],
        "family_key": change["before"]["family_key"],
    }, {"$set": change["after"]}) for change in changes]
    changed_media = await db.product_media.bulk_write(media_ops, ordered=True, session=session)
    if changed_media.matched_count != len(changes):
        raise RuntimeError("Product media changed during reconciliation; aborting transaction")
    await db.media_repair_audits.insert_many([{
        **change, "actor": actor, "created_at": created_at,
        "reason": "Supplier reconciliation updated the exact product owner's family_key",
    } for change in changes], ordered=True, session=session)


async def reconcile(manifest: dict, *, execute: bool, backup_dir: Path | None) -> dict:
    from db import client, db
    from models import Category, Product
    from pymongo import UpdateOne

    rows = validate_manifest(manifest)
    brands = await db.brands.find({"name": {"$in": ["Hansgrohe", "Grohe"]}, "floor_id": FLOOR_ID}, {"_id": 0}).to_list(10)
    by_brand = {brand["name"]: brand for brand in brands}
    if set(by_brand) != {"Hansgrohe", "Grohe"}:
        raise RuntimeError("Expected existing first-floor Hansgrohe and Grohe brands")
    scope = {"floor_id": FLOOR_ID, "brand_id": {"$in": [b["id"] for b in brands]}}
    old_products = await db.products.find(scope, {"_id": 0}).to_list(10000)
    old_by_key = {(p["brand_id"], p["sku"]): p for p in old_products}
    if len(old_by_key) != len(old_products):
        raise RuntimeError("Duplicate live article identities require review")
    old_categories = await db.categories.find({"floor_id": FLOOR_ID}, {"_id": 0}).to_list(1000)
    by_slug = {category["slug"]: category for category in old_categories}
    categories = {}
    new_categories = []
    for row in rows:
        key = (row["brand"], row["sheet"])
        if key in categories:
            continue
        slug = category_slug(*key)
        cat = by_slug.get(slug)
        if not cat:
            cat = Category(name=row["category_exact"], slug=slug, floor_id=FLOOR_ID).model_dump()
            new_categories.append(cat)
        cat = dict(cat)
        cat.update({"name": row["category_exact"], "catalog_order": row["sheet_order"],
                    "catalog_source": row["workbook"], "brand_id": by_brand[row["brand"]]["id"]})
        categories[key] = cat
    grouped = defaultdict(list)
    for row in rows:
        grouped[(row["brand"], canonical_article(row))].append(row)
    updates, additions, summary = [], [], []
    now = datetime.now(timezone.utc).isoformat()
    for (brand_name, sku), occurrences in grouped.items():
        brand = by_brand[brand_name]
        old = old_by_key.get((brand["id"], sku), {})
        payload = product_payload(occurrences, categories, old)
        payload["updated_at"] = now
        if old:
            updates.append((old, payload))
        else:
            product = Product(floor_id=FLOOR_ID, brand_id=brand["id"], **payload).model_dump()
            additions.append(product)
        summary.append({"brand": brand_name, "sku": sku, "action": "update" if old else "add",
                        "source_occurrences": len(occurrences), "price_status": payload["price_status"],
                        "old_mrp": old.get("mrp"), "new_mrp": payload["mrp"]})
    source_keys = {(by_brand[name]["id"], sku) for name, sku in grouped}
    extras = [p for p in old_products if (p["brand_id"], p["sku"]) not in source_keys]
    media = await db.product_media.find({"product_id": {"$in": [p["id"] for p in old_products]}}, {"_id": 0}).to_list(30000)
    media_changes = product_media_family_updates(updates, media)
    report = {
        "dry_run": not execute, "source_occurrences": len(rows), "source_articles": len(grouped),
        "added": len(additions), "updated": len(updates), "categories": len(categories),
        "source_category_counts": dict(Counter(f"{r['brand']} / {r['sheet']}" for r in rows)),
        "historical_products_preserved": len(extras),
        "product_media_family_updates": media_changes,
        "product_media_family_update_count": len(media_changes),
        "price_unspecified_new": [p["sku"] for p in additions if p["price_status"] == "unspecified"],
        "products": summary,
    }
    if not execute:
        return report
    if backup_dir is None or backup_dir.exists():
        raise ValueError("Execution requires a new --backup-dir")
    backup_dir.mkdir(parents=True)
    for filename, data in [("products", old_products), ("brands", brands), ("categories", old_categories), ("product_media", media), ("plan", report)]:
        (backup_dir / f"{filename}.json").write_text(json.dumps(data, default=str, indent=2))
    async with await client.start_session() as session:
        async with session.start_transaction():
            for cat in categories.values():
                await db.categories.update_one({"id": cat["id"]}, {"$set": cat}, upsert=True, session=session)
            for brand_name, brand in by_brand.items():
                source_row = next(row for row in rows if row["brand"] == brand_name)
                await db.brands.update_one({"id": brand["id"], "floor_id": FLOOR_ID}, {"$set": {
                    "catalog_source": source_row["workbook"], "catalog_order": source_row["brand_order"],
                    "catalog_authoritative": True,
                }}, session=session)
            if updates:
                ops = [UpdateOne({"id": old["id"], "sku": old["sku"], "floor_id": FLOOR_ID}, {"$set": payload}) for old, payload in updates]
                changed = await db.products.bulk_write(ops, ordered=True, session=session)
                if changed.matched_count != len(updates):
                    raise RuntimeError("A product changed during reconciliation; aborting transaction")
            if additions:
                await db.products.insert_many(additions, ordered=True, session=session)
            await apply_product_media_family_updates(db, media_changes, session=session,
                                                    actor="supplier-workbook-reconciliation", created_at=now)
            actual = await db.products.find(scope, {"_id": 0}, session=session).to_list(10000)
            actual_by_key = {(p["brand_id"], p["sku"]): p for p in actual}
            actual_entries = {e["entry_id"]: e for p in actual if p.get("catalog_source") in {r["workbook"] for r in rows} for e in p.get("catalog_entries", [])}
            if set(actual_entries) != {r["occurrence_id"] for r in rows}:
                raise RuntimeError("Post-write occurrence set does not match both workbooks")
            for row in rows:
                product = actual_by_key[(by_brand[row["brand"]]["id"], canonical_article(row))]
                expected = entry_for(row, categories[(row["brand"], row["sheet"])]["id"])
                if actual_entries[row["occurrence_id"]] != expected:
                    raise RuntimeError(f"Post-write source row mismatch: {row['occurrence_id']}")
                old = old_by_key.get((product["brand_id"], product["sku"]))
                if old and (product["id"] != old["id"] or product.get("stock") != old.get("stock")):
                    raise RuntimeError("Existing stock identity changed")
    report.update({"dry_run": False, "backup_dir": str(backup_dir), "post_write_occurrences": len(actual_entries)})
    (backup_dir / "result.json").write_text(json.dumps(report, default=str, indent=2))
    return report


async def import_images(manifest: dict, workbook_dir: Path, report_path: Path) -> dict:
    """Register exact-row images, retaining all prior media for rollback."""
    from db import db
    from services.media_service import upload_and_register
    from services.product_image_normalizer import normalize_product_image
    from PIL import Image

    rows = validate_manifest(manifest)
    for source in manifest.get("workbooks", []):
        expected = source.get("workbook_sha256") or source.get("sha256")
        if expected:
            path = workbook_dir / source["workbook"]
            with path.open("rb") as handle:
                actual = hashlib.file_digest(handle, "sha256").hexdigest()
            if actual != expected:
                raise ValueError(f"Source workbook changed: {source['workbook']}")
    by_occurrence = {row["occurrence_id"]: row for row in rows}
    brands = {brand["name"]: brand async for brand in db.brands.find({"name": {"$in": ["Hansgrohe", "Grohe"]}, "floor_id": FLOOR_ID}, {"_id": 0})}
    products = {(p["brand_id"], p["sku"]): p async for p in db.products.find({"brand_id": {"$in": [b["id"] for b in brands.values()]}, "floor_id": FLOOR_ID}, {"_id": 0})}
    archives = {name: zipfile.ZipFile(workbook_dir / next(r["workbook"] for r in rows if r["brand"] == name)) for name in brands}
    result = {"registered": [], "skipped": [], "errors": []}
    selected = []
    seen = set()
    for image in manifest["images"]:
        occurrence_id = image.get("occurrence_id")
        if not occurrence_id:
            result["skipped"].append({"image_id": image["image_id"], "reason": image["mapping_reason"]})
            continue
        row = by_occurrence[occurrence_id]
        key = (row["brand"], canonical_article(row), image["zip_media_path"])
        if key in seen:
            continue
        seen.add(key)
        selected.append((row, image))
    selected.sort(key=lambda item: (
        item[0]["brand_order"], canonical_article(item[0]),
        -((item[1].get("width") or 0) * (item[1].get("height") or 0)),
        item[0]["source_order"], item[1]["image_id"],
    ))
    sem = asyncio.Semaphore(6)
    product_locks = defaultdict(asyncio.Lock)
    async def register(row, image):
        product = products[(brands[row["brand"]]["id"], canonical_article(row))]
        async with sem, product_locks[product["id"]]:
            try:
                data = archives[row["brand"]].read(image["zip_media_path"])
                if image.get("sha256") and hashlib.sha256(data).hexdigest() != image["sha256"]:
                    raise ValueError("Embedded source image hash changed")
                with Image.open(io.BytesIO(data)) as decoded:
                    decoded.verify()
                with Image.open(io.BytesIO(data)) as decoded:
                    mime = Image.MIME.get(decoded.format, "image/png")
                    width, height = decoded.size
                # Preserve a better existing displayed photo. Supplier-row imagery
                # remains registered as a SKU-specific gallery with provenance.
                existing_media = await db.product_media.find({"product_id": product["id"]}, {"_id": 0}).to_list(100)
                normalized, _ = normalize_product_image(data, mime)
                sha1 = hashlib.sha1(normalized).hexdigest()
                identical = next((m for m in existing_media if m.get("sha1") == sha1), None)
                best_pixels = max(((m.get("width") or 0) * (m.get("height") or 0) for m in existing_media if m.get("role") not in ("dimension", "seat-cover")), default=0)
                preferred_existing = any(m.get("source_type") in ("internal", "manufacturer")
                                         and m.get("public_url") and m.get("role") not in ("dimension", "seat-cover")
                                         for m in existing_media)
                is_primary = not preferred_existing and width * height > best_pixels
                if identical:
                    result["registered"].append({"sku": product["sku"], "brand": row["brand"], "media_id": identical["id"],
                                                 "source_image_id": image["image_id"], "primary": bool(identical.get("is_primary")),
                                                 "url": identical.get("public_url"), "width": width, "height": height,
                                                 "existing_identical": True})
                    return
                doc = await upload_and_register(
                    data=data, mime=mime, brand_slug=row["brand"].lower(),
                    product_id=product["id"], brand_id=product["brand_id"], floor_id=FLOOR_ID,
                    source_type="supplier", role="hero" if is_primary else "gallery", is_primary=is_primary,
                    sort_order=-1000 if is_primary else 100,
                    uploaded_by="supplier-workbook-reconciliation",
                    notes=f"{row['workbook']} | {row['sheet']}!D{row['row']} | article {row['article']} | {image['zip_media_path']} | {image['mapping_reason']}",
                )
                if not await db.product_media.find_one({"id": doc.id, "product_id": product["id"]}):
                    raise RuntimeError("Registered media cannot be read back")
                result["registered"].append({"sku": product["sku"], "brand": row["brand"], "media_id": doc.id,
                                             "source_image_id": image["image_id"], "primary": is_primary,
                                             "url": doc.public_url, "width": width, "height": height})
            except Exception as exc:
                result["errors"].append({"brand": row["brand"], "sku": product["sku"], "image_id": image["image_id"], "error": str(exc)})
            completed = len(result["registered"]) + len(result["errors"])
            if completed % 100 == 0:
                print(f"Images {completed}/{len(selected)}; errors {len(result['errors'])}", flush=True)
                report_path.write_text(json.dumps(result, indent=2))
    # Brand stages remain sequential; bounded parallel I/O inside each brand.
    for brand in ("Hansgrohe", "Grohe"):
        await asyncio.gather(*(register(row, image) for row, image in selected if row["brand"] == brand))
    for archive in archives.values():
        archive.close()
    report_path.write_text(json.dumps(result, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--images", action="store_true")
    parser.add_argument("--workbook-dir", type=Path)
    args = parser.parse_args()
    if args.env_file:
        from dotenv import load_dotenv
        load_dotenv(args.env_file)
    manifest = json.loads(args.manifest.read_text())
    if args.images:
        if not args.execute or not args.workbook_dir:
            parser.error("--images requires --execute and --workbook-dir")
        result = asyncio.run(import_images(manifest, args.workbook_dir, args.report))
        print(json.dumps({k: len(v) for k, v in result.items()}))
    else:
        result = asyncio.run(reconcile(manifest, execute=args.execute, backup_dir=args.backup_dir))
        args.report.write_text(json.dumps(result, default=str, indent=2))
        print(json.dumps({k: v for k, v in result.items() if k not in ("products", "source_category_counts", "price_unspecified_new")}))


if __name__ == "__main__":
    main()
