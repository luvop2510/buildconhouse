"""Product / Brand / Category endpoints + AI-assisted catalog import stub."""
import asyncio
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import floor_for_write, floor_inherit, floor_query, floor_scope_ids, get_current_user, get_floor_scoped_or_404, require_min_role
from db import db, strip_ids
from models import Brand, BrandCreate, Category, CategoryCreate, Product, ProductCreate, ProductPatch, SizeVariantResolution, UserPublic
from services import catalog_service, media_service
from services.activity_log import log_event
from services.pagination import MAX_PAGE_LIMIT, normalize_pagination

router = APIRouter(tags=["catalog"])


async def _validate_diagram_media_urls(product_id: str, updates: dict) -> None:
    for field, role in (("dimension_image_urls", "dimension"), ("seat_cover_image_urls", "seat-cover")):
        if field not in updates:
            continue
        urls = updates[field] or []
        updates[field] = urls
        if len(urls) != len(set(urls)) or any(not isinstance(url, str) or not url for url in urls):
            raise HTTPException(status_code=422, detail=f"Invalid {field}")
        if not urls:
            continue
        rows = await db.product_media.find({"product_id": product_id, "role": role, "public_url": {"$in": urls}}, {"_id": 0, "public_url": 1}).to_list(len(urls))
        if {row["public_url"] for row in rows} != set(urls):
            raise HTTPException(status_code=422, detail=f"{field} must reference images uploaded for this product")


async def _require_product_relations_on_floor(brand_id: str, category_id: str, floor_id: str) -> None:
    """Keep a product's denormalized catalog hierarchy within one floor."""
    brand, category = await asyncio.gather(
        db.brands.find_one({"id": brand_id, "floor_id": floor_id}, {"_id": 0, "id": 1}),
        db.categories.find_one({"id": category_id, "floor_id": floor_id}, {"_id": 0, "id": 1}),
    )
    if not brand or not category:
        raise HTTPException(
            status_code=400,
            detail="Product brand_id and category_id must belong to the same floor as the product.",
        )


# ---------- Brands ----------
@router.get("/brands")
async def list_brands(user: UserPublic = Depends(get_current_user)):
    """Return every brand + its active product count, scoped to the
    caller's floor(s). Counts drive the left-rail brand badges in the
    Quotation Builder V4."""
    return await catalog_service.list_brands_with_counts(floor_ids=floor_scope_ids(user))


@router.get("/categories")
async def list_categories(
    brand_id: Optional[str] = None,
    user: UserPublic = Depends(get_current_user),
):
    """Return categories + per-brand-scoped product counts, scoped to the
    caller's floor(s).

    When `brand_id` is passed, counts reflect ONLY that brand — this is what
    powers the left-rail "Categories under Hansgrohe" list.
    """
    return await catalog_service.list_categories_with_counts(brand_id, floor_ids=floor_scope_ids(user))


@router.post("/brands", response_model=Brand)
async def create_brand(
    body: BrandCreate,
    user: UserPublic = Depends(require_min_role("purchase")),
):
    if await db.brands.find_one({"slug": body.slug, "floor_id": floor_for_write(user)}):
        raise HTTPException(status_code=409, detail="A brand with this slug already exists")
    payload = body.model_dump()
    payload["floor_id"] = floor_for_write(user)
    brand = Brand(**payload)
    await db.brands.insert_one(brand.model_dump())
    catalog_service.schedule_catalog_refresh()
    return brand


@router.post("/categories", response_model=Category)
async def create_category(
    body: CategoryCreate,
    user: UserPublic = Depends(require_min_role("purchase")),
):
    if await db.categories.find_one({"slug": body.slug, "floor_id": floor_for_write(user)}):
        raise HTTPException(status_code=409, detail="A category with this slug already exists")
    payload = body.model_dump()
    payload["floor_id"] = floor_for_write(user)
    category = Category(**payload)
    await db.categories.insert_one(category.model_dump())
    catalog_service.schedule_catalog_refresh()
    return category


async def _usage_ranked_product_page(
    *,
    query: dict,
    ranked_ids: set[str],
    rank_key,
    skip: int,
    limit: int,
) -> list[dict]:
    """Return a deterministic page with sparse usage-ranked products first.

    Usage exists for only a small fraction of the catalog. The previous path
    downloaded all 2,966 matching {id,name} rows on every page and sorted them
    in Python. This path fetches only matching usage IDs, then lets Mongo page
    the non-usage remainder by the indexed/stable (name,id) order.
    """
    ranked_pool: list[dict] = []
    if ranked_ids:
        ranked_pool = await db.products.find(
            {**query, "id": {"$in": list(ranked_ids)}},
            {"_id": 0, "id": 1, "name": 1},
        ).to_list(len(ranked_ids))
        ranked_pool.sort(key=rank_key)

    ranked_count = len(ranked_pool)
    selected_ranked = ranked_pool[skip:min(skip + limit, ranked_count)] if skip < ranked_count else []
    regular_skip = max(0, skip - ranked_count)
    regular_needed = limit - len(selected_ranked)

    async def _ranked_full() -> list[dict]:
        ids = [d["id"] for d in selected_ranked]
        if not ids:
            return []
        rows = await db.products.find({"id": {"$in": ids}}, {"_id": 0}).to_list(len(ids))
        by_id = {row["id"]: row for row in rows}
        return [by_id[pid] for pid in ids if pid in by_id]

    async def _regular_full() -> list[dict]:
        if regular_needed <= 0:
            return []
        regular_query = query if not ranked_ids else {**query, "id": {"$nin": list(ranked_ids)}}
        return await db.products.find(regular_query, {"_id": 0}).sort([
            ("name", 1), ("id", 1),
        ]).skip(regular_skip).limit(regular_needed).to_list(regular_needed)

    ranked_full, regular_full = await asyncio.gather(_ranked_full(), _regular_full())
    return [*ranked_full, *regular_full]

# ---------- Products ----------
@router.get("/products")
async def list_products(
    q: Optional[str] = Query(None, max_length=120, description="Literal free text search on name/sku/description/series/family/finish/colour/tags"),
    brand_id: Optional[str] = None,
    category_id: Optional[str] = None,
    subcategory: Optional[str] = None,
    series: Optional[str] = None,
    family_key: Optional[str] = None,
    finish: Optional[str] = None,
    colour: Optional[str] = None,
    sort: str = Query("popular", description="popular | recent | price_asc | price_desc | name"),
    limit: int = Query(60, ge=1),
    skip: int = Query(0, ge=0),
    user: UserPublic = Depends(get_current_user),
):
    skip, limit = normalize_pagination(skip, limit)
    return await catalog_service.list_products_page(
        user_id=user.id,
        q=q,
        brand_id=brand_id,
        category_id=category_id,
        subcategory=subcategory,
        series=series,
        family_key=family_key,
        finish=finish,
        colour=colour,
        sort=sort,
        limit=limit,
        skip=skip,
        floor_ids=floor_scope_ids(user),
    )


# ---------- Hierarchy + family-grouped views ----------
@router.get("/catalog/hierarchy")
async def catalog_hierarchy(user: UserPublic = Depends(get_current_user)):
    """Return the full Brand → Category → Subcategory → Series → Family tree,
    scoped to the caller's floor(s). Only counts active products.
    """
    pipeline = [
        {"$match": {"active": True}},
        {"$group": {
            "_id": {
                "brand_id":    "$brand_id",
                "category_id": "$category_id",
                "subcategory": "$subcategory",
                "series":      "$series",
                "family_key":  "$family_key",
                "family_name": "$family_name",
            },
            "product_count": {"$sum": 1},
            "min_price":     {"$min": "$price"},
            "sample_image":  {"$first": {"$arrayElemAt": ["$images", 0]}},
            "image_quality": {"$first": "$image_quality"},
        }},
    ]
    rows, brands, cats = await catalog_service.hierarchy_rows(floor_ids=floor_scope_ids(user))

    # Fold into brand → category → subcategory → series → family tree
    tree: dict = {}
    for r in rows:
        k = r["_id"]
        bid = k.get("brand_id") or "_"
        cid = k.get("category_id") or "_"
        subcat = k.get("subcategory") or "General"
        series = k.get("series") or "Uncategorised"
        family_key = k.get("family_key") or f"{bid}:{cid}:{subcat}:{series}:_"
        family_name = k.get("family_name") or series

        brand = brands.get(bid, {"id": bid, "name": "Unknown"})
        category = cats.get(cid, {"id": cid, "name": "Uncategorised"})
        b = tree.setdefault(bid, {"brand": brand, "categories": {}})
        c = b["categories"].setdefault(cid, {"category": category, "subcategories": {}})
        s = c["subcategories"].setdefault(subcat, {"name": subcat, "series": {}})
        se = s["series"].setdefault(series, {"name": series, "families": {}})
        fam = se["families"].setdefault(family_key, {
            "family_key": family_key, "family_name": family_name,
            "product_count": 0, "min_price": 0.0,
            "sample_image": None, "image_quality": None,
        })
        fam["product_count"] += r["product_count"]
        if fam["min_price"] == 0 or r["min_price"] < fam["min_price"]:
            fam["min_price"] = r["min_price"]
        if not fam["sample_image"] and r.get("sample_image"):
            fam["sample_image"] = r["sample_image"]
        if not fam["image_quality"]:
            fam["image_quality"] = r.get("image_quality")

    # Flatten to arrays for JSON friendliness
    def _flatten(d: dict) -> list:
        out = []
        for bid, b in d.items():
            cats_out = []
            for cid, c in b["categories"].items():
                subs_out = []
                for subname, s in c["subcategories"].items():
                    ser_out = []
                    for sername, se in s["series"].items():
                        fams_out = list(se["families"].values())
                        fams_out.sort(key=lambda f: f["family_name"] or "")
                        ser_out.append({
                            "name": sername, "family_count": len(fams_out),
                            "product_count": sum(f["product_count"] for f in fams_out),
                            "families": fams_out,
                        })
                    ser_out.sort(key=lambda x: x["name"])
                    subs_out.append({
                        "name": subname, "series_count": len(ser_out),
                        "product_count": sum(sr["product_count"] for sr in ser_out),
                        "series": ser_out,
                    })
                subs_out.sort(key=lambda x: x["name"])
                cats_out.append({
                    "category": c["category"],
                    "subcategory_count": len(subs_out),
                    "product_count": sum(sub["product_count"] for sub in subs_out),
                    "subcategories": subs_out,
                })
            cats_out.sort(key=lambda x: x["category"].get("name", ""))
            out.append({
                "brand": b["brand"],
                "category_count": len(cats_out),
                "product_count": sum(c["product_count"] for c in cats_out),
                "categories": cats_out,
            })
        out.sort(key=lambda x: x["brand"].get("name", ""))
        return out

    return {"tree": _flatten(tree)}


@router.get("/products/families")
async def list_families(
    brand_id: Optional[str] = None,
    category_id: Optional[str] = None,
    subcategory: Optional[str] = None,
    series: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = Query(60, ge=1),
    skip: int = Query(0, ge=0),
    user: UserPublic = Depends(get_current_user),
):
    """Return products grouped by family_key — one card per family, variants
    collapsed underneath. Ideal for the premium grouped catalog view.
    """
    skip, limit = normalize_pagination(skip, limit)
    return await catalog_service.list_family_groups(
        brand_id=brand_id,
        category_id=category_id,
        subcategory=subcategory,
        series=series,
        q=q,
        limit=limit,
        skip=skip,
        floor_ids=floor_scope_ids(user),
    )


# ---------- Ranked search (Iteration 2A) ----------
@router.get("/catalog/search")
async def catalog_search(
    q: str = Query("", description="Free-text query"),
    brand_id: Optional[str] = None,
    category_id: Optional[str] = None,
    subcategory: Optional[str] = None,
    series: Optional[str] = None,
    limit: int = 30,
    group: bool = Query(True, description="Group variants by family_key (Shopify-style)"),
    user: UserPublic = Depends(get_current_user),
):
    """Ranked catalog search, scoped to the caller's floor(s).

    Ranking priority (highest first):
      1. Exact SKU / SKU prefix
      2. Product name / family name (Mongo text score)
      3. Series / subcategory / finish / colour matches
      4. Fallback dimension / description matches

    Results are grouped by `family_key` by default so callers don't see 6
    duplicates of the same product with different finishes.
    """
    return await catalog_service.search_catalog(
        q=q,
        brand_id=brand_id,
        category_id=category_id,
        subcategory=subcategory,
        series=series,
        limit=limit,
        group=group,
        floor_ids=floor_scope_ids(user),
    )


@router.get("/catalog/facets")
async def catalog_facets(
    brand_id: Optional[str] = None,
    category_id: Optional[str] = None,
    subcategory: Optional[str] = None,
    series: Optional[str] = None,
    user: UserPublic = Depends(get_current_user),
):
    """Return the facet buckets (brands, categories, finishes, colours,
    price range) for the current selection, scoped to the caller's floor(s).
    """
    return await catalog_service.facet_buckets(
        brand_id=brand_id,
        category_id=category_id,
        subcategory=subcategory,
        series=series,
        floor_ids=floor_scope_ids(user),
    )


# ---------- Family-first canonical page (Iteration 2A shell — used by 2B) ----------
@router.get("/families/{family_key}")
async def get_family(family_key: str, user: UserPublic = Depends(get_current_user)):
    """Return everything the Shopify-style family page needs in a single
    call: family metadata + variants + gallery + specs union. Missing data
    is honestly reported (nulls / empty arrays), never fabricated.
    """
    if not await db.products.find_one(floor_query(user, {"family_key": family_key}), {"_id": 0, "id": 1}):
        raise HTTPException(status_code=404, detail="Family not found")
    doc = await catalog_service.family_detail(family_key, floor_ids=floor_scope_ids(user))
    if not doc:
        raise HTTPException(status_code=404, detail="Family not found")
    return doc


@router.get("/products/recent")
async def recent_products(
    limit: int = 12,
    user: UserPublic = Depends(get_current_user),
):
    """Products this user has recently added to a quotation."""
    return await catalog_service.recent_or_frequent_products(
        user.id, limit=limit, recent=True, floor_ids=floor_scope_ids(user),
    )


@router.get("/products/frequent")
async def frequent_products(
    limit: int = 12,
    user: UserPublic = Depends(get_current_user),
):
    """Products this user adds most often."""
    return await catalog_service.recent_or_frequent_products(
        user.id, limit=limit, recent=False, floor_ids=floor_scope_ids(user),
    )


@router.get("/products/{product_id}/size-variants", response_model=SizeVariantResolution)
async def resolve_product_size_variant(
    product_id: str,
    size: Optional[str] = Query(None, min_length=1, max_length=120, description="Nominal size returned by available_sizes"),
    user: UserPublic = Depends(get_current_user),
):
    """Discover or resolve a size selection on the source product's floor.

    Omit ``size`` to fetch the selected SKU plus its full size metadata. When
    supplied, clients replace their selection with the returned ``product``;
    it carries the sibling's own price, SKU, stock, specifications and media.
    """
    source = await get_floor_scoped_or_404(
        db.products, product_id, user, not_found="Product not found",
        projection={"_id": 0, "id": 1, "floor_id": 1},
    )
    # FastAPI supplies ``None`` for an omitted query argument.  Treating the
    # default Query object the same way also keeps direct route calls (unit
    # tests and internal callers) on the discoverability path.
    requested_size = size if isinstance(size, str) else None
    result = await catalog_service.resolve_size_variant(
        product_id, requested_size, floor_ids=[floor_inherit(source)],
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Size variant not found")
    return result


@router.get("/products/{product_id}")
async def get_product(product_id: str, user: UserPublic = Depends(get_current_user)):
    await get_floor_scoped_or_404(db.products, product_id, user, not_found="Product not found", projection={"_id": 0, "id": 1, "floor_id": 1})
    doc = await catalog_service.product_by_id(product_id, floor_ids=None)
    if not doc:
        raise HTTPException(status_code=404, detail="Product not found")
    return doc


@router.get("/products/{product_id}/alternates")
async def product_alternates(
    product_id: str,
    limit: int = 12,
    user: UserPublic = Depends(get_current_user),
):
    """Return alternate products a salesperson might swap in for `product_id`.

    Smart-mix ranking (closest matches first):
      Tier 1  same brand + same category + same name-prefix  (approximates family)
      Tier 2  same brand + same category
      Tier 3  same category (any brand)

    Within every tier we rank by (this user's usage count DESC, price ASC) so
    the salesperson sees products they actually reach for. The current product
    itself is always excluded.
    """
    source = await get_floor_scoped_or_404(db.products, product_id, user, not_found="Product not found", projection={"_id": 0, "id": 1, "floor_id": 1})
    result = await catalog_service.alternate_products(product_id, user.id, limit, floor_ids=[floor_inherit(source)])
    if result is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return result


@router.get("/products/{product_id}/complete-the-set")
async def complete_the_set(
    product_id: str,
    limit: int = 12,
    user: UserPublic = Depends(get_current_user),
):
    """"Complete the set" — same family (Series/Collection) but different
    category. E.g. viewing a Talis E basin mixer suggests the Talis E shower
    valve, spout, robe hook — the classic bathroom cross-sell.
    """
    source = await get_floor_scoped_or_404(db.products, product_id, user, not_found="Product not found", projection={"_id": 0, "id": 1, "floor_id": 1})
    result = await catalog_service.complete_set_products(product_id, limit, floor_ids=[floor_inherit(source)])
    if result is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return result


@router.post("/products/custom", response_model=Product)
async def create_custom_product(
    body: ProductCreate,
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Create a custom / one-off product from the Quotation Builder.

    When body.is_custom=True, the SKU can collide with existing rows (we
    auto-suffix). If False, we behave like /products with duplicate-SKU
    rejection.
    """
    floor_id = floor_for_write(user)
    await _require_product_relations_on_floor(body.brand_id, body.category_id, floor_id)
    sku = body.sku or f"CUSTOM-{datetime.now(timezone.utc).strftime('%y%m%d%H%M%S')}"
    if body.is_custom:
        # Auto-uniquify — never fail because the user typed the same SKU twice.
        base = sku
        n = 1
        while await db.products.find_one({"sku": sku, "floor_id": floor_id, "brand_id": body.brand_id}):
            n += 1
            sku = f"{base}-{n}"
    elif await db.products.find_one({"sku": sku, "floor_id": floor_id, "brand_id": body.brand_id}):
        raise HTTPException(status_code=409, detail="SKU already exists")

    payload = body.model_dump()
    payload["sku"] = sku
    payload["tags"] = list(set([*(payload.get("tags") or []), "custom"]))
    payload["floor_id"] = floor_id
    prod = Product(**payload)
    await db.products.insert_one(prod.model_dump())
    catalog_service.schedule_catalog_refresh()
    return prod


@router.post("/products", response_model=Product)
async def create_product(
    body: ProductCreate,
    user: UserPublic = Depends(require_min_role("purchase")),
):
    floor_id = floor_for_write(user)
    await _require_product_relations_on_floor(body.brand_id, body.category_id, floor_id)
    if await db.products.find_one({"sku": body.sku, "floor_id": floor_id, "brand_id": body.brand_id}):
        raise HTTPException(status_code=409, detail="SKU already exists")
    payload = body.model_dump()
    payload["floor_id"] = floor_id
    prod = Product(**payload)
    await db.products.insert_one(prod.model_dump())
    catalog_service.schedule_catalog_refresh()
    return prod


@router.patch("/products/{product_id}", response_model=Product)
async def update_product(
    product_id: str,
    body: ProductPatch,
    user: UserPublic = Depends(require_min_role("purchase")),
):
    """The single write path for the "single source of truth" product
    editor — used identically from Catalog, the Quotation Builder's product
    sheet, and (per the same shared component) Purchases in future. Only
    fields present in the request are touched (exclude_unset); everything
    else on the product document is left exactly as-is.

    Quotations already snapshot `name`/`sku`/`unit_price`/`finish`/`colour`/
    `image` onto each line item at the moment a product is added (see
    QuotationLineItem + the /quotations/{id}/items endpoint) — so this
    endpoint intentionally never touches `db.quotations`. Editing a product
    here changes what FUTURE quotations copy in; every quotation already
    generated (and its PDF) is unaffected by construction, not by any special
    case here.
    """
    existing = await db.products.find_one(floor_query(user, {"id": product_id}), {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Product not found")

    updates = body.model_dump(exclude_unset=True)
    if not updates:
        return Product(**existing)

    await _validate_diagram_media_urls(product_id, updates)

    # A salesperson configures a concealed part by its supplier SKU. It must
    # resolve to one active product on this floor: quotation lines need the
    # durable product id, not an unverified free-form SKU. A SKU may legally
    # exist under multiple brands, so prefer this product's brand and reject a
    # remaining ambiguity instead of choosing an arbitrary rough-in. The
    # Catalog preview can additionally submit the chosen product_id, which is
    # verified here rather than trusted; this lets staff deliberately choose
    # the right item when a supplier reuses an SKU across brands.
    concealed = updates.get("concealed_part")
    if concealed and concealed.get("sku"):
        sku = str(concealed["sku"]).strip()
        if not sku:
            raise HTTPException(status_code=422, detail="Conceal-part SKU is required")
        selected_product_id = str(concealed.get("product_id") or "").strip()
        if selected_product_id:
            linked = await db.products.find_one({
                "id": selected_product_id,
                "floor_id": existing.get("floor_id"),
                "sku": sku,
                "active": {"$ne": False},
            }, {"_id": 0})
            if not linked:
                raise HTTPException(status_code=422, detail="Selected conceal part is no longer available for this SKU")
        else:
            matches = await db.products.find(
                {"floor_id": existing.get("floor_id"), "sku": sku, "active": {"$ne": False}}, {"_id": 0},
            ).to_list(3)
            same_brand = [row for row in matches if row.get("brand_id") == existing.get("brand_id")]
            linked = same_brand[0] if len(same_brand) == 1 else matches[0] if len(matches) == 1 else None
            if not linked:
                detail = "Conceal-part SKU was not found in this floor's catalog" if not matches else "Conceal-part SKU is ambiguous; select the matching catalog item"
                raise HTTPException(status_code=404 if not matches else 409, detail=detail)
        if linked.get("id") == product_id:
            raise HTTPException(status_code=422, detail="A product cannot be its own conceal part")
        concealed = {**concealed, "sku": sku,
            "product_id": linked["id"], "name": linked.get("name"),
            "description": linked.get("description"), "unit_price": linked.get("price"),
            "mrp": linked.get("mrp"),
            "image": linked.get("hero_image_url") or (linked.get("images") or [None])[0],
        }
        updates["concealed_part"] = concealed

    new_sku = updates.get("sku", existing.get("sku"))
    new_brand_id = updates.get("brand_id", existing.get("brand_id"))
    new_category_id = updates.get("category_id", existing.get("category_id"))
    sku_changing = "sku" in updates and new_sku != existing.get("sku")
    brand_changing = "brand_id" in updates and new_brand_id != existing.get("brand_id")
    if sku_changing or brand_changing:
        if await db.products.find_one({
            "sku": new_sku,
            "floor_id": existing.get("floor_id"),
            "brand_id": new_brand_id,
            "id": {"$ne": product_id},
        }):
            raise HTTPException(status_code=409, detail="SKU already exists")

    if "brand_id" in updates or "category_id" in updates:
        await _require_product_relations_on_floor(
            new_brand_id, new_category_id, existing.get("floor_id"),
        )

    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.products.update_one(floor_query(user, {"id": product_id}), {"$set": updates})

    catalog_service.patch_product_in_snapshot(product_id, updates)

    await log_event(
        event_type="product.updated",
        entity_type="product",
        entity_id=product_id,
        actor=user,
        payload={"fields": sorted(updates.keys())},
        summary=f"Updated {', '.join(sorted(k for k in updates if k != 'updated_at'))}",
    )

    updated = await catalog_service.product_by_id(product_id, floor_ids=floor_scope_ids(user))
    return Product(**{k: v for k, v in updated.items() if k in Product.model_fields})


# ---------- Catalog import (AI-assisted scaffold) ----------
@router.get("/catalog/imports")
async def list_import_jobs(user: UserPublic = Depends(require_min_role("purchase"))):
    docs = await db.catalog_imports.find(floor_query(user), {"_id": 0, "rows": 0}).sort("created_at", -1).to_list(200)
    return docs


# ---------- Catalog export (Settings > Catalog > Export) ----------
@router.get("/catalog/export.xlsx")
async def export_catalog_xlsx(user: UserPublic = Depends(require_min_role("manager"))):
    from io import BytesIO
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter

    scope = floor_query(user)
    products = await db.products.find(scope, {"_id": 0}).sort("name", 1).to_list(10000)
    brands = {b["id"]: b["name"] for b in await db.brands.find(scope, {"_id": 0, "id": 1, "name": 1}).to_list(500)}
    categories = {c["id"]: c["name"] for c in await db.categories.find(scope, {"_id": 0, "id": 1, "name": 1}).to_list(500)}

    wb = Workbook()
    ws = wb.active
    ws.title = "Catalog"
    ws["A1"] = "Forge — Catalog Export"
    ws["A1"].font = Font(bold=True, size=14)
    ws.merge_cells("A1:J1")
    stamp = datetime.now(timezone.utc).strftime("%d %b %Y · %H:%M UTC")
    ws["A2"] = f"{len(products)} products · Exported {stamp}"
    ws["A2"].font = Font(color="6B7280", size=10)
    ws.merge_cells("A2:J2")

    headers = ["SKU", "Name", "Brand", "Category", "Series", "Finish", "MRP", "Trade Price", "Stock", "Warranty"]
    header_fill = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")
    for col, h in enumerate(headers, start=1):
        cell = ws.cell(row=4, column=col, value=h)
        cell.font = Font(bold=True, color="374151", size=11)
        cell.fill = header_fill

    for i, p in enumerate(products, start=5):
        ws.cell(row=i, column=1, value=p.get("sku"))
        ws.cell(row=i, column=2, value=p.get("name"))
        ws.cell(row=i, column=3, value=brands.get(p.get("brand_id"), ""))
        ws.cell(row=i, column=4, value=categories.get(p.get("category_id"), ""))
        ws.cell(row=i, column=5, value=p.get("series"))
        ws.cell(row=i, column=6, value=p.get("finish"))
        ws.cell(row=i, column=7, value=p.get("mrp"))
        ws.cell(row=i, column=8, value=p.get("price"))
        ws.cell(row=i, column=9, value=p.get("stock"))
        ws.cell(row=i, column=10, value=p.get("warranty"))

    widths = [16, 40, 16, 18, 16, 16, 10, 12, 8, 16]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A5"

    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    from fastapi.responses import StreamingResponse
    filename = f"forge-catalog-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')}.xlsx"
    return StreamingResponse(
        buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
