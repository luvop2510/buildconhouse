"""Read-only, first-floor supplier/category/section verification.

No API startup, migration, database write, or supplier import is performed.
Expected counts come from active stored supplier placements; source completeness
is independently checked where the reviewed workbook manifest exists.
Run from backend: .venv/bin/python scripts/audit_catalog_relationships.py
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from time import perf_counter
from statistics import median

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from db import client, db  # noqa: E402
from services import catalog_service as catalog  # noqa: E402
from services import catalog_database as database  # noqa: E402


def eligible_placements(products, brands):
    """Independent projection of the documented supplier eligibility contract."""
    by_id = {b["id"]: b for b in brands}
    result = []
    for product in products:
        if product.get("active") is not True:
            continue
        brand = by_id.get(product.get("brand_id"), {})
        if brand.get("catalog_authoritative") and (
            product.get("catalog_source") != brand.get("catalog_source") or not product.get("catalog_entries")
        ):
            continue
        for entry in product.get("catalog_entries") or [{}]:
            row = {**product}
            for field in ("category_id", "subcategory", "name", "description"):
                if field in entry and (entry[field] is not None or field == "subcategory"):
                    row[field] = entry[field]
            row["subcategory"] = row.get("subcategory") or "General"
            row["series"] = row.get("series") or "Uncategorised"
            result.append(row)
    return result


def family_identity(row):
    return (row.get("family_key") or f"solo:{row['id']}", row.get("floor_id"), row.get("brand_id"), row.get("category_id"))


async def audit(output):
    started = perf_counter()
    floor = await db.floors.find_one({"id": "first-floor"}, {"_id": 0, "id": 1, "name": 1, "slug": 1})
    brands, categories, products, media = await asyncio.gather(*[
        db[name].find({"floor_id": "first-floor"}, {"_id": 0}).to_list(None)
        for name in ("brands", "categories", "products", "product_media")
    ])
    snapshot = catalog._build_snapshot([p for p in products if p.get("active") is True], media, brands, categories, [])
    token = catalog._snapshot_override.set(snapshot)
    placements = eligible_placements(products, brands)
    brand_by_id = {b["id"]: b for b in brands}
    category_by_id = {c["id"]: c for c in categories}
    issues = []
    for product in products:
        for collection, identity in [(brand_by_id, product.get("brand_id")), (category_by_id, product.get("category_id"))]:
            if identity not in collection:
                issues.append({"type": "missing_or_cross_floor_reference", "product_id": product["id"], "reference_id": identity})
        for entry in product.get("catalog_entries") or []:
            if entry.get("category_id") not in category_by_id:
                issues.append({"type": "invalid_placement_category", "product_id": product["id"], "entry_id": entry.get("entry_id")})
    for category in categories:
        if category.get("parent_id") and category["parent_id"] not in category_by_id:
            issues.append({"type": "invalid_category_parent", "category_id": category["id"]})
    sku_groups = defaultdict(list)
    for product in products:
        sku_groups[(product.get("brand_id"), product.get("sku"))].append(product["id"])
    duplicates = [{"brand_id": key[0], "sku": key[1], "ids": ids} for key, ids in sku_groups.items() if len(ids) > 1]
    scopes = {(row["brand_id"], row["category_id"], row["subcategory"]) for row in placements}
    # Include configured but empty categories and every brand/category total.
    scopes |= {(b["id"], c["id"], None) for b in brands for c in categories if
               c.get("brand_id") == b["id"] or any(p["brand_id"] == b["id"] and p["category_id"] == c["id"] for p in placements)}
    scopes |= {(b["id"], None, None) for b in brands}
    matrix = []
    try:
        # Same captured source data, pre-fix category-only dedupe versus fixed
        # branch counts. This is local read-model evidence, not a hosted timing.
        legacy_listings = catalog._unique_listings(catalog._listing_products(snapshot), per_category=True)
        baseline_sections = Counter((r["brand_id"], r["category_id"], r.get("subcategory") or "General") for r in legacy_listings)
        expected_sections = defaultdict(set)
        for row in placements:
            expected_sections[(row["brand_id"], row["category_id"], row["subcategory"])].add(row["id"])
        before_section_discrepancies = [{"brand": brand_by_id[key[0]]["name"], "category_id": key[1],
                                       "subcategory": key[2], "expected": len(ids), "before": baseline_sections[key]}
                                      for key, ids in expected_sections.items() if baseline_sections[key] != len(ids)]
        fallback_filter_checks = []
        for brand in brands:
            for field, label in catalog._HIERARCHY_FALLBACK_LABELS.items():
                expected_ids = {p["id"] for p in placements if p["brand_id"] == brand["id"] and p[field] == label}
                if not expected_ids: continue
                before = {p["id"] for p in catalog._listing_products(snapshot) if p["brand_id"] == brand["id"] and p.get(field) == label}
                arguments = dict(brand_id=brand["id"], category_id=None, subcategory=None, series=None,
                                 q=None, limit=0, skip=0, floor_ids=["first-floor"])
                # Override defaults separately: duplicate kwargs are invalid.
                arguments.update({field: label})
                after = await catalog.list_family_groups(**arguments)
                fallback_filter_checks.append({"brand": brand["name"], "field": field, "label": label,
                    "before_reachable_skus": len(before), "expected_reachable_skus": len(expected_ids),
                    "after_family_cards": after["total"]})
        timings = {}
        for name, operation in (
            ("before_hierarchy_projection", lambda: catalog._unique_listings(catalog._listing_products(snapshot), per_category=True)),
            ("after_hierarchy_projection", lambda: catalog._unique_listings(catalog._listing_products(snapshot), per_placement=True)),
        ):
            values = []
            for _ in range(10):
                begin = perf_counter(); operation(); values.append((perf_counter() - begin) * 1000)
            timings[name + "_median_ms"] = round(median(values), 3)
        hierarchy, hierarchy_brands, _ = await catalog.hierarchy_rows(["first-floor"])
        hierarchy_counts = Counter()
        hierarchy_category_counts = {}
        for row in hierarchy:
            key = row["_id"]
            hierarchy_counts[(key["brand_id"], key["category_id"], key.get("subcategory") or "General")] += row["product_count"]
            hierarchy_category_counts[(key["brand_id"], key["category_id"])] = row["category_product_count"]
        for bid, cid, subcategory in sorted(scopes, key=lambda row: (brand_by_id[row[0]]["name"], category_by_id.get(row[1], {}).get("name", ""), row[2] or "")):
            selected = [p for p in placements if p["brand_id"] == bid and (cid is None or p["category_id"] == cid)
                        and (subcategory is None or p["subcategory"] == subcategory)]
            expected_ids = {p["id"] for p in selected}
            # Browse deduplicates SKU before families, preserving first placement.
            unique = {p["id"]: p for p in reversed(selected)}
            expected_families = len({family_identity(p) for p in unique.values()})
            arguments = dict(brand_id=bid, category_id=cid, subcategory=subcategory, series=None,
                             q=None, limit=0, skip=0, floor_ids=["first-floor"])
            actual = await catalog.list_family_groups(**arguments)
            product_page = await catalog.list_products_page(**{k: v for k, v in arguments.items() if k != "q"},
                q=None, user_id="read-only-catalog-audit", family_key=None, finish=None, colour=None, sort="source")
            facets = await catalog.facet_buckets(**{k: v for k, v in arguments.items() if k not in ("q", "limit", "skip")})
            actual_skus = next((r["count"] for r in facets["brands"] if r["value"] == bid), 0)
            branch = (hierarchy_counts[(bid, cid, subcategory)] if subcategory else hierarchy_category_counts.get((bid, cid), 0)) if cid else hierarchy_brands[bid]["product_count"]
            row = {"brand": brand_by_id[bid]["name"], "brand_id": bid,
                   "category": category_by_id.get(cid, {}).get("name"), "category_id": cid, "subcategory": subcategory,
                   "expected_eligible_skus": len(expected_ids), "actual_facet_skus": actual_skus,
                   "expected_family_cards": expected_families, "actual_family_cards": actual["total"],
                   "actual_product_cards": product_page["total"], "actual_hierarchy_skus": branch}
            row["verified"] = (len(expected_ids) == actual_skus and expected_families == actual["total"] == product_page["total"]
                               and (branch is None or branch == len(expected_ids)))
            matrix.append(row)
        # Independently execute production Mongo projection and compare every SKU
        # section identity against the source-derived expectation.
        mongo_started = perf_counter()
        mongo_pipeline = database.listing_pipeline(floor_ids=["first-floor"], per_placement=True)
        mongo_rows = await database.aggregate(mongo_pipeline).to_list(None)
        timings["live_mongo_projection_ms"] = round((perf_counter() - mongo_started) * 1000, 3)
        explain = await db.command("explain", {"aggregate": "products", "pipeline": mongo_pipeline,
                                               "cursor": {}, "allowDiskUse": True, "maxTimeMS": 30000}, verbosity="executionStats")
        stages = explain.get("stages", [])
        cursor_stats = next((s["$cursor"] for s in stages if "$cursor" in s), {})
        execution = cursor_stats.get("executionStats", explain.get("executionStats", {}))
        index_names = set()
        def find_indexes(value):
            if isinstance(value, dict):
                if value.get("indexName"): index_names.add(value["indexName"])
                index_names.update(value.get("indexesUsed") or [])
                for child in value.values(): find_indexes(child)
            elif isinstance(value, list):
                for child in value: find_indexes(child)
        find_indexes(cursor_stats.get("queryPlanner", {}).get("winningPlan", {}))
        find_indexes(execution.get("executionStages", {}))
        for stage in stages:
            if "$cursor" not in stage: find_indexes(stage)
        explain_summary = {"indexes": sorted(index_names), "execution_time_ms": execution.get("executionTimeMillis"),
                           "documents_examined": execution.get("totalDocsExamined"), "keys_examined": execution.get("totalKeysExamined"),
                           "spill_stages": [next(iter(s)) for s in stages if s.get("usedDisk") or s.get("spills", 0)]}
        mongo_identity = lambda p: (p["id"], p["brand_id"], p["category_id"], p.get("subcategory") or "General", p.get("series") or "Uncategorised")
        expected = {mongo_identity(p) for p in placements}
        actual = {mongo_identity(p) for p in mongo_rows}
        mongo_parity = {"expected_distinct_placements": len(expected), "actual_distinct_placements": len(actual),
                        "missing": sorted(expected - actual), "unrelated": sorted(actual - expected)}
        # Paginate each brand's complete family responses at the frontend page
        # size and prove all eligible SKU choices remain reachable as variants.
        pagination = []
        for brand in brands:
            args = dict(brand_id=brand["id"], category_id=None, subcategory=None, series=None, q=None,
                        limit=60, skip=0, floor_ids=["first-floor"])
            ids = set(); cards = []; pages = 0
            while True:
                response = await catalog.list_family_groups(**args)
                pages += 1
                cards.extend((r["floor_id"], r["brand_id"], r["category_id"], r.get("family_key") or r["sample_product_id"]) for r in response["items"])
                ids.update(v["id"] for r in response["items"] for v in r["variants"])
                args["skip"] += 60
                if args["skip"] >= response["total"]: break
            expected_ids = {p["id"] for p in placements if p["brand_id"] == brand["id"]}
            pagination.append({"brand": brand["name"], "pages": pages, "family_cards": len(cards),
                               "duplicate_cards": len(cards) - len(set(cards)), "reachable_variant_skus": len(ids),
                               "missing_product_ids": sorted(expected_ids - ids), "unrelated_product_ids": sorted(ids - expected_ids)})
        manifest = json.loads((Path(__file__).resolve().parents[1] / "catalog_pipeline/data/supplier_workbooks_2026_2027.json").read_text())
        source_checks = []
        for workbook in manifest["workbooks"]:
            brand = next(b for b in brands if b["name"] == workbook["brand"])
            expected_source = {r.get("canonical_article") or r["article"] for r in manifest["ordered_occurrences"] if r["brand"] == brand["name"]}
            actual_source = {p["sku"] for p in placements if p["brand_id"] == brand["id"]}
            source_checks.append({"brand": brand["name"], "source": Path(workbook["workbook"]).name,
                                  "expected_source_skus": len(expected_source), "actual_eligible_skus": len(actual_source),
                                  "missing_skus": sorted(expected_source - actual_source), "unexpected_skus": sorted(actual_source - expected_source)})
        summaries = []
        for brand in brands:
            stored = [p for p in products if p["brand_id"] == brand["id"]]
            eligible_ids = {p["id"] for p in placements if p["brand_id"] == brand["id"]}
            summaries.append({"brand": brand["name"], "id": brand["id"], "stored": len(stored),
                "active": sum(p.get("active") is True for p in stored), "eligible": len(eligible_ids),
                "inactive_or_missing_active": sum(p.get("active") is not True for p in stored),
                "archived_flag_records": sum(bool(p.get("archived") or p.get("archived_at")) for p in stored),
                "excluded_legacy_source": sum(p.get("active") is True and p["id"] not in eligible_ids for p in stored),
                "missing_hero_images": sum(not catalog._primary_product_image(snapshot, pid) for pid in eligible_ids),
                "unknown_canonical_prices": sum(p.get("price_status") == "unspecified" for p in stored if p["id"] in eligible_ids),
                "unknown_source_occurrence_prices": sum(e.get("mrp") is None for p in stored if p["id"] in eligible_ids for e in p.get("catalog_entries") or []),
                "missing_variant_identity": sum(not p.get("sku") or not p.get("name") for p in stored if p["id"] in eligible_ids),
                "zero_stock_eligible": sum(not p.get("stock") for p in stored if p["id"] in eligible_ids),
                "source_completeness": "reviewed workbook manifest verified" if brand.get("catalog_authoritative") else "stored-data parity verified; complete supplier inventory not independently established"})
        report = {"generated_at_utc": datetime.now(timezone.utc).isoformat(), "floor": floor,
                  "read_only": True, "elapsed_seconds": round(perf_counter() - started, 3),
                  "stored_products": len(products), "active_products": sum(p.get("active") is True for p in products),
                  "eligible_products": len({p["id"] for p in placements}), "categories": len(categories),
                  "categories_with_parent": sum(bool(c.get("parent_id")) for c in categories),
                  "empty_categories": [{"id": c["id"], "name": c["name"], "brand_id": c.get("brand_id")} for c in categories
                                       if not any(p["category_id"] == c["id"] for p in placements)],
                  "relationship_issues": issues, "duplicate_skus": duplicates,
                  "before_section_discrepancies": before_section_discrepancies,
                  "fallback_filter_checks": fallback_filter_checks,
                  "timings": timings, "mongo_query_explain": explain_summary,
                  "brands": summaries, "source_manifest_checks": source_checks, "mongo_projection_parity": mongo_parity,
                  "brand_pagination_checks": pagination, "matrix": matrix}
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps({"output": str(output), "eligible_products": report["eligible_products"],
                          "matrix_rows": len(matrix), "matrix_mismatches": sum(not r["verified"] for r in matrix),
                          "relationship_issues": len(issues), "elapsed_seconds": report["elapsed_seconds"]}))
    finally:
        catalog._snapshot_override.reset(token)
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[2] / "docs/audits/2026-10-13-catalog-matrix.json")
    asyncio.run(audit(parser.parse_args().output))
