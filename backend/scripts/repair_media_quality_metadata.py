"""Reconcile product-media quality labels from their measured dimensions.

This does not download, rewrite, resize, or delete any Supabase object. It
only corrects the ``quality`` metadata that the catalog uses to decide whether
an image is appropriate for cards, galleries, quotations, and PDFs.

Run without ``--apply`` first. The write mode is idempotent and only updates
rows whose existing label differs from the measured label.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import Counter
from pathlib import Path

from dotenv import load_dotenv
from pymongo import UpdateOne

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
load_dotenv(BASE / ".env")

from db import db  # noqa: E402
from services.media_quality import quality_from_dimensions  # noqa: E402


async def run(*, apply: bool, floor_id: str | None = None, brand_id: str | None = None, limit: int | None = None) -> dict:
    query: dict[str, object] = {}
    if floor_id:
        query["floor_id"] = floor_id
    if brand_id:
        query["brand_id"] = brand_id

    cursor = db.product_media.find(query, {"_id": 0, "id": 1, "quality": 1, "width": 1, "height": 1, "mime": 1})
    if limit is not None:
        cursor = cursor.limit(limit)

    scanned = 0
    unchanged = 0
    corrected = 0
    before = Counter()
    after = Counter()
    examples: list[dict[str, object]] = []
    operations: list[UpdateOne] = []

    async for row in cursor:
        scanned += 1
        current = str(row.get("quality") or "missing")
        expected = quality_from_dimensions(row.get("width"), row.get("height"), row.get("mime"))
        before[current] += 1
        after[expected] += 1
        if current == expected:
            unchanged += 1
            continue
        corrected += 1
        if len(examples) < 20:
            examples.append({
                "media_id": row.get("id"), "from": current, "to": expected,
                "width": row.get("width"), "height": row.get("height"),
            })
        if apply:
            operations.append(UpdateOne({"id": row["id"], "quality": {"$ne": expected}}, {"$set": {"quality": expected}}))

    modified = 0
    if apply:
        for start in range(0, len(operations), 500):
            result = await db.product_media.bulk_write(operations[start:start + 500], ordered=False)
            modified += result.modified_count

    return {
        "mode": "apply" if apply else "dry-run",
        "filter": query,
        "scanned": scanned,
        "unchanged": unchanged,
        "would_correct" if not apply else "corrected": corrected,
        "modified": modified if apply else 0,
        "quality_before": dict(sorted(before.items())),
        "quality_after": dict(sorted(after.items())),
        "examples": examples,
    }


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="persist the metadata corrections")
    parser.add_argument("--floor-id")
    parser.add_argument("--brand-id")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    print(json.dumps(await run(apply=args.apply, floor_id=args.floor_id, brand_id=args.brand_id, limit=args.limit), indent=2))


if __name__ == "__main__":
    asyncio.run(main())
