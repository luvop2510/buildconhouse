"""One authorized sales read model shared by dashboards, profiles and exports.

Only customer confirmations enter this model. Supplier POs never participate.
The bounded server-side model fails explicitly rather than reporting partial totals.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from fastapi import HTTPException

from services.analytics.filters import AnalyticsFilter, build_match
from services.analytics.kitchen_referrals import kitchen_referral_pipeline
from services.analytics.periods import Period, buckets, previous, resolve

FLOORS = {"ground-floor": "Tiles", "first-floor": "Sanitary / Bathroom", "second-floor": "Kitchen", "third-floor": "Furniture"}
MAX_RECORDS = 20_000
MAX_LINES = 100_000
INDIA = timezone(timedelta(hours=5, minutes=30))
KINDS = ("companies", "products", "architects", "customers")
BASIS = {"confirmation": "confirmation_date", "quotation": "quotation_date", "payment": "payment_dates", "delivery": "delivery_date"}


@dataclass(frozen=True)
class Query:
    floor_id: str = "all"
    preset: str = "this_month"
    date_from: str | None = None
    date_to: str | None = None
    date_basis: str = "confirmation"
    company_id: str | None = None
    product_id: str | None = None
    architect_id: str | None = None
    customer_id: str | None = None
    status: str | None = None
    search: str | None = None
    sort: str = "sales_desc"
    granularity: str = "month"
    category: str | None = None
    size: str | None = None
    finish: str | None = None
    series: str | None = None
    source: str | None = None
    order_id: str | None = None
    dimension: str | None = None
    metric: str | None = None

    def public(self):
        return {key: value for key, value in self.__dict__.items() if value is not None}


def money(value, precision=".01"):
    if value is None:
        return None
    try:
        value = value.to_decimal() if hasattr(value, "to_decimal") else Decimal(str(value))
        if not value.is_finite():
            return None
        return float(value.quantize(Decimal(precision), rounding=ROUND_HALF_UP))
    except (InvalidOperation, TypeError, ValueError):
        return None


def stamp(value):
    if not value:
        return None
    try:
        dt = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return (dt.replace(tzinfo=INDIA) if dt.tzinfo is None else dt).astimezone(timezone.utc).isoformat()
    except (ValueError, TypeError):
        return None


def period_for(q, now=None):
    # Business calendar presets and date-only custom bounds are India-local.
    now = (now or datetime.now(timezone.utc)).astimezone(INDIA)
    preset = {"this_quarter": "quarter", "this_year": "year", "all_time": "all"}.get(q.preset, q.preset)
    if preset == "custom":
        start, end = stamp(q.date_from), stamp(q.date_to)
        if q.date_to and len(q.date_to) == 10:
            end = stamp(datetime.fromisoformat(q.date_to).replace(tzinfo=INDIA) + timedelta(days=1))
        if (q.date_from and not start) or (q.date_to and not end) or (start and end and start >= end):
            raise HTTPException(422, "Choose a valid date range with the end on or after the start")
        return Period(start, end, "Custom range")
    allowed = {"today", "yesterday", "this_week", "this_month", "last_month", "quarter", "year", "all", "last_7_days", "last_30_days", "last_90_days"}
    if preset not in allowed:
        raise HTTPException(422, "Unknown sales period")
    p = resolve(preset, now=now)
    return Period(stamp(p.start), stamp(p.end), p.label)


def scope_for(q, floors):
    scope = build_match(AnalyticsFilter(floor_id=q.floor_id, status="any"), floors, (None, None))
    requested = scope.get("floor_id", {}).get("$in", list(FLOORS))
    if any(floor not in FLOORS for floor in requested):
        raise HTTPException(422, "Unknown sales department")
    return {"floor_id": {"$in": requested}, "is_deleted": {"$ne": True}}


def _project(source):
    common = {"_id": 0, "id": 1, "floor_id": 1, "customer_id": 1, "customer_name": 1,
              "referrer_id": 1, "referrer_name": 1, "referrer_type": 1, "number": 1, "created_at": 1,
              "ordered_at": 1, "grand_total": 1, "items": 1, "status": 1, "subtotal": 1, "discount_total": 1,
              "transportation_fee": 1, "payment_extra_amount": 1, "payment_extra_history": 1,
              "delivery_date": 1, "completed_at": 1, "dispatched_at": 1}
    if source == "kitchen":
        common.update({"number": "$project_reference", "customer_name": "$customer.name", "_order": 1, "_quote": 1, "_design": 1,
                       "installation": 1, "stage": 1, "attachments": 1, "activity": 1, "work_history": 1})
    elif source == "furniture":
        common.update({"finalized_at": 1, "total_payable_rmb": 1, "total_received_rmb": 1, "balance_rmb": 1, "charges": 1, "deposits": 1})
    return {"$project": common}


async def _bounded(cursor, label, limit=MAX_RECORDS):
    docs = await cursor.to_list(limit + 1)
    if len(docs) > limit:
        raise HTTPException(422, f"{label} exceeds {limit:,} records; narrow the department or entity filters")
    return docs


async def load_model(db, q, floors):
    """Filter source collections on the server before materializing a bounded model.

    Date filtering follows normalization because each floor stores its own date and
    payment schema. The cap is explicit and shared by all outputs; never truncate.
    """
    scope = scope_for(q, floors)  # Must run before the first read.
    selected = scope["floor_id"]["$in"]
    if q.source and q.source not in {"catalog", "kitchen", "furniture"}:
        raise HTTPException(422, "Unknown sales source")
    common = {key: value for key, value in (("customer_id", q.customer_id), ("referrer_id", q.architect_id), ("id", q.order_id)) if value}
    company_products = None
    if q.company_id:
        company_products = await _bounded(db.products.find({"brand_id": q.company_id, "floor_id": scope["floor_id"]}, {"_id": 0, "id": 1}), "Company products", MAX_LINES)
    async def catalog():
        if q.source not in {None, "catalog"} or not any(f in selected for f in ("ground-floor", "first-floor")):
            return []
        match = {**scope, **common, "floor_id": {"$in": [f for f in selected if f in ("ground-floor", "first-floor")]}, "status": {"$in": ["ordered", "won"]}}
        if q.product_id:
            match["items.product_id"] = q.product_id
        elif company_products is not None:
            match["items.product_id"] = {"$in": [p["id"] for p in company_products]}
        return [("catalog", d) for d in await _bounded(db.quotations.aggregate([{"$match": match}, _project("catalog"), {"$limit": MAX_RECORDS + 1}], maxTimeMS=8000), "Sales history")]
    async def kitchen():
        if q.source not in {None, "kitchen"} or "second-floor" not in selected or any((q.company_id, q.product_id, q.category, q.size, q.finish, q.series)):
            return []
        match = {**scope, **common, "floor_id": {"$in": ["second-floor"]}, "status": "ordered"}
        pipeline = kitchen_referral_pipeline(match, require_referrer=False)
        if q.order_id:
            pipeline.insert(0, {"$match": {"id": q.order_id}})
        return [("kitchen", d) for d in await _bounded(db.kitchen_projects.aggregate([*pipeline, _project("kitchen"), {"$limit": MAX_RECORDS + 1}], maxTimeMS=8000), "Kitchen history")]
    async def furniture():
        if q.source not in {None, "furniture"} or "third-floor" not in selected or any((q.company_id, q.product_id, q.category, q.size, q.finish, q.series)):
            return []
        match = {**scope, **common, "floor_id": "third-floor", "status": "final", "is_archived": {"$ne": True}, "archived_at": None}
        return [("furniture", d) for d in await _bounded(db.furniture_quotations.aggregate([{"$match": match}, _project("furniture"), {"$limit": MAX_RECORDS + 1}], maxTimeMS=8000), "Furniture history")]
    batches = await asyncio.gather(catalog(), kitchen(), furniture())
    raw = [pair for batch in batches for pair in batch]
    if len(raw) > MAX_RECORDS:
        raise HTTPException(422, "Sales history is too large; choose a department or entity")
    product_ids = list({item.get("product_id") for source, doc in raw for item in doc.get("items") or [] if item.get("product_id")})
    if sum(len(doc.get("items") or []) + len(doc.get("activity") or []) + len(doc.get("work_history") or []) for _, doc in raw) > MAX_LINES:
        raise HTTPException(422, "Sales lines are too large; choose a department, company or product")
    products = await _bounded(db.products.find({"id": {"$in": product_ids}, "floor_id": {"$in": selected}}, {"_id": 0, "id": 1, "name": 1, "sku": 1, "brand_id": 1, "category_id": 1, "size": 1, "finish": 1, "series": 1, "floor_id": 1, "related_ids": 1}), "Products", MAX_LINES) if product_ids else []
    product_map = {p["id"]: p for p in products}
    brand_ids = list({p["brand_id"] for p in products if p.get("brand_id")})
    brands = await _bounded(db.brands.find({"id": {"$in": brand_ids}, "floor_id": {"$in": selected}}, {"_id": 0, "id": 1, "name": 1}), "Companies") if brand_ids else []
    brand_map = {b["id"]: b.get("name") for b in brands}
    catalog_ids = [d["id"] for source, d in raw if source == "catalog"]
    payments = await _bounded(db.payments.find({"quotation_id": {"$in": catalog_ids}, "floor_id": {"$in": selected}, "status": "completed"}, {"_id": 0, "id": 1, "quotation_id": 1, "floor_id": 1, "amount": 1, "paid_at": 1, "created_at": 1, "entry_type": 1, "mode": 1}), "Payments", MAX_LINES) if catalog_ids else []
    by_order = defaultdict(list)
    for payment in payments:
        by_order[(payment.get("floor_id"), payment.get("quotation_id"))].append(payment)
    events = await _bounded(db.activity_events.find({"quotation_id": {"$in": catalog_ids}, "floor_id": {"$in": selected}}, {"_id": 0, "id": 1, "quotation_id": 1, "floor_id": 1, "created_at": 1, "event_type": 1}), "Activity history", MAX_LINES) if catalog_ids else []
    by_event_order = defaultdict(list)
    for event in events:
        by_event_order[(event.get("floor_id"), event.get("quotation_id"))].append(event)
    result = [normalize(source, {**doc, "_events": by_event_order.get((doc.get("floor_id"), doc.get("id")), [])}, product_map, brand_map, by_order.get((doc.get("floor_id"), doc.get("id")), [])) for source, doc in raw]
    return [r for r in result if matches(r, q)]


def normalize(source, doc, products, brands, payments):
    floor = doc["floor_id"]
    order, quote = doc.get("_order") or {}, doc.get("_quote") or {}
    currency = "RNB" if source == "furniture" else "INR"
    total = money(doc.get("total_payable_rmb") if source == "furniture" else order.get("final_amount") if source == "kitchen" else doc.get("grand_total"))
    if total is not None and total < 0:
        total = None
    lines = []
    for index, item in enumerate(doc.get("items") or []):
        product = products.get(item.get("product_id"), {})
        brand_id = item.get("brand_id") or product.get("brand_id")
        lines.append({"id": item.get("id") or f"{doc['id']}:line:{index}", "product_id": item.get("product_id"), "name": item.get("name") or product.get("name") or "Unavailable product name", "sku": item.get("sku") or product.get("sku"),
                      "company_id": brand_id, "company_name": brands.get(brand_id) or item.get("brand_name") or "Unlinked company", "category": item.get("category_id") or product.get("category_id"),
                      "size": item.get("size") or product.get("size"), "finish": item.get("finish") or product.get("finish"), "series": item.get("series") or product.get("series"),
                      "quantity": money(item.get("qty"), ".0001"), "unit": (item.get("quantity_unit") or "Unknown unit") if floor == "ground-floor" else "Pieces",
                      "unit_price": money(item.get("unit_price")), "discount_pct": money(item.get("discount_pct")), "tax": money(item.get("tax_amount")), "sales": money(item.get("net_amount")), "currency": currency})
    if source == "furniture":
        lines = [{"id": charge.get("id") or f"{doc['id']}:charge:{index}", "name": charge.get("description") or "Recorded charge", "product_id": None, "company_id": None, "category": None, "quantity": None, "unit": None, "unit_price": None, "discount": None, "tax": None, "sales": money(charge.get("amount_rmb")), "currency": "RNB"} for index, charge in enumerate(doc.get("charges") or [])]
    if source == "kitchen":
        advance = order.get("advance") or {}
        paid = money(advance.get("amount")) if advance.get("received") is True else 0
        payments = [{"id": f"{order.get('id', doc['id'])}:advance", "amount": paid, "date": stamp(advance.get("date") or advance.get("at")), "mode": "Recorded advance", "currency": "INR"}] if paid else []
    elif source == "furniture":
        paid = money(doc.get("total_received_rmb"))
        payments = [{"id": p.get("id"), "amount": money(p.get("amount_rmb")), "date": stamp(p.get("created_at")), "mode": "Deposit", "currency": "RNB"} for p in doc.get("deposits") or []]
    else:
        paid = _sum_known([{**p, "amount": money(p.get("amount"))} for p in payments if p.get("entry_type", "payment") == "payment"], "amount")
        payments = [{"id": p.get("id"), "amount": money(p.get("amount")), "date": stamp(p.get("paid_at") or p.get("created_at")), "mode": "Credit adjustment" if p.get("entry_type") == "godown_stock_credit" else p.get("mode"), "entry_type": p.get("entry_type") or "payment", "currency": "INR"} for p in payments]
    settled = _sum_known(payments, "amount") if source == "catalog" else paid
    extra_history = doc.get("payment_extra_history")
    extra = _sum_known([{"amount": money(entry.get("amount"))} for entry in extra_history], "amount") if isinstance(extra_history, list) else money(doc.get("payment_extra_amount") or 0)
    outstanding = money(doc.get("balance_rmb")) if source == "furniture" else (money(max(Decimal(0), Decimal(str(total)) + Decimal(str(extra)) - Decimal(str(settled)))) if total is not None and settled is not None and extra is not None else None)
    confirmation = stamp(doc.get("finalized_at") if source == "furniture" else order.get("at") if source == "kitchen" else doc.get("ordered_at"))
    delivery = stamp(doc.get("delivery_date") or doc.get("completed_at") or (doc.get("installation") or {}).get("completion_date"))
    return {"id": doc["id"], "number": doc.get("number") or doc["id"], "source": source, "floor_id": floor, "currency": currency,
            "customer_id": doc.get("customer_id"), "customer_name": doc.get("customer_name") or "Customer identity unavailable",
            "architect_id": doc.get("referrer_id"), "architect_name": doc.get("referrer_name"), "architect_type": doc.get("referrer_type"),
            "quotation_id": quote.get("id") if source == "kitchen" else doc["id"], "design_id": (doc.get("_design") or {}).get("id"), "confirmation_date": confirmation, "quotation_date": stamp(quote.get("created_at") or quote.get("received_date") if source == "kitchen" else doc.get("created_at")),
            "delivery_date": delivery, "payment_dates": [p["date"] for p in payments if p.get("date")], "date": confirmation,
            "status": "confirmed", "source_status": doc.get("status"), "sales": total, "collected": paid, "outstanding": max(0, outstanding) if outstanding is not None else None,
            "lines": lines, "payments": payments, "subtotal": money(doc.get("subtotal")), "discount": money(doc.get("discount_total")),
            "documents": _documents(source, doc), "timeline": _timeline(source, doc, confirmation, delivery, payments)}


def _documents(source, doc):
    if source == "catalog":
        return [{"id": doc["id"], "name": "Customer quotation", "type": "quotation", "url": f"/quotations/{doc['id']}/pdf"}]
    if source == "kitchen":
        # Only metadata and authenticated routes; never storage keys or private URLs.
        return [{"id": a["id"], "name": a.get("filename") or a.get("original_name") or "Project document", "type": a.get("kind") or "document", "url": f"/kitchen-projects/{doc['id']}/attachments/{a['id']}"} for a in doc.get("attachments") or [] if a.get("id")]
    return [{"id": doc["id"], "name": "Furniture ledger", "type": "ledger", "url": f"/furniture-quotations/{doc['id']}/pdf"}]


def _timeline(source, doc, confirmation, delivery, payments):
    result = [{"id": f"{doc['id']}:confirmed", "date": confirmation, "name": "Order confirmed"}]
    result.extend({"id": p["id"], "date": p.get("date"), "name": p.get("mode") or "Payment recorded", "amount": p.get("amount")} for p in payments)
    events = [*(doc.get("_events") or []), *(doc.get("activity") or []), *(doc.get("work_history") or [])]
    for index, event in enumerate(events):
        label = event.get("event_type") or event.get("action") or event.get("command") or event.get("status")
        if label:
            result.append({"id": event.get("id") or f"{doc['id']}:event:{index}", "date": stamp(event.get("created_at") or event.get("at")), "name": str(label).replace(".", " ").replace("_", " ")})
    if delivery:
        result.append({"id": f"{doc['id']}:delivered", "date": delivery, "name": "Delivery / completion recorded"})
    return sorted(result, key=lambda row: row.get("date") or "")


def matching_lines(row, q):
    return [line for line in row["lines"] if all((not value or line.get(field) == value) for field, value in (("company_id", q.company_id), ("product_id", q.product_id), ("category", q.category), ("size", q.size), ("finish", q.finish), ("series", q.series)))]


def matches(row, q):
    if q.status and q.status not in {"all", "any", "confirmed", row.get("source_status")}:
        return False
    if q.architect_id and row.get("architect_id") != q.architect_id:
        return False
    if any((q.company_id, q.product_id, q.category, q.size, q.finish, q.series)) and not matching_lines(row, q):
        return False
    if q.search:
        text = " ".join(str(row.get(k) or "") for k in ("id", "number", "customer_name", "architect_name")) + " " + " ".join(str(line.get(k) or "") for line in row["lines"] for k in ("name", "sku", "company_name"))
        if q.search.casefold() not in text.casefold():
            return False
    return True


def select_period(rows, q, period):
    field = BASIS[q.date_basis]
    result = []
    for row in rows:
        dates = row[field] if field == "payment_dates" else [row[field]]
        selected = [value for value in dates if value and (not period.start or value >= period.start) and (not period.end or value < period.end)]
        if not selected:
            continue
        copy = {**row, "date": min(selected)}
        if q.date_basis == "payment":
            copy["payments"] = [p for p in row["payments"] if p.get("date") in selected and p.get("entry_type", "payment") == "payment"]
            if not copy["payments"]:
                continue
            copy["sales"] = _sum_known(copy["payments"], "amount")
            copy["collected"] = copy["sales"]
            # No approved policy assigns cash receipts to individual product lines.
            copy["lines"] = [{**line, "sales": None} for line in row["lines"]]
        if any((q.company_id, q.product_id, q.category, q.size, q.finish, q.series)):
            copy["lines"] = matching_lines(copy, q)
            copy["sales"] = _sum_known(copy["lines"], "sales")
            # Payments and outstanding are order-wide; do not assign them to one product.
            copy["collected"] = copy["outstanding"] = None
        result.append(copy)
    if q.dimension in {"new", "repeat"}:
        earliest = {}
        for row in rows:
            if row.get("customer_id") and row.get("confirmation_date"):
                earliest[row["customer_id"]] = min(earliest.get(row["customer_id"], row["confirmation_date"]), row["confirmation_date"])
        result = [row for row in result if row.get("customer_id") and ((not period.start or earliest.get(row["customer_id"], "") >= period.start) == (q.dimension == "new"))]
    return result


def _sum_known(rows, field):
    values = [row.get(field) for row in rows]
    if any(value is None for value in values):
        return None
    return money(sum((Decimal(str(value)) for value in values), Decimal(0)))


def totals(rows):
    inr = [r for r in rows if r["currency"] == "INR"]
    rnb = [r for r in rows if r["currency"] == "RNB"]
    sales, sales_rnb = _sum_known(inr, "sales"), _sum_known(rnb, "sales")
    known_customers = {r["customer_id"] for r in rows if r.get("customer_id")}
    lines = [line for r in rows for line in r["lines"]]
    return {"sales": sales, "sales_rnb": sales_rnb, "orders": len(rows), "orders_inr": len(inr), "orders_rnb": len(rnb), "customers": len(known_customers) if all(r.get("customer_id") for r in rows) else None, "known_customers": len(known_customers),
            "average_order_value": money(sales / len(inr)) if sales is not None and inr else None,
            "average_order_value_rnb": money(sales_rnb / len(rnb)) if sales_rnb is not None and rnb else None,
            "collected": _sum_known(inr, "collected"), "outstanding": _sum_known(inr, "outstanding"), "collected_rnb": _sum_known(rnb, "collected"), "outstanding_rnb": _sum_known(rnb, "outstanding"),
            "products": len({line["product_id"] for line in lines if line.get("product_id")}) if not rows or all(r["source"] == "catalog" for r in rows) else None}


def ranking(rows, kind):
    groups = {}
    for row in rows:
        if kind in {"products", "companies"}:
            values = [(line.get("product_id") if kind == "products" else line.get("company_id"), line.get("name") if kind == "products" else line.get("company_name"), line) for line in row["lines"]]
        else:
            key = "customer" if kind == "customers" else "architect"
            values = [(row.get(key + "_id"), row.get(key + "_name"), None)]
        for identity, name, line in values:
            if not identity:
                continue
            if kind == "architects" and row.get("architect_type") not in {None, "architect", "interior_designer"}:
                continue
            group = groups.setdefault(identity, {"id": identity, "name": name or "Historical identity", "_rows": {}, "_lines": [], "_units": defaultdict(Decimal), "_unknown_quantity": False})
            group["_rows"][(row["source"], row["id"])] = row
            if line:
                group["_lines"].append(line)
                if line.get("quantity") is None:
                    group["_unknown_quantity"] = True
                if line.get("quantity") is not None:
                    group["_units"][line["unit"]] += Decimal(str(line["quantity"]))
    result = []
    for group in groups.values():
        members = list(group["_rows"].values())
        summary = totals(members)
        if kind in {"products", "companies"}:
            summary["sales"] = _sum_known(group["_lines"], "sales")
            summary["sales_rnb"] = 0
            summary["average_order_value"] = money(summary["sales"] / len(members)) if summary["sales"] is not None and members else None
            summary["collected"] = summary["outstanding"] = None
        units = dict(group["_units"])
        result.append({"id": group["id"], "name": group["name"], **summary, "floor_ids": sorted({r["floor_id"] for r in members}),
                       "quantities": [{"unit": unit, "quantity": money(value, ".0001")} for unit, value in sorted(units.items())],
                       "quantity": money(next(iter(units.values())), ".0001") if len(units) == 1 and not group["_unknown_quantity"] else None, "unit": next(iter(units)) if len(units) == 1 else None,
                       "last_order_date": max((r.get("confirmation_date") or "" for r in members), default="") or None,
                       **({key: next((line.get(key) for line in group["_lines"] if line.get(key)), None) for key in ("sku", "company_id", "company_name", "category", "size", "finish", "series")} if kind == "products" else {})})
    return sorted(result, key=lambda r: (-(r["sales"] or 0), -(r["sales_rnb"] or 0), r["name"].casefold(), r["id"]))


def record_public(row):
    return {key: row.get(key) for key in ("id", "number", "source", "floor_id", "currency", "customer_id", "customer_name", "architect_id", "architect_name", "date", "confirmation_date", "status", "sales", "collected", "outstanding")}


def sorted_rows(rows, sort):
    if sort in {"name", "name_asc"}:
        return sorted(rows, key=lambda r: ((r.get("name") or r.get("customer_name") or "").casefold(), r["id"]))
    if sort in {"orders", "orders_desc"}:
        return sorted(rows, key=lambda r: (-r.get("orders", 0), r["id"]))
    if sort in {"aov", "aov_desc"}:
        return sorted(rows, key=lambda r: (-(r.get("average_order_value") or 0), r["id"]))
    if sort in {"date", "date_desc", "date_asc"}:
        return sorted(rows, key=lambda r: (r.get("date") or "", r["id"]), reverse=sort != "date_asc")
    if sort == "sales_asc":
        return sorted(rows, key=lambda r: (r.get("sales") or 0, r["id"]))
    return sorted(rows, key=lambda r: (-(r.get("sales") or 0), -(r.get("sales_rnb") or 0), r["id"]))


def page_rows(rows, page=1, page_size=25):
    return {"items": rows[(page - 1) * page_size:page * page_size], "total": len(rows), "page": page, "page_size": page_size}


def dashboard(rows, q, floors, now=None):
    now = now or datetime.now(timezone.utc)
    period = period_for(q, now)
    selected = select_period(rows, q, period)
    prior_period = previous(period)
    prior = select_period(rows, q, prior_period) if prior_period else []
    kpis = totals(selected)
    before = totals(prior)
    kpis["change_pct"] = money((kpis["sales"] - before["sales"]) / before["sales"] * 100) if kpis["sales"] is not None and before["sales"] else None
    permitted = scope_for(q, floors)["floor_id"]["$in"]
    floor_rows = []
    for floor in permitted:
        members = [r for r in selected if r["floor_id"] == floor]
        summary = totals(members)
        currency = "RNB" if floor == "third-floor" else "INR"
        sales = summary["sales_rnb"] if currency == "RNB" else summary["sales"]
        denom = kpis["sales_rnb"] if currency == "RNB" else kpis["sales"]
        floor_rows.append({"id": floor, "floor_id": floor, "name": FLOORS[floor], "currency": currency, "sales": sales, "orders": summary["orders"], "customers": summary["customers"],
                           "average_order_value": summary["average_order_value_rnb"] if currency == "RNB" else summary["average_order_value"], "contribution_pct": money(sales / denom * 100) if sales is not None and denom else None})
    dated = [r["date"] for r in selected if r.get("date")]
    start, end = period.start or min(dated, default=stamp(now)), period.end or stamp(now + timedelta(seconds=1))
    local_start = datetime.fromisoformat(start).astimezone(INDIA).isoformat()
    local_end = datetime.fromisoformat(end).astimezone(INDIA).isoformat()
    periods = [Period(stamp(bucket.start), stamp(bucket.end), bucket.label) for bucket in buckets(local_start, local_end, q.granularity)]
    if len(periods) > 400:
        raise HTTPException(422, "Choose monthly, quarterly or yearly granularity for this range")
    trend = []
    for index, bucket in enumerate(periods):
        part = [r for r in selected if bucket.start <= r["date"] < bucket.end]
        total = totals(part)
        if q.date_basis == "payment":
            part = select_period(rows, q, bucket)
            total = totals(part)
        prev_sales = None
        if prior_period and period.start and period.end:
            delta = datetime.fromisoformat(period.start) - datetime.fromisoformat(prior_period.start)
            prior_start = (datetime.fromisoformat(bucket.start) - delta).isoformat()
            prior_end = (datetime.fromisoformat(bucket.end) - delta).isoformat()
            prev_sales = totals([r for r in prior if prior_start <= r["date"] < prior_end])["sales"]
        trend.append({"id": str(index), "label": bucket.label, "start": bucket.start, "end": bucket.end, "sales": total["sales"], "sales_rnb": total["sales_rnb"], "orders": total["orders"], "previous_sales": prev_sales, **quantity_summary([line for row in part for line in row["lines"]])})
    first = {}
    for row in rows:
        if row.get("customer_id") and row.get("confirmation_date"):
            first[row["customer_id"]] = min(first.get(row["customer_id"], row["confirmation_date"]), row["confirmation_date"])
    customers = {r["customer_id"] for r in selected if r.get("customer_id")}
    new = sum(1 for customer in customers if first.get(customer) and (not period.start or first[customer] >= period.start))
    missing_dates = sum(not (row["payment_dates"] if q.date_basis == "payment" else row[BASIS[q.date_basis]]) for row in rows)
    notes = ["Architect attribution uses the single recorded stable reference ID. Split attribution across several architects is unavailable.", "INR and Furniture RNB are separate currencies; contribution percentages use each currency's own total.", "Customer orders are counted once. Supplier purchase orders and unconfirmed quotations are excluded.", "Products and companies use saved catalog order lines; Kitchen projects and Furniture ledgers have no catalog product attribution.", "Outstanding is the current balance on the selected orders. Collections are recorded receipts, separate from order value.", "Returns and cancellation net-sales accounting, stock, margin and conversion are unavailable in this read model."]
    if any(r["source"] == "kitchen" for r in selected):
        notes.append("Kitchen collections contain only the recorded order advance; other payment history is unavailable.")
    if q.date_basis == "quotation":
        notes.append("Quotation date selects already-confirmed customer orders; unconfirmed quotations are never counted as sales.")
    if q.date_basis == "payment":
        notes.append("The primary measure is cash received by payment date, not confirmed order value. Product allocation of receipts is unavailable.")
    if missing_dates:
        notes.append(f"{missing_dates} confirmed orders have no recorded {q.date_basis} date and are excluded from dated results.")
    if any(r["sales"] is None for r in selected):
        notes.append("Some confirmed amounts are unavailable; affected totals are unavailable rather than treated as zero.")
    if any(not r.get("customer_id") for r in selected):
        notes.append("Orders without stable customer IDs are excluded from distinct customer counts. No identities are merged by name or phone.")
    if any(row.get("collected") is None or row.get("outstanding") is None for row in selected):
        notes.append("Some receipt or balance values are unavailable. Missing or invalid ledger amounts are not treated as zero.")
    if any(any(line["sales"] is None for line in r["lines"]) for r in selected):
        notes.append("Some historical line totals are unavailable; affected company and product values are unavailable.")
    insights = [f"{len(selected)} confirmed customer orders match this selection."]
    top = max((r for r in floor_rows if r["currency"] == "INR" and r["sales"] is not None), key=lambda r: r["sales"], default=None)
    if top and top["sales"]:
        insights.append(f"{top['name']} contributes {top['contribution_pct']}% of selected INR sales.")
    if kpis["change_pct"] is not None:
        insights.append(f"INR confirmed order value changed {kpis['change_pct']}% from the preceding equal period.")
    return {"attribute_breakdowns": attribute_breakdowns(selected), "metric_label": "Collected amount" if q.date_basis == "payment" else "Confirmed sales", "title": "Overall Sales Data" if q.floor_id == "all" else f"{FLOORS.get(q.floor_id, 'Department')} Analysis", "generated_at": now.isoformat(), "period": {"label": period.label, "start": period.start, "end": period.end}, "filters": q.public(), "kpis": kpis, "floors": floor_rows, "trend": trend,
            **{kind: ranking(selected, kind)[:10] for kind in KINDS}, "customer_segments": [{"id": "new", "name": "New purchasing customers", "customers": new}, {"id": "repeat", "name": "Repeat purchasing customers", "customers": len(customers) - new}],
            "coverage": {"notes": notes, "missing_dates": missing_dates, "missing_customer_ids": sum(not r.get("customer_id") for r in selected), "products_available": all(r["source"] == "catalog" for r in selected) and all(line.get("product_id") for r in selected for line in r["lines"])}, "insights": insights}


def entity_query(q, kind, identity):
    return replace(q, **{{"companies": "company_id", "products": "product_id", "architects": "architect_id", "customers": "customer_id"}[kind]: identity})


def quantity_summary(lines):
    units = defaultdict(Decimal)
    unknown = False
    for line in lines:
        if line.get("quantity") is None:
            unknown = True
        else:
            units[line.get("unit") or "Unknown unit"] += Decimal(str(line["quantity"]))
    return {"quantity": money(next(iter(units.values())), ".0001") if len(units) == 1 and not unknown else None,
            "unit": next(iter(units)) if len(units) == 1 else None}


def attribute_breakdowns(rows):
    output = {}
    for dimension in ("category", "size", "finish", "series"):
        grouped = {}
        for row in rows:
            for line in row["lines"]:
                name = line.get(dimension)
                if not name:
                    continue
                group = grouped.setdefault(name, {"lines": [], "orders": set()})
                group["lines"].append(line)
                group["orders"].add((row["source"], row["id"]))
        output[dimension] = sorted([{"id": name, "name": name, "sales": _sum_known(group["lines"], "sales"), "orders": len(group["orders"]), **quantity_summary(group["lines"])} for name, group in grouped.items()], key=lambda r: (-(r["sales"] or 0), r["name"]))[:50]
    return output
