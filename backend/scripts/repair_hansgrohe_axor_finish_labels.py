"""Repair verified Hansgrohe/AXOR finish labels from article-number suffixes.

The supplier catalogues identify the same fixture with an eight-digit article
number. Several special-finish suffixes were omitted or misread by an older
importer. This intentionally small, evidence-backed table writes only a row
whose displayed finish differs from the verified value.

Run without flags to audit. ``--execute`` creates a JSON rollback report in
``backend/backups`` before changing the live first-floor catalogue.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from db import db


# (brand slug, final three article digits): (supplier finish name, short code)
VERIFIED_FINISHES = {
    ("hansgrohe", "340"): ("Brushed Black Chrome", "BBC"),
    ("hansgrohe", "677"): ("Matt Black", "MB"),
    ("axor", "300"): ("Polished Red Gold", "PRG"),
    ("axor", "310"): ("Brushed Red Gold", "BRG"),
    ("axor", "330"): ("Polished Black Chrome", "PBC"),
    ("axor", "340"): ("Brushed Black Chrome", "BBC"),
}


def finish_for(brand_slug: str, sku: object) -> tuple[str, str] | None:
    compact = re.sub(r"\s+", "", str(sku or ""))
    if not re.fullmatch(r"\d{8}", compact):
        return None
    return VERIFIED_FINISHES.get((brand_slug, compact[-3:]))


async def run(*, execute: bool) -> dict:
    brands = await db.brands.find(
        {"floor_id": "first-floor", "slug": {"$in": ["hansgrohe", "axor"]}},
        {"_id": 0, "id": 1, "name": 1, "slug": 1},
    ).to_list(10)
    if not brands:
        raise RuntimeError("Hansgrohe/AXOR brands were not found; no catalog data was changed.")

    changes: list[dict] = []
    for brand in brands:
        products = await db.products.find(
            {"brand_id": brand["id"], "floor_id": "first-floor", "active": True},
            {"_id": 0, "id": 1, "sku": 1, "finish": 1, "colour": 1, "variant_label": 1, "finish_code": 1},
        ).to_list(10_000)
        for product in products:
            match = finish_for(brand["slug"], product.get("sku"))
            if not match:
                continue
            finish, finish_code = match
            desired = {"finish": finish, "colour": finish, "variant_label": finish, "finish_code": finish_code}
            before = {field: product.get(field) for field in desired}
            if before != desired:
                changes.append({
                    "product_id": product["id"], "sku": product["sku"], "brand": brand["name"],
                    "before": before, "after": desired,
                })

    report = {"dry_run": not execute, "products_repaired": len(changes), "changes": changes}
    if not execute:
        return report

    backup_dir = Path(__file__).resolve().parent.parent / "backups"
    backup_dir.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = backup_dir / f"hansgrohe_axor_finish_label_repair_{stamp}.json"
    backup_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    now = datetime.now(timezone.utc).isoformat()
    for change in changes:
        await db.products.update_one(
            {"id": change["product_id"], "floor_id": "first-floor"},
            {"$set": {**change["after"], "updated_at": now}},
        )
    report["backup_path"] = str(backup_path)
    return report


if __name__ == "__main__":
    print(json.dumps(asyncio.run(run(execute="--execute" in sys.argv)), indent=2))
