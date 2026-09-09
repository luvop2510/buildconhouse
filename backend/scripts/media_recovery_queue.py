"""Produce a read-only, usage-prioritised queue for catalog media recovery.

The queue follows the exact product-media precedence used by the catalog,
then lists active products whose *displayed hero* is below the selected
quality threshold.  It deliberately never downloads, alters, or deletes a
Supabase object; use it to choose the next SKU to recover from a verified
manufacturer or supplier master.

Examples:
    python -m scripts.media_recovery_queue
    python -m scripts.media_recovery_queue --max-quality acceptable --limit 50
    python -m scripts.media_recovery_queue --brand-id <brand-id> --floor-id first-floor
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
load_dotenv(BASE / ".env")

from db import db  # noqa: E402


QUALITY_RANK = {"missing": 0, "poor": 1, "acceptable": 2, "good": 3, "excellent": 4}
SOURCE_RANK = {"internal": 0, "manufacturer": 1, "supplier": 2}
MIN_4K_LONG_EDGE = 3840
MIN_4K_SHORT_EDGE = 2160


def media_sort_key(row: dict[str, Any]) -> tuple[int, int, int]:
    """Mirror catalog_service's per-product media order without loading it."""
    return (
        SOURCE_RANK.get(str(row.get("source_type")), 3),
        0 if row.get("is_primary") else 1,
        int(row.get("sort_order", 100)),
    )


def displayed_hero(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Return the product's selected hero using the catalog's public-media rules."""
    public_rows = [row for row in sorted(rows, key=media_sort_key) if row.get("public_url")]
    for row in public_rows:
        if row.get("is_primary") or row.get("role") == "hero":
            return row
    return public_rows[0] if public_rows else None


def meets_top_notch_media_standard(row: dict[str, Any] | None) -> bool:
    """The recovery target: a safe scalable SVG or a genuine 4K raster.

    The main application's historical ``quality`` field intentionally has a
    lower display-oriented threshold.  Keep that signal intact and expose a
    separate, auditable recovery criterion instead of relabelling 1024px
    images as 4K.
    """
    if not row:
        return False
    if str(row.get("mime") or "").lower() == "image/svg+xml":
        return True
    try:
        width, height = int(row.get("width") or 0), int(row.get("height") or 0)
    except (TypeError, ValueError):
        return False
    return min(width, height) >= MIN_4K_SHORT_EDGE and max(width, height) >= MIN_4K_LONG_EDGE


async def run(
    *,
    limit: int = 100,
    max_quality: str = "poor",
    floor_id: str | None = None,
    brand_id: str | None = None,
    require_4k: bool = False,
) -> dict[str, Any]:
    """Return the current recovery queue and an auditable summary."""
    product_filter: dict[str, Any] = {"active": True}
    if floor_id:
        product_filter["floor_id"] = floor_id
    if brand_id:
        product_filter["brand_id"] = brand_id

    products, media_rows, brand_rows, usage_rows = await asyncio.gather(
        db.products.find(product_filter, {"_id": 0}).to_list(10000),
        db.product_media.find({}, {"_id": 0}).to_list(20000),
        db.brands.find({}, {"_id": 0, "id": 1, "name": 1}).to_list(500),
        db.product_usage.find({}, {"_id": 0, "product_id": 1, "count": 1}).to_list(50000),
    )
    media_by_product: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in media_rows:
        if row.get("product_id"):
            media_by_product[str(row["product_id"])].append(row)
    usage_by_product: Counter[str] = Counter()
    for row in usage_rows:
        if row.get("product_id"):
            usage_by_product[str(row["product_id"])] += int(row.get("count", 0))
    brands = {str(row["id"]): row.get("name") or "Unknown" for row in brand_rows}

    threshold = QUALITY_RANK[max_quality]
    candidates: list[dict[str, Any]] = []
    quality_counts: Counter[str] = Counter()
    brand_counts: Counter[str] = Counter()
    for product in products:
        hero = displayed_hero(media_by_product.get(product["id"], []))
        quality = str(hero.get("quality") if hero else "missing")
        quality_counts[quality] += 1
        below_requested_quality = QUALITY_RANK.get(quality, 0) <= threshold
        below_4k = require_4k and not meets_top_notch_media_standard(hero)
        if not below_requested_quality and not below_4k:
            continue
        brand_name = brands.get(str(product.get("brand_id")), "Unknown")
        brand_counts[brand_name] += 1
        candidates.append({
            "product_id": product["id"],
            "sku": product.get("sku"),
            "name": product.get("name"),
            "brand": brand_name,
            "floor_id": product.get("floor_id"),
            "usage_count": usage_by_product[product["id"]],
            "hero_quality": quality,
            "hero_dimensions": [hero.get("width"), hero.get("height")] if hero else [None, None],
            "hero_source_type": hero.get("source_type") if hero else None,
            "hero_media_id": hero.get("id") if hero else None,
            "meets_top_notch_standard": meets_top_notch_media_standard(hero),
        })

    candidates.sort(key=lambda item: (
        -item["usage_count"],
        QUALITY_RANK.get(item["hero_quality"], 0),
        item["brand"],
        item["sku"] or "",
    ))
    return {
        "filter": {"floor_id": floor_id, "brand_id": brand_id, "max_quality": max_quality, "require_4k": require_4k},
        "active_products_scanned": len(products),
        "displayed_hero_quality": dict(sorted(quality_counts.items())),
        "recoverable_products": len(candidates),
        "recoverable_by_brand": dict(brand_counts.most_common()),
        "items": candidates[:limit],
    }


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--max-quality", choices=tuple(QUALITY_RANK), default="poor")
    parser.add_argument("--floor-id")
    parser.add_argument("--brand-id")
    parser.add_argument("--require-4k", action="store_true", help="Include every displayed hero below the 4K/SVG recovery standard")
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be positive")
    print(json.dumps(await run(**vars(args)), indent=2))


if __name__ == "__main__":
    asyncio.run(main())
