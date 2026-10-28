"""Four department sales and current customer balances, preserving saved currencies.

Product attribution comes only from catalog order lines. Kitchen counts the
current authorized order basis; Furniture counts finalized ledgers in RNB.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException

from services.analytics.breakdowns import UNLINKED_BRAND_ID, UNLINKED_BRAND_NAME
from services.analytics.filters import AnalyticsFilter, build_match
from services.analytics.gather_breakdowns import gather_product_brands
from services.analytics.kitchen_referrals import kitchen_referral_pipeline
from services.analytics.furniture import furniture_match
from services.lead_scope import POST_ORDER_CATEGORIES, POST_ORDER_RULES
from services.multi_filters import filter_values

CATALOG_FLOORS = ("ground-floor", "first-floor")
SALES_FLOORS = (*CATALOG_FLOORS, "second-floor", "third-floor")
ROW_LIMIT = 100
MAX_PRODUCT_UNIT_ROWS = 10000


def financial_scope(f: AnalyticsFilter, floors) -> dict:
    # Validate the requested scope even if it contains no catalog floor.
    match = build_match(AnalyticsFilter(floor_id=f.floor_id, status="any"), floors, (None, None))
    requested = filter_values(f.floor_id) if f.floor_id and f.floor_id != "all" else floors
    match["floor_id"] = {"$in": [floor for floor in CATALOG_FLOORS if requested is None or floor in requested]}
    return match


def _in_period(window, *, date_field="ordered_at", eligible=None) -> dict:
    start, end = window
    return {"$and": [eligible if eligible is not None else {"$eq": ["$status", "ordered"]},
                     *([{"$gte": [f"${date_field}", start]}] if start else []),
                     *([{"$lt": [f"${date_field}", end]}] if end else [])]}


def _decimal(value, *, default=None):
    return {"$convert": {"input": value, "to": "decimal", "onError": default, "onNull": default}}


def _invalid_amount(field, *, allow_negative=False):
    checks = [{"$eq": [field, None]},
              {"$in": [{"$toString": field}, ["NaN", "Infinity", "-Infinity"]]}]
    if not allow_negative:
        checks.append({"$lt": [field, 0]})
    return {"$or": checks}


def _phone_identity(field):
    phone = {"$convert": {"input": field, "to": "string", "onError": "", "onNull": ""}}
    for character in ("+", " ", "-", "(", ")", "."):
        phone = {"$replaceAll": {"input": phone, "find": character, "replacement": ""}}
    return {"$let": {"vars": {"phone": phone}, "in": {"$cond": [
        {"$regexMatch": {"input": "$$phone", "regex": "^[0-9]{10,}$"}},
        {"$concat": ["phone:", {"$substrCP": ["$$phone", {"$subtract": [{"$strLenCP": "$$phone"}, 10]}, 10]}]}, None,
    ]}}}


def _identity_stage():
    return {"$set": {"_customer_identity": {"$cond": [
        {"$and": [{"$eq": [{"$type": "$customer_id"}, "string"]}, {"$ne": ["$customer_id", ""]}]},
        {"$concat": ["id:", "$customer_id"]}, _phone_identity("$customer_phone"),
    ]}}}


def collection_total_expression() -> dict:
    """The append-only extra-cost rule used by Payments, expressed for Mongo."""
    return {"$add": [
        _decimal("$grand_total", default=0),
        {"$cond": [{"$isArray": "$payment_extra_history"},
                    {"$sum": {"$map": {"input": "$payment_extra_history", "as": "cost", "in": _decimal("$$cost.amount", default=0)}}},
                    _decimal("$payment_extra_amount", default=0)]},
    ]}


def _catalog_accounts(scope, window):
    return [
        {"$match": {**scope, "status": {"$in": ["ordered", "won"]}}},
        {"$lookup": {"from": "payments", "let": {"qid": "$id", "floor": "$floor_id"}, "pipeline": [
            {"$match": {"status": "completed", "$expr": {"$and": [
                {"$eq": ["$quotation_id", "$$qid"]}, {"$eq": ["$floor_id", "$$floor"]},
            ]}}},
            {"$group": {"_id": None, "paid": {"$sum": _decimal("$amount", default=0)}}},
        ], "as": "_payments"}},
        {"$set": {"_in_period": _in_period(window), "_currency": "INR", "_sales_total": _decimal("$grand_total", default=0),
                  "_outstanding": {"$round": [{"$max": [0, {"$subtract": [collection_total_expression(), {"$ifNull": [{"$first": "$_payments.paid"}, 0]}]}]}, 2]}}},
        _identity_stage(),
    ]


def _kitchen_accounts(scope, window):
    requested = scope.get("floor_id", {}).get("$in")
    scope = {**scope, "floor_id": {"$in": ["second-floor"] if requested is None or "second-floor" in requested else []}}
    return [
        *kitchen_referral_pipeline({**scope, "status": "ordered"}, require_referrer=False),
        {"$set": {"_in_period": _in_period(window), "_currency": "INR", "_sales_total": "$_kitchen_total_decimal",
                  "customer_phone": "$customer.phone",
                  "_invalid_money": {"$or": [_invalid_amount("$_kitchen_total_decimal"), _invalid_amount("$_kitchen_paid_decimal")]},
                  "_outstanding": {"$round": [{"$max": [0, {"$subtract": ["$_kitchen_total_decimal", "$_kitchen_paid_decimal"]}]}, 2]}}},
        _identity_stage(),
    ]


def _furniture_accounts(f, floors, window):
    return [
        {"$match": furniture_match(f, floors, (None, None))},
        {"$set": {"_in_period": _in_period(window, date_field="finalized_at", eligible={"$literal": True}),
                  "_currency": "RNB", "_sales_total": _decimal("$total_payable_rmb"), "_balance": _decimal("$balance_rmb"),
                  "ordered_at": "$finalized_at"}},
        {"$set": {"_invalid_money": {"$or": [_invalid_amount("$_sales_total"), _invalid_amount("$_balance", allow_negative=True)]},
                  "_outstanding": {"$round": [{"$max": [0, "$_balance"]}, 2]}}},
        _identity_stage(),
    ]


def account_pipeline(scope: dict, window, *, f=None, floors=None) -> list[dict]:
    """Every selected financial source, with currencies kept separate."""
    pipeline = _catalog_accounts(scope, window)
    if f is not None:
        all_scope = build_match(AnalyticsFilter(floor_id=f.floor_id, status="any"), floors, (None, None))
        requested = filter_values(f.floor_id) if f.floor_id and f.floor_id != "all" else floors
        if requested is None or "second-floor" in requested:
            pipeline.append({"$unionWith": {"coll": "kitchen_projects", "pipeline": _kitchen_accounts(all_scope, window)}})
        if requested is None or "third-floor" in requested:
            pipeline.append({"$unionWith": {"coll": "furniture_quotations", "pipeline": _furniture_accounts(f, floors, window)}})
    customer_group = {"$group": {
        "_id": {"customer": "$_customer_identity", "currency": "$_currency"},
        "customer_id": {"$last": {"$ifNull": ["$customer_id", None]}}, "name": {"$last": "$customer_name"},
        "phone": {"$last": {"$ifNull": ["$customer_phone", None]}}, "floor_ids": {"$addToSet": "$floor_id"},
        "revenue": {"$sum": {"$cond": ["$_in_period", "$_sales_total", 0]}},
        "orders": {"$sum": {"$cond": ["$_in_period", 1, 0]}},
        "outstanding": {"$sum": "$_outstanding"}, "last_order_at": {"$max": "$ordered_at"},
    }}
    qualifying = {"$match": {"$or": [{"orders": {"$gt": 0}}, {"outstanding": {"$gt": 0}}]}}
    return [*pipeline, {"$project": {"_id": 0, "id": 1, "customer_id": 1, "customer_name": 1, "customer_phone": 1,
                                         "floor_id": 1, "ordered_at": 1, "_customer_identity": 1, "_in_period": 1, "_currency": 1,
                                         "_sales_total": 1, "_outstanding": 1, "_invalid_money": 1}}, {"$facet": {
        "money": [{"$group": {"_id": "$_currency", "revenue": {"$sum": {"$cond": ["$_in_period", "$_sales_total", 0]}}, "outstanding": {"$sum": "$_outstanding"}}}],
        "counts": [{"$group": {"_id": None, "orders": {"$sum": {"$cond": ["$_in_period", 1, 0]}},
                              "customers": {"$addToSet": {"$cond": ["$_in_period", "$_customer_identity", None]}},
                              "total_customers": {"$addToSet": "$_customer_identity"},
                              "invalid_money": {"$sum": {"$cond": ["$_invalid_money", 1, 0]}}}},
                   {"$project": {"_id": 0, "orders": 1, "invalid_money": 1,
                                  "customers": {"$size": {"$setDifference": ["$customers", [None, ""]]}},
                                  "total_customers": {"$size": {"$setDifference": ["$total_customers", [None, ""]]}}}}],
        "departments": [{"$group": {"_id": {"floor": "$floor_id", "currency": "$_currency"},
                                   "revenue": {"$sum": {"$cond": ["$_in_period", "$_sales_total", 0]}}, "outstanding": {"$sum": "$_outstanding"},
                                   "orders": {"$sum": {"$cond": ["$_in_period", 1, 0]}},
                                   "customers": {"$addToSet": {"$cond": ["$_in_period", "$_customer_identity", None]}},
                                   "total_customers": {"$addToSet": "$_customer_identity"}}},
                        {"$project": {"_id": 0, "floor_id": "$_id.floor", "currency": "$_id.currency", "revenue": 1, "outstanding": 1, "orders": 1,
                                       "customers": {"$size": {"$setDifference": ["$customers", [None, ""]]}},
                                       "total_customers": {"$size": {"$setDifference": ["$total_customers", [None, ""]]}}}}],
        "customer_count": [{"$match": {"_customer_identity": {"$nin": [None, ""]}}}, customer_group, qualifying, {"$count": "value"}],
        "customers": [{"$match": {"_customer_identity": {"$nin": [None, ""]}}}, {"$sort": {"ordered_at": 1, "id": 1}}, customer_group, qualifying,
                      {"$sort": {"_id.currency": 1, "outstanding": -1, "revenue": -1, "_id.customer": 1}}, {"$limit": ROW_LIMIT},
                      {"$project": {"_id": 0, "key": {"$concat": ["$_id.currency", ":", "$_id.customer"]}, "customer_id": 1, "name": 1, "phone": 1,
                                     "currency": "$_id.currency", "floor_ids": 1, "revenue": 1, "orders": 1, "outstanding": 1, "last_order_at": 1}}],
    }}]


def line_pipeline(match: dict) -> list[dict]:
    tile_unit = {"$toLower": {"$ifNull": ["$items.quantity_unit", "Box"]}}
    unit = {"$cond": [{"$eq": ["$floor_id", "ground-floor"]}, {"$switch": {"branches": [
        {"case": {"$in": [tile_unit, ["box", "boxes"]]}, "then": "Boxes"},
        {"case": {"$in": [tile_unit, ["piece", "pieces", "pc", "pcs"]]}, "then": "Pieces"},
    ], "default": "Unknown unit"}}, "Pieces"]}
    return [
        {"$match": match}, {"$sort": {"ordered_at": 1, "id": 1}}, {"$unwind": "$items"},
        {"$group": {
            "_id": {"product_id": "$items.product_id", "unit": unit},
            "name": {"$last": "$items.name"}, "sku": {"$last": "$items.sku"},
            "revenue": {"$sum": "$items.net_amount"}, "quantity": {"$sum": "$items.qty"},
            "order_ids": {"$addToSet": "$id"}, "customer_ids": {"$addToSet": "$customer_id"},
        }},
        {"$limit": MAX_PRODUCT_UNIT_ROWS + 1},
    ]


def followup_pipeline(scope: dict, now: datetime) -> list[dict]:
    india = timezone(timedelta(hours=5, minutes=30))
    today = now.astimezone(india).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc).isoformat()
    return [
        {"$match": {**scope, "status": {"$in": ["open", "snoozed"]},
                    "category": {"$nin": sorted(POST_ORDER_CATEGORIES)}, "rule_type": {"$nin": sorted(POST_ORDER_RULES)},
                    "purchase_id": {"$in": [None, ""]}, "consolidated_order_id": {"$in": [None, ""]},
                    "completed_outcome": {"$nin": ["lost", "won", "converted"]}}},
        {"$group": {"_id": None, "count": {"$sum": 1}, "overdue": {"$sum": {"$cond": [
            {"$and": [
                {"$eq": [{"$type": "$due_at"}, "string"]}, {"$ne": ["$due_at", ""]}, {"$lt": ["$due_at", today]},
                {"$or": [{"$ne": ["$status", "snoozed"]}, {"$eq": [{"$ifNull": ["$snoozed_until", None]}, None]},
                          {"$lte": ["$snoozed_until", now.isoformat()]}]},
            ]}, 1, 0,
        ]}}}},
    ]


def _money(value) -> float:
    if hasattr(value, "to_decimal"):
        value = value.to_decimal()
    return float(Decimal(str(value or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _quantities(values) -> list[dict]:
    return [{"unit": unit, "quantity": round(quantity, 4)} for unit, quantity in sorted(values.items())]


def shape_products(rows, product_brand, brand_names) -> tuple[list[dict], list[dict], list[dict]]:
    """Aggregate counts before display limits and never add unlike quantities."""
    products, brands = {}, {}
    quantities = defaultdict(float)
    for row in rows:
        identity = row.get("_id") or {}
        product_id, unit = identity.get("product_id"), identity.get("unit") or "Unknown unit"
        quantity = float(row.get("quantity") or 0)
        quantities[unit] += quantity
        brand_id = product_brand.get(product_id) or UNLINKED_BRAND_ID
        brand = brands.setdefault(brand_id, {"revenue": 0, "quantities": defaultdict(float), "order_ids": set(), "product_ids": set()})
        brand["revenue"] += float(row.get("revenue") or 0)
        brand["quantities"][unit] += quantity
        brand["order_ids"].update(row.get("order_ids") or [])
        if not product_id:
            continue
        brand["product_ids"].add(product_id)
        product = products.setdefault(product_id, {
            "product_id": product_id, "name": row.get("name") or "Unnamed product", "sku": row.get("sku"),
            "brand_name": brand_names.get(brand_id), "revenue": 0, "quantities": defaultdict(float),
            "order_ids": set(), "customer_ids": set(),
        })
        product["revenue"] += float(row.get("revenue") or 0)
        product["quantities"][unit] += quantity
        product["order_ids"].update(row.get("order_ids") or [])
        product["customer_ids"].update(value for value in row.get("customer_ids") or [] if value)
    product_rows = [{"product_id": row["product_id"], "name": row["name"], "sku": row["sku"], "brand_name": row["brand_name"],
                     "revenue": _money(row["revenue"]), "quantities": _quantities(row["quantities"]),
                     "orders": len(row["order_ids"]), "customers": len(row["customer_ids"])} for row in products.values()]
    brand_rows = [{"brand_id": key, "name": UNLINKED_BRAND_NAME if key == UNLINKED_BRAND_ID else brand_names.get(key, "Unnamed brand"),
                   "revenue": _money(row["revenue"]), "quantities": _quantities(row["quantities"]),
                   "orders": len(row["order_ids"]), "products": len(row["product_ids"]), "is_unlinked": key == UNLINKED_BRAND_ID}
                  for key, row in brands.items()]
    product_rows.sort(key=lambda row: (-row["revenue"], row["name"], row["product_id"]))
    brand_rows.sort(key=lambda row: (row["is_unlinked"], -row["revenue"], row["name"], row["brand_id"]))
    return product_rows, brand_rows, _quantities(quantities)


async def gather_financial_summary(db, f: AnalyticsFilter, floors, period) -> dict:
    scope = financial_scope(f, floors)
    window = (period.start, period.end)
    match = {**build_match(AnalyticsFilter(floor_id=f.floor_id), floors, window), **scope}
    async def catalog_lines():
        # Kitchen and Furniture have no catalog-line reporting. Avoid sending
        # an additional aggregation to Mongo for a provably empty scope.
        if not scope["floor_id"]["$in"]:
            return []
        return await db.quotations.aggregate(line_pipeline(match)).to_list(MAX_PRODUCT_UNIT_ROWS + 1)

    accounts, lines = await asyncio.gather(
        db.quotations.aggregate(account_pipeline(scope, window, f=f, floors=floors)).to_list(1),
        catalog_lines(),
    )
    if len(lines) > MAX_PRODUCT_UNIT_ROWS:
        raise HTTPException(422, "Choose a narrower date range to report at most 10,000 product and unit combinations")
    account = accounts[0] if accounts else {}
    counts = (account.get("counts") or [{}])[0]
    if counts.get("invalid_money"):
        raise HTTPException(422, "A finalized Kitchen or Furniture record has an invalid amount. Correct it before viewing financial totals.")
    ids = sorted({row["_id"]["product_id"] for row in lines if (row.get("_id") or {}).get("product_id")})
    product_brand, brand_names = await gather_product_brands(db, ids)
    products, brands, quantities = shape_products(lines, product_brand, brand_names)
    customers = account.get("customers") or []
    for customer in customers:
        customer["name"] = customer.get("name") or "Unnamed customer"
        customer["revenue"] = _money(customer.get("revenue"))
        customer["outstanding"] = _money(customer.get("outstanding"))
        customer["floor_ids"] = sorted(customer.get("floor_ids") or [])
    currencies = {row["_id"]: row for row in account.get("money") or []}
    requested = filter_values(f.floor_id) if f.floor_id and f.floor_id != "all" else floors
    selected_floors = [floor for floor in SALES_FLOORS if requested is None or floor in requested]
    department_rows = {row["floor_id"]: row for row in account.get("departments") or []}
    departments = []
    for floor in selected_floors:
        row = department_rows.get(floor, {})
        departments.append({"floor_id": floor, "currency": "RNB" if floor == "third-floor" else "INR",
                            "revenue": _money(row.get("revenue")), "outstanding": _money(row.get("outstanding")),
                            "orders": int(row.get("orders") or 0), "customers": int(row.get("customers") or 0),
                            "total_customers": int(row.get("total_customers") or 0)})
    return {
        "period": {"start": period.start, "end": period.end, "label": period.label},
        "kpis": {"revenue": _money(currencies.get("INR", {}).get("revenue")), "revenue_rnb": _money(currencies.get("RNB", {}).get("revenue")),
                 "orders": int(counts.get("orders") or 0), "customers": int(counts.get("customers") or 0),
                 "total_customers": int(counts.get("total_customers") or 0), "products": len(products),
                 "outstanding": _money(currencies.get("INR", {}).get("outstanding")), "outstanding_rnb": _money(currencies.get("RNB", {}).get("outstanding"))},
        "quantities": quantities, "brands": brands[:ROW_LIMIT], "products": products[:ROW_LIMIT], "customers": customers, "departments": departments,
        "totals": {"brands": len(brands), "products": len(products), "customers": int((account.get("customer_count") or [{}])[0].get("value") or 0)},
        "limit": ROW_LIMIT,
        "coverage": {"sales": "all_departments", "outstanding": "department_ledgers",
                     "sales_available": bool(selected_floors), "products_available": bool(scope["floor_id"]["$in"]), "outstanding_available": bool(selected_floors),
                     "note": "Sales include confirmed Tiles and Sanitary quotations, current confirmed Kitchen orders, and finalized Furniture ledgers. INR and RNB stay separate. Kitchen balances deduct recorded advances only. Product and brand figures cover catalog product lines in Tiles and Sanitary."},
    }


async def gather_followup_summary(db, f: AnalyticsFilter, floors, now: datetime) -> dict:
    scope = build_match(AnalyticsFilter(floor_id=f.floor_id, status="any"), floors, (None, None))
    scope = {"$and": [scope, {"floor_id": {"$ne": "second-floor"}}]}
    rows = await db.followups.aggregate(followup_pipeline(scope, now)).to_list(1)
    return {"followups": int(rows[0].get("count") or 0) if rows else 0,
            "overdue_followups": int(rows[0].get("overdue") or 0) if rows else 0}
