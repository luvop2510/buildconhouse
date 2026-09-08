"""Recover high-resolution GROHE hero masters for the highest-use weak SKUs.

The script is deliberately conservative:
  * it starts from ``media_recovery_queue`` (only currently poor/missing heroes),
  * it accepts only a direct ``cdn.cloud.grohe.com`` image URL carrying the
    exact catalog SKU,
  * it decodes and dimension-checks bytes before any write, and
  * it appends a manufacturer hero while retaining the existing supplier media.

Run without ``--apply`` to inspect every candidate first.  Each successful
write is idempotent at the byte level through ``upload_and_register``.
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
from urllib.parse import unquote

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


GROHE_BRAND_NAME = "Grohe"
PRODUCT_PAGE = "https://www.grohe.com/en-GB/product/{sku}"
_CDN_ASSET = re.compile(r"https://cdn\.cloud\.grohe\.com/prod/[^\s\"'<>;&]+")


def direct_asset_urls(sku: str) -> tuple[str, str]:
    """Known official CDN paths for current and legacy GROHE product families.

    The CDN path itself contains the exact SKU and is first-party. This is a
    safe fallback for older products whose public marketing page was removed.
    """
    return tuple(
        f"https://cdn.cloud.grohe.com/prod/{family}/{sku[:2]}/{sku}/1500/{sku}.jpg"
        for family in ("10", "20")
    )  # type: ignore[return-value]


def official_asset_url(page_html: str, sku: str) -> str | None:
    """Extract a direct, SKU-scoped GROHE product image from a product page."""
    decoded = unquote(html.unescape(page_html))
    suffix = f"/{sku}.jpg"
    for url in _CDN_ASSET.findall(decoded):
        if f"/{sku}/" in url and url.endswith(suffix):
            return url
    return None


def image_dimensions(data: bytes) -> tuple[int, int]:
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            return image.size
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ValueError("official asset could not be decoded") from exc


async def run(*, limit: int = 10, apply: bool = False) -> dict:
    """Recover up to ``limit`` currently poor/missing GROHE product heroes."""
    # The global queue is deliberately cross-brand.  Read its complete sorted
    # set before selecting GROHE candidates; a shallow prefix can contain no
    # GROHE rows even while many recoverable GROHE products remain below it.
    # This is database-only work—the requested batch size still bounds every
    # network request and every possible write.
    queue = await recovery_queue(limit=10_000, max_quality="poor")
    candidates = [item for item in queue["items"] if item["brand"] == GROHE_BRAND_NAME]
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
            # A discontinued SKU can have no current GROHE product page. Keep
            # walking the global-priority order until we have a complete batch
            # of verified masters rather than letting those safe skips consume
            # the whole requested batch.
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
            page_url = PRODUCT_PAGE.format(sku=sku)
            asset_url: str | None = None
            asset: httpx.Response | None = None
            # Most legacy product pages have been removed, while the official
            # SKU-addressed CDN master remains published. Check those exact
            # paths first; no broad image matching is involved.
            for direct_url in direct_asset_urls(sku):
                try:
                    response = await client.get(direct_url)
                except httpx.HTTPError:
                    continue
                if response.status_code == 200 and response.headers.get("content-type", "").startswith("image/"):
                    asset_url, asset = direct_url, response
                    break
            if asset is None:
                try:
                    page = await client.get(page_url)
                except httpx.HTTPError as exc:
                    result["skipped"].append({"product_id": product_id, "sku": sku, "reason": f"product page request failed: {type(exc).__name__}"})
                    continue
                if page.status_code != 200:
                    result["skipped"].append({"product_id": product_id, "sku": sku, "reason": f"product page HTTP {page.status_code}"})
                    continue
                asset_url = official_asset_url(page.text, sku)
                if not asset_url:
                    result["skipped"].append({"product_id": product_id, "sku": sku, "reason": "no SKU-scoped official image"})
                    continue
                try:
                    asset = await client.get(asset_url)
                except httpx.HTTPError as exc:
                    result["skipped"].append({"product_id": product_id, "sku": sku, "reason": f"asset request failed: {type(exc).__name__}"})
                    continue
            assert asset_url and asset
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
                "source_url": asset_url,
                "dimensions": [width, height],
                "quality": quality,
            }
            if apply:
                media = await upload_and_register(
                    data=asset.content,
                    mime=asset.headers["content-type"].split(";", 1)[0],
                    brand_slug="grohe",
                    product_id=product_id,
                    brand_id=product.get("brand_id"),
                    floor_id=product.get("floor_id") or "first-floor",
                    source_type="manufacturer",
                    role="hero",
                    is_primary=True,
                    sort_order=0,
                    notes=f"Official manufacturer asset verified against {page_url}: {asset_url}",
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
