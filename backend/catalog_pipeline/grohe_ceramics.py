"""Reviewed GROHE ceramics cards from printed pages 405–427."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

MANIFEST_PATH = Path(__file__).with_name("data") / "grohe_ceramics_2026.json"


def load_manifest() -> dict:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    rows = manifest["products"]
    by_sku = {row["sku"]: row for row in rows}
    if (len(rows) != 82 or len(by_sku) != len(rows)
            or manifest["printed_page_range"] != [405, 427]):
        raise ValueError("Expected 82 distinct GROHE ceramics articles from printed pages 405–427.")
    for row in rows:
        if cover_sku := row.get("seat_cover_sku"):
            cover = by_sku[cover_sku]
            if (row.get("seat_cover_included") is not False or row["category"] != "WC"
                    or cover["product_type"] != "Seat Cover" or cover["finish"] != row["finish"]
                    or cover["series"] != row["series"]):
                raise ValueError(f"Seat cover details disagree with the reviewed WC for {row['sku']}.")
    return manifest


def extract_images(source: bytes, manifest: dict) -> dict[int, tuple[bytes, str]]:
    if hashlib.sha256(source).hexdigest() != manifest["pdf_sha256"]:
        raise ValueError("The supplied PDF differs from the reviewed GROHE pricing catalogue.")
    import fitz

    assets: dict[int, tuple[bytes, str]] = {}
    with fitz.open(stream=source, filetype="pdf") as document:
        spreads = {pdf_page: document[pdf_page - 1].get_image_info(xrefs=True)
                   for pdf_page in {row["pdf_page"] for row in manifest["products"]}}
        for row in manifest["products"]:
            pdf_page = row["pdf_page"]
            xref = row["image_xref"]
            offset = 1 if row["image_rect"][0] >= document[pdf_page - 1].rect.width / 2 else 0
            if not (405 <= row["printed_page"] <= 427
                    and row["printed_page"] == 2 * pdf_page - 4 + offset
                    and any(
                        item["xref"] == xref
                        and [round(value, 2) for value in item["bbox"]] == row["image_rect"]
                        and [item["width"], item["height"]] == row["image_size"]
                        for item in spreads[pdf_page]
                    )):
                raise ValueError(f"Image position disagrees with the reviewed card for {row['sku']}.")
            if xref not in assets:
                image = document.extract_image(xref)
                assets[xref] = image["image"], f"image/{image['ext']}"
            data, mime = assets[xref]
            if hashlib.sha256(data).hexdigest() != row["image_sha256"] or mime not in {"image/jpeg", "image/png"}:
                raise ValueError(f"Image bytes disagree with the reviewed card for {row['sku']}.")
    return assets
