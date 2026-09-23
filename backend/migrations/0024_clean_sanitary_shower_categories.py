"""Move clearly misplaced sanitary products out of the shower-head groups.

The supplier name workbooks are category-label lists, not SKU/count tables. This
pass therefore uses the live product descriptions and existing target categories,
and only moves records whose type is explicit. It never deletes or renames data.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone


FLOOR = "first-floor"
BRANDS = {
    "Grohe": "94292e11-6b64-41b4-8151-f30d66c674ad",
    "Hansgrohe": "9b72519c-bfb4-4576-9e79-e85072ab4216",
    "Axor": "347979fb-8ea5-45d9-91a1-89eef0d0b34c",
    "Vitra": "2ddd8f43-1926-4250-aed6-ee5d638e6d69",
}


def target_for(brand: str, source: str, name: str, subcategory: str | None = None) -> str | None:
    text = name.casefold()
    if brand == "Vitra" and source == "Showers":
        return "Faucets" if (subcategory or "").casefold() == "basin mixer" else None
    if brand == "Grohe":
        if source == "SHOWER":
            if "trigger spray" in text:
                return "TRIGGER"
            if re.search(r"hand\s*shower|handshower|stick shower|wall holder set|shower rail", text):
                return "HAND SHOWER SET"
            if re.search(r"extension cable|steam generator|spa |sound module|light module|temperature sensor|rough.in", text):
                return "Accessories"
            if "shower arm" in text and not re.search(r"head\s*shower|headshower|\bohs\b|\bsh\b.*shower arm", text):
                return "Accessories"
        if source == "HAND SHOWER SET" and re.search(r"hose|wall union|wall holder|wall hook|shower holder|metal tube", text):
            return "Accessories"
    if brand in {"Hansgrohe", "Axor"} and source in {"SHOWERS", "Showers"}:
        if "basic set" in text:
            return "Holder"
        if re.search(r"(?:^|\s)(?:wall|ceiling) connector", text) and not re.search(r"\bwith\s+(?:wall|ceiling) connector", text):
            return "Holder"
        if "shower arm" in text and not re.search(r"overhead|head\s*shower|headshower|\bohs\b", text):
            return "Holder"
    return None


async def up(db) -> None:
    categories = [row async for row in db.categories.find(
        {"floor_id": FLOOR}, {"_id": 0, "id": 1, "name": 1, "slug": 1},
    )]
    by_id = {row["id"]: row["name"] for row in categories}
    by_slug = {row["slug"]: row["id"] for row in categories}
    by_name = {row["name"]: row["id"] for row in categories}
    targets = {
        "Grohe": {
            "TRIGGER": by_slug.get("grohe-trigger"),
            "HAND SHOWER SET": by_slug.get("grohe-hand-shower-set"),
            "Accessories": by_name.get("Accessories"),
        },
        "Hansgrohe": {"Holder": by_slug.get("hansgrohe-holder")},
        "Axor": {"Holder": by_name.get("Holder")},
        "Vitra": {"Faucets": by_name.get("Faucets")},
    }
    now = datetime.now(timezone.utc).isoformat()
    for brand, brand_id in BRANDS.items():
        products = db.products.find(
            {"floor_id": FLOOR, "brand_id": brand_id},
            {"_id": 0, "id": 1, "name": 1, "subcategory": 1, "category_id": 1},
        )
        async for product in products:
            source_id = product.get("category_id")
            source = by_id.get(source_id, "")
            target = target_for(brand, source, product.get("name") or "", product.get("subcategory"))
            target_id = targets[brand].get(target) if target else None
            if target_id and target_id != source_id:
                await db.products.update_one(
                    {"id": product["id"], "floor_id": FLOOR, "brand_id": brand_id, "category_id": source_id},
                    {"$set": {"category_id": target_id, "updated_at": now}},
                )
