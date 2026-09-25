"""Attach workbook dimension diagrams and seat-cover photos to existing Vitra SKUs.

Dry-run by default. The bundled manifest contains only codes verified against
the first-floor Vitra catalog when extracted. Execution rechecks the *current*
database, uploads assets through the normal media service, and never creates
products or changes another brand. Use ``--execute --backup-dir PATH`` after
reviewing the dry-run report.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import mimetypes
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

PACKAGE = Path(__file__).resolve().parent.parent / "catalog_pipeline/data/vitra_dimensions_2026"
MANIFEST = PACKAGE / "manifest.json"
FLOOR_ID = "first-floor"
IMAGE_FIELDS = (("dimension_images", "dimension_image_urls", "dimension"),
                ("seat_cover_images", "seat_cover_image_urls", "seat-cover"))


def _load_manifest() -> list[dict]:
    document = json.loads(MANIFEST.read_text())
    rows = document["products"]
    codes = [row["code"] for row in rows]
    if not rows or len(set(codes)) != len(codes):
        raise RuntimeError("The Vitra image manifest is empty or has duplicate codes")
    for row in rows:
        if not row["code"].strip() or not row.get("sheet") or not isinstance(row.get("row"), int):
            raise RuntimeError(f"Missing exact code or source cell: {row!r}")
        for source_field, _, _ in IMAGE_FIELDS:
            for name in row.get(source_field, []):
                path = (PACKAGE / name).resolve()
                if not path.is_relative_to(PACKAGE.resolve()) or not path.is_file():
                    raise RuntimeError(f"Missing or unsafe image path: {name}")
                if path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
                    raise RuntimeError(f"Unsupported image format: {name}")
    return rows


async def import_images(*, execute: bool, backup_dir: Path | None = None) -> dict:
    from db import db

    rows = _load_manifest()
    brand = await db.brands.find_one(
        {"name": {"$regex": "^vitra$", "$options": "i"}, "floor_id": FLOOR_ID},
        {"_id": 0, "id": 1},
    )
    if not brand:
        raise RuntimeError("First-floor Vitra brand is missing")
    scope = {"brand_id": brand["id"], "floor_id": FLOOR_ID}
    products = await db.products.find(scope, {"_id": 0}).to_list(10000)
    by_code = {product["sku"]: product for product in products}
    if len(by_code) != len(products):
        raise RuntimeError("Duplicate current Vitra SKU; manual resolution required")
    missing = sorted(set(row["code"] for row in rows) - set(by_code))
    if missing:
        raise RuntimeError(f"Manifest codes absent from current Vitra database: {missing}")
    changed_ids = sorted(row["code"] for row in rows if row.get("product_id") != by_code[row["code"]]["id"])
    if changed_ids:
        raise RuntimeError(f"Vitra product identity changed since workbook verification: {changed_ids}")
    for row in rows:
        if row.get("review_required") and row.get("dimension_images"):
            raise RuntimeError(f"Review-required drawings cannot be automatically imported: {row['code']}")
    counts = Counter()
    for row in rows:
        for source_field, _, _ in IMAGE_FIELDS:
            counts[source_field] += len(row.get(source_field, []))
    report = {
        "current_vitra_products": len(products),
        "exact_matched_codes": len(rows),
        "dimension_photos": counts["dimension_images"],
        "seat_cover_photos": counts["seat_cover_images"],
        "dimension_codes_held_for_review": [row["code"] for row in rows if row.get("review_required")],
        "dry_run": not execute,
    }
    if not execute:
        return report
    if backup_dir is None or backup_dir.exists():
        raise RuntimeError("Execution requires a new --backup-dir")

    media = await db.product_media.find(
        {"product_id": {"$in": [by_code[row["code"]]["id"] for row in rows]}},
        {"_id": 0},
    ).to_list(10000)
    backup_dir.mkdir(parents=True)
    (backup_dir / "products.json").write_text(json.dumps([by_code[row["code"]] for row in rows], default=str, indent=2))
    (backup_dir / "product_media.json").write_text(json.dumps(media, default=str, indent=2))
    (backup_dir / "report_before.json").write_text(json.dumps(report, indent=2))

    from services import catalog_service, media_service

    uploaded = 0
    for row in rows:
        product = by_code[row["code"]]
        updates = {}
        for source_field, target_field, role in IMAGE_FIELDS:
            urls = list(product.get(target_field) or [])
            for order, name in enumerate(row.get(source_field, [])):
                path = PACKAGE / name
                mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
                attached = await media_service.upload_and_register(
                    data=path.read_bytes(), mime=mime, brand_slug="vitra",
                    product_id=product["id"], brand_id=brand["id"], floor_id=FLOOR_ID,
                    source_type="supplier", role=role, sort_order=order,
                    notes=f"{row['sheet']}!{row['row']} from ONLY FOR MM NOT MRP .xlsx; exact SKU {row['code']}",
                )
                if not attached.public_url:
                    raise RuntimeError(f"Uploaded asset has no public URL: {name}")
                if attached.public_url not in urls:
                    urls.append(attached.public_url)
                uploaded += 1
            if urls != (product.get(target_field) or []):
                updates[target_field] = urls
        if updates:
            result = await db.products.update_one({**scope, "id": product["id"], "sku": row["code"]}, {"$set": updates})
            if result.matched_count != 1:
                raise RuntimeError(f"Current product changed during import: {row['code']}")
            catalog_service.patch_product_in_snapshot(product["id"], updates)
    report.update(dry_run=False, assets_processed=uploaded, backup_dir=str(backup_dir))
    (backup_dir / "report_after.json").write_text(json.dumps(report, indent=2))
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--env-file", type=Path)
    args = parser.parse_args()
    if args.env_file:
        from dotenv import load_dotenv
        load_dotenv(args.env_file, override=False)
    print(json.dumps(asyncio.run(import_images(execute=args.execute, backup_dir=args.backup_dir)), indent=2))


if __name__ == "__main__":
    main()
