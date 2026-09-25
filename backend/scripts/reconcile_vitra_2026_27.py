"""Reconcile first-floor Vitra products to the curated WC and Washbasin sheets.

Dry-run by default. The checked-in manifest records the source cells so every
retained SKU and price can be traced back to the supplier workbook. Execution
requires an explicit backup directory and never changes other brands.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

MANIFEST = Path(__file__).resolve().parent.parent / "catalog_pipeline/data/vitra_2026_27.json"
FLOOR_ID = "first-floor"
BRAND_NAME = "Vitra"
COLOURS = {
    "white": "White",
    "matte_white": "Matt White",
    "taupe_or_sand_beige": "Matt Taupe / Sand Beige",
    "stone_grey": "Matt Stone Grey",
    "matte_black": "Matt Black",
}
CATEGORIES = {"WC": ("WC", "vitra-wc"), "wash_basin": ("Wash Basin", "vitra-wash-basin")}


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def _clean(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _cents(value: object) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"))


def _source_rows() -> list[dict]:
    manifest = json.loads(MANIFEST.read_text())
    rows = manifest["products"]
    if len(rows) != 275 or len({row["code"] for row in rows}) != 275:
        raise RuntimeError("Vitra manifest must contain exactly 275 unique source SKUs")
    if Counter(row["category"] for row in rows) != {"WC": 141, "wash_basin": 134}:
        raise RuntimeError("Vitra manifest category counts changed unexpectedly")
    for row in rows:
        if row["category"] not in CATEGORIES or row["color_group"] not in COLOURS:
            raise RuntimeError(f"Unrecognized source category or colour: {row}")
        if row["price_mrp"] is not None and _cents(row["price_mrp"]) <= 0:
            raise RuntimeError(f"Invalid source price at {row['price_cell']}")
    return rows


def _payload(row: dict, category_id: str, old: dict, valid_skus: set[str], removed_ids: set[str]) -> dict:
    family = _clean(row["family"])
    detail = _clean(row["detail"])
    colour = COLOURS[row["color_group"]]
    family_name = f"{family} · {detail}"
    mrp = _cents(row["price_mrp"] if row["price_mrp"] is not None else old["mrp"])
    if row["price_mrp"] is None and mrp <= 0:
        raise RuntimeError(f"No usable existing price for {row['code']}")
    specs = dict(old.get("specs") or {})
    specs["form"] = detail
    if "related_codes" in specs:
        specs["related_codes"] = [code for code in specs["related_codes"] if code in valid_skus]
    return {
        "name": f"{family} {detail} · {colour}",
        "category_id": category_id,
        "subcategory": detail,
        "series": family,
        "family_key": f"vitra:{_slug(row['category'])}:{_slug(family)}:{_slug(detail)}",
        "family_name": family_name,
        "variant_label": colour,
        "finish": colour,
        "colour": colour,
        "finish_code": re.search(r"B(\d{3})H", row["code"]).group(1) if re.search(r"B(\d{3})H", row["code"]) else None,
        "description": family_name,
        "dimensions": detail,
        "specs": specs,
        "mrp": float(mrp),
        "price": float(mrp),
        "tags": [row["category"].lower(), "vitra", family.lower(), colour.lower()],
        "variants": [],
        "related_ids": [value for value in old.get("related_ids", []) if value not in removed_ids],
        "compatible_ids": [value for value in old.get("compatible_ids", []) if value not in removed_ids],
        "accessory_ids": [value for value in old.get("accessory_ids", []) if value not in removed_ids],
        "active": True,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


async def reconcile(*, execute: bool, backup_dir: Path | None) -> dict:
    from db import db

    rows = _source_rows()
    brand = await db.brands.find_one({"name": {"$regex": "^vitra$", "$options": "i"}, "floor_id": FLOOR_ID})
    if not brand:
        raise RuntimeError("First-floor Vitra brand is missing")
    scope = {"brand_id": brand["id"], "floor_id": FLOOR_ID}
    products = await db.products.find(scope, {"_id": 0}).to_list(10000)
    old_by_sku = {p["sku"]: p for p in products}
    if len(old_by_sku) != len(products):
        raise RuntimeError("Duplicate live Vitra SKUs require manual resolution")
    source_by_sku = {r["code"]: r for r in rows}
    valid_skus = set(source_by_sku)
    removed_ids_set = {p["id"] for p in products if p["sku"] not in source_by_sku}
    missing = sorted(source_by_sku.keys() - old_by_sku.keys())
    if missing:
        raise RuntimeError(f"Source SKUs missing in MongoDB: {missing}")
    obsolete = [p for p in products if p["sku"] not in source_by_sku]
    if any(p.get("stock", 0) for p in obsolete):
        raise RuntimeError("An obsolete Vitra SKU has stock; refusing deletion")
    existing_categories = await db.categories.find({"floor_id": FLOOR_ID}, {"_id": 0}).to_list(1000)
    categories = {c["slug"]: c for c in existing_categories}
    price_changes = [
        {"sku": r["code"], "source": r["price_mrp"], "current": old_by_sku[r["code"]]["mrp"], "cell": r["price_cell"]}
        for r in rows if r["price_mrp"] is not None and _cents(r["price_mrp"]) != _cents(old_by_sku[r["code"]]["mrp"])
    ]
    report = {
        "source_products": len(rows), "current_products": len(products),
        "retained": len(rows), "deleted": len(obsolete),
        "category_counts": dict(Counter(r["category"] for r in rows)),
        "price_changes": price_changes,
        "missing_source_price": [r["code"] for r in rows if r["price_mrp"] is None],
        "obsolete_skus": sorted(p["sku"] for p in obsolete),
        "dry_run": not execute,
    }
    if not execute:
        return report
    if backup_dir is None:
        raise RuntimeError("--backup-dir is required for execution")
    if backup_dir.exists():
        raise RuntimeError(f"Backup directory already exists: {backup_dir}")
    all_product_ids = [p["id"] for p in products]
    media = await db.product_media.find({"product_id": {"$in": all_product_ids}}, {"_id": 0}).to_list(10000)
    backup_dir.mkdir(parents=True)
    (backup_dir / "products.json").write_text(json.dumps(products, default=str, indent=2))
    (backup_dir / "product_media.json").write_text(json.dumps(media, default=str, indent=2))
    (backup_dir / "report_before.json").write_text(json.dumps(report, default=str, indent=2))

    from db import client
    from models import Category
    from pymongo import UpdateOne

    # One transaction keeps the catalog visible as either the old complete
    # set or the new complete set. The backup above is a separate rollback aid.
    async with await client.start_session() as session:
        async with session.start_transaction():
            for name, slug in CATEGORIES.values():
                if slug not in categories:
                    category = Category(name=name, slug=slug, floor_id=FLOOR_ID).model_dump()
                    await db.categories.insert_one(category, session=session)
                    categories[slug] = category
            updates = []
            for row in rows:
                old = old_by_sku[row["code"]]
                cat_id = categories[CATEGORIES[row["category"]][1]]["id"]
                updates.append(UpdateOne(
                    {**scope, "id": old["id"], "sku": row["code"]},
                    {"$set": _payload(row, cat_id, old, valid_skus, removed_ids_set)},
                ))
            result = await db.products.bulk_write(updates, ordered=True, session=session)
            if result.matched_count != len(rows):
                raise RuntimeError(f"Only {result.matched_count}/{len(rows)} retained products were matched")
            removed_ids = [p["id"] for p in obsolete]
            if removed_ids:
                await db.product_media.delete_many({"product_id": {"$in": removed_ids}}, session=session)
                deleted = await db.products.delete_many({**scope, "id": {"$in": removed_ids}}, session=session)
                if deleted.deleted_count != len(obsolete):
                    raise RuntimeError(f"Only {deleted.deleted_count}/{len(obsolete)} obsolete products were deleted")
            actual = await db.products.find(
                scope, {"_id": 0, "sku": 1, "category_id": 1, "mrp": 1, "family_key": 1, "colour": 1}, session=session,
            ).to_list(10000)
            if {p["sku"] for p in actual} != set(source_by_sku):
                raise RuntimeError("Post-write Vitra SKU set does not match the workbook manifest")
            actual_by_sku = {p["sku"]: p for p in actual}
            for row in rows:
                product = actual_by_sku[row["code"]]
                expected = _payload(row, categories[CATEGORIES[row["category"]][1]]["id"], old_by_sku[row["code"]], valid_skus, removed_ids_set)
                for field in ("category_id", "family_key", "colour", "mrp"):
                    if product[field] != expected[field]:
                        raise RuntimeError(f"Post-write {field} mismatch for {row['code']}")
            actual_counts = Counter(p["category_id"] for p in actual)
            expected_counts = {
                categories[CATEGORIES[key][1]]["id"]: count for key, count in report["category_counts"].items()
            }
            if actual_counts != expected_counts:
                raise RuntimeError(f"Post-write Vitra category counts differ: {actual_counts}")
    report["dry_run"] = False
    report["backup_dir"] = str(backup_dir)
    report["post_write_products"] = len(actual)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--backup-dir", type=Path)
    args = parser.parse_args()
    if args.env_file:
        from dotenv import load_dotenv
        load_dotenv(args.env_file)
    print(json.dumps(asyncio.run(reconcile(execute=args.execute, backup_dir=args.backup_dir)), indent=2, default=str))


if __name__ == "__main__":
    main()
