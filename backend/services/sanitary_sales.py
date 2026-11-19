"""Sanitary sales ledgers derived from the same filtered transaction facts."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from hashlib import sha256
import json
from typing import Literal

from services.analytics.unified import INDIA

Report = Literal["pending-company", "pending-interior", "placed-company", "placed-interior", "products", "interior-orders"]
Preset = Literal["all_time", "last_7_days", "last_30_days", "custom"]
Basis = Literal["mrp", "offer"]
Sort = Literal["value", "quantity", "orders", "customers"]

REPORT_TITLES = {
    "pending-company": "Pending Quotations by Company",
    "pending-interior": "Pending Quotations by Interior or Architect",
    "placed-company": "Placed Orders by Company",
    "placed-interior": "Placed Orders by Interior or Architect",
    "products": "Product Performance",
    "interior-orders": "Number of Placed Orders by Interior or Architect",
}
INTERIOR_REPORTS = {"pending-interior", "placed-interior", "interior-orders"}
UNASSIGNED = "unassigned"
ZERO = Decimal("0")


class GroupUnavailable(Exception):
    """A selected report group no longer exists under these filters."""


@dataclass(frozen=True)
class SalesWindow:
    first: date | None = None
    last: date | None = None

    @property
    def start(self) -> str | None:
        return self._utc_midnight(self.first) if self.first else None

    @property
    def end(self) -> str | None:
        return self._utc_midnight(self.last + timedelta(days=1)) if self.last else None

    @staticmethod
    def _utc_midnight(day: date) -> str:
        return datetime.combine(day, time.min, INDIA).astimezone(timezone.utc).isoformat()


def sales_window(
    preset: Preset, date_from: str | None, date_to: str | None, *, now: datetime | None = None,
) -> SalesWindow:
    if preset == "all_time":
        return SalesWindow()
    if preset == "custom":
        if date_from and date_to:
            first, last = date.fromisoformat(date_from), date.fromisoformat(date_to)
            if first <= last and first > date.min and last < date.max:
                return SalesWindow(first, last)
        raise ValueError("Choose a valid start and end date.")
    today = (now or datetime.now(timezone.utc)).astimezone(INDIA).date()
    days = 7 if preset == "last_7_days" else 30
    return SalesWindow(today - timedelta(days=days - 1), today)


def report_sort(report: Report, sort: Sort | None) -> Sort:
    if report == "products":
        allowed, default = {"quantity", "value"}, "quantity"
    elif report == "interior-orders":
        allowed, default = {"orders", "customers", "value"}, "orders"
    else:
        allowed, default = {"value"}, "value"
    if sort and sort not in allowed:
        raise ValueError("This sort order is unavailable for the selected report.")
    return sort or default


@dataclass
class Ledger:
    """A set of canonical documents restricted to their contributing lines."""

    documents: list[dict]

    def lines(self):
        for document in self.documents:
            yield from document["lines"]

    def metrics(self, basis: Basis) -> dict:
        totals = {"mrp": ZERO, "offer": ZERO}
        missing = dict.fromkeys(totals, 0)
        line_count = 0
        for line in self.lines():
            line_count += 1
            for key in totals:
                amount = line[key]
                if amount is None:
                    missing[key] += 1
                else:
                    totals[key] += amount
        values = {
            key: None if line_count and missing[key] == line_count else totals[key]
            for key in totals
        }
        return {
            "value": values[basis], "mrp_value": values["mrp"], "offer_value": values["offer"],
            "missing_value_lines": missing[basis], "missing_mrp_lines": missing["mrp"],
            "missing_offer_lines": missing["offer"],
            "customer_count": len({doc["customer_id"] for doc in self.documents if doc["customer_identity_known"]}),
            "document_count": len({doc["id"] for doc in self.documents}),
        }

    def split(self, dimension: str) -> dict[str, Ledger]:
        grouped = defaultdict(list)
        for document in self.documents:
            if dimension == "products":
                product_lines = defaultdict(list)
                for line in document["lines"]:
                    product_lines[product_key(document, line)].append(line)
                for key, lines in product_lines.items():
                    grouped[key].append({**document, "lines": lines})
            elif dimension == "interior":
                key = document["interior_id"]
                grouped[f"interior:{key}" if key else UNASSIGNED].append(document)
            else:
                key = document["customer_id"]
                grouped[f"customer:{key}" if document["customer_identity_known"] else f"document:{document['id']}"].append(document)
        return {key: Ledger(documents) for key, documents in grouped.items()}

    def brands(self) -> list[str]:
        return sorted({line["brand_name"] for line in self.lines() if line["brand_name"]}, key=str.casefold)

    def statuses(self) -> list[str]:
        return sorted({document["status"] for document in self.documents if document["status"]})


def product_key(document: dict, line: dict) -> str:
    # A catalog ID may refer to multiple sellable finishes or sizes. Keep the
    # recorded variant characteristics and units.
    attributes = [line.get(key) for key in ("variant_id", "sku", "size", "finish", "unit")]
    identity = line["product_id"]
    if not identity and not line.get("variant_id") and not (line["brand_id"] and line["sku"]):
        identity = [document["id"], line["id"]]
    encoded = json.dumps([line["brand_id"], identity, *attributes], ensure_ascii=False)
    return sha256(encoded.encode("utf-8")).hexdigest()


def report_groups(ledger: Ledger, report: Report) -> tuple[str, dict[str, Ledger]]:
    dimension = "products" if report == "products" else "interior" if report in INTERIOR_REPORTS else "customer"
    return dimension, ledger.split(dimension)


def group_row(identity: str, ledger: Ledger, dimension: str, basis: Basis) -> dict:
    document = ledger.documents[0]
    row = {"id": identity, **ledger.metrics(basis), "brands": ledger.brands(), "statuses": ledger.statuses()}
    if dimension == "products":
        lines = list(ledger.lines())
        line = lines[0]
        quantities = [item["quantity"] for item in lines]
        row.update(
            name=line["name"], brand=line["brand_name"], sku=line["sku"], size=line["size"],
            finish=line["finish"], unit=line["unit"], image_url=next((item["image"] for item in lines if item["image"]), None),
            quantity=sum(quantities, ZERO) if all(quantity is not None for quantity in quantities) else None,
        )
    elif dimension == "interior":
        row["name"] = document["interior_name"] if identity != UNASSIGNED else "Unassigned"
    else:
        row["name"] = document["customer_name"]
    return row


def sorted_groups(groups: dict[str, Ledger], dimension: str, basis: Basis, sort: Sort) -> list[dict]:
    field = {"quantity": "quantity", "value": "value", "orders": "document_count", "customers": "customer_count"}[sort]
    rows = [group_row(identity, ledger, dimension, basis) for identity, ledger in groups.items()]

    def rank(row: dict):
        value = row[field]
        return value is None, -value if value is not None else ZERO, row["name"].casefold(), row["id"]

    return sorted(rows, key=rank)


def line_row(line: dict, basis: Basis) -> dict:
    return {
        **{key: line[key] for key in ("id", "name", "sku", "size", "finish", "unit", "quantity")},
        "brand": line["brand_name"], "mrp_value": line["mrp"], "offer_value": line["offer"], "value": line[basis],
    }


def ordered_documents(ledger: Ledger) -> list[dict]:
    return sorted(ledger.documents, key=lambda doc: (doc["date"] or "", doc["number"], doc["id"]), reverse=True)


def document_row(document: dict, basis: Basis) -> dict:
    ledger = Ledger([document])
    return {
        "id": document["id"], "name": document["number"], "number": document["number"],
        "customer_name": document["customer_name"], "contact": document["phone"],
        "date": document["date"], "status": document["status"], "quotation_id": document["id"],
        "quotation_number": document["number"], "quotation_date": document["quotation_date"],
        "pdf_available": document["pdf_available"], "brands": ledger.brands(), **ledger.metrics(basis),
        "items": [line_row(line, basis) for line in document["lines"]],
    }


def coverage_notes(ledger: Ledger, basis: Basis, metrics: dict, *, both_prices: bool = False) -> list[str]:
    notes = []
    missing = metrics["missing_value_lines"]
    if missing:
        label = "MRP" if basis == "mrp" else "Offer Price"
        notes.append(f"{label} is unavailable for {missing:,} line(s). Values with partial pricing show the recorded subtotal.")
    other = "offer" if basis == "mrp" else "mrp"
    if both_prices and metrics[f"missing_{other}_lines"]:
        label = "MRP" if other == "mrp" else "Offer Price"
        missing_other = metrics[f"missing_{other}_lines"]
        notes.append(f"{label} is unavailable for {missing_other:,} line(s).")
    if any(not doc["customer_identity_known"] for doc in ledger.documents):
        notes.append("Customer counts include records with a linked customer identity.")
    if any(not doc["date"] for doc in ledger.documents):
        notes.append("Records without a saved date appear in All time.")
    return notes


def report_page(
    ledger: Ledger, report: Report, basis: Basis, sort: Sort, *, group_id: str | None,
    customer_id: str | None, page: int, page_size: int,
) -> dict:
    dimension, groups = report_groups(ledger, report)
    first = (page - 1) * page_size
    last = first + page_size
    if group_id is None:
        level = "groups"
        rows = sorted_groups(groups, dimension, basis, sort)
    else:
        if group_id not in groups:
            raise GroupUnavailable
        ledger = groups[group_id]
        level = "documents"
        if dimension == "interior":
            customers = ledger.split("customer")
            if customer_id is None:
                level = "customers"
                rows = sorted_groups(customers, "customer", basis, "value")
            elif customer_id in customers:
                ledger = customers[customer_id]
            else:
                raise GroupUnavailable
        if level == "documents":
            rows = ordered_documents(ledger)
    items = rows[first:last]
    if level == "documents":
        items = [document_row(document, basis) for document in items]
    totals = ledger.metrics(basis)
    return {
        "level": level, "items": items, "total": len(rows), "totals": totals,
        "notes": coverage_notes(ledger, basis, totals, both_prices=report == "products"),
    }
