"""Promote exact-SKU Geberit official EPS masters as 4K catalog heroes.

Geberit's catalog product pages render only a 1200px JPEG preview, but each
SKU row names the same official ``DAS_*`` asset that Geberit publishes as an
EPS vector. This job verifies the SKU on the first-party page, derives that
specific vector source, rasterizes it locally at 2400 DPI, and writes the
result through the normal media service. It never uses the gallery's first
image and never deletes existing media.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import httpx
from dotenv import load_dotenv
from PIL import Image

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
load_dotenv(BASE / ".env")

from db import db  # noqa: E402
from scripts.media_recovery_queue import displayed_hero, run as recovery_queue  # noqa: E402
from services import catalog_service  # noqa: E402
from services.media_service import upload_and_register  # noqa: E402


BRAND = "Geberit"
PRODUCT_URL = "https://catalog.geberit.in/en-IN/product/{sku}"
EPS_URL = "https://cdn.data.geberit.com/eps/{shard_a}/{shard_b}/DAS_{asset_id}.eps"
MAX_MEDIA_BYTES = 20 * 1024 * 1024
MIN_LONG_EDGE = 3840
MIN_SHORT_EDGE = 2160
_IMAGE_URL = re.compile(r"https://images\.data\.geberit\.com/[^\"'<> ]*DAS_(\d+)[^\"'<> ]*", re.I)


def is_true_4k(width: int, height: int) -> bool:
    return min(width, height) >= MIN_SHORT_EDGE and max(width, height) >= MIN_LONG_EDGE


def das_for_sku(page_html: str, sku: str) -> str | None:
    """Return the precise row image's DAS id, not an unrelated gallery image."""
    matches = list(re.finditer(re.escape(sku), page_html, re.I))
    for match in matches:
        # In Geberit's server-rendered article table the product image appears
        # immediately before its Art. no. Keep the window narrow enough not to
        # cross into a neighbouring article's row.
        window = page_html[max(0, match.start() - 2400):match.start()]
        images = _IMAGE_URL.findall(window)
        if images:
            return images[-1]
    return None


def eps_url(asset_id: str) -> str:
    if not asset_id.isdigit() or len(asset_id) < 4:
        raise ValueError("invalid Geberit DAS id")
    return EPS_URL.format(asset_id=asset_id, shard_a=asset_id[-4:-2], shard_b=asset_id[-2:])


def rasterize_eps(data: bytes) -> bytes:
    """Render an official vector master at 2400 DPI without image upscaling."""
    with tempfile.TemporaryDirectory(prefix="buildcon-geberit-") as directory:
        source = Path(directory) / "source.eps"
        output = Path(directory) / "master.png"
        source.write_bytes(data)
        completed = subprocess.run([
            "gs", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pngalpha", "-r2400",
            "-dEPSCrop", f"-sOutputFile={output}", str(source),
        ], capture_output=True, text=True, timeout=60)
        if completed.returncode != 0 or not output.exists():
            raise ValueError(f"EPS rasterization failed: {completed.stderr[-300:]}")
        result = output.read_bytes()
    if len(result) > MAX_MEDIA_BYTES:
        raise ValueError("rasterized master exceeds the catalog 20MB media limit")
    with Image.open(io.BytesIO(result)) as image:
        image.load()
        if not is_true_4k(*image.size):
            raise ValueError(f"rasterized master is not 4K ({image.width}x{image.height})")
    return result


async def run(*, limit: int = 10_000, apply: bool = False) -> dict:
    brand = await db.brands.find_one({"name": BRAND}, {"_id": 0, "id": 1, "slug": 1})
    if not brand:
        raise RuntimeError("Geberit brand was not found")
    queue = await recovery_queue(limit=10_000, max_quality="poor", floor_id="first-floor", brand_id=brand["id"])
    result: dict = {"mode": "apply" if apply else "dry-run", "candidate_pool": len(queue["items"]), "recovered": 0, "items": [], "skipped": []}
    headers = {"User-Agent": "BuildconCatalogMediaRecovery/1.0"}
    async with httpx.AsyncClient(timeout=60, follow_redirects=True, headers=headers) as client:
        for candidate in queue["items"]:
            if len(result["items"]) >= limit:
                break
            sku = candidate.get("sku")
            if not sku:
                result["skipped"].append({"product_id": candidate["product_id"], "reason": "missing SKU"})
                continue
            product = await db.products.find_one({"id": candidate["product_id"], "active": True, "floor_id": "first-floor"}, {"_id": 0})
            if not product or product.get("sku") != sku:
                result["skipped"].append({"product_id": candidate["product_id"], "sku": sku, "reason": "catalog changed"})
                continue
            try:
                page = await client.get(PRODUCT_URL.format(sku=sku))
            except httpx.HTTPError as exc:
                result["skipped"].append({"product_id": product["id"], "sku": sku, "reason": f"product request failed: {type(exc).__name__}"})
                continue
            if page.status_code != 200 or sku.lower() not in page.text.lower():
                result["skipped"].append({"product_id": product["id"], "sku": sku, "reason": f"product page HTTP {page.status_code} or SKU absent"})
                continue
            asset_id = das_for_sku(page.text, sku)
            if not asset_id:
                result["skipped"].append({"product_id": product["id"], "sku": sku, "reason": "SKU-specific official image absent"})
                continue
            source_url = eps_url(asset_id)
            try:
                source = await client.get(source_url)
            except httpx.HTTPError as exc:
                result["skipped"].append({"product_id": product["id"], "sku": sku, "reason": f"EPS request failed: {type(exc).__name__}"})
                continue
            # Geberit distributes DOS EPS binaries, whose PostScript payload
            # begins at byte 32 rather than byte zero.
            if source.status_code != 200 or b"%!PS" not in source.content[:128]:
                result["skipped"].append({"product_id": product["id"], "sku": sku, "reason": f"official EPS HTTP {source.status_code}"})
                continue
            try:
                raster = rasterize_eps(source.content)
                with Image.open(io.BytesIO(raster)) as image:
                    image.load(); width, height = image.size
            except (ValueError, OSError, subprocess.SubprocessError) as exc:
                result["skipped"].append({"product_id": product["id"], "sku": sku, "reason": str(exc)})
                continue
            item = {"product_id": product["id"], "sku": sku, "page_url": str(page.url), "source_url": source_url, "dimensions": [width, height], "sha256": hashlib.sha256(raster).hexdigest()}
            if apply:
                media = await upload_and_register(
                    data=raster, mime="image/png", brand_slug=brand.get("slug") or "geberit", product_id=product["id"],
                    brand_id=product.get("brand_id"), floor_id=product["floor_id"], source_type="manufacturer",
                    role="hero", is_primary=True, sort_order=0,
                    notes=f"Official Geberit SKU-verified EPS rasterized at 2400 DPI. Page: {page.url}; EPS: {source_url}",
                )
                current = await db.product_media.find({"product_id": product["id"]}, {"_id": 0}).to_list(100)
                item["media_id"] = media.id
                item["outcome"] = "applied" if (displayed_hero(current) or {}).get("id") == media.id else "not_displayed"
                result["recovered"] += int(item["outcome"] == "applied")
            result["items"].append(item)
    if result["recovered"]:
        catalog_service.schedule_catalog_refresh()
    return result


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=10_000)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be positive")
    print(json.dumps(await run(limit=args.limit, apply=args.apply), indent=2))


if __name__ == "__main__":
    asyncio.run(main())
