"""Safe, CSW-only Vitra catalog re-import.

This is deliberately separate from ``run_vitra_reimport.py``: it imports only
the supplier's CSW worksheet and never treats the workbook's Sheet1 lookup
table or Sheet2 as products.

Usage (dry-run is the default and does not connect to the database):
    python scripts/run_vitra_csw_reimport.py
    python scripts/run_vitra_csw_reimport.py --execute

``--execute`` backs up only existing Vitra CSW records, supplements media
only for affected CSW SKUs with production-quality supplier artwork, and uses
the normal idempotent catalog import path for product upserts. Low-resolution
supplier artwork never overwrites existing media. Existing media is retained
for rollback; quotations are never read or written by this script.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from catalog_pipeline.adapters.vitra import VitraAdapter  # noqa: E402
from catalog_pipeline.base import MISSING  # noqa: E402
from catalog_pipeline.certifier import validate  # noqa: E402
from catalog_pipeline.vitra_csw_defaults import apply_seat_cover_defaults, build_seat_cover_pairs  # noqa: E402

SOURCE_FILE = Path("/Users/yashvardhansinhjhala/Downloads/Price Table 2026 with Seat Cover August 26.xlsx")
BACKUP_ROOT = Path(__file__).resolve().parent.parent / "backups"
CSW_FAMILY_PREFIX = "vitra:csw:"
# ``excellent`` means an extracted vector or a raster with a 1024px+ long
# edge. Vectors are resolution-independent and are the only supplied assets
# that can meet a high-resolution delivery requirement. The workbook's
# ordinary raster art must never replace existing catalog media.
PRODUCTION_IMAGE_QUALITIES = {"excellent"}


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _auto_accept(rows) -> None:
    """Accept valid CSW commercial data independently from media quality.

    A supplier thumbnail is a media problem, not a reason to omit its real
    SKU, price, series, colour or product detail from the catalog. The execute
    step strips that thumbnail while retaining a valid existing photo.
    """
    for row in rows:
        if (
            row.status == "pending"
            and row.confidence >= 0.85
            and row.sku != MISSING
            and row.mrp != MISSING
            and row.category != MISSING
        ):
            row.status = "accepted"


def parse_csw(source_file: Path) -> tuple[list[dict], dict]:
    """Read CSW only, using saved VLOOKUP results rather than evaluating formulas."""
    data = source_file.read_bytes()
    rows, extraction = VitraAdapter(only_sheets={"CSW"}).extract(data, source_file.name)
    rows, certification = validate(rows)
    _auto_accept(rows)
    public_rows = [row.to_public() for row in rows]
    accepted = [row for row in public_rows if row["status"] == "accepted"]
    review = [row for row in public_rows if row["status"] != "accepted"]
    high_res = [row for row in accepted if row.get("image_quality") in PRODUCTION_IMAGE_QUALITIES]
    seat_cover_pairs, unmatched_wcs = build_seat_cover_pairs(public_rows)
    report = {
        "source": str(source_file),
        "worksheet_scope": ["CSW"],
        "dry_run": True,
        "extraction": extraction.__dict__,
        "certification": certification.to_public(),
        "parsed_count": len(public_rows),
        "accepted_count": len(accepted),
        "review_count": len(review),
        "accepted_image_quality": dict(Counter(row.get("image_quality", "missing") for row in accepted)),
        "production_quality_media_count": len(high_res),
        "seat_cover_defaults": {
            "seat_cover_pairs_planned": len(seat_cover_pairs),
            "wcs_without_supplier_cover": unmatched_wcs,
        },
        "review_rows": [
            {"sku": row.get("sku"), "issues": row.get("issues", [])}
            for row in review
        ],
    }
    return public_rows, report


async def _backup_affected_records(db, brand_id: str, floor_id: str) -> tuple[Path, list[dict], list[dict]]:
    """Back up only the pre-existing CSW catalog slice before any write."""
    affected = await db.products.find(
        {"brand_id": brand_id, "floor_id": floor_id, "family_key": {"$regex": f"^{CSW_FAMILY_PREFIX}"}},
        {"_id": 0},
    ).to_list(5000)
    product_ids = [product["id"] for product in affected]
    media = await db.product_media.find(
        {"product_id": {"$in": product_ids}}, {"_id": 0}
    ).to_list(10000) if product_ids else []
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_dir = BACKUP_ROOT / f"vitra_csw_reimport_{timestamp}"
    backup_dir.mkdir(parents=True, exist_ok=False)
    (backup_dir / "products.json").write_text(json.dumps(affected, default=_json_default, indent=2), encoding="utf-8")
    (backup_dir / "product_media.json").write_text(json.dumps(media, default=_json_default, indent=2), encoding="utf-8")
    return backup_dir, affected, media


async def execute(rows: list[dict], report: dict) -> dict:
    """Apply the pre-reviewed CSW upsert with collision and media safeguards."""
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    from db import db
    from catalog_pipeline.orchestrator import import_accepted

    floor_id = "first-floor"
    brand = await db.brands.find_one(
        {"name": {"$regex": "^vitra$", "$options": "i"}, "floor_id": floor_id}, {"_id": 0}
    )
    if not brand:
        raise RuntimeError(f"Vitra brand not found on {floor_id}; aborting before any writes.")

    accepted = [row for row in rows if row["status"] == "accepted"]
    accepted_skus = [str(row["sku"]) for row in accepted]
    existing_for_skus = await db.products.find(
        {"brand_id": brand["id"], "floor_id": floor_id, "sku": {"$in": accepted_skus}}, {"_id": 0}
    ).to_list(5000)
    non_csw_collisions = [
        product for product in existing_for_skus
        if not str(product.get("family_key") or "").startswith(CSW_FAMILY_PREFIX)
    ]
    if non_csw_collisions:
        collision_skus = sorted(str(product.get("sku")) for product in non_csw_collisions)
        raise RuntimeError(
            "Aborting: CSW SKU(s) would overwrite non-CSW Vitra records: " + ", ".join(collision_skus)
        )

    backup_dir, affected_before, media_before = await _backup_affected_records(db, brand["id"], floor_id)
    report.update({
        "dry_run": False,
        "backup_dir": str(backup_dir),
        "affected_csw_products_before": len(affected_before),
        "affected_csw_media_before": len(media_before),
    })

    # Do not degrade existing artwork with the supplier's thumbnail-grade
    # rasters. Pricing/details may still upsert; media is supplemented only
    # where CSW ships a scalable supplier source, and only for that SKU.
    # Do NOT delete existing product_media first: upload_and_register promotes
    # the new primary through the media contract while retaining a rollback
    # copy if storage or metadata registration fails.
    high_res_skus = {
        str(row["sku"]) for row in accepted
        if row.get("image_quality") in PRODUCTION_IMAGE_QUALITIES and row.get("images")
    }
    report["production_quality_media_skus_submitted"] = len(high_res_skus)
    report["existing_csw_media_deleted"] = 0

    import_rows: list[dict] = []
    withheld_media = 0
    for row in accepted:
        copy = dict(row)
        if copy.get("image_quality") not in PRODUCTION_IMAGE_QUALITIES:
            if copy.get("images"):
                withheld_media += 1
            copy["images"] = []
            copy["image_meta"] = []
        import_rows.append(copy)
    report["accepted_rows_with_non_production_media_withheld"] = withheld_media

    result = await import_accepted(
        {"supplier_name": "Vitra", "rows": import_rows, "floor_id": floor_id},
        user_id="system_vitra_csw_reimport_2026_09",
        floor_id=floor_id,
    )
    report["import_result"] = result

    # The product upserts must finish before we resolve product IDs for the
    # default cover lines.  Only same-series/same-finish source pairs are
    # configured; Smart WCs with no separately listed cover are reported but
    # never given a fabricated component.
    pairs, unmatched_wcs = build_seat_cover_pairs(rows)
    report["seat_cover_defaults"] = await apply_seat_cover_defaults(
        db, brand_id=brand["id"], floor_id=floor_id, pairs=pairs,
    )
    report["seat_cover_defaults"]["wcs_without_supplier_cover"] = unmatched_wcs

    csw_products_after = await db.products.count_documents(
        {"brand_id": brand["id"], "floor_id": floor_id, "family_key": {"$regex": f"^{CSW_FAMILY_PREFIX}"}}
    )
    invalid_price_count = await db.products.count_documents({
        "brand_id": brand["id"], "floor_id": floor_id,
        "family_key": {"$regex": f"^{CSW_FAMILY_PREFIX}"},
        "$or": [{"mrp": {"$lte": 0}}, {"mrp": None}],
    })
    report["post_validation"] = {
        "csw_products": csw_products_after,
        "invalid_or_missing_csw_prices": invalid_price_count,
        "non_csw_collision_count": 0,
        "quotation_snapshots_written": 0,
    }
    if invalid_price_count:
        raise RuntimeError("Post-validation failed: CSW products with missing/invalid prices were found.")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Safely re-import Vitra CSW only.")
    parser.add_argument("--execute", action="store_true", help="Apply writes after the dry-run checks pass.")
    parser.add_argument("--source", type=Path, default=SOURCE_FILE, help="Vitra source .xlsx file.")
    args = parser.parse_args()
    if not args.source.is_file():
        raise SystemExit(f"Source workbook not found: {args.source}")

    rows, report = parse_csw(args.source)
    if args.execute:
        report = asyncio.run(execute(rows, report))
    print(json.dumps(report, default=_json_default, indent=2))


if __name__ == "__main__":
    main()
