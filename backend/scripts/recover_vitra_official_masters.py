"""Recover VitrA product masters from canonical VitrA India product pages.

VitrA's public catalog resolves a product-code route to the canonical product
page.  This script accepts a source only when that returned page contains the
exact catalog SKU and its Open Graph hero points to a direct Salsify original.
It is dry-run-first and appends media; no current object is deleted.
"""
from __future__ import annotations

import argparse
import asyncio
import html
import io
import json
import re
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv
from PIL import Image, UnidentifiedImageError

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
load_dotenv(BASE / ".env")

from db import db  # noqa: E402
from scripts.media_recovery_queue import run as recovery_queue  # noqa: E402
from services.media_quality import quality_from_dimensions  # noqa: E402
from services.media_service import upload_and_register  # noqa: E402


VITRA_BRAND_NAME = "Vitra"
VITRA_ROUTE = "https://www.vitra-india.com/wall-hung-toilets/recovery-p-{sku}"
_OG_IMAGE = re.compile(r'<meta property="og:image" content="([^"]+)"', re.I)
_LOW_PREVIEW_PREFIX = "/mnpadding/515/515/FFFFFF/images/q_auto:low/"


def official_asset_url(page_html: str, sku: str) -> str | None:
    """Return a direct Salsify master only when the page identifies the SKU."""
    if sku.lower() not in page_html.lower():
        return None
    match = _OG_IMAGE.search(page_html)
    if not match:
        return None
    image_url = html.unescape(match.group(1))
    if not image_url.startswith("https://img-salsify.mncdn.com/"):
        return None
    return image_url.replace(_LOW_PREVIEW_PREFIX, "/images/", 1)


def image_dimensions(data: bytes) -> tuple[int, int]:
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            return image.size
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ValueError("official asset could not be decoded") from exc


async def run(*, limit: int = 10, apply: bool = False) -> dict:
    """Recover up to ``limit`` currently poor/missing VitrA product heroes."""
    vitra = await db.brands.find_one({"name": VITRA_BRAND_NAME}, {"_id": 0, "id": 1})
    if not vitra:
        raise RuntimeError("Vitra brand was not found")
    queue = await recovery_queue(limit=10_000, max_quality="poor", brand_id=vitra["id"])
    candidates = queue["items"]
    result: dict = {
        "mode": "apply" if apply else "dry-run",
        "requested": limit,
        "candidate_pool": len(candidates),
        "recovered": 0,
        "skipped": [],
        "items": [],
    }
    headers = {"User-Agent": "BuildconCatalogMediaRecovery/1.0"}
    async with httpx.AsyncClient(timeout=60, follow_redirects=True, headers=headers) as client:
        for candidate in candidates:
            if len(result["items"]) >= limit:
                break
            sku = candidate.get("sku")
            product_id = candidate["product_id"]
            if not sku:
                result["skipped"].append({"product_id": product_id, "reason": "missing SKU"})
                continue
            product = await db.products.find_one({"id": product_id, "active": True}, {"_id": 0})
            if not product or product.get("sku") != sku:
                result["skipped"].append({"product_id": product_id, "sku": sku, "reason": "catalog SKU mismatch"})
                continue
            page_url = VITRA_ROUTE.format(sku=sku.lower())
            page = await client.get(page_url)
            if page.status_code != 200:
                result["skipped"].append({"product_id": product_id, "sku": sku, "reason": f"product page HTTP {page.status_code}"})
                continue
            asset_url = official_asset_url(page.text, sku)
            if not asset_url:
                result["skipped"].append({"product_id": product_id, "sku": sku, "reason": "no exact-SKU direct Salsify asset"})
                continue
            asset = await client.get(asset_url)
            if asset.status_code != 200 or not asset.headers.get("content-type", "").startswith("image/"):
                result["skipped"].append({"product_id": product_id, "sku": sku, "reason": f"asset HTTP {asset.status_code}"})
                continue
            try:
                width, height = image_dimensions(asset.content)
            except ValueError as exc:
                result["skipped"].append({"product_id": product_id, "sku": sku, "reason": str(exc)})
                continue
            quality = quality_from_dimensions(width, height, asset.headers.get("content-type"))
            if quality in {"missing", "poor"}:
                result["skipped"].append({
                    "product_id": product_id, "sku": sku,
                    "reason": f"official source remains {quality} ({width}x{height})",
                })
                continue
            item = {
                "product_id": product_id,
                "sku": sku,
                "page_url": str(page.url),
                "source_url": asset_url,
                "dimensions": [width, height],
                "quality": quality,
            }
            if apply:
                media = await upload_and_register(
                    data=asset.content,
                    mime=asset.headers["content-type"].split(";", 1)[0],
                    brand_slug="vitra",
                    product_id=product_id,
                    brand_id=product.get("brand_id"),
                    floor_id=product.get("floor_id") or "first-floor",
                    source_type="manufacturer",
                    role="hero",
                    is_primary=True,
                    sort_order=0,
                    notes=f"Official manufacturer asset verified against {page.url}: {asset_url}",
                )
                item["media_id"] = media.id
                result["recovered"] += 1
            result["items"].append(item)
    return result


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be positive")
    print(json.dumps(await run(limit=args.limit, apply=args.apply), indent=2))


if __name__ == "__main__":
    asyncio.run(main())
