"""The only module that reads Mongo for the Sales Data launch breakdowns.

Every read starts from Phase 0's `build_match`, so floor scoping and the
ordered_at-vs-created_at date-field choice live in exactly one place, same as
every other analytics surface.

**No new aggregation pipelines.** Revenue by Brand and Best Selling Products
both go through the canonical `metrics.line_revenue_pipeline`; Revenue by
Customer and Recent Orders fold in Python over a plain `find`, exactly the
convention `gather_collections_orders` already established for
doc-level (rather than line-level) rollups. Confirmed-order volume is small
by construction — one document per closed deal — and folding in Python keeps
these unit-testable against the codebase's existing fake-db pattern.
"""
from __future__ import annotations

from dataclasses import replace
from typing import Optional

from services.analytics.filters import AnalyticsFilter, build_match
from services.analytics.gather import collected_by_quotation
from services.analytics.metrics import line_revenue_pipeline

# Generous enough that no real reporting period is truncated, bounded so a
# pathological query cannot stream the whole book into memory. The live book
# has 35 confirmed orders across all time.
_MAX_ROWS = 20000

# Every distinct product that appears on a confirmed order in the window.
# Separate from the caller's own display limit: brand revenue folds ALL of
# them, so truncating here would silently understate a brand.
_MAX_PRODUCTS = 5000

_ORDER_FIELDS = {
    "_id": 0, "id": 1, "number": 1, "customer_id": 1, "customer_name": 1,
    "floor_id": 1, "created_by_name": 1, "ordered_at": 1, "grand_total": 1,
}


def _ordered(f: AnalyticsFilter) -> AnalyticsFilter:
    """The filter every revenue read uses: the caller's floor and date window,
    forced to confirmed orders. Revenue is never counted from a draft."""
    return replace(f, status="ordered")


async def _ordered_match(db, f, accessible_floors, window) -> dict:
    ordered = _ordered(f)
    # Validate access before any lookup, including an empty brand result.
    match = build_match(ordered, accessible_floors, window)
    if ordered.brand_id:
        scope = build_match(AnalyticsFilter(floor_id=f.floor_id, status="any"), accessible_floors, (None, None))
        products = await db.products.find(
            {**scope, "brand_id": ordered.brand_id}, {"_id": 0, "id": 1},
        ).to_list(None)
        match["items.product_id"] = {"$in": [p["id"] for p in products]}
    return match


async def gather_confirmed_orders(db, f: AnalyticsFilter, accessible_floors, window) -> list[dict]:
    """Confirmed orders in the window, projected to the fields the Customer
    and Recent Orders surfaces need. Both fold over this same list, so they
    can never disagree about which orders are in the period."""
    match = await _ordered_match(db, f, accessible_floors, window)
    return await db.quotations.find(match, _ORDER_FIELDS).to_list(_MAX_ROWS)


async def gather_order_collections(db, orders: list[dict]) -> dict[str, float]:
    """Completed-payment totals per order id, via Phase 1's own helper."""
    return await collected_by_quotation(db, [o["id"] for o in orders if o.get("id")])


async def gather_product_line_revenue(
    db, f: AnalyticsFilter, accessible_floors, window, limit: int | None = _MAX_PRODUCTS,
) -> list[dict]:
    """Revenue per product id, straight off the canonical line pipeline.

    Sums `items.net_amount`, so this reconciles to grand_total by
    construction — never qty x unit_price, which ignores the discount
    cascade and is why `/executive-analytics/dashboard`'s brand figures
    cannot be reused on a page that also shows Total Revenue.
    """
    match = await _ordered_match(db, f, accessible_floors, window)
    return await db.quotations.aggregate(
        line_revenue_pipeline(match, group_by="items.product_id", limit=limit),
    ).to_list(limit)


async def gather_line_labels(
    db, f: AnalyticsFilter, accessible_floors, window,
) -> tuple[dict[str, str], dict[str, str]]:
    """product_id -> name and product_id -> sku, harvested from the order
    lines themselves.

    Deliberately not from db.products: a third of the live book's ordered
    product ids no longer resolve to a catalog doc, and the line records what
    was actually sold. A plain projected find, not an aggregation.
    """
    match = await _ordered_match(db, f, accessible_floors, window)
    docs = await db.quotations.find(
        match, {"_id": 0, "items.product_id": 1, "items.name": 1, "items.sku": 1},
    ).to_list(_MAX_ROWS)

    names: dict[str, str] = {}
    skus: dict[str, str] = {}
    for doc in docs:
        for item in doc.get("items") or []:
            product_id = item.get("product_id")
            if not product_id:
                continue
            # Last write wins; a renamed product shows its most recent label.
            if item.get("name"):
                names[product_id] = item["name"]
            if item.get("sku"):
                skus[product_id] = item["sku"]
    return names, skus


async def gather_product_brands(db, product_ids: list[str]) -> tuple[dict[str, str], dict[str, str]]:
    """product_id -> brand_id (only where it resolves) and brand_id -> name.

    Unresolvable ids are simply absent from the first map; `breakdowns.
    brand_rows` folds those into the Unlinked bucket rather than dropping the
    revenue.
    """
    if not product_ids:
        return {}, {}
    products = await db.products.find(
        {"id": {"$in": product_ids}}, {"_id": 0, "id": 1, "brand_id": 1},
    ).to_list(len(product_ids))
    product_brand = {p["id"]: p["brand_id"] for p in products if p.get("id") and p.get("brand_id")}

    brand_ids = sorted(set(product_brand.values()))
    if not brand_ids:
        return product_brand, {}
    brands = await db.brands.find(
        {"id": {"$in": brand_ids}}, {"_id": 0, "id": 1, "name": 1},
    ).to_list(len(brand_ids))
    return product_brand, {b["id"]: b["name"] for b in brands if b.get("id")}


async def latest_confirmed_order_at(db, f: AnalyticsFilter, accessible_floors) -> Optional[str]:
    """The newest ordered_at across everything the caller can see, ignoring
    the date window — the anchor the smart default period falls back to.

    Sorts and takes one document rather than aggregating a $max: it is a
    single indexed read (migration 0013 added the analytics indexes) and adds
    no pipeline.
    """
    match = await _ordered_match(db, f, accessible_floors, (None, None))
    newest = await db.quotations.find(
        {**match, "ordered_at": {"$ne": None}}, {"_id": 0, "ordered_at": 1},
    ).sort("ordered_at", -1).limit(1).to_list(1)
    return newest[0]["ordered_at"] if newest else None
