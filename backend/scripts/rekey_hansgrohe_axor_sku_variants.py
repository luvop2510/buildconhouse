"""Unify Hansgrohe and AXOR finish variants using the manufacturer article key.

Hansgrohe/AXOR catalogue article numbers use the first five digits for the
product design and the last three for its finish.  A prior name-based import
created separate family keys whenever the finish wording varied (for example
``...-bbr`` versus ``...-bbc``), leaving the same fixture scattered through
the catalogue.

This command changes a family key when either (a) at least two active,
eight-digit articles share a brand, floor, category, and five-digit article
prefix, or (b) a legacy, name-derived family incorrectly spans different
five-digit article designs. It does not merge products: each SKU retains its
own price, stock, images, and all other product data. Product media is kept
on the same family key so the catalogue's variant picker remains image-safe.

Run without flags for an audit.  ``--execute`` writes a reversible JSON report
to ``backend/backups`` before updating the live catalogue.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from db import db


ARTICLE_RE = re.compile(r"^(?P<design>\d{5})(?P<finish>\d{3})$")


def article_design(sku: object) -> str | None:
    """Return the finish-independent manufacturer design number, if valid."""
    match = ARTICLE_RE.fullmatch(re.sub(r"\s+", "", str(sku or "")))
    return match.group("design") if match else None


async def run(*, execute: bool) -> dict:
    brands = await db.brands.find(
        {"floor_id": "first-floor", "slug": {"$in": ["hansgrohe", "axor"]}},
        {"_id": 0, "id": 1, "name": 1, "slug": 1},
    ).to_list(10)
    if not brands:
        raise RuntimeError("Hansgrohe/AXOR brands were not found; no catalog data was changed.")

    changes: list[dict] = []
    family_count_by_brand: dict[str, int] = defaultdict(int)
    candidate_rows_by_brand: dict[str, int] = defaultdict(int)
    split_family_count_by_brand: dict[str, int] = defaultdict(int)

    for brand in brands:
        products = await db.products.find(
            {"brand_id": brand["id"], "floor_id": "first-floor", "active": True},
            {"_id": 0, "id": 1, "sku": 1, "family_key": 1, "category_id": 1, "floor_id": 1},
        ).to_list(10_000)
        grouped: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
        products_by_legacy_family: dict[str, list[dict]] = defaultdict(list)
        for product in products:
            design = article_design(product.get("sku"))
            if design:
                grouped[(product["floor_id"], product["category_id"], design)].append(product)
                if product.get("family_key"):
                    products_by_legacy_family[product["family_key"]].append(product)

        # A different five-digit design is a different fixture. Name-based
        # keys previously joined some same-size or similarly worded fixtures
        # (for example Xelu Q and Xevolos E) as if they were finishes.
        split_family_keys = {
            family_key
            for family_key, rows in products_by_legacy_family.items()
            if len({article_design(row.get("sku")) for row in rows}) > 1
        }
        split_family_count_by_brand[brand["name"]] = len(split_family_keys)

        for (floor_id, _category_id, design), siblings in sorted(grouped.items()):
            is_finish_family = len(siblings) >= 2
            is_legacy_misgroup = any(row.get("family_key") in split_family_keys for row in siblings)
            if not is_finish_family and not is_legacy_misgroup:
                continue
            if is_finish_family:
                family_count_by_brand[brand["name"]] += 1
                candidate_rows_by_brand[brand["name"]] += len(siblings)
            target_key = f"hansgrohe:{brand['slug']}:sku:{design}"
            for product in siblings:
                if product.get("family_key") == target_key:
                    continue
                changes.append({
                    "product_id": product["id"], "sku": product["sku"],
                    "brand": brand["name"], "floor_id": floor_id,
                    "from_family_key": product.get("family_key"),
                    "to_family_key": target_key,
                })

    report = {
        "dry_run": not execute,
        "rule": "same brand + floor + category + first five digits of an eight-digit manufacturer article",
        "variant_families_by_brand": dict(sorted(family_count_by_brand.items())),
        "candidate_rows_by_brand": dict(sorted(candidate_rows_by_brand.items())),
        "legacy_cross_design_families_split_by_brand": dict(sorted(split_family_count_by_brand.items())),
        "products_rekeyed": len(changes),
        "changes": changes,
    }
    if not execute:
        return report

    backup_dir = Path(__file__).resolve().parent.parent / "backups"
    backup_dir.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = backup_dir / f"hansgrohe_axor_sku_variant_rekey_{stamp}.json"
    backup_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    now = datetime.now(timezone.utc).isoformat()
    for change in changes:
        await db.products.update_one(
            {"id": change["product_id"], "floor_id": change["floor_id"]},
            {"$set": {"family_key": change["to_family_key"], "updated_at": now}},
        )
        await db.product_media.update_many(
            {"product_id": change["product_id"], "floor_id": change["floor_id"]},
            {"$set": {"family_key": change["to_family_key"]}},
        )
    report["backup_path"] = str(backup_path)
    return report


if __name__ == "__main__":
    print(json.dumps(asyncio.run(run(execute="--execute" in sys.argv)), indent=2))
