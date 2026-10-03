"""Read-only exhaustive source/database/API coverage verification."""
from __future__ import annotations

import argparse
import asyncio
from collections import defaultdict
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from scripts.reconcile_supplier_workbooks import DEFAULT_MANIFEST, FLOOR_ID, canonical_article, entry_for, validate_manifest


async def verify(manifest: dict, backup_dir: Path | None) -> dict:
    from db import db
    from services import catalog_service as catalog

    rows = validate_manifest(manifest)
    brands = {b["name"]: b async for b in db.brands.find({"name": {"$in": ["Hansgrohe", "Grohe"]}, "floor_id": FLOOR_ID}, {"_id": 0})}
    all_products = await db.products.find({"brand_id": {"$in": [b["id"] for b in brands.values()]}, "floor_id": FLOOR_ID}, {"_id": 0}).to_list(10000)
    products = {(p["brand_id"], p["sku"]): p for p in all_products}
    if len(products) != len(all_products):
        raise AssertionError("Duplicate canonical brand/article records")
    categories = {c["id"]: c async for c in db.categories.find({"floor_id": FLOOR_ID}, {"_id": 0})}
    stored_entries = {e["entry_id"]: (p, e) for p in all_products for e in p.get("catalog_entries", []) if e.get("source_catalog") in {r["workbook"] for r in rows}}
    assert set(stored_entries) == {r["occurrence_id"] for r in rows}, "Source occurrence coverage mismatch"
    unique_words = set()
    word_checks = 0
    for row in rows:
        product = products[(brands[row["brand"]]["id"], canonical_article(row))]
        stored_product, entry = stored_entries[row["occurrence_id"]]
        assert stored_product["id"] == product["id"]
        category = categories[entry["category_id"]]
        assert category["name"] == row["sheet"] and category["catalog_order"] == row["sheet_order"]
        assert entry == entry_for(row, category["id"]), f"Raw source value changed: {row['occurrence_id']}"
        assert product.get("active") is True
        values = [row["article"], row.get("description_exact"), row.get("section_heading_exact"),
                  *[cell.get("value") for cell in row["source_cells"].values()]]
        for value in values:
            if value is None:
                continue
            for word in str(value).split():
                assert catalog._matches_search(product, re.compile(re.escape(word), re.IGNORECASE)), (row["occurrence_id"], word)
                unique_words.add(word.casefold())
                word_checks += 1
    before = json.loads((backup_dir / "products.json").read_text()) if backup_dir else []
    for old in before:
        now = products[(old["brand_id"], old["sku"])]
        assert now["id"] == old["id"] and now.get("stock") == old.get("stock"), "Existing stock identity changed"
    snapshot = await catalog.refresh_catalog_snapshot()
    result = {"source_occurrences_verified": len(rows), "source_occurrence_coverage_percent": 100,
              "canonical_source_products_verified": len({(r["brand"], canonical_article(r)) for r in rows}),
              "duplicate_canonical_records": 0, "source_word_checks": word_checks,
              "unique_source_words": len(unique_words), "word_coverage_percent": 100,
              "existing_stock_identities_verified": len(before), "brands": []}
    for brand_name in ("Hansgrohe", "Grohe"):
        brand = brands[brand_name]
        brand_rows = [r for r in rows if r["brand"] == brand_name]
        expected_skus = list(dict.fromkeys(canonical_article(r) for r in brand_rows))
        listed = await catalog.list_products_page(user_id="source-verification", q=None, brand_id=brand["id"], category_id=None,
                    subcategory=None, series=None, family_key=None, finish=None, colour=None, sort="source", limit=10000, skip=0, floor_ids=[FLOOR_ID])
        assert [p["sku"] for p in listed["items"]] == expected_skus, "Source order or SKU coverage mismatch"
        assert len({p["id"] for p in listed["items"]}) == len(expected_skus), "Repeated product cards"
        actual_categories = await catalog.list_categories_with_counts(brand["id"], floor_ids=[FLOOR_ID])
        expected_names = list(dict.fromkeys(r["sheet"] for r in brand_rows))
        assert [c["name"] for c in actual_categories] == expected_names, "Unexpected category or category order"
        by_sheet = defaultdict(list)
        for row in brand_rows:
            by_sheet[row["sheet"]].append(row)
        for category in actual_categories:
            expected = list(dict.fromkeys(canonical_article(r) for r in by_sheet[category["name"]]))
            page = await catalog.list_products_page(user_id="source-verification", q=None, brand_id=brand["id"], category_id=category["id"],
                       subcategory=None, series=None, family_key=None, finish=None, colour=None, sort="source", limit=10000, skip=0, floor_ids=[FLOOR_ID])
            assert [p["sku"] for p in page["items"]] == expected, (brand_name, category["name"], "Category membership/order")
            assert category["product_count"] == len(expected)
        unknown = [p for p in listed["items"] if p.get("price_unknown")]
        missing_hero = [p["sku"] for p in listed["items"] if not p.get("hero_image_url")]
        result["brands"].append({"brand": brand_name, "brand_id": brand["id"], "products": len(expected_skus),
                                "source_rows": len(brand_rows), "categories": len(actual_categories),
                                "source_order_verified": True, "category_membership_verified": True,
                                "unknown_price_products_visible": len(unknown), "products_without_displayed_image": missing_hero})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.env_file:
        from dotenv import load_dotenv
        load_dotenv(args.env_file)
    result = asyncio.run(verify(json.loads(args.manifest.read_text()), args.backup_dir))
    args.report.write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
