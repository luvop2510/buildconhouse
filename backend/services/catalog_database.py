"""Bounded Mongo catalog reads for catalogs beyond the warm-cache budget.

Filtering, placement expansion, grouping, counting and paging happen in Mongo.
Only a requested page and its exact related products/media enter API memory.
"""
from __future__ import annotations
import asyncio
import inspect
import re
from dataclasses import replace
from fastapi import HTTPException
from db import db

MAX_CONTEXT_PRODUCTS = 2500
MAX_CONTEXT_MEDIA = 20000
MAX_REFERENCE_ROWS = 5000
MAX_RESPONSE_BYTES = 48 * 1024 * 1024
MAX_QUERY_MS = 30000


def floor_query(floor_ids):
    return {} if floor_ids is None else {"floor_id": {"$in": floor_ids}}


async def bounded(cursor, maximum, description):
    from bson import BSON
    rows = []; size = 0
    async for row in cursor:
        size += len(BSON.encode(row))
        if len(rows) >= maximum or size > MAX_RESPONSE_BYTES:
            raise HTTPException(status_code=413, detail=f"{description} is too large for one response; narrow the floor, brand, category or search filters")
        rows.append(row)
    return rows


def aggregate(pipeline):
    return db.products.aggregate(pipeline, allowDiskUse=True, maxTimeMS=MAX_QUERY_MS, batchSize=32)


def listing_pipeline(filters=None, *, floor_ids=None, q=None, per_category=False):
    """Match floor before joins; expand source placements before user filters."""
    from services import catalog_service as catalog
    query = {"active": True, **floor_query(floor_ids)}
    filters = {key: value for key, value in (filters or {}).items() if value is not None}
    # These fields are invariant across source occurrences and can use indexes.
    for key in ("brand_id", "family_key", "finish", "colour", "series"):
        if key in filters:
            query[key] = filters[key]
    pipeline = [
        {"$match": query},
        {"$lookup": {"from": "brands", "localField": "brand_id", "foreignField": "id", "as": "_brand"}},
        {"$set": {"_brand": {"$arrayElemAt": ["$_brand", 0]}}},
        {"$match": {"_brand.name": {"$not": {"$regex": r"^\s*axor\s*$", "$options": "i"}}, "_brand.slug": {"$not": {"$regex": r"^\s*axor\s*$", "$options": "i"}}, "$expr": {"$or": [
            {"$ne": [{"$ifNull": ["$_brand.catalog_authoritative", False]}, True]},
            {"$and": [{"$eq": ["$catalog_source", "$_brand.catalog_source"]}, {"$gt": [{"$size": {"$ifNull": ["$catalog_entries", []]}}, 0]}]},
        ]}}},
        {"$set": {"_placement": {"$cond": [{"$gt": [{"$size": {"$ifNull": ["$catalog_entries", []]}}, 0]}, "$catalog_entries", [None]]}}},
        {"$unwind": "$_placement"},
        {"$set": {**{key: {"$ifNull": [f"$_placement.{key}", f"${key}"]} for key in ("category_id", "name", "description")},
            "subcategory": {"$cond": [{"$ne": [{"$type": "$_placement.subcategory"}, "missing"]}, "$_placement.subcategory", "$subcategory"]},
            "listing_id": {"$ifNull": ["$_placement.entry_id", "$$REMOVE"]},
            "catalog_entry": {"$ifNull": ["$_placement", "$$REMOVE"]},
            "price": {"$ifNull": ["$_placement.mrp", "$price"]},
            "mrp": {"$ifNull": ["$_placement.mrp", "$mrp"]},
            "price_status": {"$cond": [{"$ne": [{"$ifNull": ["$_placement.mrp", None]}, None]}, "known", "$price_status"]},
            "source_price_unspecified": {"$and": [{"$ne": ["$_placement", None]}, {"$eq": [{"$ifNull": ["$_placement.mrp", None]}, None]}]},
            "price_source": {"$cond": [{"$ne": [{"$ifNull": ["$_placement.mrp", None]}, None]}, "supplier", {"$cond": [{"$eq": ["$price_status", "unspecified"]}, "unspecified", "existing"]}]},
            "_catalog_database_listing": True,
            "_source_rank": {"$cond": [{"$ne": ["$_placement", None]}, 0, 1]},
            "_brand_order": {"$ifNull": ["$_brand.catalog_order", 999]},
            "_sort_price": {"$ifNull": ["$_placement.mrp", {"$ifNull": ["$price", 0]}]},
        }},
    ]
    if filters:
        pipeline.append({"$match": filters})
    if q:
        pattern = re.escape(q[:120])
        pipeline.append({"$match": {"$or": [{field: {"$regex": pattern, "$options": "i"}} for field in catalog._SEARCH_FIELDS]}})
    pipeline += [
        {"$sort": {"_source_rank": 1, "_brand_order": 1, "_placement.source_catalog": 1, "_placement.source_order": 1, "name": 1, "listing_id": 1, "id": 1}},
        {"$group": {"_id": {"id": "$id", "category": "$category_id"} if per_category else "$id", "document": {"$first": "$$ROOT"}}},
        {"$replaceRoot": {"newRoot": "$document"}},
    ]
    return pipeline


def family_group_key():
    return {"key": {"$ifNull": ["$listing_id", {"$ifNull": ["$family_key", {"$concat": ["solo:", "$id"]}]}]}, "floor": "$floor_id", "brand": "$brand_id", "category": "$category_id"}


def source_sort():
    return {"_source_rank": 1, "_brand_order": 1, "_placement.source_catalog": 1, "_placement.source_order": 1, "name": 1, "listing_id": 1, "id": 1}


def usage_lookup(user_id):
    return [
        {"$lookup": {"from": "product_usage", "let": {"pid": "$id"}, "pipeline": [
            {"$match": {"$expr": {"$eq": ["$product_id", "$$pid"]}}},
            {"$group": {"_id": None, "usage_count": {"$sum": "$count"}, "my_usage_count": {"$sum": {"$cond": [{"$eq": ["$user_id", user_id]}, "$count", 0]}}, "last_used_at": {"$max": {"$cond": [{"$eq": ["$user_id", user_id]}, "$last_used_at", None]}}}},
        ], "as": "_usage"}},
        {"$set": {"_usage": {"$arrayElemAt": ["$_usage", 0]}}},
        {"$set": {"usage_count": {"$ifNull": ["$_usage.usage_count", 0]}, "my_usage_count": {"$ifNull": ["$_usage.my_usage_count", 0]}, "_recent_rank": {"$cond": [{"$ne": [{"$ifNull": ["$_usage.last_used_at", None]}, None]}, 0, 1]}}},
    ]


async def context(products, *, product_ids=None, floor_ids=None):
    """Complete bounded relationships for a page; namespace all family joins."""
    from services import catalog_service as catalog
    if product_ids is not None:
        products = await bounded(db.products.find({"id": {"$in": list(product_ids)}, **floor_query(floor_ids)}, {"_id": 0}), MAX_CONTEXT_PRODUCTS, "Requested product page")
    products = list(products)
    relatives = []
    for product in products:
        namespace = {"floor_id": product.get("floor_id"), "brand_id": product.get("brand_id"), "active": True}
        if product.get("family_key"):
            relatives.append({**namespace, "family_key": product["family_key"], "$or": [{"category_id": product.get("category_id")}, {"catalog_entries.category_id": product.get("category_id")}]})
        configured = product.get("concealed_part") or {}
        if configured.get("sku"):
            relatives.append({"floor_id": product.get("floor_id"), "sku": configured["sku"], "active": True})
        configuration_group = (product.get("specs") or {}).get("configuration_group")
        if configuration_group:
            relatives.append({**namespace, "category_id": product.get("category_id"), "specs.configuration_group": configuration_group})
    if relatives:
        related = await bounded(db.products.find({"$or": relatives}, {"_id": 0}), MAX_CONTEXT_PRODUCTS, "Product family relationships")
        by_id = {p["id"]: p for p in [*products, *related]}
    else:
        by_id = {p["id"]: p for p in products}
    if len(by_id) > MAX_CONTEXT_PRODUCTS:
        raise HTTPException(status_code=413, detail="Product families exceed the response budget; narrow the catalog page")
    products = list(by_id.values())
    ids = list(by_id)
    def media_floor(product):
        # ProductMedia requires an explicit floor; ambiguous legacy rows
        # cannot establish ownership of a requested product.
        return {"floor_id": product.get("floor_id")}
    family_scopes = [{"family_key": p["family_key"], **media_floor(p), "brand_id": {"$in": [p.get("brand_id"), None]}} for p in products if p.get("family_key")]
    product_scopes = [{"product_id": p["id"], **media_floor(p)} for p in products]
    media_query = {"$or": product_scopes + family_scopes} if products else {"id": {"$in": []}}
    brands, categories, media, usage = await asyncio.gather(
        bounded(db.brands.find({"id": {"$in": list({p.get("brand_id") for p in products})}}, {"_id": 0}), MAX_REFERENCE_ROWS, "Brands"),
        bounded(db.categories.find({"id": {"$in": list({p.get("category_id") for p in products} | {e.get("category_id") for p in products for e in p.get("catalog_entries") or []})}}, {"_id": 0}), MAX_REFERENCE_ROWS, "Categories"),
        bounded(db.product_media.find(media_query, {"_id": 0}), MAX_CONTEXT_MEDIA, "Product media"),
        bounded(db.product_usage.aggregate([{"$match": {"product_id": {"$in": ids}}}, {"$group": {"_id": "$product_id", "count": {"$sum": "$count"}}}, {"$project": {"_id": 0, "product_id": "$_id", "count": 1}}], allowDiskUse=True, maxTimeMS=MAX_QUERY_MS), MAX_CONTEXT_PRODUCTS, "Product usage"),
    )
    return catalog._build_snapshot(products, media, brands, categories, usage)


async def run_in_memory(name, snapshot, arguments):
    from services import catalog_service as catalog
    token = catalog._snapshot_override.set(snapshot)
    try:
        return await getattr(catalog, name)(**arguments)
    finally:
        catalog._snapshot_override.reset(token)


async def list_page(arguments):
    from services import catalog_service as catalog
    filters = {key: arguments.get(key) for key in ("brand_id", "category_id", "subcategory", "series", "family_key", "finish", "colour")}
    pipeline = listing_pipeline(filters, floor_ids=arguments.get("floor_ids"), q=arguments.get("q"))
    sort = arguments["sort"]
    if sort in {"recent", "popular"}:
        # Authoritative source placements retain workbook ordering.
        has_source = await aggregate(pipeline + [{"$match": {"listing_id": {"$exists": True}}}, {"$limit": 1}, {"$project": {"id": 1}}]).to_list(1)
        if sort == "popular" and has_source:
            order = source_sort()
        else:
            pipeline += usage_lookup(arguments["user_id"])
            order = {"_recent_rank": 1, "_usage.last_used_at": -1, "name": 1, "id": 1} if sort == "recent" else {"usage_count": -1, "my_usage_count": -1, "name": 1, "id": 1}
    else:
        order = {"_sort_price": 1, "id": 1} if sort == "price_asc" else {"_sort_price": -1, "id": 1} if sort == "price_desc" else {"name": 1, "id": 1} if sort == "name" else source_sort()
    result = await aggregate(pipeline + [{"$facet": {"total": [{"$count": "value"}], "items": [{"$sort": order}, {"$skip": arguments["skip"]}, {"$limit": arguments["limit"]}, {"$unset": ["_brand", "_placement"]}]}}]).to_list(1)
    result = result[0] if result else {}; rows = result.get("items", [])
    snapshot = await context(rows)
    ids = [p["id"] for p in rows]
    mine = await bounded(db.product_usage.find({"user_id": arguments["user_id"], "product_id": {"$in": ids}}, {"_id": 0}), MAX_CONTEXT_PRODUCTS, "User product usage")
    my_rows = {row["product_id"]: row for row in mine}
    # The badge describes the top 15% of used products. Mongo computes the
    # threshold without shipping all usage records or counts to API memory.
    grouped_usage = [{"$group": {"_id": "$product_id", "count": {"$sum": "$count"}}}]
    total_usage = await db.product_usage.aggregate(grouped_usage + [{"$count": "value"}], allowDiskUse=True, maxTimeMS=MAX_QUERY_MS).to_list(1)
    n = total_usage[0]["value"] if total_usage else 0
    cut = await db.product_usage.aggregate(grouped_usage + [{"$sort": {"count": -1}}, {"$skip": min(n - 1, int(n * .15)) if n else 0}, {"$limit": 1}], allowDiskUse=True, maxTimeMS=MAX_QUERY_MS).to_list(1)
    threshold = cut[0]["count"] if cut else 0
    items = []
    for row in rows:
        item = catalog.hydrate_product(row, snapshot); mine = my_rows.get(row["id"], {}); usage = snapshot.global_usage.get(row["id"], 0)
        item.update(usage_count=usage, my_usage_count=int(mine.get("count", 0)), popular=bool(threshold > 0 and usage >= threshold), frequently_used=int(mine.get("count", 0)) >= 3, recently_used=bool(mine.get("last_used_at")))
        items.append(item)
    return {"total": result.get("total", [{}])[0].get("value", 0) if result.get("total") else 0, "items": items}


async def reference_counts(name, arguments):
    from services import catalog_service as catalog
    categories = name == "list_categories_with_counts"
    field = "category_id" if categories else "brand_id"
    filters = {"brand_id": arguments.get("brand_id")} if categories else {}
    counts = await bounded(aggregate(listing_pipeline(filters, floor_ids=arguments.get("floor_ids"), per_category=categories) + [{"$group": {"_id": f"${field}", "count": {"$sum": 1}}}]), MAX_REFERENCE_ROWS, "Catalog reference counts")
    by_id = {row["_id"]: row["count"] for row in counts}
    collection = db.categories if categories else db.brands
    rows = await bounded(collection.find(floor_query(arguments.get("floor_ids")), {"_id": 0}), MAX_REFERENCE_ROWS, "Catalog references")
    from catalog_policy import removed_brand_document
    output = []
    for row in rows:
        if not categories and removed_brand_document(row): continue
        if categories and arguments.get("brand_id") and (not by_id.get(row["id"]) or row.get("brand_id") not in (None, arguments["brand_id"])): continue
        output.append({**row, "product_count": by_id.get(row["id"], 0)})
    return sorted(output, key=catalog._category_sort_key if categories else lambda row: row.get("name") or "")


async def families(arguments):
    filters = {key: arguments.get(key) for key in ("brand_id", "category_id", "subcategory", "series")}
    base = listing_pipeline(filters, floor_ids=arguments.get("floor_ids"), q=arguments.get("q"))
    groups = [{"$sort": source_sort()}, {"$group": {"_id": family_group_key(), "sample": {"$first": "$$ROOT"}}}, {"$set": {"_sort_name": {"$ifNull": ["$sample.catalog_entry.name", {"$ifNull": ["$sample.family_name", "$sample.name"]}]}}}]
    has_source = await aggregate(base + [{"$match": {"listing_id": {"$exists": True}}}, {"$limit": 1}, {"$project": {"id": 1}}]).to_list(1)
    order = {"sample._source_rank": 1, "sample._brand_order": 1, "sample._placement.source_catalog": 1, "sample._placement.source_order": 1, "_sort_name": 1, "sample.id": 1} if has_source else {"_sort_name": 1, "sample.id": 1}
    result = await aggregate(base + groups + [{"$facet": {"total": [{"$count": "value"}], "items": [{"$sort": order}, {"$skip": arguments["skip"]}, {"$limit": arguments["limit"]}]}}]).to_list(1)
    result = result[0] if result else {}; selected = result.get("items", [])
    if not selected: return {"total": result.get("total", [{}])[0].get("value", 0) if result.get("total") else 0, "items": []}
    keys = [row["_id"] for row in selected]
    rows = await bounded(aggregate(base + [{"$set": {"_family_group": family_group_key()}}, {"$match": {"_family_group": {"$in": keys}}}, {"$unset": ["_brand", "_placement", "_family_group"]}]), MAX_CONTEXT_PRODUCTS, "Family page variants")
    snapshot = await context(rows)
    page_snapshot = replace(snapshot, products=tuple(rows))
    response = await run_in_memory("list_family_groups", page_snapshot, {**arguments, "skip": 0})
    response["total"] = result["total"][0]["value"] if result.get("total") else 0
    return response


async def facets(arguments):
    filters = {key: arguments.get(key) for key in ("brand_id", "category_id", "subcategory", "series")}
    fields = {"brands": "brand_id", "categories": "category_id", "subcategories": "subcategory", "series": "series", "finishes": "finish", "sizes": "size", "colours": "colour", "materials": "material"}
    buckets = {name: [{"$match": {field: {"$nin": [None, ""]}}}, {"$group": {"_id": {"value": f"${field}", "id": "$id"}}}, {"$group": {"_id": "$_id.value", "count": {"$sum": 1}}}, {"$sort": {"count": -1, "_id": 1}}, {"$limit": 100}, {"$project": {"_id": 0, "value": "$_id", "count": 1}}] for name, field in fields.items()}
    buckets["price"] = [{"$match": {"price_status": {"$ne": "unspecified"}}}, {"$group": {"_id": None, "min": {"$min": "$price"}, "max": {"$max": "$price"}}}, {"$project": {"_id": 0}}]
    result = await aggregate(listing_pipeline(filters, floor_ids=arguments.get("floor_ids"), per_category=True) + [{"$facet": buckets}]).to_list(1)
    result = result[0] if result else {key: [] for key in fields}; result["price"] = result.get("price", [{}])[0] if result.get("price") else {"min": 0, "max": 0}
    return result


async def search(arguments):
    filters = {key: arguments.get(key) for key in ("brand_id", "category_id", "subcategory", "series")}
    query = (arguments.get("q") or "").strip()[:120]; lower = query.lower(); escaped = re.escape(query)
    base = listing_pipeline(filters, floor_ids=arguments.get("floor_ids"))
    if query:
        def match(field, regex): return {"$regexMatch": {"input": {"$convert": {"input": f"${field}", "to": "string", "onError": "", "onNull": ""}}, "regex": regex, "options": "i"}}
        score = [{"$switch": {"branches": [{"case": {"$eq": [{"$toLower": {"$ifNull": ["$sku", ""]}}, lower]}, "then": 100}, {"case": match("sku", "^" + escaped), "then": 60}, {"case": match("sku", escaped), "then": 30}], "default": 0}}]
        score += [{"$cond": [match(field, escaped), weight, 0]} for field, weight in (("name", 12), ("family_name", 10), ("series", 6), ("subcategory", 4), ("finish", 3), ("size", 3), ("colour", 3), ("dimensions", 1), ("description", 1), ("catalog_search_text", 1))]
        base += [{"$set": {"_score": {"$add": score}}}, {"$match": {"_score": {"$gt": 0}}}]
    result = await aggregate(base + [{"$facet": {"total": [{"$count": "value"}], "items": [{"$sort": {"_score": -1, **source_sort()} if query else source_sort()}, {"$limit": arguments["limit"] * 3}, {"$unset": ["_brand", "_placement"]}]}}]).to_list(1)
    result = result[0] if result else {}; rows = result.get("items", []); snapshot = await context(rows)
    response = await run_in_memory("search_catalog", replace(snapshot, products=tuple(rows)), arguments)
    if not arguments["group"]: response["total"] = result["total"][0]["value"] if result.get("total") else 0
    return response


async def hierarchy(arguments):
    base = listing_pipeline(floor_ids=arguments.get("floor_ids"), per_category=True)
    grouped = await bounded(aggregate(base + [{"$group": {"_id": {key: f"${key}" for key in ("brand_id", "category_id", "subcategory", "series", "family_key", "family_name")}, "product_count": {"$sum": 1}, "min_price": {"$min": "$price"}, "sample_image": {"$first": {"$arrayElemAt": ["$images", 0]}}, "image_quality": {"$first": "$image_quality"}}}]), MAX_REFERENCE_ROWS, "Catalog hierarchy")
    brands, categories = await asyncio.gather(reference_counts("list_brands_with_counts", arguments), bounded(db.categories.find(floor_query(arguments.get("floor_ids")), {"_id": 0}), MAX_REFERENCE_ROWS, "Catalog categories"))
    return grouped, {row["id"]: row for row in brands}, {row["id"]: row for row in categories}


async def related(name, arguments):
    filters = floor_query(arguments.get("floor_ids"))
    source = await db.products.find_one({"id": arguments["product_id"], "active": True, **filters}, {"_id": 0})
    if not source: return None
    if name == "alternate_products":
        candidates = await bounded(db.products.find({"id": {"$ne": source["id"]}, "category_id": source.get("category_id"), "active": True, **filters}, {"_id": 0}).limit(400), 400, "Alternate product candidates")
    elif name == "complete_set_products":
        matches = []
        if source.get("family_key"): matches.append({"family_key": source["family_key"]})
        for key in ("series", "collection"):
            if source.get(key): matches.append({key: source[key], "brand_id": source.get("brand_id")})
        candidates = await bounded(db.products.find({"id": {"$ne": source["id"]}, "category_id": {"$ne": source.get("category_id")}, "active": True, **filters, "$or": matches or [{"id": None}]}, {"_id": 0}).limit(arguments["limit"]), MAX_CONTEXT_PRODUCTS, "Complete set candidates")
    else:
        candidates = []
    snapshot = await context([source, *candidates])
    if name in {"alternate_products", "complete_set_products"}:
        snapshot = replace(snapshot, products=tuple([source, *candidates]))
    if arguments.get("user_id"):
        usage = await bounded(db.product_usage.find({"user_id": arguments["user_id"], "product_id": {"$in": list(snapshot.product_by_id)}}, {"_id": 0}), MAX_CONTEXT_PRODUCTS, "User product usage")
        snapshot.usage_by_user[arguments["user_id"]] = {row["product_id"]: row for row in usage}
    return await run_in_memory(name, snapshot, arguments)


async def recent(arguments):
    query = {"active": True, **floor_query(arguments.get("floor_ids"))}
    rows = await bounded(db.product_usage.aggregate([
        {"$match": {"user_id": arguments["user_id"]}},
        {"$sort": {"last_used_at" if arguments["recent"] else "count": -1, "product_id": 1}},
        {"$lookup": {"from": "products", "localField": "product_id", "foreignField": "id", "as": "product"}},
        {"$unwind": "$product"}, {"$match": {f"product.{key}": value for key, value in query.items()}},
        {"$limit": arguments["limit"]},
    ], allowDiskUse=True, maxTimeMS=MAX_QUERY_MS), MAX_CONTEXT_PRODUCTS, "Recent products")
    snapshot = await context([row["product"] for row in rows]); snapshot.usage_by_user[arguments["user_id"]] = {row["product_id"]: {**row, "product": None} for row in rows}
    return await run_in_memory("recent_or_frequent_products", snapshot, arguments)


async def call(name, function, args, kwargs):
    bound = inspect.signature(function).bind(*args, **kwargs); bound.apply_defaults(); arguments = dict(bound.arguments)
    if "limit" in arguments:
        from services.pagination import normalize_pagination
        _, arguments["limit"] = normalize_pagination(0, arguments["limit"])
    if name == "list_products_page": return await list_page(arguments)
    if name in {"list_brands_with_counts", "list_categories_with_counts"}: return await reference_counts(name, arguments)
    if name == "list_family_groups": return await families(arguments)
    if name == "facet_buckets": return await facets(arguments)
    if name == "search_catalog": return await search(arguments)
    if name == "hierarchy_rows": return await hierarchy(arguments)
    if name == "recent_or_frequent_products": return await recent(arguments)
    if name == "family_detail":
        rows = await bounded(db.products.find({"family_key": arguments["family_key"], "active": True, **floor_query(arguments.get("floor_ids"))}, {"_id": 0}), MAX_CONTEXT_PRODUCTS, "Family detail")
        return await run_in_memory(name, await context(rows), arguments)
    return await related(name, arguments)
