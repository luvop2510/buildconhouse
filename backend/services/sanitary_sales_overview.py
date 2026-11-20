"""Sanitary reporting over the saved quote, order, collections and follow-up ledgers."""
from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from itertools import chain
from typing import Literal

from services.analytics.unified import INDIA
from services.canonical_customers import canonical_customer_ids
from services.lead_scope import POST_ORDER_CATEGORIES, POST_ORDER_RULES
from services.payment_totals import completed_payment_totals, recorded_collection_total
from services.purchase_stages import active_quantity_expression, delivery_timestamp_expression
from services.purchase_workspace import delivered_tracker_quantity_expression
from services.sanitary_sales import (
    Basis, GroupUnavailable, Ledger, SalesWindow, Sort, ZERO, coverage_notes,
    customer_key, ordered_documents, sorted_groups,
)
from services.sanitary_sales_source import (
    MAX_RECORDS, SANITARY_FLOOR, SanitarySalesLimitError, _calendar_date,
    _indexed_dates, _projection, _rupees, _stamp, _text, load_records,
)

Section = Literal[
    "draft", "pending", "pending_quotations", "placed", "delivered", "payment_pending", "paid",
    "followups", "outstanding", "delivered_unpaid", "conversion", "architect", "attention", "brand",
]

PREVIEW = 10
AGING = {
    "not_due": "Not yet due",
    "due_today": "Due today",
    "1_30": "1–30 days overdue",
    "31_60": "31–60 days overdue",
    "61_90": "61–90 days overdue",
    "over_90": "Over 90 days overdue",
    "no_due_date": "No payment due date recorded",
}
FOLLOWUP_FIELDS = (
    "id", "customer_id", "customer_name", "due_at", "reason", "quotation_id", "quotation_number",
    "assigned_to_name", "status", "snoozed_until",
)


async def resolve_customers(db, *groups):
    rows = list(chain.from_iterable(groups))
    ids = await canonical_customer_ids(db, (row.get("customer_id") for row in rows))
    for row in rows:
        if row.get("customer_id") in ids:
            row["canonical_customer_id"] = ids[row["customer_id"]]


async def _fulfillment(db, order_ids: list[str]) -> dict:
    if not order_ids:
        return {}
    rows = await db.purchase_orders.aggregate([
        {"$match": {"floor_id": SANITARY_FLOOR, "quotation_id": {"$in": order_ids}, "status": {"$ne": "cancelled"}}},
        {"$unwind": "$items"},
        {"$match": {"items.cancelled": {"$ne": True}}},
        {"$project": {
            "quotation_id": 1, "customer_id": {"$ifNull": ["$items.customer_id", "$customer_id"]},
            "line_id": "$items.quotation_line_id", "product_id": "$items.product_id", "active": active_quantity_expression(),
            "fulfilled": delivered_tracker_quantity_expression(), "date": delivery_timestamp_expression(),
        }},
        {"$group": {
            "_id": {"quotation": "$quotation_id", "customer": "$customer_id"},
            "active": {"$sum": "$active"}, "fulfilled": {"$sum": "$fulfilled"},
            "lines": {"$addToSet": "$line_id"},
            "products": {"$addToSet": "$product_id"},
            "delivered_at": {"$max": {"$cond": [{"$gt": ["$fulfilled", 0]}, "$date", None]}},
        }},
        {"$limit": MAX_RECORDS + 1},
    ], maxTimeMS=8000).to_list(MAX_RECORDS + 1)
    if len(rows) > MAX_RECORDS:
        raise SanitarySalesLimitError("Too many order fulfillment records. Choose a shorter date range.")
    return {(row["_id"]["quotation"], row["_id"].get("customer")): row for row in rows}


async def _followups(db, now: datetime) -> list[dict]:
    today = now.date()
    boundary = datetime.combine(today + timedelta(days=1), time.min, INDIA)
    query = {
        "floor_id": SANITARY_FLOOR, "status": {"$in": ["open", "snoozed"]},
        "deleted_at": None, "is_deleted": {"$ne": True},
        "category": {"$nin": sorted(POST_ORDER_CATEGORIES)}, "rule_type": {"$nin": sorted(POST_ORDER_RULES)},
        "purchase_id": {"$in": [None, ""]}, "consolidated_order_id": {"$in": [None, ""]},
        "completed_outcome": {"$nin": ["lost", "won", "converted"]},
        **_indexed_dates("due_at", None, boundary),
    }
    result = []
    async for row in db.followups.find(query, _projection(FOLLOWUP_FIELDS)).max_time_ms(8000):
        if row["status"] == "snoozed" and row.get("snoozed_until"):
            until = _stamp(row["snoozed_until"])
            if not until or until > now:
                continue
        due = _calendar_date(_stamp(row.get("due_at")))
        if not due or due > today.isoformat() or not _text(row.get("id")):
            continue
        result.append({**row, "due_date": due, "days_overdue": (today - date.fromisoformat(due)).days})
        if len(result) > MAX_RECORDS:
            raise SanitarySalesLimitError("Too many open Sanitary follow-ups for a complete overview.")
    return sorted(result, key=lambda row: (row["due_date"], row["id"]))


@dataclass
class Overview:
    pending: Ledger
    placed: Ledger
    opportunities: Ledger
    followups: list[dict]
    fulfillment: dict
    receipts: dict
    today: date


async def load_overview(db, window: SalesWindow, brand_id: str | None) -> Overview:
    now = datetime.now(INDIA)
    scope = {"start": window.start, "end": window.end, "brand_id": brand_id, "include_pdfs": False}

    async def orders():
        rows = await load_records(db, kind="placed", **scope)
        ids = [row["id"] for row in rows]
        fulfillment, receipts = await asyncio.gather(
            _fulfillment(db, ids), completed_payment_totals(db, ids, floor_id=SANITARY_FLOOR, include_cash=True),
        )
        return rows, fulfillment, receipts

    pending, (placed, fulfillment, receipts), opportunities, followups = await asyncio.gather(
        load_records(db, kind="pending", **scope), orders(),
        load_records(db, kind="opportunities", **scope), _followups(db, now),
    )
    await resolve_customers(db, pending, placed, opportunities, followups)
    return Overview(Ledger(pending), Ledger(placed), Ledger(opportunities), followups, fulfillment, receipts, now.date())


def _stage(doc):
    if doc["status"] in {"ordered", "lost", "rejected"}:
        return doc["status"]
    if doc["status"] == "draft" and not doc["sent_at"]:
        return "draft"
    if doc["sent_at"] or doc["status"] in {"sent", "pending"}:
        return "pending"
    return doc["status"]


def _order_state(doc, data):
    # The fulfillment register counts the remaining active quantities. Require
    # coverage of all explicitly linked quote lines where those links exist.
    row = data.fulfillment.get((doc["id"], doc["customer_id"])) or data.fulfillment.get((doc["id"], None))
    if not row or row["active"] <= 0:
        return "unknown", None
    linked = {value for value in row["lines"] if value}
    expected = doc["fulfillment_line_ids"] - {None}
    expected_products = doc["fulfillment_products"] - {None}
    covered = expected <= linked if linked and expected else bool(expected_products) and expected_products <= set(row["products"])
    if row["fulfilled"] >= row["active"] and covered:
        return "delivered", _calendar_date(_stamp(row["delivered_at"]))
    return ("partial" if row["fulfilled"] else "pending"), None


def _aging(due, today):
    if not due:
        return "no_due_date", None
    days = (today - date.fromisoformat(due)).days
    if days <= 0:
        return ("not_due" if days < 0 else "due_today"), 0
    return ("1_30" if days <= 30 else "31_60" if days <= 60 else "61_90" if days <= 90 else "over_90"), days


def _document(doc, basis, kind=None):
    return {
        "id": doc["id"], "target_type": "quotation", "target_id": doc["id"],
        "number": doc["number"], "date": doc["date"], "status": _stage(doc),
        "customer_id": doc["customer_id"] if doc["customer_identity_known"] else None,
        "customer_name": doc["customer_name"], "value": Ledger([doc]).metrics(basis)["value"],
        "kind": kind or _stage(doc),
    }


def _payment(doc, data, basis):
    receipt = data.receipts.get(doc["id"], {})
    total = recorded_collection_total(doc)
    settled, paid = _rupees(receipt.get("total", 0)), _rupees(receipt.get("cash", 0))
    valid = settled is not None and paid is not None and not receipt.get("invalid_count")
    outstanding = max(ZERO, total - settled) if total is not None and valid else None
    # Historical order import deliberately omitted prior receipts. Its ledger
    # can prove full settlement, but an otherwise positive balance is unknown.
    if doc["historical_order"] and outstanding:
        outstanding = None
    due = _calendar_date(_stamp(doc["payment_due_date"]))
    aging, overdue = _aging(due, data.today)
    order_date = doc["date"] or _calendar_date(_stamp(doc["created_at"]))
    delivery_status, delivered_at = _order_state(doc, data)
    return {
        **_document(doc, basis, "payment"), "target_type": "payment",
        "order_amount": total, "paid": paid if valid and (receipt or not doc["historical_order"]) else None,
        "credits": settled - paid if valid else None, "outstanding": outstanding,
        "payment_due_date": due, "days_overdue": overdue, "aging": aging,
        "age_days": max(0, (data.today - date.fromisoformat(order_date)).days) if order_date else None,
        "age_reference": ("order date" if doc["date"] else "quotation creation") if order_date else None,
        "delivery_status": delivery_status, "delivered_at": delivered_at, "employee": doc["employee"],
    }


def _brand_ledgers(ledger):
    groups = defaultdict(list)
    for doc in ledger.documents:
        lines_by_brand = defaultdict(list)
        for line in doc["lines"]:
            lines_by_brand[line["brand_id"] or "unassigned"].append(line)
        for brand, lines in lines_by_brand.items():
            groups[brand].append({**doc, "lines": lines})
    return {key: Ledger(rows) for key, rows in groups.items()}


def _balances(rows):
    balances = [row["outstanding"] for row in rows if row["outstanding"] is not None]
    missing = len(rows) - len(balances)
    return {
        "value": sum(balances, ZERO) if balances or not rows else None,
        "missing_amounts": missing,
        "order_count": sum(balance > ZERO for balance in balances),
    }


def _customer_groups(pairs):
    groups = {}
    for doc, item in pairs:
        customer_id = item.get("customer_id")
        key = customer_key(doc) if customer_id else (item["target_type"], item["id"])
        group = groups.setdefault(key, {
            "id": f"{item['target_type']}:{item['id']}", "customer_id": customer_id,
            "customer_name": item["customer_name"], "items": [],
        })
        group["items"].append(item)
    return list(groups.values())


def _task(row):
    return {
        "id": row["id"], "target_type": "followup", "target_id": row["id"],
        "customer_id": _text(row.get("customer_id")), "customer_name": row.get("customer_name") or "Unknown customer",
        "number": row.get("quotation_number"), "date": row["due_date"], "due_date": row["due_date"],
        "days_overdue": row["days_overdue"], "reason": row.get("reason"), "employee": row.get("assigned_to_name"),
        "kind": "overdue" if row["days_overdue"] else "due_today",
        "label": "Overdue follow-up" if row["days_overdue"] else "Follow-up due today",
    }


def _converted(doc):
    return doc["status"] == "ordered" and doc["outcome"] != "lost" and bool(doc["lines"])


def _opportunity(doc):
    return doc["source"] != "transfer" and not doc["historical_order"] and bool(doc["lines"]) and (
        bool(doc["sent_at"]) or doc["status"] in {"sent", "pending"} or _converted(doc)
    )


def _architect_rows(pending, placed, payments, basis, order):
    quotations, orders = pending.split("interior"), placed.split("interior")
    rows = []
    for group in sorted(quotations.keys() | orders.keys()):
        unconverted, ordered = quotations.get(group, Ledger([])), orders.get(group, Ledger([]))
        docs = [*unconverted.documents, *ordered.documents]
        rows.append({
            "id": group, "name": docs[0]["interior_name"], "type": docs[0]["interior_type"],
            "customer_count": len(Ledger(docs).customers()),
            "draft_customers": len({customer_key(doc) for doc in unconverted.documents if doc["customer_identity_known"] and _stage(doc) == "draft"}),
            "pending_customers": len({customer_key(doc) for doc in unconverted.documents if doc["customer_identity_known"] and _stage(doc) == "pending"}),
            "order_count": len(ordered.documents), "order_value": ordered.metrics(basis)["value"],
            "outstanding": _balances([payments[doc["id"]] for doc in ordered.documents])["value"],
        })
    field = {"value": "order_value", "orders": "order_count", "customers": "customer_count"}[order]
    return sorted(rows, key=lambda row: (row[field] is None, -(row[field] or 0), row["name"].casefold(), row["id"]))


def _brand_rows(pending, placed, basis, total):
    rows = []
    for brand in sorted(pending.keys() | placed.keys()):
        unconverted, ordered = pending.get(brand, Ledger([])), placed.get(brand, Ledger([]))
        quantities = defaultdict(Decimal)
        for line in ordered.lines():
            if line["quantity"] is not None:
                quantities[line["unit"]] += line["quantity"]
        name = next(chain(ordered.lines(), unconverted.lines()))["brand_name"]
        placed_metrics = ordered.metrics(basis)
        amount = placed_metrics["value"]
        rows.append({
            "id": brand, "name": name, "pending_value": unconverted.metrics(basis)["value"],
            "placed_value": amount, "order_count": placed_metrics["document_count"],
            "quantities": [{"unit": unit, "quantity": quantity} for unit, quantity in sorted(quantities.items())],
            "share": round(amount / total * 100, 1) if amount is not None and total else None,
        })
    return sorted(rows, key=lambda row: (row["placed_value"] is None, -(row["placed_value"] or 0), row["name"].casefold(), row["id"]))


def overview_result(data, basis: Basis, architect_sort: Sort, product_sort: Sort, *, section=None, group_id=None):
    pending, placed = data.pending, data.placed
    stages = {"draft": [], "pending": []}
    for doc in ordered_documents(pending):
        if _stage(doc) in stages:
            stages[_stage(doc)].append(doc)
    ranked_orders = ordered_documents(placed)
    payments_by_id = {doc["id"]: _payment(doc, data, basis) for doc in ranked_orders}
    payments = list(payments_by_id.values())
    delivered = [doc for doc in ranked_orders if payments_by_id[doc["id"]]["delivery_status"] == "delivered"]
    due = sorted((row for row in payments if row["outstanding"]), key=lambda row: (
        -(row["days_overdue"] or 0), row["delivery_status"] != "delivered", -row["outstanding"], row["id"],
    ))
    due_delivered = [row for row in due if row["delivery_status"] == "delivered"]
    paid = [row for row in payments if row["order_amount"] and row["outstanding"] == ZERO]
    opportunities = [doc for doc in ordered_documents(data.opportunities) if _opportunity(doc)]
    followups = [_task(doc) for doc in data.followups]
    def attention():
        quote_rows = [(doc, {**_document(doc, basis, "high_value_quotation"), "label": "High-value unconverted quotation"})
                      for doc in ordered_documents(pending)]
        valuable = [(doc, row) for doc, row in quote_rows if row["value"] and row["value"] > 0]
        valuable.sort(key=lambda pair: (-pair[1]["value"], pair[1]["id"]))
        valuable = valuable[:PREVIEW]
        docs = {doc["id"]: doc for doc in ranked_orders}
        payment_actions = [(docs[row["id"]], {**row, "kind": "delivered_unpaid" if row["delivery_status"] == "delivered" else "payment_overdue"})
                           for row in due if row["delivery_status"] == "delivered" or (row["days_overdue"] or 0) > 30]
        return _customer_groups(chain(zip(data.followups, followups, strict=True), valuable, payment_actions))

    if section:
        if section in stages:
            return [_document(doc, basis, section) for doc in stages[section]]
        if section in {"pending_quotations", "placed", "delivered", "conversion"}:
            docs = {"pending_quotations": pending.documents, "placed": ranked_orders, "delivered": delivered, "conversion": opportunities}[section]
            return [_document(doc, basis, "converted" if section == "conversion" and _converted(doc) else section) for doc in docs]
        if section == "followups":
            return _customer_groups(zip(data.followups, followups, strict=True))
        if section == "attention":
            return attention()
        if section in {"payment_pending", "outstanding", "delivered_unpaid", "paid"}:
            return {"payment_pending": due, "outstanding": due, "delivered_unpaid": due_delivered, "paid": paid}[section]
        if section == "brand":
            pending_brands, placed_brands = _brand_ledgers(pending), _brand_ledgers(placed)
            if group_id not in pending_brands and group_id not in placed_brands:
                raise GroupUnavailable
            return [*(_document(doc, basis, "pending") for doc in ordered_documents(pending_brands.get(group_id, Ledger([])))),
                    *(_document(doc, basis, "placed") for doc in ordered_documents(placed_brands.get(group_id, Ledger([]))))]
        if section == "architect":
            unconverted = pending.split("interior").get(group_id, Ledger([]))
            ordered = placed.split("interior").get(group_id, Ledger([]))
            if not unconverted.documents and not ordered.documents:
                raise GroupUnavailable
            return _customer_groups((doc, _document(doc, basis)) for doc in chain(ordered_documents(ordered), ordered_documents(unconverted)))

    def stage(id, name, docs):
        metrics = Ledger(docs).metrics(basis)
        return {"id": id, "name": name, **metrics}

    placed_metrics, pending_metrics = placed.metrics(basis), pending.metrics(basis)
    aging_groups = defaultdict(list)
    for row in due:
        aging_groups[row["aging"]].append(row)
    overdue = sum(row["days_overdue"] > 0 for row in followups)
    converted = sum(_converted(doc) for doc in opportunities)
    placed_by_id = {doc["id"]: doc for doc in ranked_orders}
    outstanding = {**_balances(payments), "customer_count": len({customer_key(placed_by_id[row["id"]]) for row in due if row["customer_id"]})}
    delivered_unpaid = _balances([payments_by_id[doc["id"]] for doc in delivered])
    notes = list(dict.fromkeys(chain(coverage_notes(pending, basis, pending_metrics), coverage_notes(placed, basis, placed_metrics))))
    notes.extend([
        "Open quotations use quotation date, and placed orders use order date. Draft and Pending customer counts can overlap.",
        "Architect customer counts cover the quotations and placed orders in the selected scope.",
        "Follow-ups count all Sanitary sales tasks due today or earlier. They stay current when sales filters change.",
        "Collections show current whole-order balances for selected orders, including any recorded credits. MRP and Offer Price apply to sales analysis.",
        "Conversion tracks sent or placed quotations created in the period. Revisions count together, and imported orders without quotation history are excluded.",
    ])
    if any(row["delivery_status"] == "unknown" for row in payments):
        notes.append("Some orders lack fulfillment evidence. Delivered totals include orders with confirmed fulfillment.")
    if outstanding["missing_amounts"]:
        notes.append(f"Payment data is incomplete for {outstanding['missing_amounts']} selected order(s). Balances show recorded amounts.")
    if any(doc["historical_order"] and payments_by_id[doc["id"]]["outstanding"] is None for doc in ranked_orders):
        notes.append("Historical order imports omitted earlier receipts. Their remaining balances are unverified until the ledger establishes full settlement.")
    return {
        "kpis": {
            "pending_quotations": pending_metrics, "placed_orders": placed_metrics,
            "draft_customers": len(Ledger(stages["draft"]).customers()),
            "pending_customers": len(Ledger(stages["pending"]).customers()),
            "followups": {"overdue": overdue, "today": len(followups) - overdue,
                          "customer_count": len({customer_key(row) for row in data.followups if _text(row.get("customer_id"))})},
            "outstanding": outstanding, "delivered_unpaid": delivered_unpaid,
            "conversion": {"rate": round(converted / len(opportunities) * 100, 1) if opportunities else None,
                           "converted": converted, "opportunities": len(opportunities)},
        },
        "pipeline": [
            stage("draft", "Draft", stages["draft"]), stage("pending", "Pending", stages["pending"]),
            stage("placed", "Order placed", ranked_orders), stage("delivered", "Delivered", delivered),
            stage("payment_pending", "Payment pending", [placed_by_id[row["id"]] for row in due]),
            stage("paid", "Paid", [placed_by_id[row["id"]] for row in paid]),
        ],
        "brands": _brand_rows(_brand_ledgers(pending), _brand_ledgers(placed), basis, placed_metrics["value"]),
        "architects": _architect_rows(pending, placed, payments_by_id, basis, architect_sort),
        "products": sorted_groups(placed.split("products"), "products", basis, product_sort)[:5],
        "attention": attention()[:PREVIEW],
        "payments": {"items": due[:PREVIEW], "aging": [{"id": id, "name": name, **_balances(aging_groups[id])} for id, name in AGING.items()]},
        "notes": notes,
    }
