"""Import the supplied PCIPL, DVJ, SMIT Bath Line, Shree Ceramic and B.R. catalogs.

The import is idempotent by Ground Floor + brand + deterministic SKU.  It
archives each original workbook in private Supabase storage, persists brands,
categories, jobs and products to MongoDB, and uploads embedded supplier images
to the public Supabase product bucket through the catalog pipeline.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from auth import TILES_FLOOR_ID
from catalog_pipeline.adapters.tile_catalog_2026 import TileCatalog2026Adapter
from catalog_pipeline.base import MISSING
from catalog_pipeline.certifier import validate
from catalog_pipeline.integrity_guard import scan_catalog
from catalog_pipeline.orchestrator import _offload_row_images, import_accepted
from db import db
from media_storage.factory import get_media_storage, private_bucket
from models import CatalogImportJob

SOURCES = (
    ("PCIPL", Path("/Users/yashvardhansinhjhala/Library/Containers/net.whatsapp.WhatsApp/Data/tmp/documents/369B9F09-6432-4E07-9B54-2983CE919CD3/PCIPL 2026.xlsx")),
    ("DVJ", Path("/Users/yashvardhansinhjhala/Library/Containers/net.whatsapp.WhatsApp/Data/tmp/documents/53E686C5-CE5C-49C6-9CE3-F51C326AE743/DVJ 2026.xlsx")),
    ("SMIT Bath Line", Path("/Users/yashvardhansinhjhala/Library/Containers/net.whatsapp.WhatsApp/Data/tmp/documents/75FF6C6C-D469-42F0-8609-B4F93F791C00/SMIT BATH LINE 2026.xlsx")),
    ("Shree Ceramic", Path("/Users/yashvardhansinhjhala/Library/Containers/net.whatsapp.WhatsApp/Data/tmp/documents/5327841B-354C-4606-AA3C-CA8DEAEDCB3B/SHREE CERAMIC 2026.xlsx")),
    ("B.R.", Path("/Users/yashvardhansinhjhala/Library/Containers/net.whatsapp.WhatsApp/Data/tmp/documents/5395DBDE-6C6A-4823-AB0C-09610EA1539B/B.R.2026.xlsx")),
)


def auto_accept(rows):
    for row in rows:
        if row.status == "pending" and row.confidence >= 0.85 and row.sku not in (MISSING, None) and row.mrp not in (MISSING, None) and row.category not in (MISSING, None):
            row.status = "accepted"
    return rows


async def import_source(
    brand: str,
    source: Path,
    *,
    dry_run: bool,
    force_landscape_images: bool = False,
) -> dict:
    data = source.read_bytes()
    rows, extraction = TileCatalog2026Adapter(brand).extract(data, source.name)
    rows, certification = validate(rows)
    rows = auto_accept(rows)
    public_rows = [row.to_public() for row in rows]
    accepted = sum(row["status"] == "accepted" for row in public_rows)
    rejected = sum(row["status"] == "rejected" for row in public_rows)
    summary = {"brand": brand, "source_file": source.name, "source_sha1": hashlib.sha1(data).hexdigest(),
               "total_rows": len(public_rows), "accepted": accepted, "rejected": rejected,
               "images_found": extraction.images_found, "images_mapped": extraction.images_mapped,
               "extraction_warnings": extraction.warnings, "certification": certification.to_public()}
    if not public_rows or rejected or accepted != len(public_rows):
        raise RuntimeError(f"{brand}: catalog validation did not produce a clean accepted batch: {summary}")
    if dry_run:
        return summary

    storage = get_media_storage()
    source_key = f"catalog-sources/{TILES_FLOOR_ID}/{brand.lower().replace(' ', '-')}/{summary['source_sha1']}/{source.name}"
    source_asset = {"bucket": private_bucket(), "storage_key": source_key, "sha1": summary["source_sha1"],
                    "size_bytes": len(data), "content_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
    if not await storage.exists(bucket=private_bucket(), key=source_key):
        stored = await storage.upload(bucket=private_bucket(), key=source_key, data=data,
                                      content_type=source_asset["content_type"], upsert=False, cache_control="private, max-age=0")
        source_asset.update({"sha1": stored.sha1, "size_bytes": stored.size_bytes})
    owner = await db.users.find_one({"email": "owner@forge.app"}, {"id": 1, "_id": 0})
    blob_map = await _offload_row_images(public_rows)
    job = CatalogImportJob(filename=source.name, source_type="excel", supplier_name=brand,
                           total_rows=len(public_rows), accepted_rows=accepted, rejected_rows=rejected,
                           status="classified", rows=public_rows, created_by=(owner or {}).get("id", "system"),
                           floor_id=TILES_FLOOR_ID).model_dump()
    job.update({"extraction": extraction.__dict__, "certification": certification.to_public(), "source_asset": source_asset})
    if force_landscape_images:
        job["force_landscape_images"] = True
    await db.catalog_imports.insert_one(job)
    job.pop("_id", None)
    result = await import_accepted(
        job,
        (owner or {}).get("id", "system"),
        blob_map=blob_map,
        floor_id=TILES_FLOOR_ID,
        force_landscape_images=force_landscape_images,
    )
    status = "imported" if not result["failed"] and not result["skipped"] else "failed"
    await db.catalog_imports.update_one({"id": job["id"]}, {"$set": {"status": status, "accepted_rows": result["imported"] + result["updated"], "rejected_rows": result["skipped"]}})
    if status != "imported":
        raise RuntimeError(f"{brand}: incomplete import: {result}")
    return {**summary, "job_id": job["id"], "source_asset": source_asset, "import_result": result}


async def main(dry_run: bool) -> None:
    missing = [str(source) for _, source in SOURCES if not source.is_file()]
    if missing:
        raise SystemExit("Source workbook not found: " + ", ".join(missing))
    before = await scan_catalog() if not dry_run else None
    if before is not None and not before.ok:
        raise SystemExit("Catalog integrity guard failed before import; no changes made.")
    result = [await import_source(brand, source, dry_run=dry_run) for brand, source in SOURCES]
    after = await scan_catalog() if not dry_run else None
    if after is not None and not after.ok:
        raise SystemExit("Post-import catalog integrity guard failed; imports are recoverable via job snapshots.")
    print(json.dumps({"mode": "dry-run" if dry_run else "import", "brands": result,
                      "catalog_integrity": "passed" if after else None}, indent=2, default=str))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="validate without MongoDB or Supabase writes")
    args = parser.parse_args()
    asyncio.run(main(args.dry_run))
