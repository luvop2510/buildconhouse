"""Resumable, additive GROHE 2026 PDF import.

This migration never replaces GROHE's existing catalogue or media. It only
inserts a source SKU when all of these are true:

* its SKU is unambiguous in the audited PDF manifest;
* a product-code word and one embedded raster share the same PDF column and
  row position; and
* the product remains absent immediately before insertion.

The image is uploaded exclusively through ``upload_and_register`` so every
stored binary has a matching ``product_media`` document.  A failed upload
compensates by deleting its just-created product document. Re-running the
script safely resumes from the next missing SKU.

Examples:
    .venv/bin/python scripts/run_grohe_pricing_2026_import.py --dry-run
    .venv/bin/python scripts/run_grohe_pricing_2026_import.py --execute \
        --confirm-source-images --limit 50 --workers 4
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from catalog_pipeline.adapters.grohe import SKU_RE, extract_concealed_requirements  # noqa: E402
from db import db  # noqa: E402
from models import CatalogImportJob, Product  # noqa: E402
from services.media_service import upload_and_register  # noqa: E402

DEFAULT_PDF = Path("/Users/yashvardhansinhjhala/Downloads/GROHE PRICING 2026.pdf")
DEFAULT_MANIFEST = Path("/tmp/grohe_2026_audit/pdf_products.json")
FLOOR_ID = "first-floor"
SOURCE_NOTE = "GROHE PRICING 2026.pdf"

# These are physical PDF page numbers (not the printed page number), read from
# the document's table of contents and section title pages.  They deliberately
# map to the existing taxonomy rather than creating vague new categories.
PAGE_CATEGORIES = (
    (5, 35, "Faucets"),
    (36, 43, "Thermostats"),
    (45, 61, "Showers"),
    (62, 62, "Angle Valve"),
    (64, 75, "Accessories"),
    (208, 211, "Water Closets"),
    (212, 215, "Basins"),
    (216, 218, "Bathtubs"),
    (219, 221, "Urinals"),
    (223, 224, "Concealed Cisterns"),
    (225, 227, "Flush Plates"),
    (229, 230, "Faucets"),
    (232, 233, "Kitchen Sinks"),
    (234, 238, "Kitchen"),
)


def category_for_page(page: int) -> str | None:
    for first, last, category in PAGE_CATEGORIES:
        if first <= page <= last:
            return category
    return None


def family_key_for_sku(sku: str) -> str:
    """Use GROHE's finish-insensitive article prefix as the variant family."""
    return f"grohe:sku:{sku[:-3].lower()}" if len(sku) > 3 else f"grohe:sku:{sku.lower()}"


def _source_rows(manifest_path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in payload.get("products", []):
        sku = str(row.get("sku") or "").upper().strip()
        name = str(row.get("name") or "").strip()
        if (
            SKU_RE.fullmatch(sku) and name and not SKU_RE.fullmatch(name.upper())
            and row.get("price") and row.get("page")
        ):
            grouped[sku].append({**row, "sku": sku})

    rows: list[dict[str, Any]] = []
    ambiguous: list[str] = []
    for sku, candidates in grouped.items():
        fingerprints = {(r["name"], r["price"], r["page"]) for r in candidates}
        if len(fingerprints) != 1:
            ambiguous.append(sku)
            continue
        row = candidates[0]
        category = category_for_page(int(row["page"]))
        if category:
            row["category"] = category
            rows.append(row)
    return rows, sorted(ambiguous)


def _image_for_source_row(document, row: dict[str, Any]) -> tuple[bytes, int, int, int] | None:
    """Return PNG bytes plus source position for a SKU/image-validated card."""
    import fitz

    page = document[int(row["page"]) - 1]
    midpoint = page.rect.width / 2
    sku_words = [
        (x0, y0)
        for x0, y0, _x1, _y1, text, *_rest in page.get_text("words")
        if text.upper().strip() == row["sku"]
        and (110 <= x0 <= 220 or 680 <= x0 <= 820)
    ]
    if len(sku_words) != 1:
        return None
    sku_x, sku_y = sku_words[0]
    side_left = sku_x < midpoint
    seen: set[tuple[int, float, float, float, float]] = set()
    options: list[tuple[float, int, Any, int, int]] = []
    for image in page.get_images(full=True):
        xref = image[0]
        try:
            pixmap = fitz.Pixmap(document, xref)
        except Exception:
            continue
        # Ceiling showers and rails are legitimately very wide or tall in the
        # supplier layout.  Do not reject a correctly positioned SKU image
        # merely because one dimension is under 30 px; icons/logos are below
        # 15 px and remain excluded.
        if pixmap.width < 15 or pixmap.height < 15:
            continue
        for rect in page.get_image_rects(xref):
            key = (xref, round(rect.x0, 1), round(rect.y0, 1), round(rect.x1, 1), round(rect.y1, 1))
            if key in seen:
                continue
            seen.add(key)
            if (rect.x0 < midpoint) != side_left:
                continue
            distance = abs(rect.y0 - sku_y)
            if distance <= 82:
                options.append((distance, xref, rect, pixmap.width, pixmap.height))
    if not options:
        return None
    _distance, xref, _rect, width, height = min(options, key=lambda option: option[0])
    return fitz.Pixmap(document, xref).tobytes("png"), xref, width, height


def _prepare_candidates(pdf_path: Path, manifest_path: Path) -> tuple[list[dict[str, Any]], list[str], dict[str, list[str]]]:
    import fitz

    rows, ambiguous = _source_rows(manifest_path)
    requirements = extract_concealed_requirements(pdf_path.read_bytes())
    candidates: list[dict[str, Any]] = []
    document = fitz.open(pdf_path)
    try:
        for row in rows:
            image = _image_for_source_row(document, row)
            if not image:
                continue
            data, xref, width, height = image
            candidates.append({
                **row, "image_data": data, "image_xref": xref,
                "source_width": width, "source_height": height,
                "concealed_skus": requirements.get(row["sku"], []),
            })
    finally:
        document.close()
    return candidates, ambiguous, requirements


async def _backfill_existing_categories(brand_id: str, categories: dict[str, dict[str, Any]]) -> int:
    """Correct category values on earlier resumable batches from this PDF."""
    changed = 0
    async for product in db.products.find(
        {"brand_id": brand_id, "floor_id": FLOOR_ID, "tags": "pricing-2026"}, {"_id": 0}
    ):
        page = (product.get("specs") or {}).get("source_page")
        category_name = category_for_page(int(page)) if str(page or "").isdigit() else None
        if category_name and product.get("category_id") != categories[category_name]["id"]:
            await db.products.update_one(
                {"id": product["id"], "brand_id": brand_id, "floor_id": FLOOR_ID},
                {"$set": {"category_id": categories[category_name]["id"], "updated_at": datetime.now(timezone.utc).isoformat()}},
            )
            changed += 1
    return changed


async def _backfill_existing_concealed(brand_id: str, requirements: dict[str, list[str]]) -> int:
    """Apply only the geometry-safe requirement mappings to existing SKUs."""
    changed = 0
    now = datetime.now(timezone.utc).isoformat()
    async for product in db.products.find(
        {"brand_id": brand_id, "floor_id": FLOOR_ID, "sku": {"$in": list(requirements)}}, {"_id": 0}
    ):
        concealed_skus = requirements[product["sku"]]
        if (
            product.get("must_buy_concealed") is True
            and product.get("concealed_skus") == concealed_skus
            and product.get("concealed_sku") == concealed_skus[0]
        ):
            continue
        specs = dict(product.get("specs") or {})
        specs["Must Buy Concealed"] = ", ".join(concealed_skus)
        await db.products.update_one(
            {"id": product["id"], "brand_id": brand_id, "floor_id": FLOOR_ID},
            {"$set": {
                "must_buy_concealed": True, "concealed_sku": concealed_skus[0],
                "concealed_skus": concealed_skus, "specs": specs, "updated_at": now,
            }},
        )
        changed += 1
    return changed


async def run(
    pdf_path: Path, manifest_path: Path, *, execute: bool, confirm_source_images: bool,
    limit: int | None, workers: int,
) -> dict[str, Any]:
    if not pdf_path.is_file():
        raise FileNotFoundError(pdf_path)
    if not manifest_path.is_file():
        raise FileNotFoundError(manifest_path)

    candidates, ambiguous, requirements = _prepare_candidates(pdf_path, manifest_path)
    brand = await db.brands.find_one(
        {"name": {"$regex": "^grohe$", "$options": "i"}, "floor_id": FLOOR_ID}, {"_id": 0}
    )
    if not brand:
        raise RuntimeError("GROHE is missing from first-floor; refusing to create a shadow brand.")
    category_docs = {
        category["name"]: category
        async for category in db.categories.find({"floor_id": FLOOR_ID}, {"_id": 0})
    }
    missing_categories = sorted({row["category"] for row in candidates} - set(category_docs))
    if missing_categories:
        raise RuntimeError(f"Required existing categories are missing: {missing_categories}")

    current_skus = {
        product["sku"]
        async for product in db.products.find(
            {"brand_id": brand["id"], "floor_id": FLOOR_ID}, {"_id": 0, "sku": 1}
        )
    }
    pending = [row for row in candidates if row["sku"] not in current_skus]
    if limit is not None:
        pending = pending[:limit]
    report: dict[str, Any] = {
        "source_rows_with_position_validated_images": len(candidates),
        "ambiguous_source_skus_skipped": ambiguous,
        "existing_grohe_skus": len(current_skus),
        "pending_additions": len(pending),
        "safe_concealed_requirements": len(requirements),
        "dry_run_only": not execute,
    }
    if not execute:
        report["examples"] = [
            {key: row[key] for key in ("sku", "name", "price", "page", "category", "concealed_skus")}
            for row in pending[:20]
        ]
        return report
    if not confirm_source_images:
        raise RuntimeError("Pass --confirm-source-images to execute the reviewed position-validated import.")

    job = CatalogImportJob(
        filename=pdf_path.name, source_type="pdf", status="validated", supplier_name="Grohe",
        total_rows=len(pending), accepted_rows=0, rejected_rows=len(ambiguous), rows=[],
        created_by="grohe-pricing-2026-position-validated-import", floor_id=FLOOR_ID,
    )
    await db.catalog_imports.insert_one(job.model_dump())
    category_backfills = await _backfill_existing_categories(brand["id"], category_docs)
    concealed_backfills = await _backfill_existing_concealed(brand["id"], requirements)
    semaphore = asyncio.Semaphore(max(1, workers))
    added: list[str] = []
    skipped_existing: list[str] = []
    failures: dict[str, str] = {}

    async def insert_one(row: dict[str, Any]) -> None:
        async with semaphore:
            # A second lookup makes a retry/resume idempotent even if a previous
            # process completed an item after this run planned its batch.
            exists = await db.products.find_one(
                {"brand_id": brand["id"], "floor_id": FLOOR_ID, "sku": row["sku"]}, {"_id": 0, "id": 1}
            )
            if exists:
                skipped_existing.append(row["sku"])
                return
            concealed_skus = row["concealed_skus"]
            product = Product(
                floor_id=FLOOR_ID, name=str(row["name"])[:200], sku=row["sku"], brand_id=brand["id"],
                category_id=category_docs[row["category"]]["id"], description=str(row["name"])[:1000],
                family_key=family_key_for_sku(row["sku"]), family_name=str(row["name"])[:200],
                mrp=float(str(row["price"]).replace(",", "")), price=float(str(row["price"]).replace(",", "")),
                specs={
                    "source_catalog": SOURCE_NOTE, "source_page": int(row["page"]),
                    "image_association": "PDF-position-validated", "source_image_xref": row["image_xref"],
                    "Must Buy Concealed": ", ".join(concealed_skus),
                } if concealed_skus else {
                    "source_catalog": SOURCE_NOTE, "source_page": int(row["page"]),
                    "image_association": "PDF-position-validated", "source_image_xref": row["image_xref"],
                },
                tags=["grohe", "pricing-2026", row["category"].lower()], active=True,
                must_buy_concealed=bool(concealed_skus),
                concealed_sku=concealed_skus[0] if concealed_skus else None,
                concealed_skus=concealed_skus,
            )
            try:
                await db.products.insert_one(product.model_dump())
                await upload_and_register(
                    data=row["image_data"], mime="image/png", brand_slug="grohe", product_id=product.id,
                    family_key=product.family_key, brand_id=brand["id"], floor_id=FLOOR_ID,
                    source_type="supplier", role="hero", is_primary=True, sort_order=0,
                    notes=f"{SOURCE_NOTE}; page {row['page']}; PDF position-validated image xref {row['image_xref']}",
                )
                added.append(row["sku"])
            except Exception as exc:
                await db.products.delete_one({"id": product.id, "brand_id": brand["id"], "floor_id": FLOOR_ID})
                failures[row["sku"]] = f"{type(exc).__name__}: {exc}"

    await asyncio.gather(*(insert_one(row) for row in pending))
    status = "imported" if not failures else "failed"
    await db.catalog_imports.update_one(
        {"id": job.id},
        {"$set": {"status": status, "accepted_rows": len(added), "error": json.dumps(failures) if failures else None}},
    )
    no_media = await db.products.aggregate([
        {"$match": {"brand_id": brand["id"], "floor_id": FLOOR_ID}},
        {"$lookup": {"from": "product_media", "localField": "id", "foreignField": "product_id", "as": "media"}},
        {"$match": {"media": {"$size": 0}}}, {"$count": "count"},
    ]).to_list(1)
    report.update({
        "job_id": job.id, "added": len(added), "skipped_existing_during_write": len(skipped_existing),
        "failures": failures, "category_backfills": category_backfills,
        "concealed_requirement_backfills": concealed_backfills,
        "grohe_products_after": await db.products.count_documents({"brand_id": brand["id"], "floor_id": FLOOR_ID}),
        "grohe_products_without_media_after": no_media[0]["count"] if no_media else 0,
        "dry_run_only": False,
    })
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, default=DEFAULT_PDF)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm-source-images", action="store_true")
    parser.add_argument("--limit", type=int, default=50, help="Maximum missing products to add in this resumable run.")
    parser.add_argument("--workers", type=int, default=4, help="Concurrent storage uploads (default: 4).")
    args = parser.parse_args()
    if args.dry_run and args.execute:
        parser.error("Use either --dry-run or --execute, not both.")
    result = asyncio.run(run(
        args.pdf, args.manifest, execute=args.execute, confirm_source_images=args.confirm_source_images,
        limit=args.limit, workers=args.workers,
    ))
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
