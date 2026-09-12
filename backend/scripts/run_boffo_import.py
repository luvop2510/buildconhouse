"""Import BOFFO 2026 into Ground Floor > Tiles with verified landscape media.

The source workbook is archived in private Supabase Storage.  Product and
media metadata are persisted in MongoDB; supplier images are stored in the
public Supabase product bucket.  Portrait source artwork is padded, never
rotated or cropped, to an actual 16:10 landscape raster before upload.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from auth import TILES_FLOOR_ID  # noqa: E402
from catalog_pipeline.integrity_guard import scan_catalog  # noqa: E402
from db import db  # noqa: E402
from media_storage import get_media_storage  # noqa: E402
from run_tile_catalog_2026_import import import_source  # noqa: E402


BRAND = "BOFFO"
DEFAULT_SOURCE = Path("/Users/yashvardhansinhjhala/Downloads/BOFFO 2026.xlsx")


async def _verify_landscape_media() -> dict:
    """Prove that Mongo metadata and the bytes stored in Supabase agree."""
    brand = await db.brands.find_one({"name": BRAND, "floor_id": TILES_FLOOR_ID}, {"_id": 0, "id": 1})
    if not brand:
        raise RuntimeError("BOFFO brand was not created in MongoDB")
    products = await db.products.find(
        {"brand_id": brand["id"], "floor_id": TILES_FLOOR_ID}, {"_id": 0, "id": 1, "sku": 1},
    ).to_list(100)
    if len(products) != 38:
        raise RuntimeError(f"Expected 38 BOFFO products in MongoDB, found {len(products)}")
    product_ids = [product["id"] for product in products]
    media = await db.product_media.find(
        {"brand_id": brand["id"], "floor_id": TILES_FLOOR_ID, "source_type": "supplier", "product_id": {"$in": product_ids}},
        {"_id": 0, "product_id": 1, "bucket": 1, "storage_key": 1, "width": 1, "height": 1},
    ).to_list(100)
    if len(media) != 38:
        raise RuntimeError(f"Expected 38 BOFFO supplier-media records in MongoDB, found {len(media)}")
    if {row.get("product_id") for row in media} != set(product_ids):
        raise RuntimeError("Every BOFFO product must have exactly one supplier media record")

    storage = get_media_storage()
    inspected: list[tuple[int, int]] = []
    for asset in media:
        raw = await storage.download(bucket=asset["bucket"], key=asset["storage_key"])
        with Image.open(io.BytesIO(raw)) as image:
            width, height = image.size
        if width <= height:
            raise RuntimeError(f"Stored media is not landscape: {asset['storage_key']} ({width}x{height})")
        if (asset.get("width"), asset.get("height")) != (width, height):
            raise RuntimeError(f"Mongo media dimensions do not match Supabase bytes: {asset['storage_key']}")
        inspected.append((width, height))
    return {"products": len(products), "media": len(media), "all_landscape": True, "dimensions": sorted(set(inspected))}


async def main(source: Path, dry_run: bool) -> None:
    if not source.is_file():
        raise SystemExit(f"Source workbook not found: {source}")
    if not dry_run:
        pre = await scan_catalog()
        if not pre.ok:
            raise SystemExit("Catalog integrity check failed before import; no changes made.")
    result = await import_source(BRAND, source, dry_run=dry_run, force_landscape_images=True)
    verification = None if dry_run else await _verify_landscape_media()
    post = None if dry_run else await scan_catalog()
    if post is not None and not post.ok:
        raise SystemExit("Catalog integrity check failed after BOFFO import.")
    print(json.dumps({"mode": "dry-run" if dry_run else "import", "result": result,
                      "verification": verification, "catalog_integrity": "passed" if post else None}, indent=2, default=str))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--dry-run", action="store_true", help="Validate without MongoDB or Supabase writes")
    options = parser.parse_args()
    asyncio.run(main(options.source, options.dry_run))
