"""Legacy entry point for the position-validated GROHE 2026 importer.

Use ``run_grohe_pricing_2026_import.py`` directly for new operations.  This
filename is retained so an existing runbook cannot accidentally invoke the
old text-only importer, which could not verify product/image associations.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from catalog_pipeline.adapters.grohe import GroheAdapter  # noqa: E402
from catalog_pipeline.base import MISSING  # noqa: E402
from db import db  # noqa: E402
from models import CatalogImportJob, Category, Product  # noqa: E402

DEFAULT_PDF = Path("/Users/yashvardhansinhjhala/Downloads/GROHE PRICING 2026.pdf")
FLOOR_ID = "first-floor"
SOURCE_NOTE = "GROHE PRICING 2026.pdf"


def _clean(value):
    return None if value in (None, "", MISSING) else value


def _select_source_rows(pdf_path: Path) -> tuple[dict[str, object], dict]:
    """Parse once and reject duplicate SKU definitions rather than guessing."""
    rows, extraction = GroheAdapter().extract(pdf_path.read_bytes(), pdf_path.name)
    grouped: dict[str, list] = defaultdict(list)
    for row in rows:
        if row.sku != MISSING and row.mrp != MISSING and row.category != MISSING:
            grouped[row.sku].append(row)

    selected: dict[str, object] = {}
    ambiguous: list[str] = []
    for sku, candidates in grouped.items():
        fingerprints = {
            (candidate.name, candidate.mrp, candidate.category, candidate.concealed_sku)
            for candidate in candidates
        }
        if len(fingerprints) == 1:
            selected[sku] = candidates[0]
        else:
            ambiguous.append(sku)
    return selected, {
        "extraction": extraction.__dict__,
        "source_rows": len(rows),
        "eligible_rows": sum(len(rows) for rows in grouped.values()),
        "unique_rows": len(selected),
        "ambiguous_skus_skipped": sorted(ambiguous),
    }


def _specs_for(row) -> dict:
    specs = {
        "source_catalog": SOURCE_NOTE,
        "source_page": row.image_page,
        "image_import": "not imported: PDF thumbnails are not SKU-safe source media",
    }
    if row.must_buy_concealed and row.concealed_sku:
        specs["Must Buy Concealed"] = row.concealed_sku
    return specs


async def run(pdf_path: Path, *, execute: bool, reviewed_requirements: bool = False) -> dict:
    if not pdf_path.is_file():
        raise FileNotFoundError(f"Pricing PDF not found: {pdf_path}")
    source, report = _select_source_rows(pdf_path)
    brand = await db.brands.find_one(
        {"name": {"$regex": "^grohe$", "$options": "i"}, "floor_id": FLOOR_ID},
        {"_id": 0},
    )
    if not brand:
        raise RuntimeError("Grohe brand is missing from first-floor; refusing to create an unreviewed brand.")

    current = {
        product["sku"]: product
        async for product in db.products.find(
            {"brand_id": brand["id"], "floor_id": FLOOR_ID}, {"_id": 0}
        )
    }
    existing = {sku: row for sku, row in source.items() if sku in current}
    # The PDF contains only thumbnail-grade imagery (<320px).  A missing SKU
    # therefore remains a review candidate, not an image-less catalog entry:
    # this task explicitly preserves the catalog's correctly displayed media.
    additions = {sku: row for sku, row in source.items() if sku not in current}
    label_updates = {
        sku: row for sku, row in existing.items()
        if row.must_buy_concealed and (
            current[sku].get("must_buy_concealed") is not True
            or current[sku].get("concealed_sku") != _clean(row.concealed_sku)
            or current[sku].get("specs", {}).get("Must Buy Concealed") != _clean(row.concealed_sku)
        )
    }
    report.update({
        "existing_skus_preserved": len(existing),
        "missing_products_needing_verified_media": len(additions),
        "concealed_requirement_updates": len(label_updates),
        "existing_media_preserved": await db.product_media.count_documents({"brand_id": brand["id"]}),
        "source_has_no_safe_pdf_media": True,
    })
    if not execute:
        report["dry_run_only"] = True
        report["examples_to_add"] = [
            {"sku": sku, "name": row.name, "mrp": row.mrp, "category": row.category,
             "must_buy_concealed": row.must_buy_concealed, "concealed_sku": row.concealed_sku}
            for sku, row in list(additions.items())[:20]
        ]
        return report

    if not reviewed_requirements:
        raise RuntimeError(
            "Refusing to write concealed requirements from unreviewed PDF text overlays. "
            "Review the dry-run manifest, then pass --confirm-reviewed-requirements."
        )

    # Auditable maker/checker record plus before-images for a narrow rollback.
    job = CatalogImportJob(
        filename=pdf_path.name, source_type="pdf", status="validated",
        supplier_name="Grohe", total_rows=len(source), accepted_rows=0,
        rejected_rows=len(report["ambiguous_skus_skipped"]), rows=[],
        created_by="grohe-pricing-2026-additive-script", floor_id=FLOOR_ID,
    )
    await db.catalog_imports.insert_one(job.model_dump())
    snapshots: list[dict] = []
    now = datetime.now(timezone.utc).isoformat()

    # No new records are inserted from this source because no SKU has a
    # verified acceptable-or-better image.  Keep the block deliberately empty
    # rather than accepting the PDF's visually plausible but wrong/low-res
    # page thumbnails.
    additions = {}
    categories = {
        category["name"].lower(): category
        async for category in db.categories.find({"floor_id": FLOOR_ID}, {"_id": 0})
    }
    created_categories = []
    for row in additions.values():
        key = row.category.lower()
        if key in categories:
            continue
        category = Category(
            name=row.category,
            slug="-".join(filter(None, row.category.lower().split())),
            floor_id=FLOOR_ID,
        )
        await db.categories.insert_one(category.model_dump())
        categories[key] = category.model_dump()
        created_categories.append(row.category)

    updated = 0
    for sku, row in label_updates.items():
        previous = current[sku]
        snapshots.append({"job_id": job.id, "product_id": previous["id"], "was_new": False,
                          "previous": previous, "created_at": now})
        specs = dict(previous.get("specs") or {})
        if row.concealed_sku:
            specs["Must Buy Concealed"] = row.concealed_sku
        else:
            specs.pop("Must Buy Concealed", None)
        await db.products.update_one(
            {"id": previous["id"], "brand_id": brand["id"], "floor_id": FLOOR_ID},
            {"$set": {"must_buy_concealed": row.must_buy_concealed,
                      "concealed_sku": _clean(row.concealed_sku), "specs": specs,
                      "concealed_skus": list(row.concealed_skus or ([row.concealed_sku] if row.concealed_sku else [])),
                      "updated_at": now}},
        )
        updated += 1

    inserted = 0
    for sku, row in additions.items():
        category = categories[row.category.lower()]
        product = Product(
            floor_id=FLOOR_ID, name=row.name[:200], sku=sku, brand_id=brand["id"],
            category_id=category["id"], series=_clean(row.series),
            family_key=_clean(row.family_key), family_name=_clean(row.name),
            variant_label=_clean(row.variant), finish=_clean(row.finish),
            dimensions=_clean(row.dimensions), description=_clean(row.description),
            mrp=float(row.mrp), price=float(row.mrp), specs=_specs_for(row),
            tags=["grohe", row.category.lower(), "pricing-2026"],
            must_buy_concealed=row.must_buy_concealed,
            concealed_sku=_clean(row.concealed_sku),
            concealed_skus=list(row.concealed_skus or ([row.concealed_sku] if row.concealed_sku else [])), active=True,
        )
        snapshots.append({"job_id": job.id, "product_id": product.id, "was_new": True,
                          "previous": None, "created_at": now})
        await db.products.insert_one(product.model_dump())
        inserted += 1

    if snapshots:
        await db.catalog_import_snapshots.insert_many(snapshots)
    await db.catalog_imports.update_one(
        {"id": job.id}, {"$set": {"status": "imported", "accepted_rows": inserted + updated}},
    )
    report.update({
        "job_id": job.id, "added": inserted, "labelled_existing": updated,
        "created_categories": created_categories, "dry_run_only": False,
    })
    return report


def main() -> None:
    # Preserve the former command name, but route every invocation through the
    # audited image-position importer. Its confirmation flag is deliberately
    # renamed to make the source-media review explicit.
    from run_grohe_pricing_2026_import import main as validated_main
    if "--confirm-reviewed-requirements" in sys.argv:
        sys.argv.remove("--confirm-reviewed-requirements")
        sys.argv.append("--confirm-source-images")
    validated_main()
    return

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, default=DEFAULT_PDF)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Validate and report only (the default).")
    mode.add_argument("--execute", action="store_true", help="Write the additive changes to Atlas.")
    parser.add_argument(
        "--confirm-reviewed-requirements", action="store_true",
        help="Required with --execute after visually reviewing every concealed-SKU candidate.",
    )
    args = parser.parse_args()
    result = asyncio.run(run(args.pdf, execute=args.execute, reviewed_requirements=args.confirm_reviewed_requirements))
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
