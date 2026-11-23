"""Parse the reviewed BIANA 2026–2027 workbook and its original product images."""
from __future__ import annotations

from io import BytesIO
from pathlib import Path
import re

from openpyxl import load_workbook

from .framework import make_family_key
from .image_extractor import extract_images_from_xlsx_ex
from .resource_limits import validate_source


SHEET = "Table 1"
FINISHES = {
    "SS": ("SS", "Stainless Steel"),
    "MB": ("Black", "Black"),
    "BGL": ("Br. Gold", "Brushed Gold"),
    "BRG": ("Br. Rose Gold", "Brushed Rose Gold"),
    "BV": ("Br. Bronze", "Brushed Bronze"),
    "GM": ("Br. Gun metal", "Brushed Gun Metal"),
    "CH": ("Chrome", "Chrome"),
    "GL": ("Gold", "Gold"),
    "RG": ("Rose Gold", "Rose Gold"),
}
FAMILY_SIZES = {
    "Tile Insert": ("150 × 150", "125 × 125", "100 × 100"),
    "Drain Channel": ("80 × 600 (Side/Center)", "80 × 750 (Side/Center)", "80 × 900 (Side/Center)"),
    "Popup Coupling": ('5"', '7"'),
}
FAMILY_CODES = {
    "Tile Insert": ("SS", "MB", "BGL", "BRG", "BV", "GM"),
    "Drain Channel": ("SS", "MB", "BGL", "BRG", "BV", "GM"),
    "Popup Coupling": ("CH", "MB", "GL", "RG", "BGL", "BRG", "BV", "GM"),
}


def _product_images(data: bytes) -> dict:
    images = {}
    placements = list(extract_images_from_xlsx_ex(data, optimize=False))
    if len(placements) != 53 or len({image.sha1 for _, _, _, image in placements}) != 34:
        raise ValueError("Expected 53 BIANA image placements referencing 34 distinct assets.")
    separator_count = 0
    for sheet, row, column, image in placements:
        if sheet != SHEET or column != 4 or min(image.width, image.height) == 0:
            raise ValueError(f"Unexpected BIANA image anchor at {sheet}, row {row}, column {column + 1}.")
        # E28 contains a product photo and a 105×2 decorative rule.
        if row == 28 and image.sha1 == "ec482e2e69d9bd39":
            separator_count += 1
            continue
        if row in images:
            raise ValueError(f"Multiple BIANA product images are anchored to E{row}.")
        images[row] = image
    if separator_count != 1 or len({image.sha1 for image in images.values()}) != 33:
        raise ValueError("Expected 33 distinct BIANA product assets and one decorative rule.")
    return images


def extract_rows(source: Path) -> list[dict]:
    data = source.read_bytes()
    validate_source(data, source.name)
    images = _product_images(data)
    expected = {
        (family, size, code)
        for family, sizes in FAMILY_SIZES.items()
        for size in sizes
        for code in FAMILY_CODES[family]
    }
    rows = []
    workbook = load_workbook(BytesIO(data), read_only=True, keep_links=False)
    try:
        if workbook.sheetnames != [SHEET]:
            raise ValueError(f"Expected the BIANA worksheet {SHEET!r}.")
        values = workbook[SHEET].values
        heading = next(values, ())[:6]
        if heading != ("SR.", None, "IMAGES", "SIZE", None, None):
            raise ValueError("Unexpected BIANA column headings.")
        for row, cells in enumerate(values, start=2):
            if all(value is None for value in cells):
                continue
            serial, code, source_size, source_name, image_cell, mrp = cells[:6]
            if image_cell is not None or any(value is not None for value in cells[6:]):
                raise ValueError(f"Unexpected BIANA data columns on row {row}.")
            if not isinstance(source_size, str) or not isinstance(source_name, str) or type(mrp) is not int or mrp <= 0:
                raise ValueError(f"Missing or invalid BIANA description, size, or MRP in row {row}.")
            description = " ".join(source_name.split())
            size = re.sub(r"\s*\*\s*", " × ", " ".join(source_size.split()))
            family = next((label for label in FAMILY_SIZES if description.startswith(label + " ")), None)
            if family is None:
                raise ValueError(f"Unknown BIANA product family in row {row}.")
            source_finish = description[len(family) + 1:]
            # The source describes Brushed Bronze on row 41 without a supplier code.
            variant_code = "BV" if code is None and row == 41 else code
            raw_finish, finish = FINISHES.get(variant_code, (None, None))
            if family == "Popup Coupling" and variant_code == "GM":
                raw_finish = finish = "Gun Metal"
            key = (family, size, variant_code)
            if key not in expected or raw_finish != source_finish:
                raise ValueError(f"Unexpected or duplicate BIANA family, size, or finish in row {row}.")
            expected.remove(key)
            image = images.pop(row, None)
            if image is None:
                raise ValueError(f"BIANA product on row {row} has no image anchored to E{row}.")
            family_name = f"{family} {size}"
            family_key = make_family_key("biana", family, size)
            sku = f"{family_key.replace(':', '-').upper()}-{variant_code}"
            specs = {"source_sheet": SHEET, "source_row": row}
            if serial is not None:
                specs["source_serial"] = serial
            rows.append({
                "row_id": sku,
                "sku": sku,
                "brand": "BIANA",
                "name": f"{family_name} {finish}",
                "category": family,
                "size": size,
                "dimensions": size,
                "description": family_name,
                "family_name": family_name,
                "family_key": family_key,
                "variant": finish,
                "finish": finish,
                "finish_code": code,
                "mrp": mrp,
                "images": [image.data_url],
                "image_meta": [image.to_dict()],
                "image_quality": image.quality,
                "specs": specs,
                "status": "accepted",
            })
    finally:
        workbook.close()
    if expected or images or len(rows) != 52 or len({row["sku"] for row in rows}) != 52:
        raise ValueError("BIANA workbook does not contain exactly 52 distinct variants with product images.")
    return rows
