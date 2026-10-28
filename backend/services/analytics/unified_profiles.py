"""Entity and individual-record presentation for the shared sales model."""
from __future__ import annotations

from dataclasses import replace

from fastapi import HTTPException

from services.analytics.unified import (KINDS, dashboard, money, page_rows, period_for,
                                       ranking, record_public, scope_for, select_period, totals)
from services.referrer_identity import referrer_query


async def identity_for(db, q, floors, kind, identity, rows, *, contacts=False):
    scope = scope_for(q, floors)
    collection = {"companies": "brands", "products": "products", "architects": "referrers", "customers": "customers"}[kind]
    match = {"id": identity, "floor_id": scope["floor_id"], "is_deleted": {"$ne": True}}
    if kind == "architects":
        match = referrer_query({"floor_id": scope["floor_id"]}, {"id": identity})
    fields = {"_id": 0, **{key: 1 for key in ("id", "name", "floor_id", "status", "active", "sku", "brand_id", "category_id", "size", "finish", "series", "company", "city", "code")}}
    if contacts:
        fields.update({key: 1 for key in ("phone", "email", "address")})
    doc = await db[collection].find_one(match, fields)
    linked = next((r for r in ranking(rows, kind) if r["id"] == identity), None)
    if not doc and not linked:
        raise HTTPException(404, "This entity is unavailable in your permitted sales scope")
    doc = {**(linked or {}), **(doc or {})}
    if kind == "products":
        doc.setdefault("brand_id", doc.get("company_id"))
        doc.setdefault("category_id", doc.get("category"))
    attributes = [{"label": key.replace("_", " ").capitalize(), "value": doc.get(key)} for key in ("sku", "brand_id", "category_id", "size", "finish", "series", "company", "city") if kind == "products" or doc.get(key) is not None]
    if contacts:
        attributes.extend({"label": key.capitalize(), "value": doc.get(key)} for key in ("phone", "email", "address"))
    return {"id": identity, "kind": kind, "name": doc.get("name") or (linked or {}).get("name") or "Historical identity", "status": doc.get("status") or ("Inactive" if doc.get("active") is False else "Recorded"),
            "floor_ids": linked.get("floor_ids", []) if linked else [doc["floor_id"]] if doc.get("floor_id") else [], "attributes": attributes}


async def profile(db, rows, q, floors, kind, identity, *, contacts=False, table_page=1, table_page_size=25):
    entity = await identity_for(db, q, floors, kind, identity, rows, contacts=contacts)
    report = dashboard(rows, q, floors)
    selected = select_period(rows, q, period_for(q))
    lifetime = totals(select_period(rows, replace(q, date_basis="confirmation", dimension=None), period_for(replace(q, preset="all"))))
    entity["attributes"].extend([
        {"label": "Lifetime confirmed sales (INR)", "value": lifetime["sales"]},
        {"label": "Lifetime confirmed sales (RNB)", "value": lifetime["sales_rnb"]},
        {"label": "Last order date", "value": max((row.get("confirmation_date") or "" for row in rows), default="") or None},
    ])
    if kind == "customers":
        entity["attributes"].extend([
            {"label": "Products purchased", "value": report["kpis"].get("products")},
            {"label": "Current outstanding balance (INR)", "value": report["kpis"].get("outstanding")},
            {"label": "Current outstanding balance (RNB)", "value": report["kpis"].get("outstanding_rnb")},
        ])
    product = next(iter(ranking(selected, "products")), None) if kind == "products" else None
    if kind == "products":
        quantity = product.get("quantity") if product else None
        entity["attributes"].extend([
            {"label": "Quantity sold", "value": quantity}, {"label": "Quantity unit", "value": product.get("unit") if product else None},
            {"label": "Average selling price", "value": money(product["sales"] / quantity) if product and product.get("sales") is not None and quantity else None},
            {"label": "Stock", "value": None},
        ])
    quotes = []
    payments = []
    activity = []
    for row in selected:
        quotes.append({"id": row.get("quotation_id") or row["id"], "order_id": row["id"], "design_id": row.get("design_id"), "number": row["number"], "source": row["source"], "customer_name": row["customer_name"], "floor_id": row["floor_id"], "date": row.get("quotation_date"), "status": "Linked to confirmed order", "currency": row["currency"]})
        payments.extend({**payment, "order_id": row["id"], "source": row["source"], "customer_name": row["customer_name"]} for payment in row["payments"])
        activity.extend({**event, "order_id": row["id"], "source": row["source"]} for event in row["timeline"])
    def paginate(values):
        return page_rows(values, table_page, table_page_size)
    tables = {"orders": paginate([record_public(row) for row in selected]), "quotations": paginate(quotes), "payments": paginate(payments),
              "activity": paginate(activity), "projects": paginate([record_public(row) for row in selected if row["source"] == "kitchen"]),
              "delivery": paginate([{"id": row["id"], "date": row["delivery_date"], "source": row["source"], "customer_name": row["customer_name"]} for row in selected if row.get("delivery_date")]),
              "related_products": paginate([])}
    tables.update({key: paginate(ranking(selected, key)) for key in KINDS if key != "companies"})
    if kind == "products":
        scope = scope_for(q, floors)
        product_doc = await db.products.find_one({"id": identity, "floor_id": scope["floor_id"]}, {"_id": 0, "related_ids": 1})
        related_ids = (product_doc or {}).get("related_ids") or []
        if len(related_ids) > 1000:
            raise HTTPException(422, "Related products exceed 1,000 entries; review the recorded product relationships")
        if related_ids:
            related = await db.products.find({"id": {"$in": related_ids}, "floor_id": scope["floor_id"], "is_deleted": {"$ne": True}}, {"_id": 0, "id": 1, "name": 1, "sku": 1, "brand_id": 1, "floor_id": 1}).to_list(1000)
            tables["related_products"] = paginate(related)
    history = await profile_history(db, q, floors)
    tables["quotations"] = paginate(history["quotations"])
    project_ids = {project["id"] for project in history["projects"]}
    confirmed_projects = [record_public(row) for row in selected if row["source"] == "kitchen" and row["id"] not in project_ids]
    tables["projects"] = paginate([*history["projects"], *confirmed_projects])
    known_activities = {event["id"] for event in history["activity"]}
    tables["activity"] = paginate([*history["activity"], *[event for event in activity if event["id"] not in known_activities]])
    if kind == "companies":
        tables["products"] = await directory(db, rows, q, floors, "products", page=table_page, page_size=table_page_size)
    if kind in {"companies", "architects", "customers"}:
        linked_customers = {row["id"]: row for row in ranking(selected, "customers")}
        for source in [*history["quotations"], *history["projects"]]:
            if source.get("customer_id"):
                linked_customers.setdefault(source["customer_id"], {"id": source["customer_id"], "name": source.get("customer_name") or "Recorded customer", "sales": 0, "sales_rnb": 0, "orders": 0})
        if kind == "architects":
            from services.analytics.unified import MAX_RECORDS, _bounded
            reference_scope = scope_for(q, floors)
            reference_people = await _bounded(db.customers.find({"referrer_id": identity, "floor_id": reference_scope["floor_id"], "is_deleted": {"$ne": True}}, {"_id": 0, "id": 1, "name": 1}), "Linked customers", MAX_RECORDS)
            for customer in reference_people:
                if customer.get("id"):
                    linked_customers.setdefault(customer["id"], {"id": customer["id"], "name": customer.get("name") or "Recorded customer", "sales": 0, "sales_rnb": 0, "orders": 0})
        tables["customers"] = paginate(list(linked_customers.values()))
    if kind in {"products", "companies"}:
        tables["payments"] = paginate([])
        report["coverage"]["notes"].append("Payments are order-wide; allocation of receipts to this company or product is unavailable.")
    report["coverage"]["notes"].append("Quotation history uses actual quotation creation / Kitchen receipt dates within the selected range, including unconfirmed quotations. Amounts are complete quotation totals, not attributed product/company sales; they never enter confirmed-sales KPIs.")
    return {**report, "title": entity["name"], "identity": entity, "tables": tables, "lifetime": lifetime}


def order_detail(row):
    notes = []
    if row["source"] != "catalog":
        notes.append("Catalog product lines are unavailable for this workflow. The recorded project / ledger total is authoritative.")
    if row["source"] == "kitchen":
        notes.append("Payments show the recorded order advance only.")
    if not row.get("delivery_date"):
        notes.append("Delivery / completion date is unavailable.")
    return {**record_public(row), "lines": row["lines"], "payments": row["payments"], "timeline": row["timeline"], "documents": row["documents"],
            "summary": {"subtotal": row["subtotal"], "discount": row["discount"], "total": row["sales"], "collected": row["collected"], "outstanding": row["outstanding"]}, "notes": notes}


async def directory(db, rows, q, floors, kind, *, page=1, page_size=25):
    """Include permitted catalog/contact identities that have no selected sales.

    Sales sorting needs the full bounded identity set; exceeding that bound is an
    explicit failure rather than a truncated catalogue disguised as a total.
    """
    import re
    from services.analytics.unified import MAX_RECORDS, _bounded, sorted_rows
    scope = scope_for(q, floors)
    match = {"floor_id": scope["floor_id"], "is_deleted": {"$ne": True}}
    if kind == "architects":
        match = referrer_query({"floor_id": scope["floor_id"]}, {"type": {"$in": ["architect", "interior_designer"]}})
    if kind == "products":
        for key, value in (("brand_id", q.company_id), ("id", q.product_id), ("category_id", q.category), ("size", q.size), ("finish", q.finish), ("series", q.series)):
            if value:
                match[key] = value
    elif kind == "companies" and q.company_id:
        match["id"] = q.company_id
    elif kind == "customers" and q.customer_id:
        match["id"] = q.customer_id
    elif kind == "architects" and q.architect_id:
        match["id"] = q.architect_id
    collection = {"companies": "brands", "products": "products", "architects": "referrers", "customers": "customers"}[kind]
    selected_performance = ranking(select_period(rows, q, period_for(q)), kind)
    related_filter = any((q.customer_id and kind != "customers", q.architect_id and kind != "architects", q.product_id and kind != "products", q.company_id and kind not in {"companies", "products"}, q.dimension in {"new", "repeat"}))
    if related_filter:
        match = {"$and": [match, {"id": {"$in": [row["id"] for row in selected_performance]}}]}
    if q.search:
        needle = {"$regex": re.escape(q.search), "$options": "i"}
        match = {"$and": [match, {"$or": [{key: needle} for key in ("name", "id", "sku", "company", "code")]}]}
    docs = await _bounded(db[collection].find(match, {"_id": 0, "id": 1, "name": 1, "floor_id": 1, "sku": 1, "brand_id": 1, "category_id": 1, "size": 1, "finish": 1, "series": 1}), "Entity directory", MAX_RECORDS)
    performance = {row["id"]: row for row in selected_performance}
    items = []
    visible_ids = set()
    for doc in docs:
        identity = doc.get("id")
        if not identity:
            continue
        visible_ids.add(identity)
        base = {"id": identity, "name": doc.get("name") or "Recorded identity", "sales": 0, "sales_rnb": 0, "orders": 0, "customers": 0,
                "average_order_value": None, "average_order_value_rnb": None, "floor_ids": [doc["floor_id"]] if doc.get("floor_id") else [],
                "quantity": 0 if kind == "products" else None, "unit": None, "quantities": [], "last_order_date": None}
        items.append({**base, **{key: value for key, value in doc.items() if key != "floor_id"}, **performance.get(identity, {})})
    for identity, row in performance.items():
        if identity in visible_ids:
            continue
        if q.search and q.search.casefold() not in (row["id"] + " " + row["name"]).casefold():
            continue
        items.append({**row, "historical": True})
    return page_rows(sorted_rows(items, q.sort), page, page_size)


async def profile_history(db, q, floors):
    """Quotation history is independent of confirmed-sales admission.

    Quote creation/receipt dates are the meaningful history date, stated in the
    response. A draft can appear here without ever entering confirmed sales.
    """
    import asyncio
    from services.analytics.unified import MAX_RECORDS, _bounded, stamp
    scope = scope_for(q, floors)
    selected_floors = scope["floor_id"]["$in"]
    period = period_for(q)
    bounds = {key: value for key, value in (("$gte", period.start), ("$lt", period.end)) if value}
    shared = {key: value for key, value in (("customer_id", q.customer_id), ("referrer_id", q.architect_id)) if value}
    product_ids = None
    if q.company_id:
        products = await _bounded(db.products.find({"floor_id": scope["floor_id"], "brand_id": q.company_id}, {"_id": 0, "id": 1}), "Company products", MAX_RECORDS)
        product_ids = [product["id"] for product in products]
    async def catalog():
        floors = [floor for floor in selected_floors if floor in {"ground-floor", "first-floor"}]
        if not floors or q.source not in {None, "catalog"}:
            return []
        match = {**scope, **shared, "floor_id": {"$in": floors}}
        if bounds:
            match["created_at"] = bounds
        conditions = []
        for key, value in (("product_id", q.product_id), ("category_id", q.category), ("size", q.size), ("finish", q.finish), ("series", q.series)):
            if value:
                conditions.append({key: value})
        if product_ids is not None:
            conditions.append({"product_id": {"$in": product_ids}})
        if conditions:
            match["items"] = {"$elemMatch": {"$and": conditions}}
        docs = await _bounded(db.quotations.find(match, {"_id": 0, "id": 1, "number": 1, "customer_id": 1, "customer_name": 1, "referrer_id": 1, "referrer_name": 1, "floor_id": 1, "status": 1, "grand_total": 1, "created_at": 1}), "Quotation history", MAX_RECORDS)
        return [{"id": doc["id"], "order_id": doc["id"] if doc.get("status") in {"ordered", "won"} else None, "number": doc.get("number") or doc["id"], "source": "catalog", "floor_id": doc["floor_id"], "customer_id": doc.get("customer_id"), "customer_name": doc.get("customer_name"), "architect_id": doc.get("referrer_id"), "architect_name": doc.get("referrer_name"), "date": stamp(doc.get("created_at")), "status": doc.get("status") or "Unavailable", "quotation_amount": money(doc.get("grand_total")), "currency": "INR"} for doc in docs]
    async def kitchen():
        if "second-floor" not in selected_floors or q.source not in {None, "kitchen"} or any((q.company_id, q.product_id, q.category, q.size, q.finish, q.series)):
            return [], [], []
        docs = await _bounded(db.kitchen_projects.find({**scope, **shared, "floor_id": "second-floor"}, {"_id": 0, "id": 1, "project_reference": 1, "customer_id": 1, "customer.name": 1, "referrer_id": 1, "referrer_name": 1, "stage": 1, "status": 1, "created_at": 1, "quotation_versions": 1, "activity": 1, "work_history": 1}), "Project history", MAX_RECORDS)
        if sum(len(doc.get("quotation_versions") or []) + len(doc.get("activity") or []) + len(doc.get("work_history") or []) for doc in docs) > MAX_RECORDS:
            raise HTTPException(422, "Project histories exceed 20,000 entries; choose a narrower department or entity")
        quotes, projects, kitchen_activity = [], [], []
        for doc in docs:
            quoted = False
            for quote in doc.get("quotation_versions") or []:
                date = stamp(quote.get("received_date") or quote.get("created_at"))
                if not date or (period.start and date < period.start) or (period.end and date >= period.end):
                    continue
                quoted = True
                quotes.append({"id": quote["id"], "project_id": doc["id"], "source": "kitchen", "floor_id": "second-floor", "customer_id": doc.get("customer_id"), "customer_name": (doc.get("customer") or {}).get("name"), "architect_id": doc.get("referrer_id"), "architect_name": doc.get("referrer_name"), "design_id": quote.get("design_version_id"), "date": date, "status": quote.get("response") or "Not recorded", "quotation_amount": money(quote.get("amount")), "currency": "INR"})
            created = stamp(doc.get("created_at"))
            if quoted or (created and (not period.start or created >= period.start) and (not period.end or created < period.end)):
                projects.append({"id": doc["id"], "project_id": doc["id"], "source": "kitchen", "number": doc.get("project_reference") or doc["id"], "floor_id": "second-floor", "customer_id": doc.get("customer_id"), "customer_name": (doc.get("customer") or {}).get("name"), "architect_id": doc.get("referrer_id"), "architect_name": doc.get("referrer_name"), "date": created, "status": doc.get("stage") or doc.get("status") or "Unavailable", "currency": "INR"})
                for index, event in enumerate([*(doc.get("activity") or []), *(doc.get("work_history") or [])]):
                    at = stamp(event.get("at") or event.get("created_at"))
                    if not at or (period.start and at < period.start) or (period.end and at >= period.end):
                        continue
                    label = event.get("action") or event.get("event_type") or event.get("command") or event.get("status")
                    if label:
                        kitchen_activity.append({"id": event.get("id") or f"{doc['id']}:event:{index}", "project_id": doc["id"], "source": "kitchen", "date": at, "name": str(label).replace("_", " ").replace(".", " ")})
        if len(quotes) > MAX_RECORDS:
            raise HTTPException(422, "Kitchen quotation history exceeds 20,000 entries; choose a narrower department or entity")
        return quotes, projects, kitchen_activity
    catalog_quotes, (kitchen_quotes, projects, kitchen_activity) = await asyncio.gather(catalog(), kitchen())
    quotes = catalog_quotes + kitchen_quotes
    catalog_ids = [quote["id"] for quote in catalog_quotes]
    activities = await _bounded(db.activity_events.find({"quotation_id": {"$in": catalog_ids}, "floor_id": scope["floor_id"], **({"created_at": bounds} if bounds else {})}, {"_id": 0, "id": 1, "quotation_id": 1, "created_at": 1, "event_type": 1}), "Activity history", MAX_RECORDS) if catalog_ids else []
    public_activities = [{"id": event["id"], "order_id": event.get("quotation_id"), "source": "catalog", "date": stamp(event.get("created_at")), "name": str(event.get("event_type") or "Recorded activity").replace(".", " ").replace("_", " ")} for event in activities]
    return {"quotations": quotes, "projects": projects, "activity": [*public_activities, *kitchen_activity]}
