"""Read and compare the Ground Floor MCM workbook. Does not write to Mongo or R2."""
from __future__ import annotations

import argparse
import asyncio
import base64
from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from catalog_pipeline.adapters.tile_catalog_2026 import MCMAdapter
from catalog_pipeline.certifier import validate
from catalog_pipeline.image_extractor import extract_images_from_xlsx_ex
from services.product_image_normalizer import normalize_product_image

FLOOR = "ground-floor"
BRAND = "MCM"
BRAND_IDENTITY = {"$regex": r"^\s*m\s*\.?\s*c\s*\.?\s*m\s*\.?\s*$", "$options": "i"}
SIZE_SUFFIX = re.compile(r"\s*\((\d+\s*[x×]\s*\d+(?:\s*mm)?)\)\s*$", re.I)


def normalized(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").casefold())


def size_key(size):
    return normalized(str(size or "").replace("×", "x")).removesuffix("mm")


def name_key(name, size):
    text = str(name or "")
    old_suffix = SIZE_SUFFIX.search(text)
    if old_suffix and size_key(old_suffix[1]) == size_key(size):
        text = text[:old_suffix.start()]
    return normalized(text)


def identity(name, size, finish):
    return name_key(name, size), size_key(size), normalized(finish)


def positive_decimal(value):
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return parsed if parsed.is_finite() and parsed > 0 else None


def image_hashes(row):
    header, encoded = row.images[0].split(",", 1)
    mime = header.removeprefix("data:").split(";", 1)[0]
    raw = base64.b64decode(encoded, validate=True)
    normalized_payload, _ = normalize_product_image(raw, mime)
    return hashlib.sha256(raw).hexdigest(), hashlib.sha1(normalized_payload).hexdigest()


def read_source(source):
    data = source.read_bytes()
    rows, extraction = MCMAdapter().extract(data, source.name)
    rows, _ = validate(rows)
    expected_anchors = Counter((row.specs["source_row"], 2) for row in rows)
    anchors = list(extract_images_from_xlsx_ex(data, optimize=False))
    actual_anchors = Counter((index, col) for _, index, col, _ in anchors)
    if (len({sheet for sheet, *_ in anchors}) != 1 or extraction.warnings
            or len(rows) != 53 or expected_anchors != actual_anchors):
        raise ValueError("Expected 53 MCM workbook rows with exactly one image in each product image cell")
    if len({identity(row.name, row.size, row.finish) for row in rows}) != len(rows):
        raise ValueError("Workbook repeats a product, size and finish")
    serials = {row.specs["source_serial"] for row in rows}
    if serials != {str(i) for i in range(1, len(rows) + 1)}:
        raise ValueError("Missing or duplicate MCM worksheet serial")
    for row in rows:
        pieces = positive_decimal(row.specs["pcs_per_box"])
        if (row.issues or row.specs["price_unit"] != "sqft" or row.finish != "STONE" or len(row.images) != 1
                or not positive_decimal(row.mrp) or not positive_decimal(row.specs["sqft_per_box"])
                or pieces is None or pieces != pieces.to_integral_value()):
            raise ValueError(f"Invalid workbook price, packaging, finish or image on row {row.specs['source_row']}")
    return data, rows


async def compare(database, rows, *, session=None):
    brands = await database.brands.find(
        {"$or": [{"name": BRAND_IDENTITY}, {"slug": BRAND_IDENTITY}]},
        {"_id": 0, "id": 1, "name": 1, "slug": 1, "floor_id": 1}, session=session,
    ).sort("id", 1).to_list()
    ground_brands = [brand for brand in brands if brand.get("floor_id") == FLOOR]
    brand = ground_brands[0] if len(ground_brands) == 1 else None
    scope = {"floor_id": FLOOR, "brand_id": {"$in": [brand["id"] for brand in ground_brands]}}
    products = await database.products.find(scope, {"_id": 0}, session=session).sort("id", 1).to_list()
    media = await database.product_media.find(scope, {"_id": 0}, session=session).sort("id", 1).to_list()
    by_identity, by_sku, by_name, media_by_product = (defaultdict(list) for _ in range(4))
    for product in products:
        key = identity(product.get("name"), product.get("size"), product.get("finish"))
        by_identity[key].append(product)
        by_sku[product["sku"]].append(product)
        by_name[key[0]].append(product)
    for item in media:
        media_by_product[item.get("product_id")].append(item)
    comparable_names = {identity(row.name, row.size, row.finish)[0] for row in rows}
    aliases = []
    async for product in database.products.find(
        {"floor_id": FLOOR, "brand_id": {"$nin": [brand["id"] for brand in ground_brands]}},
        {"_id": 0, "name": 1, "size": 1, "finish": 1, "sku": 1, "brand_id": 1}, session=session,
    ).sort("_id", 1):
        if name_key(product.get("name"), product.get("size")) in comparable_names or (product.get("sku") or "").upper().startswith("MCM-"):
            aliases.append(product)

    seen = set()
    details = []
    for row in rows:
        raw_digest, supplier_digest = image_hashes(row)
        item_key = identity(row.name, row.size, row.finish)
        matches = by_identity[item_key]
        sku_matches = by_sku[row.sku]
        same_name = by_name[item_key[0]]
        planned = {
            "excel_row": row.specs["source_row"], "name": row.name, "size": row.size, "finish": row.finish,
            "generated_sku": row.sku, "old_price_per_sqft": None, "new_price_per_sqft": row.mrp,
            "pieces_per_box": int(row.specs["pcs_per_box"]), "sqft_per_box": float(row.specs["sqft_per_box"]),
            "source_image_sha256": raw_digest, "normalized_image_sha1": supplier_digest,
            "image_change": False,
        }
        details.append(planned)
        if len(matches) > 1 or any(match not in matches for match in sku_matches):
            planned.update(status="ambiguous", candidate_ids=sorted({p["id"] for p in matches + sku_matches}))
            seen.update(planned["candidate_ids"])
            continue
        if not matches:
            if any(not sibling.get("size") or not sibling.get("finish") or sibling.get("variants") for sibling in same_name):
                planned.update(status="ambiguous", candidate_ids=[p["id"] for p in same_name])
                seen.update(planned["candidate_ids"])
            else:
                planned.update(status="new_variant" if same_name else "new_product", image_change=True)
            continue

        product = matches[0]
        seen.add(product["id"])
        specs = product.get("specs") or {}
        owned_media = media_by_product[product["id"]]
        spec_changes = {}
        desired = {"name": row.name, "size": row.size, "finish": row.finish, "price_unit": "sqft",
                   "pcs_per_box": planned["pieces_per_box"], "sqft_per_box": planned["sqft_per_box"]}
        current = {"name": product.get("name"), "size": product.get("size"), "finish": product.get("finish"),
                   "price_unit": specs.get("price_unit") or specs.get("rate_unit"),
                   "pcs_per_box": specs.get("pcs_per_box") or specs.get("box_pieces"),
                   "sqft_per_box": specs.get("sqft_per_box") or specs.get("box_sqft")}
        for key, value in desired.items():
            old = current[key]
            if key in ("pcs_per_box", "sqft_per_box"):
                changed = positive_decimal(old) != positive_decimal(value)
            else:
                changed = old != value
            if changed:
                spec_changes[key] = {"before": old, "after": value}
        price_changed = any(product.get(key) != row.mrp for key in ("price", "mrp"))
        image_changed = not any(
            m.get("sha1") == supplier_digest and m.get("is_primary") and m.get("public_url")
            for m in owned_media
        )
        planned.update(
            status="specifications" if spec_changes or image_changed else "price" if price_changed else "unchanged",
            product_id=product["id"], current_sku=product["sku"], current_unit=current["price_unit"],
            old_price_per_sqft=product.get("price") if current["price_unit"] == "sqft" else None,
            old_catalog_price=product.get("price"), old_catalog_mrp=product.get("mrp"),
            price_change=price_changed, specifications_changed=spec_changes, image_change=image_changed,
            existing_image_references=[{"media_id": m["id"], "sha1": m["sha1"], "url": m.get("public_url")} for m in owned_media],
        )

    # A second size/finish for a brand-new product is a variant, not another
    # standalone family. Keep a source row for every concrete SKU.
    new_names = set()
    for planned in details:
        if planned["status"] == "new_product":
            key = name_key(planned["name"], planned["size"])
            if key in new_names:
                planned["status"] = "new_variant"
            new_names.add(key)

    counts = Counter(planned["status"] for planned in details)
    absent = [p for p in products if p["id"] not in seen]
    return {
        "brand": brand,
        "brand_matches_all_floors": brands,
        "production_mcm_products": len(products),
        "production_mcm_media": len(media),
        "other_brand_near_matches": aliases,
        "blocked_reason": "Expected exactly one existing Ground Floor MCM brand" if not brand else None,
        "comparison": {
            "existing_unchanged": counts["unchanged"],
            "existing_price_changes": sum(bool(row.get("price_change")) for row in details),
            "existing_specification_changes": counts["specifications"],
            "new_products_proposed": counts["new_product"],
            "new_variants_proposed": counts["new_variant"],
            "image_changes_proposed": sum(row["image_change"] for row in details),
            "ambiguous_matches": counts["ambiguous"],
            "existing_absent_from_excel": len(absent),
            "failed_imports": 0,
        },
        "absent_products": [{key: p.get(key) for key in ("id", "sku", "name", "size", "finish", "price")} for p in absent],
        "rows": details,
    }


def write_report(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", opener=lambda name, flags: os.open(name, flags, 0o600)) as output:
        json.dump(report, output, indent=2, sort_keys=True)


async def main(args):
    if args.env_file:
        from dotenv import load_dotenv
        load_dotenv(args.env_file)
    from db import client, db
    try:
        data, rows = read_source(args.workbook)
        report = await compare(db, rows)
        report.update(
            mode="dry-run", database=db.name, workbook=args.workbook.name, source_sha256=hashlib.sha256(data).hexdigest(),
            worksheet_rows=len(rows), source_images=len({row["source_image_sha256"] for row in report["rows"]}),
            image_anchors=len(rows), sizes=sorted({row.size for row in rows}),
        )
        write_report(args.report, report)
        print(json.dumps({key: report[key] for key in ("blocked_reason", "production_mcm_products", "production_mcm_media", "worksheet_rows", "source_images", "image_anchors", "comparison")}, indent=2))
    finally:
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
