"""Repair verified historical Hansgrohe article-number defects.

Run without ``--apply`` first.  Applying creates a product/media snapshot and
uploads it to the private Supabase bucket before changing only preflighted,
unambiguous Hansgrohe SKUs.  Product IDs never change, so media,
quotation, order and purchase references remain attached to the same catalog
product.  Historical document snapshots are deliberately not rewritten.

    python -m scripts.repair_hansgrohe_skus
    python -m scripts.repair_hansgrohe_skus --apply
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
load_dotenv(BASE / ".env")

from catalog_pipeline.adapters.hansgrohe import canonical_hansgrohe_sku  # noqa: E402
from db import db  # noqa: E402


# Verified on first-party Hansgrohe product pages.  The two July source rows
# both said 26456000; ``-2`` was later invented as a collision workaround.
# Keep the evidence with the correction rather than treating that suffix as a
# supplier identifier.
VERIFIED_PRODUCT_REPAIRS = (
    {
        "product_id": "639c8d2e-95e6-406b-a117-f18155b9519d",
        "from_sku": "26456000", "to_sku": "27456000",
        "patch": {
            "name": "HG FixFit S wall outlet with non-return valve, Chrome",
            "description": "HG FixFit S wall outlet with non-return valve, Chrome",
        },
        "evidence_url": "https://www.hansgrohe.de/articledetail-fixfit-wandanschluss-s-mit-rueckflussverhinderer-27456000/quickview",
    },
    {
        "product_id": "811a1b0f-1b20-401b-9f36-e8134b63bbf2",
        "from_sku": "26456000-2", "to_sku": "26456000",
        "patch": {
            "name": "HG FixFit Porter 300 wall outlet with shower holder and shelf, Chrome",
            "description": "HG FixFit Porter 300 wall outlet with shower holder and shelf, Chrome",
            "variant_label": None,
        },
        "evidence_url": "https://www.hansgrohe.com/articledetail-fixfit-wall-outlet-porter-300-with-shower-holder-and-shower-shelf-26456000",
    },
)

# The source job must be corrected too.  Otherwise a retry/reimport can
# recreate the catalog defect even after the product rows are fixed.
SOURCE_ROW_REPAIRS = (
    {
        "job_id": "5a717163-ffe3-474b-a817-7c2e2ab18993",
        "row_id": "d90c0288-26a4-4a12-ad28-d7db818c5cb6",
        "from_sku": "26456000", "to_sku": "27456000",
        "patch": {
            "name": "HG FixFit S wall outlet with non-return valve, Chrome",
            "description": "HG FixFit S wall outlet with non-return valve, Chrome",
        },
    },
    {
        "job_id": "5a717163-ffe3-474b-a817-7c2e2ab18993",
        "row_id": "cd402945-c31c-449f-937c-dc4d65c22d91",
        "from_sku": "26456000", "to_sku": "26456000",
        "patch": {
            "name": "HG FixFit Porter 300 wall outlet with shower holder and shelf, Chrome",
            "description": "HG FixFit Porter 300 wall outlet with shower holder and shelf, Chrome",
        },
    },
)


async def planned_repairs() -> list[dict]:
    brands = await db.brands.find(
        {"name": {"$regex": "^hansgrohe$", "$options": "i"}}, {"_id": 0, "id": 1},
    ).to_list(20)
    brand_ids = [row["id"] for row in brands]
    if not brand_ids:
        return []
    products = await db.products.find(
        {"brand_id": {"$in": brand_ids}, "sku": {"$type": "string"}},
        {"_id": 0, "id": 1, "sku": 1, "name": 1, "brand_id": 1, "floor_id": 1},
    ).to_list(10_000)
    repairs: list[dict] = []
    for product in products:
        old_sku = str(product.get("sku") or "")
        new_sku = canonical_hansgrohe_sku(old_sku)
        if old_sku == new_sku:
            continue
        collision = await db.products.find_one({
            "id": {"$ne": product["id"]}, "brand_id": product["brand_id"],
            "floor_id": product.get("floor_id"), "sku": new_sku,
        }, {"_id": 0, "id": 1, "sku": 1, "name": 1})
        repairs.append({
            "product_id": product["id"], "name": product.get("name"),
            "brand_id": product["brand_id"], "floor_id": product.get("floor_id"),
            "from_sku": old_sku, "to_sku": new_sku, "collision": collision,
        })
    products_by_id = {row["id"]: row for row in products}
    for repair in VERIFIED_PRODUCT_REPAIRS:
        product = products_by_id.get(repair["product_id"])
        if not product:
            repairs.append({**repair, "kind": "verified", "missing_product": True, "collision": None})
            continue
        # A controlled repair can safely be rerun after interruption.  Do not
        # turn a completed correction into a false preflight failure.
        if product.get("sku") == repair["to_sku"]:
            continue
        repairs.append({
            **repair, "kind": "verified", "name": product.get("name"),
            "brand_id": product.get("brand_id"), "floor_id": product.get("floor_id"),
            "missing_product": False, "unexpected_current_sku": product.get("sku") != repair["from_sku"],
            "collision": None,
        })
    planned_product_ids = {item["product_id"] for item in repairs if item.get("product_id")}
    planned_departures = {item["product_id"]: item.get("to_sku") for item in repairs if item.get("product_id")}
    for item in repairs:
        if item.get("missing_product") or item.get("unexpected_current_sku"):
            continue
        collision = await db.products.find_one({
            "id": {"$ne": item["product_id"]}, "brand_id": item["brand_id"],
            "floor_id": item.get("floor_id"), "sku": item["to_sku"],
        }, {"_id": 0, "id": 1, "sku": 1, "name": 1})
        # A collision is safe only when it is another repair in this same
        # controlled batch and that product will vacate the target SKU first.
        if collision and collision["id"] in planned_product_ids and planned_departures.get(collision["id"]) != item["to_sku"]:
            collision = None
        item["collision"] = collision
    return repairs


async def run(apply: bool) -> dict:
    repairs = await planned_repairs()
    blocked = [item for item in repairs if item.get("collision") or item.get("missing_product") or item.get("unexpected_current_sku")]
    result = {"mode": "apply" if apply else "dry-run", "repairs": repairs, "blocked": blocked}
    if not apply or blocked:
        return result

    # This is a production data correction.  The existing backup utility also
    # copies the snapshot to forge-private, so rollback does not depend on the
    # current machine surviving.
    from scripts.backup_db import backup
    snapshot = await backup(["products", "product_media", "catalog_imports"])
    now = datetime.now(timezone.utc).isoformat()
    applied: list[dict] = []
    # First move products away from the collision target, then claim it.
    for item in sorted(repairs, key=lambda row: row["to_sku"] == "26456000"):
        patch = {"sku": item["to_sku"], "updated_at": now, **item.get("patch", {})}
        update = await db.products.update_one(
            {"id": item["product_id"], "sku": item["from_sku"]},
            {"$set": patch},
        )
        if update.modified_count != 1:
            raise RuntimeError(f"SKU repair lost its precondition for product {item['product_id']}")
        applied.append({k: item[k] for k in ("product_id", "from_sku", "to_sku")})
    source_applied: list[dict] = []
    # Correct explicit, audited source rows and then all remaining historical
    # 7-digit numeric values in Hansgrohe import jobs.
    for row in SOURCE_ROW_REPAIRS:
        set_fields = {f"rows.$[row].{key}": value for key, value in {"sku": row["to_sku"], **row["patch"]}.items()}
        update = await db.catalog_imports.update_one(
            {"id": row["job_id"]}, {"$set": set_fields},
            array_filters=[{"row.row_id": row["row_id"], "row.sku": row["from_sku"]}],
        )
        if update.modified_count != 1:
            raise RuntimeError(f"source-row repair lost its precondition for {row['row_id']}")
        source_applied.append({k: row[k] for k in ("job_id", "row_id", "from_sku", "to_sku")})
    jobs = await db.catalog_imports.find(
        {"supplier_name": {"$regex": "^hansgrohe$", "$options": "i"}}, {"_id": 0, "id": 1, "rows": 1},
    ).to_list(1000)
    for job in jobs:
        for row in job.get("rows") or []:
            old_sku = str(row.get("sku") or "")
            new_sku = canonical_hansgrohe_sku(old_sku)
            if old_sku == new_sku:
                continue
            update = await db.catalog_imports.update_one(
                {"id": job["id"]}, {"$set": {"rows.$[row].sku": new_sku}},
                array_filters=[{"row.row_id": row.get("row_id"), "row.sku": old_sku}],
            )
            if update.modified_count == 1:
                source_applied.append({"job_id": job["id"], "row_id": row.get("row_id"), "from_sku": old_sku, "to_sku": new_sku})
    await db.catalog_data_corrections.insert_one({
        "kind": "hansgrohe_article_number_leading_zero_repair",
        "created_at": now,
        "snapshot_path": str(snapshot),
        "changes": applied,
        "source_row_changes": source_applied,
    })
    return {**result, "snapshot_path": str(snapshot), "applied": applied, "source_rows_applied": source_applied}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Perform the guarded repair after the Supabase-backed snapshot.")
    args = parser.parse_args()
    print(asyncio.run(run(args.apply)))
