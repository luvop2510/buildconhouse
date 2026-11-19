"""Import the Ground Floor BRAQ 2026 workbook through the tile catalog pipeline."""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import math
import re
from collections import Counter
from pathlib import Path

from openpyxl import load_workbook

from run_tile_catalog_2026_import import TILES_FLOOR_ID, db, import_rows, scan_catalog
from catalog_pipeline.adapters.tile_catalog_2026 import CATEGORY, _slug
from catalog_pipeline.base import MISSING, ExtractionReport, ProductRow
from catalog_pipeline.image_extractor import extract_images_from_xlsx_ex

BRAND = "BRAQ"
HEADERS = ("NO", "NAME", "PHOTO", "SIZE", "BOX IN PCS", "BOX SQFT", "RATE PER SQFT")


def extract(data: bytes, filename: str) -> tuple[list[ProductRow], ExtractionReport]:
    workbook = load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    try:
        sheet = workbook["Sheet1"]
        values = list(sheet.values)
    finally:
        workbook.close()
    if not values or values[0] != HEADERS:
        raise ValueError("Unexpected BRAQ catalogue headers")

    images = {}
    for sheet_name, row, column, image in extract_images_from_xlsx_ex(data, optimize=False):
        if (sheet_name, column) != ("Sheet1", 2) or row in images:
            raise ValueError(f"Unexpected or ambiguous photo anchor at {sheet_name} row {row}")
        images[row] = image
    unique_images = len({image.sha1 for image in images.values()})
    report = ExtractionReport(brand=BRAND, filename=filename, source_type="excel",
                              raw_rows=len(values) - 1, images_found=len(images))
    listings = Counter((row[1], row[3]) for row in values[1:])
    rows, serials = [], set()
    for number, (serial, name, _, size, pieces, coverage, rate) in enumerate(values[1:], 2):
        rate_match = re.fullmatch(r"(\d+(?:\.\d+)?) PER SQFT", str(rate))
        image = images.pop(number, None)
        if image is None:
            raise ValueError(f"Sheet1 row {number} is missing its PHOTO anchor")
        if (type(serial) is not int or serial <= 0 or serial in serials
                or not isinstance(name, str) or not name.strip() or len(name) > 200
                or not isinstance(size, str) or not size.strip()
                or type(pieces) is not int or pieces <= 0
                or type(coverage) not in (int, float) or not math.isfinite(coverage) or coverage <= 0
                or rate_match is None):
            raise ValueError(f"Sheet1 row {number} has invalid or duplicate catalogue data")
        serials.add(serial)
        price = float(rate_match[1])
        # The catalog requires a SKU. Use the workbook's NO as its internal
        # import key, preserving both listings even when name and size repeat.
        rows.append(ProductRow(
            brand=BRAND, sku=str(serial), name=name, size=size,
            category=CATEGORY, family_key=f"braq:{_slug(name)}", family_name=name,
            variant=f"{pieces} pcs/box" if listings[name, size] > 1 else MISSING,
            mrp=price, dealer_price=price, images=[image.data_url],
            image_meta=[image.to_dict()], image_quality=image.quality,
            specs={"source_file": filename, "source_row": number, "source_serial": serial,
                   "source_rate": rate, "price_unit": "sqft",
                   "pcs_per_box": pieces, "sqft_per_box": coverage},
        ))
    if images or serials != set(range(1, 195)) or unique_images != 193:
        raise ValueError(f"Expected 194 product rows and 193 unique images. Unassigned photo rows: {sorted(images)}")
    report.parsed_rows = report.images_mapped = len(rows)
    return rows, report


def match_existing(rows: list[ProductRow], products: list[dict]) -> None:
    matched = set()
    for row in rows:
        def matches(product):
            specs = product.get("specs") or {}
            if specs.get("source_file") == row.specs["source_file"] and specs.get("source_serial") is not None:
                return str(specs["source_serial"]) == str(row.specs["source_serial"])
            return (
                str(product.get("name") or "").strip().casefold() in
                {row.name.strip().casefold(), f"{row.name} ({row.size})".casefold()}
                and str(product.get("size") or product.get("dimensions") or "").strip().casefold() == row.size.casefold()
                and str(specs.get("pcs_per_box", specs.get("box_pieces"))) == str(row.specs["pcs_per_box"])
                and float(specs.get("sqft_per_box", specs.get("box_sqft")) or 0) == row.specs["sqft_per_box"]
            )

        candidates = [product for product in products if matches(product)]
        if len(candidates) > 1 or any(
            product["sku"] == row.sku and product not in candidates for product in products
        ):
            raise ValueError(f"Ambiguous existing BRAQ product for source row {row.specs['source_row']}")
        if candidates:
            product = candidates[0]
            if product["id"] in matched:
                raise ValueError(f"Existing BRAQ product matches multiple rows: {product['id']}")
            matched.add(product["id"])
            row.sku = product["sku"]
    if len(matched) != len(products):
        raise ValueError(f"{len(products) - len(matched)} BRAQ products require manual matching")


async def main(source: Path, apply: bool) -> None:
    data = source.read_bytes()
    rows, report = extract(data, source.name)
    brand_name = BRAND
    if apply:
        scope = {"floor_id": TILES_FLOOR_ID}
        brands = await db.brands.find({
            **scope, "$or": [{"name": {"$regex": "^BRAQ$", "$options": "i"}}, {"slug": "braq"}],
        }).to_list(2)
        if len(brands) > 1:
            raise ValueError("Multiple existing Ground Floor BRAQ brands require review")
        if not await db.categories.find_one({**scope, "name": CATEGORY}):
            raise ValueError("Ground Floor Tiles category is missing")
        if brands:
            brand_name = brands[0]["name"]
            products = await db.products.find({**scope, "brand_id": brands[0]["id"]}).to_list(None)
            match_existing(rows, products)
        if not (await scan_catalog()).ok:
            raise ValueError("Catalog integrity guard failed before import")
    result = await import_rows(brand_name, source, data, rows, report, dry_run=not apply)
    print(json.dumps({**result, "unique_images": 193}, default=str))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--apply", action="store_true", help="Write to the configured MongoDB and object storage")
    args = parser.parse_args()
    asyncio.run(main(args.workbook, args.apply))
