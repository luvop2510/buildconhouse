"""In-process read model for Forge's supplier catalog.

MongoDB Atlas is geographically remote from the API runtime (~228 ms per
round trip), while the complete production catalog is small (~3 MB products +
~2.6 MB media metadata). Loading one immutable snapshot at startup removes the
multi-round-trip tax from every catalog request. Mutating routes refresh the
snapshot explicitly; a stale-while-revalidate timer is a safety net for writes
performed by offline import scripts.
"""
from __future__ import annotations

import asyncio
import copy
import logging
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field as dataclass_field, replace
from contextvars import ContextVar
from functools import wraps
from bson import BSON
from datetime import datetime
from time import monotonic
from typing import Optional

from db import db
from catalog_policy import removed_brand_document
from models import ProductMedia

_SNAPSHOT_MAX_AGE_SECONDS = 300.0
_MEDIA_PRIORITY = {"internal": 0, "manufacturer": 1, "supplier": 2}
_SEARCH_FIELDS = (
    "name", "sku", "description", "series", "family_name", "subcategory",
    "collection", "finish", "colour", "dimensions", "size", "tags", "catalog_search_text",
)
# Ground Floor is exclusively the Tiles module (Qutone, Dimore, ...). Real
# tile supplier pricelists routinely reuse one photograph across several
# finish/size SKUs of the same design — that's normal, not a data-entry
# mistake, unlike sanitaryware colour variants (see
# `_canonical_sku_for_sha1`). Guards built around "identical photo across
# siblings = mistake" must not apply here.
_TILE_FLOOR_ID = "ground-floor"
# Hierarchy exposes these labels for missing supplier metadata. Filtering a
# visible choice must include the same products as that hierarchy branch.
_HIERARCHY_FALLBACK_LABELS = {"subcategory": "General", "series": "Uncategorised"}


@dataclass
class CatalogSnapshot:
    products: tuple[dict, ...]
    product_by_id: dict[str, dict]
    products_by_family: dict[str, tuple[dict, ...]]
    media_by_product: dict[str, tuple[ProductMedia, ...]]
    media_by_family: dict[str, tuple[ProductMedia, ...]]
    media_rows_by_product: dict[str, tuple[dict, ...]]
    media_rows_by_family: dict[str, tuple[dict, ...]]
    brands: tuple[dict, ...]
    categories: tuple[dict, ...]
    global_usage: dict[str, int]
    usage_by_user: dict[str, dict[str, dict]]
    loaded_at: float
    database_backed: bool = False
    # Lazily built, bounded references into this snapshot. Hydrating each WC
    # variant or legacy concealed association must not scan the whole catalog.
    hydration_by_sku: dict[str, tuple[dict, ...]] | None = None
    hydration_by_configuration: dict[str, tuple[dict, ...]] | None = None
    source_bytes: int = 0
    source_rows: dict[str, int | None] = dataclass_field(default_factory=dict)


_snapshot_override: ContextVar[CatalogSnapshot | None] = ContextVar("catalog_snapshot_override", default=None)
# The October supplier imports raised the verified source data to ~20 MB.
# The former 16 MiB cap silently sent this ordinary catalog through the
# network-heavy fallback. Keep a finite budget with headroom for the active
# catalog; Railway's 1 GiB process limit still bounds deployment memory.
_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024
_SNAPSHOT_ROW_LIMITS = {"products": 10000, "product_media": 20000, "brands": 2000, "categories": 2000, "product_usage": 50000}
_SNAPSHOT_BATCH_SIZE = 512
_snapshot: CatalogSnapshot | None = None
_refresh_lock = asyncio.Lock()
_background_refresh: asyncio.Task | None = None
_refresh_generation = 0
_refresh_retry_at = 0.0
_REFRESH_RETRY_SECONDS = 15.0
_logger = logging.getLogger(__name__)


def _media_sort_key(row: dict) -> tuple[int, int, int]:
    return (
        _MEDIA_PRIORITY.get(row.get("source_type", "supplier"), 3),
        0 if row.get("is_primary") else 1,
        int(row.get("sort_order", 100)),
    )


def _build_snapshot(
    products: list[dict], media_rows: list[dict], brands: list[dict],
    categories: list[dict], usage_rows: list[dict],
) -> CatalogSnapshot:
    excluded_brand_ids = {row["id"] for row in brands if removed_brand_document(row)}
    brands = [row for row in brands if row["id"] not in excluded_brand_ids]
    excluded_products = [row for row in products if row.get("brand_id") in excluded_brand_ids]
    excluded_ids = {row["id"] for row in excluded_products}
    excluded_families = {row.get("family_key") for row in excluded_products if row.get("family_key")}
    products = [row for row in products if row["id"] not in excluded_ids]
    retained_families = {row.get("family_key") for row in products if row.get("family_key")}
    excluded_families -= retained_families
    media_rows = [row for row in media_rows if row.get("product_id") not in excluded_ids
                  and row.get("family_key") not in excluded_families]
    product_by_id = {row["id"]: row for row in products}
    products_by_family_raw: dict[str, list[dict]] = defaultdict(list)
    for row in products:
        if row.get("family_key"):
            products_by_family_raw[row["family_key"]].append(row)

    media_product_raw: dict[str, list[dict]] = defaultdict(list)
    media_family_raw: dict[str, list[dict]] = defaultdict(list)
    for row in media_rows:
        if row.get("product_id"):
            media_product_raw[row["product_id"]].append(row)
        if row.get("family_key"):
            media_family_raw[row["family_key"]].append(row)
    for rows in media_product_raw.values():
        rows.sort(key=_media_sort_key)
    for rows in media_family_raw.values():
        rows.sort(key=_media_sort_key)
    # A photo attached to both a SKU and a family is one model referenced by
    # two indexes, rather than two independently validated Python objects.
    media_models = {id(row): ProductMedia(**row) for row in media_rows
                    if row.get("product_id") or row.get("family_key")}

    global_usage: dict[str, int] = defaultdict(int)
    usage_by_user: dict[str, dict[str, dict]] = defaultdict(dict)
    for row in usage_rows:
        pid = row.get("product_id")
        uid = row.get("user_id")
        if not pid:
            continue
        global_usage[pid] += int(row.get("count", 0))
        if uid:
            usage_by_user[uid][pid] = row

    return CatalogSnapshot(
        products=tuple(products),
        product_by_id=product_by_id,
        products_by_family={key: tuple(rows) for key, rows in products_by_family_raw.items()},
        media_by_product={
            key: tuple(media_models[id(row)] for row in rows)
            for key, rows in media_product_raw.items()
        },
        media_by_family={
            key: tuple(media_models[id(row)] for row in rows)
            for key, rows in media_family_raw.items()
        },
        media_rows_by_product={key: tuple(rows) for key, rows in media_product_raw.items()},
        media_rows_by_family={key: tuple(rows) for key, rows in media_family_raw.items()},
        brands=tuple(sorted(brands, key=lambda row: row.get("name") or "")),
        categories=tuple(sorted(categories, key=lambda row: row.get("name") or "")),
        global_usage=dict(global_usage),
        usage_by_user={uid: dict(rows) for uid, rows in usage_by_user.items()},
        loaded_at=monotonic(),
    )


async def _bounded_snapshot_collection(name: str, query: dict, budget: list[int]) -> list[dict] | None:
    rows: list[dict] = []
    # A 32-document batch made normal catalogs pay hundreds of remote
    # getMore round trips. Mongo still bounds each batch by its wire byte cap;
    # the shared byte/row guards below bound retained snapshot data.
    cursor = db[name].find(query, {"_id": 0}).batch_size(_SNAPSHOT_BATCH_SIZE)
    try:
        async for row in cursor:
            budget[0] += len(BSON.encode(row))
            if len(rows) >= _SNAPSHOT_ROW_LIMITS[name] or budget[0] > _SNAPSHOT_MAX_BYTES:
                return None
            rows.append(row)
    finally:
        await cursor.close()
    return rows


async def refresh_catalog_snapshot(*, only_if_missing: bool = False) -> CatalogSnapshot:
    """Warm a bounded cache, or select indexed Mongo reads for a large catalog.

    The byte budget is shared by all collections. Cursors use bounded batches;
    crossing the threshold discards the partial cache, never partial results.
    """
    global _snapshot, _refresh_retry_at
    async with _refresh_lock:
        # Concurrent cold requests wait for the first warmup and reuse it.
        # Explicit post-write refreshes always reload the source collections.
        if only_if_missing and _snapshot is not None:
            return _snapshot
        while True:
            generation = _refresh_generation
            budget = [0]
            collection_names = ("products", "product_media", "brands", "categories", "product_usage")
            # These collections are independent. TaskGroup also cancels and
            # closes every cursor if one source fails, preserving the old model.
            async with asyncio.TaskGroup() as group:
                reads = [group.create_task(_bounded_snapshot_collection(
                    name, {"active": True} if name == "products" else {}, budget,
                )) for name in collection_names]
            collections = [read.result() for read in reads]
            if any(rows is None for rows in collections):
                candidate = _build_snapshot([], [], [], [], [])
                candidate.database_backed = True
            else:
                # Pydantic media validation/index creation must not freeze all
                # other API requests during a cold or periodic catalog rebuild.
                candidate = await asyncio.to_thread(_build_snapshot, *collections)
            candidate.source_bytes = budget[0]
            candidate.source_rows = dict(zip(collection_names, [
                len(rows) if rows is not None else None for rows in collections
            ]))
            if generation != _refresh_generation:
                # A completed write during source reads invalidates this build.
                # Reload it rather than overwriting the immediate product edit.
                continue
            _snapshot = candidate
            _refresh_retry_at = 0.0
            log = _logger.warning if candidate.database_backed or budget[0] >= _SNAPSHOT_MAX_BYTES * .8 else _logger.info
            log("Catalog mode=%s source_bytes=%d budget_bytes=%d source_rows=%s",
                "database" if candidate.database_backed else "memory", budget[0],
                _SNAPSHOT_MAX_BYTES, candidate.source_rows)
            return _snapshot


def catalog_diagnostics() -> dict:
    """Operational counters only, safe for readiness and performance probes."""
    snapshot = _snapshot
    return {
        "mode": "uninitialized" if snapshot is None else "database" if snapshot.database_backed else "memory",
        "source_bytes": snapshot.source_bytes if snapshot else 0,
        "budget_bytes": _SNAPSHOT_MAX_BYTES,
        "source_rows": snapshot.source_rows if snapshot else {},
        "refresh_in_flight": _background_refresh is not None and not _background_refresh.done(),
        "retry_after_seconds": max(0, round(_refresh_retry_at - monotonic(), 1)),
    }


async def _background_catalog_refresh() -> CatalogSnapshot:
    global _refresh_retry_at
    try:
        return await refresh_catalog_snapshot(only_if_missing=_snapshot is None)
    except Exception:
        _refresh_retry_at = monotonic() + _REFRESH_RETRY_SECONDS
        _logger.exception("Catalog refresh failed; retaining the previous snapshot")
        raise


def _refresh_finished(task: asyncio.Task) -> None:
    # Retrieve exceptions even if every request was cancelled or a warm request
    # used stale data. The refresh coroutine logs its failure once.
    if not task.cancelled():
        task.exception()


def _start_catalog_refresh() -> asyncio.Task:
    global _background_refresh
    if _background_refresh is None or _background_refresh.done():
        _background_refresh = asyncio.create_task(_background_catalog_refresh())
        _background_refresh.add_done_callback(_refresh_finished)
    return _background_refresh


async def stop_catalog_refresh() -> None:
    """Finish ownership of background catalog work before Mongo shutdown."""
    global _background_refresh
    task = _background_refresh
    _background_refresh = None
    if task is not None and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


async def get_catalog_snapshot() -> CatalogSnapshot:
    override = _snapshot_override.get()
    if override is not None:
        return override
    if _snapshot is None:
        # All cold callers share success/failure and a disconnected client
        # cannot cancel the shared warmup for other pages.
        if monotonic() < _refresh_retry_at and _background_refresh is not None:
            return await asyncio.shield(_background_refresh)
        return await asyncio.shield(_start_catalog_refresh())
    if (monotonic() - _snapshot.loaded_at > _SNAPSHOT_MAX_AGE_SECONDS
            and monotonic() >= _refresh_retry_at):
        _start_catalog_refresh()
    return _snapshot


def schedule_catalog_refresh() -> None:
    """Refresh after a catalog/media mutation without delaying its response."""
    global _refresh_generation
    # Don't lose an invalidation when a prior refresh is already in flight.
    _refresh_generation += 1
    _start_catalog_refresh()


def patch_product_in_snapshot(product_id: str, updates: dict) -> None:
    """Apply a field-level product edit to the live in-process snapshot
    immediately — no Atlas round trip, no full-catalog rebuild, no backend
    restart. This is the "refresh only the affected product" path the
    single-source-of-truth product editor relies on for instant propagation
    to every screen reading from the snapshot (catalog grid, search, product
    detail, quotation builder picker) without waiting on the background
    refresh below.

    Safe by construction: `product_by_id[id]` and the matching entries inside
    `products` / `products_by_family` are the SAME dict object (built via a
    single comprehension in `_build_snapshot`), so mutating the dict in place
    is instantly visible through every one of those views — there is nothing
    else to keep in sync.

    `schedule_catalog_refresh()` still runs alongside this as a durability
    backstop (matches the existing media-mutation pattern), in case the
    in-memory snapshot was ever rebuilt from a source that doesn't share
    object identity (e.g. a cold reload mid-request).
    """
    if _snapshot is None:
        return
    row = _snapshot.product_by_id.get(product_id)
    if row is not None:
        row.update(updates)
        # A product edit can change its SKU or configuration group. Rebuild on
        # the next read so the immediate edit path remains authoritative.
        _snapshot.hydration_by_sku = None
        _snapshot.hydration_by_configuration = None
    schedule_catalog_refresh()


async def note_product_usage(user_id: str, product_ids: list[str], at: str) -> None:
    """Keep popularity/recent/frequent reads coherent with a completed write."""
    global _snapshot
    async with _refresh_lock:
        if _snapshot is None or getattr(_snapshot, "database_backed", False):
            return
        snapshot = _snapshot
        global_usage = dict(snapshot.global_usage)
        usage_by_user = {
            uid: {pid: dict(row) for pid, row in rows.items()}
            for uid, rows in snapshot.usage_by_user.items()
        }
        mine = usage_by_user.setdefault(user_id, {})
        for product_id in set(product_ids):
            previous = mine.get(product_id, {})
            mine[product_id] = {
                "user_id": user_id,
                "product_id": product_id,
                "count": int(previous.get("count", 0)) + 1,
                "last_used_at": at,
            }
            global_usage[product_id] = global_usage.get(product_id, 0) + 1
        _snapshot = replace(snapshot,
            global_usage=global_usage,
            usage_by_user=usage_by_user,
        )


def _dedup_media(rows: list[ProductMedia]) -> list[ProductMedia]:
    seen: set[str] = set()
    out: list[ProductMedia] = []
    for row in sorted(rows, key=lambda item: (
        _MEDIA_PRIORITY.get(item.source_type, 3),
        0 if item.is_primary else 1,
        int(item.sort_order),
    )):
        if row.id in seen:
            continue
        seen.add(row.id)
        out.append(row)
    return out


def _canonical_sku_for_sha1(snapshot: CatalogSnapshot, family_key: str, sha1: str) -> Optional[str]:
    """Deterministic (lowest-SKU) owner of a given image hash within a family.

    Used to suppress a supplier-file duplicate photo (byte-identical image
    reused across two different colour/finish siblings) on every sibling
    except one, so switching variants never appears to show "the same
    picture again" for a reason the user can't tell apart from a bug.
    """
    canonical: Optional[str] = None
    for sibling in snapshot.products_by_family.get(family_key, ()):
        sib_sku = sibling.get("sku") or ""
        if any(m.sha1 == sha1 for m in snapshot.media_by_product.get(sibling["id"], ())):
            if canonical is None or sib_sku < canonical:
                canonical = sib_sku
    return canonical


def _apply_media(product: dict, snapshot: CatalogSnapshot) -> None:
    # Both the cached catalog and database-backed endpoints use the same
    # photo/seat-cover/legacy preview policy. Resolve only this exact product:
    # family siblings can have different finishes and must never lend images.
    from services.media_service import _apply_media_to_product

    rows = _dedup_media(list(snapshot.media_by_product.get(product.get("id"), ())))
    _apply_media_to_product(product, rows)


def _primary_product_image(snapshot: CatalogSnapshot, product_id: str, family_key: Optional[str] = None) -> Optional[str]:
    # Product media is authoritative.  Do not fall back to family media here:
    # a family can contain visually different finish/size variants, and a
    # supplier ``family_key`` is not globally unique. Reapply the exact
    # primary/source/sort policy used by `_apply_media` rather than relying on
    # the incidental insertion order of raw snapshot rows; this value feeds
    # `variants[].image`, which is the selected-colour hero source.
    media_by_product = getattr(snapshot, "media_by_product", None)
    if media_by_product is not None:
        from services.media_service import _apply_media_to_product

        media_rows = _dedup_media(list(media_by_product.get(product_id, ())))
        preview = dict(getattr(snapshot, "product_by_id", {}).get(product_id, {}))
        _apply_media_to_product(preview, media_rows)
        return preview["hero_image_url"]

    # Lightweight snapshot doubles used by focused family-list tests expose
    # the raw rows only. Preserve the production ordering policy there too,
    # rather than making a catalogue list depend on an implementation detail
    # of the full immutable snapshot.
    rows = list(getattr(snapshot, "media_rows_by_product", {}).get(product_id, ()))
    rows.sort(key=lambda item: (
        _MEDIA_PRIORITY.get(item.get("source_type", "supplier"), 3),
        0 if item.get("is_primary") else 1,
        int(item.get("sort_order", 100)),
    ))
    photos = [row for row in rows if row.get("public_url") and row.get("role") not in ("dimension", "seat-cover")]
    for row in photos:
        if row.get("is_primary") or row.get("role") == "hero":
            return row["public_url"]
    if photos:
        return photos[0]["public_url"]
    return next((row["public_url"] for row in rows if row.get("public_url") and row.get("role") == "seat-cover"), None)


def _family_siblings(snapshot: CatalogSnapshot, product: dict) -> list[dict]:
    """Return the actual family of one catalog product.

    Supplier family keys are only meaningful inside a floor and the catalog
    namespace (brand/category).  Keeping this rule in one place prevents a
    coincidental key on another floor or category from becoming a selectable
    variant or leaking its media into a card.
    """
    family_key = product.get("family_key")
    if not family_key:
        return [product]
    siblings = [
        sibling for sibling in getattr(snapshot, "products_by_family", {}).get(family_key, ())
        if sibling.get("floor_id") == product.get("floor_id")
        and sibling.get("brand_id") == product.get("brand_id")
        and _is_catalog_product(sibling, snapshot)
        and (
            any(e.get("category_id") == product.get("category_id") for e in sibling.get("catalog_entries") or [])
            if product.get("catalog_entries") else sibling.get("category_id") == product.get("category_id")
        )
    ]
    if product.get("catalog_entries"):
        siblings.sort(key=lambda sibling: min(
            e.get("source_order", 0) for e in sibling["catalog_entries"]
            if e.get("category_id") == product.get("category_id")
        ))
    return siblings


def _normalise_size(value: object) -> str:
    """Compare supplier size strings without making their display text lossy.

    Supplier files variously use ``600 X 1200``, ``600x1200`` and
    ``600×1200`` for the same nominal tile.  The catalog returns the original
    (first-seen) label, but uses this canonical key when grouping/resolving a
    size selection.
    """
    return re.sub(r"\s+", "", str(value or "").strip().lower()).replace("×", "x")


def _product_size(product: dict) -> Optional[str]:
    value = product.get("size") or product.get("dimensions")
    text = str(value or "").strip()
    return text or None


def _size_metadata_for_products(products: list[dict]) -> dict:
    """Expose the distinct selectable sizes for one product style.

    A style is a ``family_key`` on one floor.  A selector is useful only when
    at least two distinct nominal sizes exist; a one-SKU/one-size product is
    deliberately reported as non-switchable rather than pretending it has a
    variant control.
    """
    labels: dict[str, str] = {}
    for sibling in products:
        label = _product_size(sibling)
        key = _normalise_size(label)
        if label and key:
            labels.setdefault(key, label)
    # Nominal tile dimensions should read naturally (600x600 before
    # 600x1200), rather than lexicographically (where "1200" sorts first).
    available_sizes = [
        label for _, label in sorted(
            labels.items(),
            key=lambda item: (
                tuple(int(part) for part in re.findall(r"\d+", item[1])),
                item[0],
            ),
        )
    ]
    return {
        "available_sizes": available_sizes,
        "size_count": len(available_sizes),
        "size_switchable": len(available_sizes) > 1,
    }


def _size_metadata(product: dict, snapshot: CatalogSnapshot) -> dict:
    if product.get("family_key"):
        siblings = _family_siblings(snapshot, product)
    else:
        siblings = [product]
    return _size_metadata_for_products(siblings)


def _variant_summary(product: dict, snapshot: CatalogSnapshot) -> dict:
    """Return every SKU-specific field a finish selector must switch.

    A family is only a navigation aid: its members remain independent SKUs
    with their own price, stock, specifications and media.  Keeping this
    projection in one place prevents a grouped card from accidentally showing
    the representative SKU's business data after a user selects another
    finish.
    """
    colour = product.get("colour") or product.get("color")
    summary = {
        "id": product["id"], "sku": product.get("sku"), "name": product.get("name"),
        "finish": product.get("finish"), "finish_code": product.get("finish_code"),
        "variant_label": product.get("variant_label"), "size": _product_size(product),
        "colour": colour, "color": colour,
        "price": product.get("price"), "mrp": product.get("mrp"),
        "stock": product.get("stock", 0), "dimensions": product.get("dimensions"),
        "dimension_image_urls": product.get("dimension_image_urls") or [],
        "seat_cover_image_urls": product.get("seat_cover_image_urls") or [],
        "material": product.get("material"), "warranty": product.get("warranty"),
        "specs": product.get("specs") or {}, "description": product.get("description"),
        "image": _primary_product_image(snapshot, product["id"], product.get("family_key")),
        "configuration_options": _configuration_options(product, snapshot),
    }
    if product.get("price_status") is not None:
        summary["price_unknown"] = product["price_status"] == "unspecified"
    if product.get("catalog_entries"):
        entry = next((e for e in product["catalog_entries"] if e.get("category_id") == product.get("category_id")), product["catalog_entries"][0])
        summary["listing_id"] = product.get("listing_id") or entry["entry_id"]
    # Each finish is independently sellable. Explicit null prevents clients
    # from inheriting the representative card's rough-in for another SKU.
    summary["concealed_part"] = None
    if product.get("concealed_part"):
        configured = {
            "id": product.get("id"), "floor_id": product.get("floor_id"), "brand_id": product.get("brand_id"),
            "concealed_part": copy.deepcopy(product["concealed_part"]),
        }
        _hydrate_concealed_part(configured, snapshot)
        summary["concealed_part"] = configured["concealed_part"]
    return summary


def _hydration_products(snapshot):
    return snapshot.product_by_id.values() if hasattr(snapshot, "product_by_id") else snapshot.products


def _hydration_candidates(snapshot, *, sku=None, configuration_group=None):
    if getattr(snapshot, "hydration_by_sku", None) is None or getattr(snapshot, "hydration_by_configuration", None) is None:
        by_sku = defaultdict(list)
        by_configuration = defaultdict(list)
        for candidate in _hydration_products(snapshot):
            if candidate.get("sku"):
                by_sku[candidate["sku"]].append(candidate)
            specs = candidate.get("specs") or {}
            group = specs.get("configuration_group") if isinstance(specs, dict) else None
            if isinstance(group, str) and group:
                by_configuration[group].append(candidate)
        snapshot.hydration_by_sku = {key: tuple(rows) for key, rows in by_sku.items()}
        snapshot.hydration_by_configuration = {key: tuple(rows) for key, rows in by_configuration.items()}
    if sku is not None:
        return snapshot.hydration_by_sku.get(sku, ())
    return snapshot.hydration_by_configuration.get(configuration_group, ())


def _hydrate_concealed_part(product: dict, snapshot: CatalogSnapshot) -> None:
    """Fill a legacy SKU-only conceal configuration from this catalog snapshot.

    Migration 0021 deliberately preserves old importer fields as a minimal
    ``{sku, qty}`` configuration.  Resolving those rows here makes them as
    usable in the quotation picker as a newly configured product, without a
    database lookup on the catalog read path.
    """
    configured = product.get("concealed_part")
    if not isinstance(configured, dict) or not str(configured.get("sku") or "").strip():
        return
    sku = str(configured["sku"]).strip()
    def eligible(candidate):
        return (candidate and candidate.get("id") != product.get("id")
                and candidate.get("floor_id") == product.get("floor_id")
                and candidate.get("sku") == sku and candidate.get("active", True))

    selected_id = configured.get("product_id")
    if selected_id:
        # A saved selection identifies an exact SKU even when other brands
        # reuse its article number. Do not substitute an arbitrary same-SKU
        # product if that selected item has been retired or moved.
        linked = snapshot.product_by_id.get(selected_id)
        linked = linked if eligible(linked) else None
    else:
        matches = [candidate for candidate in _hydration_candidates(snapshot, sku=sku) if eligible(candidate)]
        same_brand = [candidate for candidate in matches if candidate.get("brand_id") == product.get("brand_id")]
        linked = same_brand[0] if len(same_brand) == 1 else matches[0] if len(matches) == 1 else None
    if not linked:
        product["concealed_part"] = {**configured, "product_id": None}
        return
    product["concealed_part"] = {
        **configured,
        "sku": sku,
        "product_id": linked.get("id"),
        "name": linked.get("name"),
        "description": linked.get("description"),
        "unit_price": linked.get("price"),
        "mrp": linked.get("mrp"),
        "image": _primary_product_image(snapshot, linked["id"], linked.get("family_key")) or linked.get("hero_image_url") or (linked.get("images") or [None])[0],
    }


def _hydrate_variants(product: dict, snapshot: CatalogSnapshot) -> None:
    if (product.get("variants") and not product.get("catalog_entries")) or not product.get("family_key"):
        return
    variants = []
    for sibling in _family_siblings(snapshot, product):
        if sibling["id"] == product["id"]:
            continue
        variants.append(_variant_summary(sibling, snapshot))
    if variants or product.get("catalog_entries"):
        # A colour/finish selector is only truthful if every sibling SKU can
        # be selected.  The former eight-item preview silently hid finishes in
        # larger supplier families (including 10+ finish Hansgrohe ranges).
        product["variants"] = variants


def _configuration_options(product: dict, snapshot: CatalogSnapshot) -> list[dict]:
    """Return same-finish WC configuration choices, never changing colour."""
    specs = product.get("specs") or {}
    group = specs.get("configuration_group") if isinstance(specs, dict) else None
    if not isinstance(group, str) or not group:
        return []
    finish = str(product.get("finish") or product.get("colour") or "").strip().casefold()
    options: list[dict] = []
    seen_labels: set[str] = set()
    for candidate in _hydration_candidates(snapshot, configuration_group=group):
        candidate_specs = candidate.get("specs") or {}
        if (
            not isinstance(candidate_specs, dict)
            or not _is_catalog_product(candidate, snapshot)
            or candidate_specs.get("configuration_group") != group
            or candidate.get("floor_id") != product.get("floor_id")
            or candidate.get("brand_id") != product.get("brand_id")
            or candidate.get("category_id") != product.get("category_id")
            or str(candidate.get("finish") or candidate.get("colour") or "").strip().casefold() != finish
        ):
            continue
        label = str(candidate_specs.get("configuration_label") or candidate.get("name") or candidate.get("sku"))
        if label in seen_labels:
            continue
        seen_labels.add(label)
        options.append({
            "id": candidate["id"], "sku": candidate.get("sku"), "label": label,
            "price": candidate.get("price"), "mrp": candidate.get("mrp"),
            "finish": candidate.get("finish") or candidate.get("colour"),
            "image": _primary_product_image(snapshot, candidate["id"], candidate.get("family_key")),
        })
    return sorted(options, key=lambda option: (option["label"], option.get("sku") or "")) if len(options) > 1 else []


def _family_variants(product: dict, snapshot: CatalogSnapshot) -> list[dict]:
    """Complete, same-floor family membership for size-aware clients.

    ``variants`` omits the current product for legacy callers. This separate
    contract includes the current product too, so clients can model the whole
    family without having to reconstruct that membership themselves.
    """
    if product.get("family_key"):
        rows = _family_siblings(snapshot, product)
    else:
        rows = [product]
    return [
        _variant_summary(row, snapshot)
        for row in (rows if product.get("catalog_entries") else sorted(rows, key=lambda item: (item.get("sku") or "", item.get("id") or "")))
    ]


def product_hero_image(product: dict, snapshot: CatalogSnapshot) -> Optional[str]:
    """Resolve an exact SKU preview without hydrating its family and variants."""
    preview = dict(product)
    _apply_media(preview, snapshot)
    return preview.get("hero_image_url")


def hydrate_product(product: dict, snapshot: CatalogSnapshot) -> dict:
    out = {key: copy.deepcopy(value) for key, value in product.items() if not key.startswith("_")}
    out["price_unknown"] = product.get("price_status") == "unspecified"
    _apply_media(out, snapshot)
    _hydrate_concealed_part(out, snapshot)
    _hydrate_variants(out, snapshot)
    out["configuration_options"] = _configuration_options(product, snapshot)
    out.update(_size_metadata(product, snapshot))
    out["family_variants"] = _family_variants(product, snapshot)
    return out


def _is_catalog_product(product: dict, snapshot: CatalogSnapshot) -> bool:
    brand = next((b for b in getattr(snapshot, "brands", ()) if b.get("id") == product.get("brand_id")), {})
    return not brand.get("catalog_authoritative") or bool(
        product.get("catalog_source") == brand.get("catalog_source") and product.get("catalog_entries")
    )


def _product_listing(product: dict, entry: dict) -> dict:
    row = {**product, "listing_id": entry["entry_id"], "catalog_entry": entry}
    for field in ("category_id", "subcategory", "name", "description"):
        if field in entry and (field == "subcategory" or entry[field] is not None):
            row[field] = entry[field]
    row["source_price_unspecified"] = entry.get("mrp") is None
    if entry.get("mrp") is not None:
        row.update(mrp=entry["mrp"], price=entry["mrp"], price_status="known", price_source="supplier")
    else:
        row["price_source"] = "existing" if product.get("price_status") != "unspecified" else "unspecified"
    return row


def _listing_products(snapshot: CatalogSnapshot) -> list[dict]:
    """Project workbook rows without changing canonical IDs or stored data.

    One SKU can occur in several sheets/sections. Filtering must happen after
    expansion, otherwise its later category placements silently disappear.
    """
    rows = []
    for product in snapshot.products:
        if not _is_catalog_product(product, snapshot):
            continue
        if product.get("_catalog_database_listing"):
            rows.append(product)
            continue
        entries = product.get("catalog_entries") or []
        if not entries:
            rows.append(product)
            continue
        for entry in entries:
            row = _product_listing(product, entry)
            rows.append(row)
    return rows


def _family_listing_siblings(snapshot: CatalogSnapshot, product: dict) -> list[dict]:
    siblings = []
    for sibling in _family_siblings(snapshot, product):
        if sibling["id"] == product["id"]:
            siblings.append(product)
            continue
        entry = next((entry for entry in sibling.get("catalog_entries") or []
                      if entry.get("category_id") == product.get("category_id")), None)
        siblings.append(_product_listing(sibling, entry) if entry else sibling)
    return siblings


def _unique_listings(rows: list[dict], *, per_category: bool = False, per_placement: bool = False) -> list[dict]:
    """Keep the first matching source placement, retaining every row on the SKU."""
    seen = set()
    out = []
    for index, row in enumerate(rows):
        product_id = row.get("id", index)
        if per_placement:
            key = (product_id, *((row.get(field) or _HIERARCHY_FALLBACK_LABELS[field])
                                 if field in _HIERARCHY_FALLBACK_LABELS else row.get(field) for field in (
                "category_id", "subcategory", "series", "family_key", "family_name",
            )))
        else:
            key = (product_id, row.get("category_id")) if per_category else product_id
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def _source_sort_key(row: dict, snapshot: CatalogSnapshot) -> tuple:
    entry = row.get("catalog_entry") or {}
    brand_order = next((b.get("catalog_order", 999) for b in getattr(snapshot, "brands", ())
                        if b.get("id") == row.get("brand_id")), 999)
    return (
        0 if entry else 1, brand_order if brand_order is not None else 999,
        entry.get("source_catalog") or "", entry.get("source_order", 0),
        row.get("name") or "", row.get("listing_id") or row["id"],
    )


def _category_sort_key(category: dict) -> tuple:
    order = category.get("catalog_order")
    return (0 if order is not None else 1, order if order is not None else 999,
            category.get("name") or "", category.get("id") or "")


def _matches_filters(product: dict, *, brand_id: Optional[str], category_id: Optional[str],
                     subcategory: Optional[str], series: Optional[str], family_key: Optional[str],
                     finish: Optional[str], colour: Optional[str],
                     floor_ids: Optional[list[str]] = None) -> bool:
    if floor_ids is not None and product.get("floor_id") not in floor_ids:
        return False
    expected = {
        "brand_id": brand_id,
        "category_id": category_id,
        "subcategory": subcategory,
        "series": series,
        "family_key": family_key,
        "finish": finish,
        "colour": colour,
    }
    def matches(field, value):
        actual = product.get(field)
        if field in _HIERARCHY_FALLBACK_LABELS:
            label = _HIERARCHY_FALLBACK_LABELS[field]
            requests_fallback = label in value if isinstance(value, (list, tuple)) else value == label
            if requests_fallback and actual in (None, ""):
                actual = label
        return value is None or (actual in value if isinstance(value, (list, tuple)) else actual == value)
    return all(matches(field, value) for field, value in expected.items())


def _family_card_key(product: dict) -> tuple:
    return (product.get("family_key") or f"solo:{product['id']}", product.get("floor_id"),
            product.get("brand_id"), product.get("category_id"))


def _one_per_family(products: list[dict]) -> list[dict]:
    seen = set()
    result = []
    for product in products:
        key = _family_card_key(product)
        if key not in seen:
            seen.add(key)
            result.append(product)
    return result


def _matches_search(product: dict, pattern: re.Pattern | None) -> bool:
    if pattern is None:
        return True
    for field in _SEARCH_FIELDS:
        value = product.get(field)
        if isinstance(value, list):
            text = " ".join(str(item) for item in value)
        else:
            text = str(value or "")
        if pattern.search(text):
            return True
    return False


def _compile_search(query: Optional[str]) -> re.Pattern | None:
    if not query:
        return None
    # Search input is user data, never a regular-expression language. Escaping
    # it avoids catastrophic backtracking across the in-memory catalog.
    return re.compile(re.escape(query[:120]), re.IGNORECASE)


def _iso_timestamp(value: object) -> float:
    if not isinstance(value, str) or not value:
        return 0.0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


async def list_products_page(
    *, user_id: str, q: Optional[str], brand_id: Optional[str], category_id: Optional[str],
    subcategory: Optional[str], series: Optional[str], family_key: Optional[str],
    finish: Optional[str], colour: Optional[str], sort: str, limit: int, skip: int,
    floor_ids: Optional[list[str]] = None, size: Optional[str] = None,
) -> dict:
    snapshot = await get_catalog_snapshot()
    pattern = _compile_search(q)
    matching = [
        product for product in _listing_products(snapshot)
        if _matches_filters(
            product, brand_id=brand_id, category_id=category_id,
            subcategory=subcategory, series=series, family_key=family_key,
            finish=finish, colour=colour, floor_ids=floor_ids,
        ) and (size is None or (_product_size(product) in size if isinstance(size, list) else _product_size(product) == size)) and _matches_search(product, pattern)
    ]
    matching.sort(key=lambda row: _source_sort_key(row, snapshot))
    matching = _unique_listings(matching)
    my_rows = snapshot.usage_by_user.get(user_id, {})

    if sort == "source" or (sort == "popular" and any(row.get("catalog_entry") for row in matching)):
        matching.sort(key=lambda row: _source_sort_key(row, snapshot))
    elif sort == "price_asc":
        matching.sort(key=lambda row: (float(row.get("price") or 0), row["id"]))
    elif sort == "price_desc":
        matching.sort(key=lambda row: (-float(row.get("price") or 0), row["id"]))
    elif sort == "name":
        matching.sort(key=lambda row: (row.get("name") or "", row["id"]))
    else:
        if sort == "recent":
            ranked = [row for row in matching if my_rows.get(row["id"], {}).get("last_used_at")]
            ranked.sort(key=lambda row: (
                -_iso_timestamp(my_rows[row["id"]].get("last_used_at")),
                row.get("name") or "", row["id"],
            ))
        else:
            ranked = [row for row in matching if snapshot.global_usage.get(row["id"], 0) > 0]
            ranked.sort(key=lambda row: (
                -snapshot.global_usage.get(row["id"], 0),
                -int(my_rows.get(row["id"], {}).get("count", 0)),
                row.get("name") or "", row["id"],
            ))
        ranked_ids = {row["id"] for row in ranked}
        regular = [row for row in matching if row["id"] not in ranked_ids]
        regular.sort(key=lambda row: (row.get("name") or "", row["id"]))
        matching = [*ranked, *regular]

    matching = _one_per_family(matching)
    total = len(matching)

    usage_counts = sorted(snapshot.global_usage.values(), reverse=True)
    popular_ids: set[str] = set()
    if usage_counts:
        cutoff = min(len(usage_counts) - 1, int(len(usage_counts) * 0.15))
        threshold = usage_counts[cutoff]
        if threshold > 0:
            popular_ids = {
                product_id for product_id, count in snapshot.global_usage.items()
                if count >= threshold
            }

    docs = [hydrate_product(row, snapshot) for row in matching[skip:skip + limit]]
    for doc in docs:
        product_id = doc["id"]
        mine = my_rows.get(product_id, {})
        doc["usage_count"] = snapshot.global_usage.get(product_id, 0)
        doc["my_usage_count"] = int(mine.get("count", 0))
        doc["popular"] = product_id in popular_ids
        doc["frequently_used"] = int(mine.get("count", 0)) >= 3
        doc["recently_used"] = bool(mine.get("last_used_at"))
    return {"total": total, "items": docs}


async def list_brands_with_counts(floor_ids: Optional[list[str]] = None) -> list[dict]:
    snapshot = await get_catalog_snapshot()
    products = _unique_listings(_listing_products(snapshot))
    products = products if floor_ids is None else [
        p for p in products if p.get("floor_id") in floor_ids
    ]
    counts = Counter(row.get("brand_id") for row in products)
    brands = snapshot.brands if floor_ids is None else [
        b for b in snapshot.brands if b.get("floor_id") in floor_ids
    ]
    out = copy.deepcopy(list(brands))
    for row in out:
        row["product_count"] = counts.get(row.get("id"), 0)
    return out


async def list_categories_with_counts(brand_id: Optional[str], floor_ids: Optional[list[str]] = None) -> list[dict]:
    snapshot = await get_catalog_snapshot()
    counts = Counter(
        row.get("category_id") for row in _unique_listings(_listing_products(snapshot), per_category=True)
        if (not brand_id or row.get("brand_id") == brand_id)
        and (floor_ids is None or row.get("floor_id") in floor_ids)
    )
    out = []
    categories = snapshot.categories if floor_ids is None else [
        c for c in snapshot.categories if c.get("floor_id") in floor_ids
    ]
    for category in categories:
        if brand_id and category.get("brand_id") and category["brand_id"] != brand_id:
            continue
        count = counts.get(category.get("id"), 0)
        if brand_id and count == 0:
            continue
        row = copy.deepcopy(category)
        row["product_count"] = count
        out.append(row)
    return sorted(out, key=_category_sort_key)


async def recent_or_frequent_products(
    user_id: str, *, limit: int, recent: bool, floor_ids: Optional[list[str]] = None,
) -> list[dict]:
    snapshot = await get_catalog_snapshot()
    rows = list(snapshot.usage_by_user.get(user_id, {}).values())
    if recent:
        rows.sort(key=lambda row: -_iso_timestamp(row.get("last_used_at")))
    else:
        rows.sort(key=lambda row: -int(row.get("count", 0)))
    out = []
    seen_families = set()
    for usage in rows:
        product = snapshot.product_by_id.get(usage.get("product_id"))
        if product and _is_catalog_product(product, snapshot) and (floor_ids is None or product.get("floor_id") in floor_ids):
            key = _family_card_key(product)
            if key in seen_families:
                continue
            seen_families.add(key)
            out.append(hydrate_product(product, snapshot))
            if len(out) >= limit:
                break
    return out


async def product_by_id(product_id: str, floor_ids: Optional[list[str]] = None,
                        catalog_entry_id: Optional[str] = None) -> dict | None:
    snapshot = await get_catalog_snapshot()
    product = snapshot.product_by_id.get(product_id)
    if product and floor_ids is not None and product.get("floor_id") not in floor_ids:
        product = None
    if product and catalog_entry_id:
        product = next((row for row in _listing_products(snapshot)
                        if row["id"] == product_id and row.get("listing_id") == catalog_entry_id), None)
    return hydrate_product(product, snapshot) if product else None


async def resolve_size_variant(
    product_id: str, size: Optional[str] = None, floor_ids: Optional[list[str]] = None,
) -> dict | None:
    """Resolve a requested size to an actual sibling SKU, never a patch.

    The returned ``product`` is the complete hydrated catalog row for the
    resolved SKU, so quotation/tile-selection callers replace their selected
    product wholesale and naturally receive that SKU's price, stock, media and
    specifications.  We prefer a sibling with matching finish/colour metadata
    and make any remaining tie deterministic by SKU then id.
    """
    snapshot = await get_catalog_snapshot()
    source = snapshot.product_by_id.get(product_id)
    if not source or (floor_ids is not None and source.get("floor_id") not in floor_ids):
        return None

    metadata = _size_metadata(source, snapshot)
    # This doubles as the discoverability endpoint: a client can fetch one
    # canonical product plus the complete size metadata before it chooses a
    # target.  It is also useful for one-size styles.
    if size is None:
        return {
            "source_product_id": source["id"],
            "requested_size": None,
            "resolved_product_id": source["id"],
            **metadata,
            "product": hydrate_product(source, snapshot),
        }
    requested_key = _normalise_size(size)
    if not requested_key:
        return None

    if source.get("family_key"):
        siblings = _family_siblings(snapshot, source)
    else:
        siblings = [source]
    candidates = [row for row in siblings if _normalise_size(_product_size(row)) == requested_key]
    if not candidates:
        return None

    # A family may contain finishes/colours as well as sizes.  Selecting a
    # size should retain the closest equivalent of the currently selected
    # finish when available, but must still resolve an existing SKU when that
    # finish is not offered in the requested size.
    preference_fields = ("finish", "finish_code", "colour", "variant_label")
    candidates.sort(key=lambda row: (
        -sum(
            1 for field in preference_fields
            if source.get(field) not in (None, "") and row.get(field) == source.get(field)
        ),
        row.get("sku") or "",
        row.get("id") or "",
    ))
    resolved = candidates[0]
    return {
        "source_product_id": source["id"],
        "requested_size": size,
        "resolved_product_id": resolved["id"],
        **metadata,
        "product": hydrate_product(resolved, snapshot),
    }


async def hierarchy_rows(floor_ids: Optional[list[str]] = None) -> tuple[list[dict], dict[str, dict], dict[str, dict]]:
    snapshot = await get_catalog_snapshot()
    groups: dict[tuple, dict] = {}
    # One SKU may be placed in multiple sections of the same worksheet.
    # Keep each hierarchy branch while counting repeated rows in it once.
    products = _unique_listings(_listing_products(snapshot), per_placement=True)
    products = products if floor_ids is None else [
        p for p in products if p.get("floor_id") in floor_ids
    ]
    category_counts = Counter((p.get("brand_id"), p.get("category_id")) for p in
                              _unique_listings(products, per_category=True))
    for product in products:
        key = (
            product.get("brand_id"), product.get("category_id"), product.get("subcategory"),
            product.get("series"), product.get("family_key"), product.get("family_name"),
        )
        row = groups.setdefault(key, {
            "_id": {
                "brand_id": key[0], "category_id": key[1], "subcategory": key[2],
                "series": key[3], "family_key": key[4], "family_name": key[5],
            },
            "product_count": 0,
            "category_product_count": category_counts[(key[0], key[1])],
            "min_price": float(product.get("price") or 0),
            "sample_image": (product.get("images") or [None])[0],
            "image_quality": product.get("image_quality"),
        })
        row["product_count"] += 1
        row["min_price"] = min(row["min_price"], float(product.get("price") or 0))
    return (
        list(groups.values()),
        {row["id"]: {**copy.deepcopy(row), "product_count": len({p["id"] for p in products if p.get("brand_id") == row["id"]})} for row in snapshot.brands},
        {row["id"]: copy.deepcopy(row) for row in snapshot.categories},
    )


async def list_family_groups(
    *, brand_id: Optional[str], category_id: Optional[str], subcategory: Optional[str],
    series: Optional[str], q: Optional[str], limit: int, skip: int,
    floor_ids: Optional[list[str]] = None,
    finish: Optional[str] = None, colour: Optional[str] = None, size: Optional[str] = None,
) -> dict:
    snapshot = await get_catalog_snapshot()
    pattern = _compile_search(q)
    products = [
        row for row in _listing_products(snapshot)
        if _matches_filters(
            row, brand_id=brand_id, category_id=category_id, subcategory=subcategory,
            series=series, family_key=None, finish=finish, colour=colour, floor_ids=floor_ids,
        )
        and (size is None or (_product_size(row) in size if isinstance(size, list) else _product_size(row) == size))
        and _matches_search(row, pattern)
    ]
    products.sort(key=lambda row: _source_sort_key(row, snapshot))
    products = _unique_listings(products)
    groups: dict[tuple[str, str | None, str | None, str | None], dict] = {}
    for product in products:
        # ``family_key`` is supplier-owned text, not a global database key;
        # keep all-floor views from merging styles across business units.
        key = _family_card_key(product)
        group = groups.setdefault(key, {
            "listing_id": product.get("listing_id"),
            "catalog_entry": product.get("catalog_entry"),
            "catalog_entries": product.get("catalog_entries"),
            "price_unknown": product.get("price_status") == "unspecified",
            "source_price_unspecified": product.get("source_price_unspecified", False),
            "price_source": product.get("price_source"),
            "family_key": product.get("family_key"),
            "family_name": product.get("name") if product.get("catalog_entry") else product.get("family_name") or product.get("name"),
            "sample_product_id": product["id"],
            "brand_id": product.get("brand_id"),
            "category_id": product.get("category_id"),
            "subcategory": product.get("subcategory"),
            "series": product.get("series"),
            "floor_id": product.get("floor_id"),
            "min_price": float(product.get("price") or 0),
            "max_price": float(product.get("price") or 0),
            "product_count": 0,
            "sample_image_quality": product.get("image_quality"),
            "variants": [],
        })
        price = float(product.get("price") or 0)
        group["min_price"] = min(group["min_price"], price)
        group["max_price"] = max(group["max_price"], price)
        group["product_count"] += 1
        # Group and count cheaply; media/configuration/concealed hydration is
        # needed only for the requested page, not every SKU in the catalog.
        group["variants"].append(product)
    has_source = any(item.get("catalog_entry") for item in products)
    ordered = sorted(groups.values(), key=lambda row: (
        _source_sort_key({**row, "id": row["sample_product_id"], "name": row["family_name"]}, snapshot)
        if has_source else (row.get("family_name") or "",)
    ))
    page = []
    for raw_group in ordered[skip:skip + limit]:
        group = copy.deepcopy({**raw_group, "variants": [
            {**_variant_summary(product, snapshot), "image_quality": product.get("image_quality")}
            for product in raw_group["variants"]
        ]})
        sample_product = snapshot.product_by_id.get(group["sample_product_id"]) if hasattr(snapshot, "product_by_id") else next(
            (product for product in products if product.get("id") == group["sample_product_id"]), None,
        )
        if sample_product and group.get("catalog_entry"):
            sample_product = {**sample_product, "category_id": group["category_id"], "catalog_entry": group["catalog_entry"]}
        group["sample_image"] = _primary_product_image(snapshot, group["sample_product_id"])
        group["configuration_options"] = _configuration_options(sample_product, snapshot) if sample_product else []
        family_products = (
            (_family_siblings(snapshot, sample_product) or [sample_product])
            if group.get("family_key") else [
                product for product in products if product.get("id") == group.get("sample_product_id")
            ]
        )
        if sample_product:
            siblings = _family_listing_siblings(snapshot, sample_product) or [sample_product]
            # Keep the occurrence SKU first so tapping the card opens that
            # exact row, with the remaining finish siblings still available.
            group["variants"] = [group["variants"][0], *[
                {**_variant_summary(sibling, snapshot), "image_quality": sibling.get("image_quality")} for sibling in siblings
                if sibling["id"] != sample_product["id"]
            ]]
            group["product_count"] = len(group["variants"])
            group["min_price"] = min(float(v.get("price") or 0) for v in group["variants"])
            group["max_price"] = max(float(v.get("price") or 0) for v in group["variants"])
        group.update(_size_metadata_for_products(family_products))
        sample_id = group["sample_product_id"]
        sample_media = snapshot.media_rows_by_product.get(sample_id, ())
        # Metadata must describe the exact preview selected above. Raw media
        # order puts an internal gallery before a manufacturer's primary photo;
        # selecting the first row here used to overwrite the correct hero.
        hero = next((row for row in sample_media
                     if group["sample_image"] and row.get("public_url") == group["sample_image"]), None)
        if hero:
            group["sample_image_quality"] = hero.get("quality") or group.get("sample_image_quality")
            group["sample_image_source"] = hero.get("source_type")
        page.append(group)
    return {"total": len(ordered), "items": page}


async def facet_buckets(
    *, brand_id: Optional[str], category_id: Optional[str], subcategory: Optional[str],
    series: Optional[str], floor_ids: Optional[list[str]] = None,
) -> dict:
    snapshot = await get_catalog_snapshot()
    products = [
        # Filter every source occurrence before bucket's (value, SKU) dedupe.
        # Category-level dedupe here loses later same-category sections.
        row for row in _listing_products(snapshot)
        if _matches_filters(
            row, brand_id=brand_id, category_id=category_id, subcategory=subcategory,
            series=series, family_key=None, finish=None, colour=None, floor_ids=floor_ids,
        )
    ]

    def bucket(field: str) -> list[dict]:
        counts = Counter(value for value, _ in {
            (row.get(field), row.get("id", index)) for index, row in enumerate(products) if row.get(field) not in (None, "")
        })
        return [
            {"value": value, "count": count}
            for value, count in sorted(counts.items(), key=lambda item: (-item[1], str(item[0])))[:100]
        ]

    prices = [float(row.get("price") or 0) for row in products if row.get("price_status") != "unspecified"]
    return {
        "brands": bucket("brand_id"),
        "categories": bucket("category_id"),
        "subcategories": bucket("subcategory"),
        "series": bucket("series"),
        "finishes": bucket("finish"),
        "sizes": bucket("size"),
        "colours": bucket("colour"),
        "materials": bucket("material"),
        "price": {"min": min(prices, default=0), "max": max(prices, default=0)},
    }


async def search_catalog(
    *, q: str, brand_id: Optional[str], category_id: Optional[str], subcategory: Optional[str],
    series: Optional[str], limit: int, group: bool, floor_ids: Optional[list[str]] = None,
) -> dict:
    snapshot = await get_catalog_snapshot()
    query = (q or "").strip()
    q_lower = query.lower()
    products = [
        row for row in _listing_products(snapshot)
        if _matches_filters(
            row, brand_id=brand_id, category_id=category_id, subcategory=subcategory,
            series=series, family_key=None, finish=None, colour=None, floor_ids=floor_ids,
        )
    ]
    products.sort(key=lambda row: _source_sort_key(row, snapshot))
    products = _unique_listings(products)

    def score(product: dict) -> float:
        sku = (product.get("sku") or "").lower()
        name = (product.get("name") or "").lower()
        family = (product.get("family_name") or "").lower()
        series_l = (product.get("series") or "").lower()
        subcat = (product.get("subcategory") or "").lower()
        finish_l = (product.get("finish") or "").lower()
        size_l = (product.get("size") or "").lower()
        colour_l = (product.get("colour") or "").lower()
        dimensions = (product.get("dimensions") or "").lower()
        description = (product.get("description") or "").lower()
        value = 0.0
        if sku == q_lower:
            value += 100
        elif sku.startswith(q_lower):
            value += 60
        elif q_lower in sku:
            value += 30
        value += 12 if q_lower in name else 0
        value += 10 if q_lower in family else 0
        value += 6 if q_lower in series_l else 0
        value += 4 if q_lower in subcat else 0
        value += 3 if q_lower in finish_l else 0
        value += 3 if q_lower in size_l else 0
        value += 3 if q_lower in colour_l else 0
        value += 1 if q_lower in dimensions else 0
        value += 1 if q_lower in description else 0
        value += 1 if q_lower in (product.get("catalog_search_text") or "").lower() else 0
        return value

    if query:
        scored = [(score(row), row) for row in products]
        matched_docs = [
            row for value, row in sorted(scored, key=lambda item: item[0], reverse=True)
            if value > 0
        ]
        total_matches = len(matched_docs)
        docs = matched_docs
    else:
        total_matches = len(products)
        docs = products

    if not group:
        items = [hydrate_product(row, snapshot) for row in docs[:limit]]
        return {"query": query, "total": total_matches, "grouped": False, "items": items}

    groups: dict[tuple[str, str | None, str | None, str | None], dict] = {}
    order: list[tuple[str, str | None, str | None, str | None]] = []
    for product in docs:
        key = _family_card_key(product)
        if key not in groups:
            groups[key] = {
                "listing_id": product.get("listing_id"),
                "catalog_entry": product.get("catalog_entry"),
                "price_unknown": product.get("price_status") == "unspecified",
                "family_key": product.get("family_key"),
                "family_name": product.get("family_name") or product.get("name"),
                "brand_id": product.get("brand_id"), "category_id": product.get("category_id"),
                "subcategory": product.get("subcategory"), "series": product.get("series"),
                "floor_id": product.get("floor_id"),
                "score": score(product) if query else 0,
                "product_count": 0, "min_price": product.get("price"),
                "max_price": product.get("price"), "variants": [],
                "sample_product_id": product["id"],
            }
            order.append(key)
        family = groups[key]
        family["product_count"] += 1
        family["min_price"] = min(family["min_price"], product.get("price") or family["min_price"])
        family["max_price"] = max(family["max_price"], product.get("price") or family["max_price"])
        family["variants"].append(_variant_summary(product, snapshot))

    grouped = [groups[key] for key in order][:limit]
    for family in grouped:
        sample = snapshot.product_by_id.get(family["sample_product_id"])
        if sample and family.get("catalog_entry"):
            sample = _product_listing(sample, family["catalog_entry"])
        family_products = _family_listing_siblings(snapshot, sample) if sample else []
        family["variants"] = [_variant_summary(p, snapshot) for p in family_products] or family["variants"]
        family["product_count"] = len(family["variants"])
        family.update(_size_metadata_for_products(family_products))
        media = snapshot.media_rows_by_product.get(family["sample_product_id"], ())
        family["hero_image_url"] = _primary_product_image(snapshot, family["sample_product_id"])
        family["image_quality"] = sample.get("image_quality") if sample else None
        hero = next((row for row in media
                     if family["hero_image_url"] and row.get("public_url") == family["hero_image_url"]), None)
        if hero:
            family["image_quality"] = hero.get("quality")
            family["image_source"] = hero.get("source_type")
    return {"query": query, "total": len(order), "grouped": True, "items": grouped}



async def family_detail(family_key: str, floor_ids: Optional[list[str]] = None) -> dict | None:
    snapshot = await get_catalog_snapshot()
    candidates = [
        p for p in snapshot.products_by_family.get(family_key, ())
        if (floor_ids is None or p.get("floor_id") in floor_ids) and _is_catalog_product(p, snapshot)
    ]
    if not candidates:
        return None
    # The endpoint identifies a family by supplier key; retain the first
    # catalog namespace only when a malformed/imported key collides.
    first_candidate = candidates[0]
    products = _family_siblings(snapshot, first_candidate)
    if not first_candidate.get("catalog_entries"):
        products.sort(key=lambda row: (row.get("colour") or "", row.get("finish") or "", row.get("sku") or ""))
    if not products:
        return None
    first = products[0]
    brand = next((copy.deepcopy(row) for row in snapshot.brands if row.get("id") == first.get("brand_id")), None)
    category = next((copy.deepcopy(row) for row in snapshot.categories if row.get("id") == first.get("category_id")), None)

    media_rows = []
    for product in products:
        media_rows.extend(snapshot.media_rows_by_product.get(product["id"], ()))
    seen_media: set[str] = set()
    gallery = []
    for media in media_rows:
        media_id = media.get("id")
        if not media.get("public_url") or media_id in seen_media or media.get("role") in ("dimension", "seat-cover"):
            continue
        if media_id:
            seen_media.add(media_id)
        gallery.append({
            "id": media_id, "url": media.get("public_url"), "role": media.get("role"),
            "source_type": media.get("source_type"), "width": media.get("width"),
            "height": media.get("height"), "quality": media.get("quality"),
            "is_primary": media.get("is_primary"), "product_id": media.get("product_id"),
            "family_key": media.get("family_key"),
        })

    variants = []
    specs_union: dict = {}
    for product in products:
        summary = _variant_summary(product, snapshot)
        # ``hero_image`` is the original family-detail field; retain it as a
        # compatibility alias while grouped cards consistently use ``image``.
        summary["hero_image"] = summary["image"]
        variants.append(summary)
        for key, value in (product.get("specs") or {}).items():
            specs_union.setdefault(key, value)

    return {
        "family_key": family_key,
        "family_name": first.get("family_name") or first.get("name"),
        "brand": brand, "category": category, "subcategory": first.get("subcategory"),
        "series": first.get("series"), "description": first.get("description"),
        "min_price": min(product.get("price", 0) for product in products),
        "max_price": max(product.get("price", 0) for product in products),
        "variant_count": len(products), "variants": variants, "gallery": gallery,
        **_size_metadata_for_products(products),
        "specs_union": specs_union,
        "hero_image_url": next(
            (item["url"] for item in gallery if item.get("is_primary")),
            gallery[0]["url"] if gallery else None,
        ),
        "downloads": [],
        "compatible_ids": first.get("compatible_ids") or [],
        "accessory_ids": first.get("accessory_ids") or [],
        "related_ids": first.get("related_ids") or [],
    }


async def alternate_products(product_id: str, user_id: str, limit: int, floor_ids: Optional[list[str]] = None) -> dict | None:
    snapshot = await get_catalog_snapshot()
    source = snapshot.product_by_id.get(product_id)
    if source and floor_ids is not None and source.get("floor_id") not in floor_ids:
        source = None
    if not source:
        return None
    name_prefix = " ".join((source.get("name") or "").split()[:2]).strip().lower()
    my_usage = snapshot.usage_by_user.get(user_id, {})
    pool = [
        row for row in snapshot.products
        if row["id"] != product_id and row.get("category_id") == source.get("category_id")
        and _is_catalog_product(row, snapshot)
        and (floor_ids is None or row.get("floor_id") in floor_ids)
    ][:400]

    def tier(product: dict) -> int:
        prefix = " ".join((product.get("name") or "").split()[:2]).strip().lower()
        same_brand = product.get("brand_id") == source.get("brand_id")
        if same_brand and name_prefix and prefix == name_prefix:
            return 1
        return 2 if same_brand else 3

    scored = [
        (
            tier(product),
            -int(my_usage.get(product["id"], {}).get("count", 0)),
            float(product.get("price") or 0),
            product,
        )
        for product in pool
    ]
    scored.sort(key=lambda row: (row[0], row[1], row[2]))
    return {
        "source_product_id": product_id,
        "items": [hydrate_product(row[3], snapshot) for row in scored[:limit]],
        "tiers": {
            "family": sum(1 for row in scored if row[0] == 1),
            "brand_category": sum(1 for row in scored if row[0] == 2),
            "category": sum(1 for row in scored if row[0] == 3),
        },
    }


async def complete_set_products(product_id: str, limit: int, floor_ids: Optional[list[str]] = None) -> dict | None:
    snapshot = await get_catalog_snapshot()
    source = snapshot.product_by_id.get(product_id)
    if source and floor_ids is not None and source.get("floor_id") not in floor_ids:
        source = None
    if not source:
        return None
    candidates = []
    for product in snapshot.products:
        if not _is_catalog_product(product, snapshot):
            continue
        if product["id"] == product_id or product.get("category_id") == source.get("category_id"):
            continue
        if floor_ids is not None and product.get("floor_id") not in floor_ids:
            continue
        matches = (
            (source.get("family_key") and product.get("family_key") == source.get("family_key"))
            or (
                source.get("series") and product.get("series") == source.get("series")
                and product.get("brand_id") == source.get("brand_id")
            )
            or (
                source.get("collection") and product.get("collection") == source.get("collection")
                and product.get("brand_id") == source.get("brand_id")
            )
        )
        if matches:
            candidates.append(product)
        if len(candidates) >= limit:
            break
    by_category: dict[str, dict] = {}
    for product in candidates:
        by_category.setdefault(product.get("category_id") or "_", product)
    return {
        "source_product_id": product_id,
        "items": [hydrate_product(product, snapshot) for product in list(by_category.values())[:limit]],
    }


async def media_for_product(product_id: str, floor_ids: Optional[list[str]] = None) -> list[ProductMedia] | None:
    snapshot = await get_catalog_snapshot()
    product = snapshot.product_by_id.get(product_id)
    if not product:
        return None
    if floor_ids is not None and product.get("floor_id") not in floor_ids:
        return None
    rows = [m for m in snapshot.media_by_product.get(product_id, ()) if floor_ids is None or m.floor_id in floor_ids]
    if product.get("family_key"):
        rows.extend(m for m in snapshot.media_by_family.get(product["family_key"], ()) if floor_ids is None or m.floor_id in floor_ids)
    return _dedup_media(rows)


async def snapshot_for_product_ids(product_ids: list[str], floor_ids: Optional[list[str]] = None) -> CatalogSnapshot:
    """Batch media ownership for quotation/purchase consumers in either mode."""
    snapshot = await get_catalog_snapshot()
    if not getattr(snapshot, "database_backed", False):
        return snapshot
    from services.catalog_database import context
    return await context([], product_ids=product_ids, floor_ids=floor_ids)


def _database_capable(function):
    @wraps(function)
    async def read(*args, **kwargs):
        snapshot = await get_catalog_snapshot()
        if getattr(snapshot, "database_backed", False):
            from services import catalog_database
            return await catalog_database.call(function.__name__, function, args, kwargs)
        return await function(*args, **kwargs)
    return read


# Keep the existing in-memory algorithms and public contracts unchanged at
# normal sizes. Each large-catalog read has a bounded database implementation.
for _reader_name in (
    "list_products_page", "list_brands_with_counts", "list_categories_with_counts",
    "recent_or_frequent_products", "product_by_id", "resolve_size_variant",
    "hierarchy_rows", "list_family_groups", "facet_buckets", "search_catalog",
    "family_detail", "alternate_products", "complete_set_products", "media_for_product",
):
    globals()[_reader_name] = _database_capable(globals()[_reader_name])
