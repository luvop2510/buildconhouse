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
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from time import monotonic
from typing import Optional

from db import db
from models import ProductMedia

_SNAPSHOT_MAX_AGE_SECONDS = 300.0
_MEDIA_PRIORITY = {"internal": 0, "manufacturer": 1, "supplier": 2}
_SEARCH_FIELDS = (
    "name", "sku", "description", "series", "family_name", "subcategory",
    "collection", "finish", "colour", "dimensions", "size", "tags",
)
# Ground Floor is exclusively the Tiles module (Qutone, Dimore, ...). Real
# tile supplier pricelists routinely reuse one photograph across several
# finish/size SKUs of the same design — that's normal, not a data-entry
# mistake, unlike sanitaryware colour variants (see
# `_canonical_sku_for_sha1`). Guards built around "identical photo across
# siblings = mistake" must not apply here.
_TILE_FLOOR_ID = "ground-floor"


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


_snapshot: CatalogSnapshot | None = None
_refresh_lock = asyncio.Lock()
_background_refresh: asyncio.Task | None = None


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
            key: tuple(ProductMedia(**row) for row in rows)
            for key, rows in media_product_raw.items()
        },
        media_by_family={
            key: tuple(ProductMedia(**row) for row in rows)
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


async def refresh_catalog_snapshot() -> CatalogSnapshot:
    """Reload all compact catalog read-model collections in one RTT group."""
    global _snapshot
    async with _refresh_lock:
        products, media_rows, brands, categories, usage_rows = await asyncio.gather(
            db.products.find({"active": True}, {"_id": 0}).to_list(10000),
            db.product_media.find({}, {"_id": 0}).to_list(20000),
            db.brands.find({}, {"_id": 0}).to_list(500),
            db.categories.find({}, {"_id": 0}).to_list(500),
            db.product_usage.find({}, {"_id": 0}).to_list(50000),
        )
        _snapshot = _build_snapshot(products, media_rows, brands, categories, usage_rows)
        return _snapshot


async def get_catalog_snapshot() -> CatalogSnapshot:
    global _background_refresh
    if _snapshot is None:
        return await refresh_catalog_snapshot()
    if monotonic() - _snapshot.loaded_at > _SNAPSHOT_MAX_AGE_SECONDS:
        if _background_refresh is None or _background_refresh.done():
            _background_refresh = asyncio.create_task(refresh_catalog_snapshot())
    return _snapshot


def schedule_catalog_refresh() -> None:
    """Refresh after a catalog/media mutation without delaying its response."""
    global _background_refresh
    if _background_refresh is None or _background_refresh.done():
        _background_refresh = asyncio.create_task(refresh_catalog_snapshot())


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
    schedule_catalog_refresh()


async def note_product_usage(user_id: str, product_ids: list[str], at: str) -> None:
    """Keep popularity/recent/frequent reads coherent with a completed write."""
    global _snapshot
    async with _refresh_lock:
        if _snapshot is None:
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
        _snapshot = CatalogSnapshot(
            products=snapshot.products,
            product_by_id=snapshot.product_by_id,
            products_by_family=snapshot.products_by_family,
            media_by_product=snapshot.media_by_product,
            media_by_family=snapshot.media_by_family,
            media_rows_by_product=snapshot.media_rows_by_product,
            media_rows_by_family=snapshot.media_rows_by_family,
            brands=snapshot.brands,
            categories=snapshot.categories,
            global_usage=global_usage,
            usage_by_user=usage_by_user,
            loaded_at=snapshot.loaded_at,
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
    # IMPORTANT: this must resolve media for THIS product only. It used to
    # also pool in every family sibling's media via `media_by_family` as a
    # "helpful" fallback — but since every sibling's own media_by_product
    # rows ALSO have their own is_primary/hero flags, a pooled+globally
    # sorted list has no way to prefer "this exact product's own photo"
    # over "some other colour's photo that happens to sort first". That
    # produced the reported bug: switching finish/colour updates every text
    # field correctly but the image can silently stay on (or jump to) a
    # completely different variant's photo. A product must never display
    # another variant's image — if it has none of its own, show nothing
    # (the frontend's empty-state placeholder) rather than borrow one.
    rows = list(snapshot.media_by_product.get(product.get("id"), ()))
    rows = _dedup_media(rows)

    summary = {"supplier": 0, "manufacturer": 0, "internal": 0}
    for media in rows:
        summary[media.source_type] += 1
    best_quality = "missing"
    for quality in ("excellent", "good", "acceptable", "poor", "missing"):
        if any(media.quality == quality for media in rows):
            best_quality = quality
            break

    gallery: list[dict] = []
    hero_url: Optional[str] = None
    hero_quality: Optional[str] = None
    for media in rows:
        if not media.public_url:
            continue
        gallery.append({
            "id": media.id,
            "family_key": media.family_key,
            "url": media.public_url,
            "role": media.role,
            "source_type": media.source_type,
            "width": media.width,
            "height": media.height,
            "quality": media.quality,
            "is_primary": media.is_primary,
        })
        if not hero_url and (media.is_primary or media.role == "hero"):
            hero_url = media.public_url
            hero_quality = media.quality
    if not hero_url and gallery:
        hero_url = gallery[0]["url"]
        hero_quality = gallery[0].get("quality")

    if not gallery and product.get("images"):
        legacy = product.get("images") or []
        gallery = [
            {
                "url": url, "role": "gallery", "source_type": "supplier",
                "quality": product.get("image_quality") or "missing",
                "width": None, "height": None, "is_primary": index == 0,
            }
            for index, url in enumerate(legacy) if url
        ]
        if gallery:
            hero_url = legacy[0]
            summary["supplier"] = len(gallery)
            best_quality = product.get("image_quality") or best_quality
            hero_quality = best_quality

    product["media_summary"] = {
        **summary, "best_quality": best_quality, "total": sum(summary.values()),
    }
    product["hero_image_url"] = hero_url
    product["gallery"] = gallery
    # Product-level importer metadata can be stale after a media repair or a
    # manual replacement. The actual selected hero is authoritative for every
    # consumer of a hydrated product (PDP, cards, quotations and PDFs).
    product["image_quality"] = hero_quality or best_quality
    if gallery:
        product["images"] = [item["url"] for item in gallery if item.get("url")]
    elif hero_url:
        product["images"] = [hero_url]


def _primary_product_image(snapshot: CatalogSnapshot, product_id: str, family_key: Optional[str] = None) -> Optional[str]:
    # Product media is authoritative.  Do not fall back to family media here:
    # a family can contain visually different finish/size variants, and a
    # supplier ``family_key`` is not globally unique.
    for row in snapshot.media_rows_by_product.get(product_id, ()):
        if not row.get("public_url"):
            continue
        return row["public_url"]
    return None


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
    return [
        sibling for sibling in getattr(snapshot, "products_by_family", {}).get(family_key, ())
        if sibling.get("floor_id") == product.get("floor_id")
        and sibling.get("brand_id") == product.get("brand_id")
        and sibling.get("category_id") == product.get("category_id")
    ]


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
    return {
        "id": product["id"], "sku": product.get("sku"), "name": product.get("name"),
        "finish": product.get("finish"), "finish_code": product.get("finish_code"),
        "variant_label": product.get("variant_label"), "size": _product_size(product),
        "colour": colour, "color": colour,
        "price": product.get("price"), "mrp": product.get("mrp"),
        "stock": product.get("stock", 0), "dimensions": product.get("dimensions"),
        "material": product.get("material"), "warranty": product.get("warranty"),
        "specs": product.get("specs") or {}, "description": product.get("description"),
        "image": _primary_product_image(snapshot, product["id"], product.get("family_key")),
    }


def _hydrate_variants(product: dict, snapshot: CatalogSnapshot) -> None:
    if product.get("variants") or not product.get("family_key"):
        return
    variants = []
    for sibling in _family_siblings(snapshot, product):
        if sibling["id"] == product["id"]:
            continue
        variants.append(_variant_summary(sibling, snapshot))
    if variants:
        # A colour/finish selector is only truthful if every sibling SKU can
        # be selected.  The former eight-item preview silently hid finishes in
        # larger supplier families (including 10+ finish Hansgrohe ranges).
        product["variants"] = variants


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
        for row in sorted(rows, key=lambda item: (item.get("sku") or "", item.get("id") or ""))
    ]


def hydrate_product(product: dict, snapshot: CatalogSnapshot) -> dict:
    out = copy.deepcopy(product)
    _apply_media(out, snapshot)
    _hydrate_variants(out, snapshot)
    out.update(_size_metadata(product, snapshot))
    out["family_variants"] = _family_variants(product, snapshot)
    return out


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
    return all(value is None or product.get(field) == value for field, value in expected.items())


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
    floor_ids: Optional[list[str]] = None,
) -> dict:
    snapshot = await get_catalog_snapshot()
    pattern = _compile_search(q)
    matching = [
        product for product in snapshot.products
        if _matches_filters(
            product, brand_id=brand_id, category_id=category_id,
            subcategory=subcategory, series=series, family_key=family_key,
            finish=finish, colour=colour, floor_ids=floor_ids,
        ) and _matches_search(product, pattern)
    ]
    total = len(matching)
    my_rows = snapshot.usage_by_user.get(user_id, {})

    if sort == "price_asc":
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
    products = snapshot.products if floor_ids is None else [
        p for p in snapshot.products if p.get("floor_id") in floor_ids
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
        row.get("category_id") for row in snapshot.products
        if (not brand_id or row.get("brand_id") == brand_id)
        and (floor_ids is None or row.get("floor_id") in floor_ids)
    )
    out = []
    categories = snapshot.categories if floor_ids is None else [
        c for c in snapshot.categories if c.get("floor_id") in floor_ids
    ]
    for category in categories:
        count = counts.get(category.get("id"), 0)
        if brand_id and count == 0:
            continue
        row = copy.deepcopy(category)
        row["product_count"] = count
        out.append(row)
    return out


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
    for usage in rows:
        product = snapshot.product_by_id.get(usage.get("product_id"))
        if product and (floor_ids is None or product.get("floor_id") in floor_ids):
            out.append(hydrate_product(product, snapshot))
            if len(out) >= limit:
                break
    return out


async def product_by_id(product_id: str, floor_ids: Optional[list[str]] = None) -> dict | None:
    snapshot = await get_catalog_snapshot()
    product = snapshot.product_by_id.get(product_id)
    if product and floor_ids is not None and product.get("floor_id") not in floor_ids:
        product = None
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
    products = snapshot.products if floor_ids is None else [
        p for p in snapshot.products if p.get("floor_id") in floor_ids
    ]
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
            "min_price": float(product.get("price") or 0),
            "sample_image": (product.get("images") or [None])[0],
            "image_quality": product.get("image_quality"),
        })
        row["product_count"] += 1
        row["min_price"] = min(row["min_price"], float(product.get("price") or 0))
    return (
        list(groups.values()),
        {row["id"]: copy.deepcopy(row) for row in snapshot.brands},
        {row["id"]: copy.deepcopy(row) for row in snapshot.categories},
    )


async def list_family_groups(
    *, brand_id: Optional[str], category_id: Optional[str], subcategory: Optional[str],
    series: Optional[str], q: Optional[str], limit: int, skip: int,
    floor_ids: Optional[list[str]] = None,
) -> dict:
    snapshot = await get_catalog_snapshot()
    pattern = _compile_search(q)
    products = [
        row for row in snapshot.products
        if _matches_filters(
            row, brand_id=brand_id, category_id=category_id, subcategory=subcategory,
            series=series, family_key=None, finish=None, colour=None, floor_ids=floor_ids,
        )
        and (pattern is None or any(pattern.search(str(row.get(field) or "")) for field in (
            "name", "family_name", "series", "subcategory", "finish", "colour", "sku",
        )))
    ]
    products.sort(key=lambda row: (
        row.get("family_name") or "", row.get("colour") or "", row.get("sku") or "",
    ))
    groups: dict[tuple[str, str | None, str | None, str | None], dict] = {}
    for product in products:
        # ``family_key`` is supplier-owned text, not a global database key;
        # keep all-floor views from merging styles across business units.
        key = (
            product.get("family_key") or f"solo:{product['id']}", product.get("floor_id"),
            product.get("brand_id"), product.get("category_id"),
        )
        group = groups.setdefault(key, {
            "family_key": product.get("family_key"),
            "family_name": product.get("family_name") or product.get("name"),
            "sample_product_id": product["id"],
            "brand_id": product.get("brand_id"),
            "category_id": product.get("category_id"),
            "subcategory": product.get("subcategory"),
            "series": product.get("series"),
            "floor_id": product.get("floor_id"),
            "min_price": float(product.get("price") or 0),
            "max_price": float(product.get("price") or 0),
            "product_count": 0,
            "sample_image": _primary_product_image(snapshot, product["id"]),
            "sample_image_quality": product.get("image_quality"),
            "variants": [],
        })
        price = float(product.get("price") or 0)
        group["min_price"] = min(group["min_price"], price)
        group["max_price"] = max(group["max_price"], price)
        group["product_count"] += 1
        summary = _variant_summary(product, snapshot)
        summary["image_quality"] = product.get("image_quality")
        group["variants"].append(summary)
    ordered = sorted(groups.values(), key=lambda row: row.get("family_name") or "")
    page = copy.deepcopy(ordered[skip:skip + limit])
    for group in page:
        sample_product = snapshot.product_by_id.get(group["sample_product_id"]) if hasattr(snapshot, "product_by_id") else next(
            (product for product in products if product.get("id") == group["sample_product_id"]), None,
        )
        family_products = (
            (_family_siblings(snapshot, sample_product) or [sample_product])
            if group.get("family_key") else [
                product for product in products if product.get("id") == group.get("sample_product_id")
            ]
        )
        group.update(_size_metadata_for_products(family_products))
        sample_id = group["sample_product_id"]
        sample_media = snapshot.media_rows_by_product.get(sample_id, ())
        hero = next((row for row in sample_media if row.get("public_url")), None)
        if hero:
            group["sample_image"] = hero["public_url"]
            group["sample_image_quality"] = hero.get("quality") or group.get("sample_image_quality")
            group["sample_image_source"] = hero.get("source_type")
    return {"total": len(ordered), "items": page}


async def facet_buckets(
    *, brand_id: Optional[str], category_id: Optional[str], subcategory: Optional[str],
    series: Optional[str], floor_ids: Optional[list[str]] = None,
) -> dict:
    snapshot = await get_catalog_snapshot()
    products = [
        row for row in snapshot.products
        if _matches_filters(
            row, brand_id=brand_id, category_id=category_id, subcategory=subcategory,
            series=series, family_key=None, finish=None, colour=None, floor_ids=floor_ids,
        )
    ]

    def bucket(field: str) -> list[dict]:
        counts = Counter(row.get(field) for row in products if row.get(field) not in (None, ""))
        return [
            {"value": value, "count": count}
            for value, count in sorted(counts.items(), key=lambda item: (-item[1], str(item[0])))[:100]
        ]

    prices = [float(row.get("price") or 0) for row in products]
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
        row for row in snapshot.products
        if _matches_filters(
            row, brand_id=brand_id, category_id=category_id, subcategory=subcategory,
            series=series, family_key=None, finish=None, colour=None, floor_ids=floor_ids,
        )
    ]

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
        return value

    if query:
        scored = [(score(row), row) for row in products]
        matched_docs = [
            row for value, row in sorted(scored, key=lambda item: item[0], reverse=True)
            if value > 0
        ]
        total_matches = len(matched_docs)
        docs = matched_docs[:limit * 3]
    else:
        total_matches = len(products)
        docs = products[:limit * 3]

    if not group:
        items = [hydrate_product(row, snapshot) for row in docs[:limit]]
        return {"query": query, "total": total_matches, "grouped": False, "items": items}

    groups: dict[tuple[str, str | None, str | None, str | None], dict] = {}
    order: list[tuple[str, str | None, str | None, str | None]] = []
    for product in docs:
        key = (
            product.get("family_key") or f"solo:{product['id']}", product.get("floor_id"),
            product.get("brand_id"), product.get("category_id"),
        )
        if key not in groups:
            groups[key] = {
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
        family_products = _family_siblings(snapshot, sample) if sample else []
        family.update(_size_metadata_for_products(family_products))
        media = snapshot.media_rows_by_product.get(family["sample_product_id"], ())
        hero = next((row for row in media if row.get("public_url")), None)
        if hero:
            family["hero_image_url"] = hero.get("public_url")
            family["image_quality"] = hero.get("quality")
            family["image_source"] = hero.get("source_type")
    return {"query": query, "total": len(order), "grouped": True, "items": grouped}



async def family_detail(family_key: str, floor_ids: Optional[list[str]] = None) -> dict | None:
    snapshot = await get_catalog_snapshot()
    candidates = [
        p for p in snapshot.products_by_family.get(family_key, ())
        if floor_ids is None or p.get("floor_id") in floor_ids
    ]
    if not candidates:
        return None
    # The endpoint identifies a family by supplier key; retain the first
    # catalog namespace only when a malformed/imported key collides.
    first_candidate = candidates[0]
    products = sorted(
        _family_siblings(snapshot, first_candidate),
        key=lambda row: (row.get("colour") or "", row.get("finish") or "", row.get("sku") or ""),
    )
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
        if not media.get("public_url") or media_id in seen_media:
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
