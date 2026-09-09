"""Find and safely promote SKU-verified official product media.

Discovery is read-only and writes a JSONL manifest. Applying requires both
``--apply`` and that manifest, and writes are limited to explicitly reviewed
``ready`` rows. Add an ``approval`` object with ``status: "approved"``, a
non-empty ``reviewer``, and a non-empty ``reviewed_at`` to each reviewed row.
Every asset is downloaded and validated again before it enters the existing
media pipeline. The runner never substitutes a generic search image and never
deletes the former asset.

Examples:
    python -m scripts.catalog_image_enrichment --floor-id first-floor \\
        --limit 10000 --output recovery.jsonl
    python -m scripts.catalog_image_enrichment --floor-id first-floor \\
        --legacy-poor-only --limit 100 --output legacy-recovery.jsonl
    python -m scripts.catalog_image_enrichment --apply --manifest recovery.jsonl \\
        --output applied.jsonl
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import html
import io
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, unquote, urljoin, urlparse
from xml.etree import ElementTree

import httpx
from dotenv import load_dotenv
from PIL import Image, UnidentifiedImageError

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
load_dotenv(BASE / ".env")

from db import db  # noqa: E402
from media_storage.factory import get_media_storage  # noqa: E402
from scripts.media_recovery_queue import displayed_hero, run as recovery_queue  # noqa: E402
from services import catalog_service  # noqa: E402
from services.media_service import upload_and_register  # noqa: E402


# Keep this deliberately conservative. Add a domain only after confirming it
# is a first-party manufacturer property for that brand. A custom JSON file
# may extend this list without changing code.
OFFICIAL_DOMAINS: dict[str, tuple[str, ...]] = {
    "Grohe": ("grohe.com",),
    "Hansgrohe": ("hansgrohe.com",),
    "Axor": ("axor-design.com", "hansgrohe.com"),
    # Geberit's country catalogues and image delivery service are both
    # first-party.  The generic extractor still requires the exact SKU on a
    # catalogue product page; it never treats a CDN filename alone as proof.
    "Geberit": ("geberit.com", "catalog.geberit.us", "catalog.geberit.in"),
    "Vitra": ("vitra-india.com",),
}
# Some manufacturer catalogues expose stable, SKU-addressed product pages.
# Try these first: search indexes are incomplete for discontinued/currently
# regionalised products, but the page itself still has to prove the exact SKU.
CANONICAL_PRODUCT_PAGE_URLS: dict[str, str] = {
    "grohe.com": "https://www.grohe.com/en-GB/product/{sku}",
    "catalog.geberit.in": "https://catalog.geberit.in/en-IN/product/{sku}",
    "vitra-india.com": "https://www.vitra-india.com/wall-hung-toilets/recovery-p-{sku}",
}
SEARCH_URL = "https://html.duckduckgo.com/html/"
MAX_MEDIA_BYTES = 20 * 1024 * 1024
# This runner is deliberately stricter than the legacy ``quality`` label.
# ``quality=excellent`` begins at 1024px elsewhere in the application and is
# useful for ordinary display, but it must not be presented as a 4K recovery.
# A raster master needs both axes at least 2160px and one at least 3840px.
MIN_4K_LONG_EDGE = 3840
MIN_4K_SHORT_EDGE = 2160
IMAGE_URL = re.compile(r"https?://[^\s\"'<>\\]+", re.I)
META_CONTENT = re.compile(
    r"<meta[^>]+(?:property|name)=[\"'](?:og:image(?::secure_url)?|twitter:image)[\"'][^>]+content=[\"']([^\"']+)[\"']",
    re.I,
)
IMG_ATTRIBUTE = re.compile(r"<(?:img|source)\b[^>]+(?:src|srcset)=[\"']([^\"']+)[\"']", re.I)
# Exact-SKU files can still be non-hero assets (for example a technical
# pressure/flow chart). They must never replace the customer-facing product
# hero merely because they are safe SVGs.
NON_HERO_ASSET_URL_MARKERS = ("pqchart", "technical", "diagram", "installation")


def normalized_sku(value: str | None) -> str:
    """Compare SKU values without letting case, spaces, or dots interfere."""
    return re.sub(r"[^A-Z0-9]", "", (value or "").upper())


def is_acceptable_asset(width: int, height: int, mime: str = "") -> bool:
    """Return whether an already-validated asset meets the recovery bar.

    SVG is a scalable master only after :func:`image_dimensions` has parsed
    and rejected active/external content.  Raster media is never upscaled to
    satisfy this check.
    """
    if mime.lower() == "image/svg+xml":
        return True
    return min(width, height) >= MIN_4K_SHORT_EDGE and max(width, height) >= MIN_4K_LONG_EDGE


def _host_is_official(url: str, domain: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    domain = domain.lower()
    return host == domain or host.endswith(f".{domain}")


def _duckduckgo_target(href: str) -> str | None:
    href = html.unescape(href)
    parsed = urlparse(href)
    if "duckduckgo.com" in (parsed.hostname or "") and parsed.path.startswith("/l/"):
        values = parse_qs(parsed.query).get("uddg")
        return unquote(values[0]) if values else None
    return href if href.startswith(("http://", "https://")) else None


def search_result_urls(page: str, domain: str) -> list[str]:
    """Return first-party result links from DuckDuckGo's documented HTML page."""
    links = re.findall(r"<a[^>]+class=[\"'][^\"']*result__a[^\"']*[\"'][^>]+href=[\"']([^\"']+)", page, re.I)
    result: list[str] = []
    for raw in links:
        target = _duckduckgo_target(raw)
        if target and _host_is_official(target, domain) and target not in result:
            result.append(target)
    return result


def _looks_like_image_url(url: str) -> bool:
    path = urlparse(url).path.lower()
    return any(path.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".svg"))


def is_primary_hero_asset_url(url: str) -> bool:
    """Reject exact-SKU support diagrams that are unsuitable as heroes."""
    path = urlparse(url).path.lower()
    return not any(marker in path for marker in NON_HERO_ASSET_URL_MARKERS)


def asset_urls(page_html: str, page_url: str, sku: str, limit: int) -> list[str]:
    """Extract exact-SKU image URLs from a verified product page.

    A page can contain lifestyle photos, installation diagrams and "related"
    product imagery.  The page's SKU alone does not prove any one of those is
    the product, so the generic crawler accepts only an asset URL that also
    carries the normalized SKU.  Brand-specific adapters may use a stronger
    documented identity contract where a manufacturer CDN does not embed SKUs.
    """
    found: list[str] = []
    raw_values: list[str] = META_CONTENT.findall(page_html)
    raw_values.extend(IMG_ATTRIBUTE.findall(page_html))
    raw_values.extend(IMAGE_URL.findall(html.unescape(page_html)))
    for raw in raw_values:
        # srcset can contain multiple URLs with size hints.
        for token in raw.split(","):
            candidate = token.strip().split(" ", 1)[0]
            if not candidate or candidate.startswith(("data:", "javascript:")):
                continue
            candidate = urljoin(page_url, candidate)
            if (
                not _looks_like_image_url(candidate)
                or not is_primary_hero_asset_url(candidate)
                or normalized_sku(sku) not in normalized_sku(candidate)
                or candidate in found
            ):
                continue
            found.append(candidate)
    normalized = normalized_sku(sku)
    found.sort(key=lambda value: (normalized not in normalized_sku(value), value))
    return found[:limit]


def weak_media_to_remove(rows: list[dict[str, Any]]) -> list[str]:
    """Return weak sibling media only when a usable official hero is live.

    This is deliberately separate from discovery so an interrupted recovery
    can be cleaned up safely later.  It never removes a product's only image
    and never treats supplier/internal imagery as proof that the product was
    recovered from an official source.
    """
    hero = displayed_hero(rows)
    if not hero or hero.get("source_type") != "manufacturer":
        return []
    if not is_acceptable_asset(
        int(hero.get("width") or 0), int(hero.get("height") or 0), str(hero.get("mime") or ""),
    ):
        return []
    return [
        str(row["id"])
        for row in rows
        if row.get("id") != hero.get("id")
        and str(row.get("quality") or "missing") in {"poor", "missing"}
    ]


async def prune_replaced_weak_media(*, floor_id: str, apply_changes: bool) -> dict[str, Any]:
    """Audit or remove weak media shadowed by an official hero on one floor."""
    products = await db.products.find(
        {"active": True, "floor_id": floor_id}, {"_id": 0, "id": 1, "sku": 1},
    ).to_list(10_000)
    ids = [row["id"] for row in products]
    media = await db.product_media.find({"product_id": {"$in": ids}}, {"_id": 0}).to_list(30_000)
    by_product: dict[str, list[dict[str, Any]]] = {}
    for row in media:
        by_product.setdefault(str(row["product_id"]), []).append(row)
    items = []
    removal_ids: list[str] = []
    for product in products:
        ids_to_remove = weak_media_to_remove(by_product.get(product["id"], []))
        if not ids_to_remove:
            continue
        items.append({"product_id": product["id"], "sku": product.get("sku"), "media_ids": ids_to_remove})
        removal_ids.extend(ids_to_remove)

    removed = 0
    if apply_changes:
        # Each deletion has its own storage compensation and immutable audit
        # event.  A small bound improves this long-lived maintenance job
        # without flooding Supabase or MongoDB with hundreds of requests.
        gate = asyncio.Semaphore(8)

        async def _delete_bounded(media_id: str) -> bool:
            async with gate:
                return await delete_media(media_id)

        outcomes = await asyncio.gather(*(_delete_bounded(media_id) for media_id in removal_ids))
        removed = sum(bool(outcome) for outcome in outcomes)
    if apply_changes and removed:
        catalog_service.schedule_catalog_refresh()
    return {
        "mode": "apply" if apply_changes else "dry-run",
        "floor_id": floor_id,
        "products_with_weak_legacy_media": len(items),
        "weak_media_removed" if apply_changes else "weak_media_to_remove": removed if apply_changes else len(removal_ids),
        "items": items,
    }


def _svg_dimensions(data: bytes) -> tuple[int, int]:
    """Validate a simple product SVG and return nominal scalable dimensions.

    A first-party SVG is a genuine vector master, so its pixel dimensions are
    not a quality limit.  Reject active/external SVG features before storage;
    catalog imagery is content, never executable markup.
    """
    try:
        root = ElementTree.fromstring(data)
    except (ElementTree.ParseError, UnicodeDecodeError) as exc:
        raise ValueError("asset could not be decoded as SVG") from exc
    if root.tag.rsplit("}", 1)[-1].lower() != "svg":
        raise ValueError("asset is not an SVG document")
    for node in root.iter():
        tag = node.tag.rsplit("}", 1)[-1].lower()
        if tag in {"script", "foreignobject", "iframe", "object", "embed"}:
            raise ValueError("SVG contains an active element")
        for key, value in node.attrib.items():
            if key.lower().startswith("on") or (key.rsplit("}", 1)[-1] == "href" and value and not value.startswith("#")):
                raise ValueError("SVG contains an active or external reference")
    # ``viewBox`` is the reliable scalable canvas; width/height can carry CSS
    # units and are intentionally not used as a source-resolution claim.
    view_box = root.attrib.get("viewBox", "").replace(",", " ").split()
    if len(view_box) == 4:
        try:
            width, height = float(view_box[2]), float(view_box[3])
            if width > 0 and height > 0:
                return max(1, int(width)), max(1, int(height))
        except ValueError:
            pass
    return 1024, 1024


def image_dimensions(data: bytes, mime: str = "") -> tuple[int, int]:
    if mime.lower() == "image/svg+xml" or data.lstrip().startswith(b"<svg"):
        return _svg_dimensions(data)
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            return image.size
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ValueError("asset could not be decoded as an image") from exc


def _load_domains(path: str | None) -> dict[str, tuple[str, ...]]:
    domains = dict(OFFICIAL_DOMAINS)
    if not path:
        return domains
    payload = json.loads(Path(path).read_text())
    if not isinstance(payload, dict):
        raise ValueError("domains JSON must be an object mapping a brand to domain list")
    for brand, values in payload.items():
        if not isinstance(brand, str) or not isinstance(values, list) or not all(isinstance(v, str) for v in values):
            raise ValueError("each domains JSON value must be a list of domain strings")
        domains[brand] = tuple(values)
    return domains


async def _download_image(client: httpx.AsyncClient, url: str) -> tuple[bytes, str] | None:
    try:
        async with client.stream("GET", url, follow_redirects=True) as response:
            if response.status_code != 200:
                return None
            content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
            if not content_type.startswith("image/"):
                return None
            content_length = response.headers.get("content-length")
            if content_length and int(content_length) > MAX_MEDIA_BYTES:
                return None
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > MAX_MEDIA_BYTES:
                    return None
                chunks.append(chunk)
            return b"".join(chunks), content_type
    except (httpx.HTTPError, ValueError):
        return None


async def _search_pages(
    client: httpx.AsyncClient, *, domain: str, sku: str, max_pages: int,
) -> list[str]:
    try:
        response = await client.get(SEARCH_URL, params={"q": f'site:{domain} "{sku}"'}, follow_redirects=True)
        if response.status_code != 200:
            return []
        return search_result_urls(response.text, domain)[:max_pages]
    except httpx.HTTPError:
        return []


def official_page_candidates(domain: str, sku: str, search_pages: Iterable[str]) -> list[str]:
    """Return canonical first-party SKU URL followed by de-duplicated search hits."""
    pages: list[str] = []
    template = CANONICAL_PRODUCT_PAGE_URLS.get(domain)
    if template:
        pages.append(template.format(sku=sku))
    for page in search_pages:
        if page not in pages:
            pages.append(page)
    return pages


async def find_official_asset(
    client: httpx.AsyncClient,
    *,
    sku: str,
    domains: Iterable[str],
    max_pages_per_domain: int,
    max_assets_per_page: int,
) -> dict[str, Any] | None:
    """Search first-party pages for an exact-SKU hero candidate.

    A qualifying 4K/SVG candidate returns immediately.  When an official hero
    is exact but below the recovery target, preserve the best such evidence so
    a manifest distinguishes it from a true source miss without permitting a
    write.
    """
    target_sku = normalized_sku(sku)
    best_below_target: dict[str, Any] | None = None
    for domain in domains:
        pages = official_page_candidates(
            domain, sku,
            await _search_pages(client, domain=domain, sku=sku, max_pages=max_pages_per_domain),
        )
        for page_url in pages:
            try:
                page = await client.get(page_url, follow_redirects=True)
            except httpx.HTTPError:
                continue
            if page.status_code != 200 or not _host_is_official(str(page.url), domain):
                continue
            # Exact SKU must be present in the first-party page, not inferred
            # from a search snippet or from a CDN filename.
            if target_sku not in normalized_sku(page.text):
                continue
            for source_url in asset_urls(page.text, str(page.url), sku, max_assets_per_page):
                downloaded = await _download_image(client, source_url)
                if not downloaded:
                    continue
                data, mime = downloaded
                try:
                    width, height = image_dimensions(data, mime)
                except ValueError:
                    continue
                candidate = {
                    "source_page_url": str(page.url),
                    "source_url": source_url,
                    "mime": mime,
                    "width": width,
                    "height": height,
                    "size_bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "official_domain": domain,
                    "match_evidence": f"Exact SKU {sku} present on official {domain} product page",
                    "meets_top_notch_standard": is_acceptable_asset(width, height, mime),
                }
                if candidate["meets_top_notch_standard"]:
                    return candidate
                candidate["rejection_reason"] = f"Official exact-SKU asset is below 4K target ({width}x{height})"
                if not best_below_target or (min(width, height), max(width, height)) > (
                    min(int(best_below_target["width"]), int(best_below_target["height"])),
                    max(int(best_below_target["width"]), int(best_below_target["height"])),
                ):
                    best_below_target = candidate
    return best_below_target


def _write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, sort_keys=True) + "\n")


def _append_jsonl(path: Path, row: dict[str, Any]) -> None:
    """Persist each result promptly so a long web batch can resume safely."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, sort_keys=True) + "\n")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def discovery_outcome(match: dict[str, Any] | None) -> str:
    """Classify discovery evidence without relaxing the write eligibility bar."""
    if not match:
        return "not_found_or_not_acceptable"
    return "ready" if match.get("meets_top_notch_standard") else "official_asset_below_target"


def discovery_scope(*, require_4k: bool) -> str:
    """Name the queue criterion recorded in each resumable manifest row."""
    return "top_quality" if require_4k else "legacy_poor_only"


def is_approved_ready_row(row: dict[str, Any]) -> bool:
    """Return whether a discovery result has explicit, attributable approval.

    Discovery evidence alone must never authorize a production storage/database
    write.  Requiring a reviewer and timestamp keeps the JSONL manifest both
    resumable and auditable without adding mutable review state to a product.
    """
    approval = row.get("approval")
    return (
        row.get("outcome") == "ready"
        and isinstance(approval, dict)
        and approval.get("status") == "approved"
        and isinstance(approval.get("reviewer"), str)
        and bool(approval["reviewer"].strip())
        and isinstance(approval.get("reviewed_at"), str)
        and bool(approval["reviewed_at"].strip())
    )


def storage_matches_registered_media(data: bytes, media: Any) -> bool:
    """Check that a read-back Supabase object is the registered object."""
    return (
        len(data) == int(media.size_bytes or 0)
        and hashlib.sha1(data).hexdigest() == str(media.sha1 or "")
    )


async def discover(
    *, floor_id: str, limit: int, domains_by_brand: dict[str, tuple[str, ...]],
    max_pages_per_domain: int, max_assets_per_page: int, delay_seconds: float,
    require_4k: bool = True, skip_product_ids: set[str] | None = None,
    checkpoint: Path | None = None,
) -> list[dict[str, Any]]:
    # Legacy-only runs prioritise the historical poor/missing labels. The
    # default top-quality run additionally includes every hero below 4K/SVG.
    queue = await recovery_queue(
        limit=10_000, max_quality="poor", floor_id=floor_id, require_4k=require_4k,
    )
    results: list[dict[str, Any]] = []
    headers = {"User-Agent": "BuildconCatalogImageEnrichment/1.0 (+catalog media recovery)"}
    timeout = httpx.Timeout(45, connect=15)
    async with httpx.AsyncClient(headers=headers, timeout=timeout) as client:
        remaining = [
            candidate for candidate in queue["items"]
            if candidate["product_id"] not in (skip_product_ids or set())
        ]
        for candidate in remaining[:limit]:
            sku = candidate.get("sku")
            base = {
                "mode": "discovery", "product_id": candidate["product_id"], "sku": sku,
                "name": candidate.get("name"), "brand": candidate.get("brand"),
                "floor_id": candidate.get("floor_id"), "old_media_id": candidate.get("hero_media_id"),
                "old_quality": candidate.get("hero_quality"), "old_dimensions": candidate.get("hero_dimensions"),
                "queue_scope": discovery_scope(require_4k=require_4k),
            }
            if not sku:
                row = {**base, "outcome": "missing_sku"}
                results.append(row)
                if checkpoint:
                    _append_jsonl(checkpoint, row)
                continue
            domains = domains_by_brand.get(str(candidate.get("brand")), ())
            if not domains:
                row = {**base, "outcome": "source_not_configured"}
                results.append(row)
                if checkpoint:
                    _append_jsonl(checkpoint, row)
                continue
            match = await find_official_asset(
                client, sku=sku, domains=domains, max_pages_per_domain=max_pages_per_domain,
                max_assets_per_page=max_assets_per_page,
            )
            row = {**base, "outcome": discovery_outcome(match), **(match or {})}
            results.append(row)
            if checkpoint:
                _append_jsonl(checkpoint, row)
            if delay_seconds:
                await asyncio.sleep(delay_seconds)
    return results


async def apply(manifest_rows: list[dict[str, Any]], checkpoint: Path | None = None) -> list[dict[str, Any]]:
    ready = [row for row in manifest_rows if row.get("outcome") == "ready"]
    approved = [row for row in ready if is_approved_ready_row(row)]
    results: list[dict[str, Any]] = []
    storage = get_media_storage()
    for row in ready:
        if is_approved_ready_row(row):
            continue
        result = {**row, "mode": "apply", "outcome": "skipped_unapproved"}
        results.append(result)
        if checkpoint:
            _append_jsonl(checkpoint, result)
    headers = {"User-Agent": "BuildconCatalogImageEnrichment/1.0 (+catalog media recovery)"}
    async with httpx.AsyncClient(headers=headers, timeout=httpx.Timeout(60, connect=15)) as client:
        for row in approved:
            product = await db.products.find_one({
                "id": row["product_id"], "active": True, "floor_id": row["floor_id"],
            }, {"_id": 0})
            if not product or normalized_sku(product.get("sku")) != normalized_sku(row.get("sku")):
                result = {**row, "mode": "apply", "outcome": "catalog_changed"}
                results.append(result)
                if checkpoint:
                    _append_jsonl(checkpoint, result)
                continue
            try:
                page = await client.get(row["source_page_url"], follow_redirects=True)
            except httpx.HTTPError:
                result = {**row, "mode": "apply", "outcome": "source_unavailable"}
                results.append(result)
                if checkpoint:
                    _append_jsonl(checkpoint, result)
                continue
            official_domain = str(row.get("official_domain") or "")
            if (
                not official_domain
                or page.status_code != 200
                or not _host_is_official(str(page.url), official_domain)
                or normalized_sku(row["sku"]) not in normalized_sku(page.text)
            ):
                result = {**row, "mode": "apply", "outcome": "source_sku_mismatch"}
                results.append(result)
                if checkpoint:
                    _append_jsonl(checkpoint, result)
                continue
            downloaded = await _download_image(client, row["source_url"])
            if not downloaded:
                result = {**row, "mode": "apply", "outcome": "asset_unavailable"}
                results.append(result)
                if checkpoint:
                    _append_jsonl(checkpoint, result)
                continue
            data, mime = downloaded
            try:
                width, height = image_dimensions(data, mime)
            except ValueError:
                result = {**row, "mode": "apply", "outcome": "asset_undecodable"}
                results.append(result)
                if checkpoint:
                    _append_jsonl(checkpoint, result)
                continue
            digest = hashlib.sha256(data).hexdigest()
            if not is_acceptable_asset(width, height, mime) or digest != row.get("sha256"):
                result = {**row, "mode": "apply", "outcome": "asset_changed_or_not_acceptable"}
                results.append(result)
                if checkpoint:
                    _append_jsonl(checkpoint, result)
                continue
            notes = (
                f"Official SKU-verified asset. Page: {row['source_page_url']}; "
                f"asset: {row['source_url']}; dimensions: {width}x{height}; SHA-256: {digest}"
            )
            media = await upload_and_register(
                data=data, mime=mime, brand_slug=str(row["brand"]).lower(), product_id=product["id"],
                brand_id=product.get("brand_id"), floor_id=product["floor_id"], source_type="manufacturer",
                role="hero", is_primary=True, sort_order=0, notes=notes,
            )
            registered = await db.product_media.find_one(
                {"id": media.id, "product_id": product["id"]}, {"_id": 0},
            )
            current_media = await db.product_media.find({"product_id": product["id"]}, {"_id": 0}).to_list(100)
            displayed = displayed_hero(current_media)
            stored_is_acceptable = is_acceptable_asset(
                int(media.width or 0), int(media.height or 0), str(media.mime or ""),
            )
            object_verified = False
            try:
                if await storage.exists(bucket=media.bucket, key=media.storage_key):
                    object_verified = storage_matches_registered_media(
                        await storage.download(bucket=media.bucket, key=media.storage_key), media,
                    )
            except Exception:  # Verification is reported, never hidden by a write result.
                object_verified = False
            metadata_verified = bool(
                registered
                and registered.get("bucket") == media.bucket
                and registered.get("storage_key") == media.storage_key
                and registered.get("mime") == media.mime
                and int(registered.get("width") or 0) == int(media.width or 0)
                and int(registered.get("height") or 0) == int(media.height or 0)
            )
            outcome = "stored_below_4k" if not stored_is_acceptable else "not_displayed"
            if not object_verified or not metadata_verified:
                outcome = "post_write_verification_failed"
            elif stored_is_acceptable and displayed and displayed.get("id") == media.id:
                # Keep the prior asset as a recoverable gallery/audit record.
                # Storage and metadata deletion must be an explicit, later
                # retention action—not an implicit side effect of recovery.
                outcome = "applied"
            result = {
                **row, "mode": "apply", "outcome": outcome, "new_media_id": media.id,
                "removed_media_ids": [], "storage_object_verified": object_verified,
                "product_media_verified": metadata_verified,
                "displayed_hero_verified": bool(displayed and displayed.get("id") == media.id),
            }
            results.append(result)
            if checkpoint:
                _append_jsonl(checkpoint, result)
    if approved:
        catalog_service.schedule_catalog_refresh()
    return results


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--floor-id", default="first-floor")
    parser.add_argument("--limit", type=int, default=10_000, help="Number of remaining weak heroes to process (default: entire queue)")
    parser.add_argument("--domains-json", help="JSON mapping brand names to additional/overridden official domains")
    parser.add_argument("--max-pages-per-domain", type=int, default=2)
    parser.add_argument("--max-assets-per-page", type=int, default=40)
    parser.add_argument("--delay-seconds", type=float, default=0.25)
    parser.add_argument("--output", required=True, help="JSONL result/manifest path")
    parser.add_argument("--resume", action="store_true", help="Continue discovery using product IDs already in --output")
    parser.add_argument(
        "--legacy-poor-only", action="store_true",
        help="Discover only legacy poor/missing displayed heroes; still require 4K/SVG assets",
    )
    parser.add_argument("--manifest", help="Reviewed discovery JSONL to apply")
    parser.add_argument("--apply", action="store_true", help="Write only ready rows from --manifest")
    args = parser.parse_args()
    if args.limit < 1 or args.max_pages_per_domain < 1 or args.max_assets_per_page < 1 or args.delay_seconds < 0:
        parser.error("limits must be positive and delay cannot be negative")
    if args.apply != bool(args.manifest):
        parser.error("--apply and --manifest must be supplied together; discovery is otherwise read-only")
    output = Path(args.output)
    if args.apply and args.resume:
        parser.error("--resume is discovery-only; use a new output path for each apply run")
    if args.apply and args.legacy_poor_only:
        parser.error("--legacy-poor-only is discovery-only")
    if args.apply:
        if output.exists():
            output.unlink()
        rows = await apply(_read_jsonl(Path(args.manifest)), checkpoint=output)
    else:
        existing_rows = _read_jsonl(output) if args.resume and output.exists() else []
        if not args.resume and output.exists():
            output.unlink()
        new_rows = await discover(
            floor_id=args.floor_id, limit=args.limit, domains_by_brand=_load_domains(args.domains_json),
            max_pages_per_domain=args.max_pages_per_domain, max_assets_per_page=args.max_assets_per_page,
            delay_seconds=args.delay_seconds, require_4k=not args.legacy_poor_only,
            skip_product_ids={str(row["product_id"]) for row in existing_rows if row.get("product_id")},
            checkpoint=output,
        )
        rows = [*existing_rows, *new_rows]
    counts: dict[str, int] = {}
    for row in rows:
        counts[str(row["outcome"])] = counts.get(str(row["outcome"]), 0) + 1
    print(json.dumps({"mode": "apply" if args.apply else "discovery", "output": str(output), "counts": counts}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
