"""Authorized, bounded read model for the existing Follow-ups workspace."""
from __future__ import annotations

import asyncio
import re
from calendar import monthrange
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Literal

from fastapi import HTTPException
from pymongo.errors import ExecutionTimeout

from access_profiles import profile_allows_request
from auth import accessible_floor_ids, authorize_staff_resource
from models import QuotationLineItem, RoomDiscountCfg
from services import lead_scope
from services.canonical_customers import LIVE_CUSTOMER, canonical_customer_ids, identity_group_token, normalized_phone
from services.followup_engine import IST, parse_iso
from services.pricing import net_amount_list
from services.sanitary_sales_source import PRINTED_DATE_FORMATS

Category = Literal["all", "today", "overdue", "upcoming", "completed", "won", "lost", "created", "active", "outcomes"]
Scope = Literal["all", "work"]
Period = Literal["all_time", "today", "this_week", "last_week", "last_7_days", "this_month",
                 "last_month", "last_30_days", "last_3_months", "last_6_months", "custom"]
CATEGORIES = ("today", "overdue", "upcoming", "completed", "won", "lost", "created")
ACTIVE = ("today", "overdue", "upcoming")
FLOORS = ("ground-floor", "first-floor", "third-floor")
NO_ASSIGNEE = "unassigned"
RECORD_LIMIT = 20_000
PAGE_RECORD_LIMIT = 1_000
MAX_QUOTE_LINES = 120_000
BATCH = 500
PAISE = Decimal("0.01")
UNAVAILABLE = "This Follow-ups view exceeds its reporting limit. Narrow the dates, customer or department."

FOLLOWUP_FIELDS = """id floor_id customer_id customer_name customer_phone quotation_id quotation_number
assigned_to assigned_to_name assignments due_at completed_at completed_outcome status notebook_status
consolidated_order_id consolidated_order_floor_id is_converted converted_at quotation_price
latest_note notes latest_response resolution_note lost_reason reason""".split()
QUOTE_FIELDS = """id floor_id customer_id customer_name phone_snapshot number doc_number doc_type
created_at quotation_created_at historical_import.batch_id quotation_import.batch_id doc_date status customer_outcome
outcome_at outcome_reason ordered_at created_by created_by_name grand_total project_discount_pct
category_discounts room_discounts items.id items.brand_id items.brand_name items.product_id items.sku
items.name items.qty items.unit_price items.net_amount items.discount_pct items.category_id items.room""".split()
FURNITURE_FIELDS = """id floor_id customer_id customer_name customer_phone created_at created_by
total_payable_rmb""".split()


def report_date(value) -> date | None:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, str) and len(value) == 10:
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None
    stamp = value if isinstance(value, datetime) else parse_iso(value) if isinstance(value, str) else None
    return (stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)).astimezone(IST).date() if stamp else None


def _month_back(day: date, months: int) -> date:
    year, month = divmod(day.year * 12 + day.month - 1 - months, 12)
    return date(year, month + 1, min(day.day, monthrange(year, month + 1)[1]))


def period_bounds(period: Period, today: date, start: date | None, end: date | None):
    """Inclusive India-calendar bounds; week begins on Monday."""
    if period == "custom":
        if start is None or end is None or start > end:
            raise HTTPException(422, "Choose a valid start and end date.")
        return start, end
    monday = today - timedelta(days=today.weekday())
    first = today.replace(day=1)
    next_month = (first + timedelta(days=32)).replace(day=1)
    return {
        "all_time": (None, None),
        "today": (today, today),
        "this_week": (monday, monday + timedelta(days=6)),
        "last_week": (monday - timedelta(days=7), monday - timedelta(days=1)),
        "last_7_days": (today - timedelta(days=6), today),
        "this_month": (first, next_month - timedelta(days=1)),
        "last_month": (_month_back(first, 1), first - timedelta(days=1)),
        "last_30_days": (today - timedelta(days=29), today),
        "last_3_months": (_month_back(today, 3) + timedelta(days=1), today),
        "last_6_months": (_month_back(today, 6) + timedelta(days=1), today),
    }[period]


def _coarse_window(field_name, bounds):
    # Mongo can use ISO prefix ranges before exact India date checks. Keep
    # missing and malformed history in scope for the missing-date disclosure.
    start, end = bounds
    if not start or not end:
        return {}
    string_bounds = {
        "$gte": date.fromordinal(max(start.toordinal() - 1, 1)).isoformat(),
        "$lte": date.fromordinal(min(end.toordinal() + 1, date.max.toordinal())).isoformat() + "\uffff",
    }
    return {"$or": [{field_name: string_bounds}, {field_name: {"$not": {"$regex": r"^\d{4}-\d\d-\d\d"}}}]}


async def _bounded(collection, query, fields, *, cap=RECORD_LIMIT):
    if not query:
        return []
    cursor = collection.find(query, {"_id": 0, **dict.fromkeys(fields, 1)}).max_time_ms(5_000).limit(cap + 1)
    rows, line_count = [], 0
    try:
        async for row in cursor:
            line_count += len(row.get("items") or [])
            if len(rows) == cap or line_count > MAX_QUOTE_LINES:
                raise HTTPException(422, UNAVAILABLE)
            rows.append(row)
    except ExecutionTimeout as exc:
        raise HTTPException(422, UNAVAILABLE) from exc
    finally:
        await cursor.close()
    return rows


async def _related(collection, keys, fields, *, field_name="id", extra=None):
    """Read exact floor-bound links in chunks without a cross-floor ID join."""
    by_floor = defaultdict(set)
    for floor, identity in keys:
        if floor and identity:
            by_floor[floor].add(identity)
    queries = []
    for floor, identities in by_floor.items():
        ids = sorted(identities)
        queries.extend({"floor_id": floor, field_name: {"$in": ids[offset:offset + BATCH]}, **(extra or {})}
                       for offset in range(0, len(ids), BATCH))
    # Bound concurrent connections and total result rows across input batches.
    found = 0
    for offset in range(0, len(queries), 6):
        for batch in await asyncio.gather(*(_bounded(collection, query, fields) for query in queries[offset:offset + 6])):
            found += len(batch)
            if found > RECORD_LIMIT:
                raise HTTPException(422, UNAVAILABLE)
            for row in batch:
                yield row


async def _authorized_departments(database, user):
    permitted = accessible_floor_ids(user)
    candidates = [floor for floor in FLOORS if permitted is None or floor in permitted]
    return await _bounded(database.floors, {"id": {"$in": candidates}, "active": {"$ne": False}}, ["id", "name"], cap=10)


async def _can_read_quotes(user, floor):
    path = "/api/furniture-quotations" if floor == "third-floor" else "/api/quotations"
    if not profile_allows_request(user.access_profile, "GET", path):
        return False
    try:
        await authorize_staff_resource(user, method="GET", path=path, floor_id=floor)
    except HTTPException as exc:
        if exc.status_code == 403:
            return False
        raise
    return True


def _money(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        amount = Decimal(str(value))
        return amount.quantize(PAISE) if amount.is_finite() else None
    except InvalidOperation:
        return None


def _brand_values(doc, products, brand_names):
    """Use saved net line prices, with pricing-service fallback for old snapshots."""
    lines = doc.get("items") or []
    saved = [_money(line.get("net_amount")) for line in lines]
    if any(value is None for value in saved) and all(
        line.get("qty") is not None and line.get("unit_price") is not None for line in lines
    ):
        try:
            repriced = net_amount_list(
                [QuotationLineItem(**line) for line in lines],
                doc.get("project_discount_pct") or 0,
                doc.get("category_discounts") or {},
                {room: RoomDiscountCfg(**value) for room, value in (doc.get("room_discounts") or {}).items()},
            )
            saved = [amount if amount is not None else _money(value) for amount, value in zip(saved, repriced, strict=True)]
        except (TypeError, ValueError, ArithmeticError, AttributeError):
            pass
    totals = {}
    for line, amount in zip(lines, saved, strict=True):
        product = products.get((doc["floor_id"], line.get("product_id")), {})
        brand_id = line.get("brand_id") or product.get("brand_id")
        if brand_id:
            brand_names.setdefault(brand_id, line.get("brand_name") or brand_id)
            prior = totals.get(brand_id, Decimal(0))
            totals[brand_id] = prior + amount if prior is not None and amount is not None else None
    return totals


def _outcome(quote):
    explicit = quote.get("customer_outcome")
    if explicit in {"won", "lost"}:
        return explicit
    status = quote.get("status")
    if status in {"ordered", "won"}:
        return "won"
    if status in {"lost", "rejected"}:
        return "lost"
    return None


def _first_day(*values):
    return next((day for value in values if (day := report_date(value)) is not None), None)


def _created_day(quote, legacy_tile_evidence):
    if quote.get("doc_type") == "tiles_quotation":
        # Legacy Selection-to-Quotation transitions changed the same document.
        # Use durable provenance only; a later edit never dates creation.
        return _first_day(quote.get("quotation_created_at"), legacy_tile_evidence.get(doc_key(quote)))
    if quote.get("quotation_import"):
        # The import write time belongs to the batch, not the original PDF.
        printed = quote.get("doc_date")
        if isinstance(printed, str):
            for fmt in PRINTED_DATE_FORMATS:
                try:
                    return datetime.strptime(printed.strip(), fmt).date()
                except ValueError:
                    continue
        return None
    return report_date(quote.get("created_at"))


def doc_key(row):
    return row["floor_id"], row["id"]


def _assigned(row):
    names = {}
    if row.get("assigned_to"):
        names[row["assigned_to"]] = row.get("assigned_to_name")
    for assignment in row.get("assignments") or []:
        if assignment.get("floor_id") == row["floor_id"] and assignment.get("user_id"):
            names.setdefault(assignment["user_id"], assignment.get("user_name"))
    return names


def _task_outcome(task):
    outcome = task.get("completed_outcome") or task.get("notebook_status")
    return outcome if outcome in {"won", "lost"} else None


def _task_category(task, quote, due_day, today):
    outcome = _task_outcome(task)
    if outcome:
        if quote and _outcome(quote):
            return None  # represented once by the source quotation report
        if task.get("consolidated_order_id") and task.get("consolidated_order_floor_id") != task["floor_id"]:
            return None  # another department's sale may not be attributed here
        return outcome
    if task.get("status") not in {"open", "snoozed"}:
        return "completed" if task.get("status") in {"done", "dismissed"} else None
    if quote and (_outcome(quote) or quote.get("status") == "cancelled"):
        return None  # reconciliation can run after the commercial write commits
    if due_day is None:
        return "all"
    return "today" if due_day == today else "overdue" if due_day < today else "upcoming"


@dataclass
class Record:
    fields: dict
    category: str
    day: date | None
    customer_id: str | None
    display_name: str
    phone: str | None
    assigned: dict
    quote_key: tuple | None
    currency: str
    value: Decimal | None
    brands: dict = field(default_factory=dict)
    identity: str = ""

    def amount(self, brand):
        return self.brands.get(brand) if brand else self.value

    def public(self, brand, names, staff):
        primary_id = self.fields.get("assigned_to")
        return {
            **self.fields, "date": self.day.isoformat() if self.day else None,
            "assigned_to_name": staff.get(primary_id) or self.assigned.get(primary_id),
            "assigned": [{"id": employee, "name": staff.get(employee) or name} for employee, name in self.assigned.items()],
            "customer_id": self.customer_id, "customer_name": self.display_name, "customer_phone": self.phone,
            "brands": [{"id": identity, "name": names[identity]} for identity in self.brands],
            "currency": self.currency,
            "value": float(amount) if (amount := self.amount(brand)) is not None else None,
        }


def _quote_record(doc, category, day, linked, brands, *, furniture=False):
    assigned = {}
    for row in linked:
        assigned.update(_assigned(row))
    # A placed order is credited to the recorded quotation creator by the
    # existing Won orders workflow. Preserve linked assignments for filtering.
    creator = doc.get("created_by")
    if creator and (not assigned or category == "won"):
        assigned.setdefault(creator, doc.get("created_by_name"))
    display = creator if category == "won" and creator else next(iter(assigned), None)
    return Record(
        {"id": doc["id"], "kind": "quotation", "floor_id": doc["floor_id"],
         "quotation_id": doc["id"], "quotation_number": doc.get("doc_number") or doc.get("number"),
         "status": category, "doc_type": "furniture" if furniture else doc.get("doc_type") or "standard",
         "assigned_to": display, "lost_reason": doc.get("outcome_reason") if category == "lost" else None},
        category, day, doc.get("customer_id"), doc.get("customer_name") or "Customer",
        doc.get("customer_phone") or doc.get("phone_snapshot"), assigned, doc_key(doc),
        "RNB" if furniture else "INR",
        _money(doc.get("total_payable_rmb") if furniture else doc.get("grand_total")), brands,
    )


def _task_record(task, quote, brands, category, day):
    assigned = _assigned(task)
    return Record(
        {"id": task["id"], "kind": "followup", "floor_id": task["floor_id"],
         "quotation_id": task.get("quotation_id"),
         "quotation_number": (quote or {}).get("doc_number") or task.get("quotation_number") or (quote or {}).get("number"),
         "due_at": task["due_at"].isoformat() if isinstance(task.get("due_at"), datetime) else task.get("due_at"),
         "status": category if category in {"won", "lost", "created"} else task.get("status"),
         "assigned_to": next(iter(assigned), None),
        "notes": task.get("latest_note") or task.get("notes") or task.get("latest_response") or task.get("resolution_note"),
         "lost_reason": task.get("lost_reason"), "doc_type": (quote or {}).get("doc_type"), "reason": task.get("reason")},
        category, day, task.get("customer_id"), task.get("customer_name") or "Customer", task.get("customer_phone"),
        assigned, doc_key(quote) if quote else doc_key(task) if task.get("is_converted") else None, "INR",
        _money(quote.get("grand_total") if quote else task.get("quotation_price") if task.get("is_converted") else None),
        brands,
    )


def _metric(records, brand=None):
    amounts = defaultdict(Decimal)
    seen = set()
    missing_values = 0
    for row in records:
        key = row.quote_key
        if key is None or key in seen:
            continue
        seen.add(key)
        value = row.amount(brand)
        if value is None:
            missing_values += 1
        else:
            amounts[row.currency] += value
    return {
        "count": len(records), "customers": len({row.identity for row in records}),
        "amounts": [{"currency": currency, "value": float(amount)} for currency, amount in sorted(amounts.items())],
        "missing_dates": sum(row.day is None for row in records),
        "missing_values": missing_values,
    }


def _schedule(rows, first_day, brand):
    upcoming = defaultdict(list)
    for row in rows:
        upcoming[row.day].append(row)
    return [
        {"day": day.isoformat(), **_metric(upcoming[day], brand)}
        for offset in range(7) if (day := first_day + timedelta(days=offset))
    ]


def _employee_summary(rows, staff, brand):
    grouped = defaultdict(list)
    for row in rows:
        for employee in row.assigned or {NO_ASSIGNEE: "Unassigned"}:
            grouped[employee].append(row)
    return [
        {"id": employee, "name": staff[employee],
         **{category: sum(row.category == category for row in records) for category in ACTIVE},
         "amounts": _metric(records, brand)["amounts"]}
        for employee, records in sorted(grouped.items(), key=lambda pair: (staff[pair[0]].casefold(), pair[0]))
    ]


def _brand_summary(rows, names, selected_brand):
    grouped = defaultdict(lambda: {"won": [], "lost": []})
    for row in rows:
        if row.category in {"won", "lost"}:
            for brand in row.brands:
                if not selected_brand or brand == selected_brand:
                    grouped[brand][row.category].append(row)
    return [
        {"id": brand, "name": names[brand], "won": len(outcomes["won"]), "lost": len(outcomes["lost"]),
         "won_amounts": _metric(outcomes["won"], brand)["amounts"], "lost_amounts": _metric(outcomes["lost"], brand)["amounts"],
         "missing_values": sum(_metric(value, brand)["missing_values"] for value in outcomes.values())}
        for brand, outcomes in sorted(grouped.items(), key=lambda pair: (names[pair[0]].casefold(), pair[0]))
    ]


def _and(*conditions):
    clauses = [clause for clause in conditions if clause]
    return {"$and": clauses} if len(clauses) > 1 else clauses[0] if clauses else {}


def _floor_ids(keys):
    by_floor = defaultdict(list)
    for floor, identity in keys:
        by_floor[floor].append(identity)
    return [{"floor_id": floor, "customer_id": {"$in": values}} for floor, values in by_floor.items()]


def _phone_terms(term):
    if not re.fullmatch(r"[+\d(). -]+", term):
        return ()
    digits = re.sub(r"\D", "", term)
    return tuple(dict.fromkeys(value for value in (digits, normalized_phone(term)) if value))


def _text_search(term, name, phone_names, *, other_names=(), customer_selectors=()):
    if not term:
        return {}
    literal = {"$regex": re.escape(term), "$options": "i"}
    digits = _phone_terms(term)
    phone_term = {"$regex": "|".join(r"\D*".join(value) for value in digits)} if digits else literal
    return {"$or": [{name: literal}, *({key: literal} for key in other_names),
                    *({key: phone_term} for key in phone_names), *customer_selectors]}


def _matches_search(row, term):
    if not term:
        return True
    strings = (row.display_name, row.phone, row.fields.get("quotation_number"))
    if any(term.casefold() in str(value or "").casefold() for value in strings):
        return True
    digits = re.sub(r"\D", "", row.phone or "")
    return any(value in digits for value in _phone_terms(term))


def _assignment_filter(row, employee):
    return not employee or (not row.assigned if employee == NO_ASSIGNEE else employee in row.assigned)


def _in_period(day, bounds):
    start, end = bounds
    return (start is None and end is None) if day is None else (start is None or start <= day <= end)


def _group_page(records, page, page_size, brand, brand_names, staff):
    grouped = defaultdict(list)
    for row in sorted(records, key=lambda row: (row.day is None, row.day or date.max, row.fields["floor_id"], row.fields["id"])):
        grouped[row.identity].append(row)
    offset = (page - 1) * page_size
    selected = list(grouped.items())[offset:offset + page_size]
    if sum(len(rows) for _, rows in selected) > PAGE_RECORD_LIMIT:
        raise HTTPException(422, "Too many follow-ups on this page. Narrow the dates or customer.")
    items = []
    for identity, rows in selected:
        first = rows[0]
        items.append({
            "key": identity_group_token(identity), "customer_id": first.customer_id, "customer_name": first.display_name,
            "customer_phone": first.phone, "records": [row.public(brand, brand_names, staff) for row in rows],
        })
    return items, len(grouped) > offset + page_size


async def _tile_creation_evidence(database, docs):
    pending = {doc_key(doc): doc.get("customer_id") for doc in docs
               if doc.get("doc_type") == "tiles_quotation" and not doc.get("quotation_created_at")}
    evidence = {}
    events = {"event_type": "walkin.quotation_created", "entity_type": "walkin"}
    fields = ["floor_id", "quotation_id", "customer_id", "created_at"]
    async for row in _related(database.activity_events, pending, fields, field_name="quotation_id", extra=events):
        key = (row["floor_id"], row["quotation_id"])
        day = report_date(row.get("created_at"))
        if day and pending.get(key) and pending[key] == row.get("customer_id") and (key not in evidence or day < evidence[key]):
            evidence[key] = day
    # Legacy Walk-in transitions wrote this event without a floor. Accept it
    # only for an already-authorized Ground quote with an exact customer link.
    legacy = [identity for (floor, identity), customer in pending.items()
              if floor == "ground-floor" and customer and (floor, identity) not in evidence]
    for offset in range(0, len(legacy), BATCH):
        rows = await _bounded(database.activity_events, {
            **events, "floor_id": None, "quotation_id": {"$in": legacy[offset:offset + BATCH]},
        }, fields)
        for row in rows:
            key = "ground-floor", row["quotation_id"]
            day = report_date(row.get("created_at"))
            if day and pending[key] == row.get("customer_id") and (key not in evidence or day < evidence[key]):
                evidence[key] = day
    # The creation receipt stores the original builder kind. Its updated_at
    # naming denotes the original create response revision, not a later edit.
    async for row in _related(database.settings, pending.keys() - evidence.keys(),
                              ["floor_id", "quotation_id", "source_updated_at"],
                              field_name="quotation_id", extra={"kind": "tile_draft_receipt", "source_doc_type": "tiles_quotation"}):
        key = (row["floor_id"], row["quotation_id"])
        if day := report_date(row.get("source_updated_at")):
            evidence[key] = day
    return evidence


def _earliest_task_outcome(doc, tasks, outcome):
    # Imports can carry an outcome without a timestamp. A later reminder
    # closure is not evidence of the time the imported document was won/lost.
    if doc.get("quotation_import") or doc.get("historical_import"):
        return None
    return min((day for task in tasks if _task_outcome(task) == outcome
                if (day := report_date(task.get("completed_at"))) is not None), default=None)


async def _quote_closure_events(database, docs, reminders):
    candidates = []
    for doc in docs:
        outcome = _outcome(doc)
        if outcome and not (_first_day(doc.get("outcome_at"), doc.get("ordered_at") if outcome == "won" else None)
                            or _earliest_task_outcome(doc, reminders[doc_key(doc)], outcome)):
            candidates.append(doc_key(doc))
    events = defaultdict(dict)
    async for event in _related(
        database.activity_events, candidates, ["floor_id", "quotation_id", "created_at", "event_type", "payload.to"],
        field_name="quotation_id", extra={"$or": [
            {"event_type": "quotation.order_placed"},
            {"event_type": "quotation.status_changed", "payload.to": {"$in": ["won", "lost", "rejected"]}},
        ]},
    ):
        key = (event["floor_id"], event["quotation_id"])
        result = "won" if event["event_type"] == "quotation.order_placed" or event.get("payload", {}).get("to") == "won" else "lost"
        if stamp := report_date(event.get("created_at")):
            events[key][result] = max(stamp, events[key].get(result, stamp))
    return events


async def _planner_source(database, user, floors, term, bounds, include_reports):
    staff_task_match = {"floor_id": {"$in": floors}, "category": {"$nin": sorted(lead_scope.POST_ORDER_CATEGORIES)},
                        "rule_type": {"$nin": sorted(lead_scope.POST_ORDER_RULES)}, "purchase_id": None}
    customer_matches = await _bounded(
        database.customers,
        _and({"floor_id": {"$in": floors}, **LIVE_CUSTOMER}, _text_search(term, "name", ["phone", "phone_normalized"]))
        if term else {},
        ["floor_id", "id"],
    )
    customer_selectors = _floor_ids((row["floor_id"], row["id"]) for row in customer_matches)
    quote_search = _text_search(term, "customer_name", ["phone_snapshot"],
                                other_names=["number", "doc_number"], customer_selectors=customer_selectors)
    quotation_floors = [floor for floor, can_read in zip(floors, await asyncio.gather(
        *(_can_read_quotes(user, floor) for floor in floors)
    ), strict=True) if can_read] if include_reports else []
    quote_window = {"$or": [
        _coarse_window("created_at", bounds),
        {"customer_outcome": {"$in": ["won", "lost"]}},
        {"status": {"$in": ["ordered", "won", "lost", "rejected"]}},
        {"doc_type": "tiles_quotation"}, {"quotation_import": {"$exists": True}},
    ]} if bounds[0] else {}
    quote_base = {"floor_id": {"$in": quotation_floors}, "source": {"$ne": "transfer"},
                  "doc_type": {"$ne": "tiles_selection"}}
    quote_candidates, furniture_docs = await asyncio.gather(
        _bounded(database.quotations, _and(quote_base, quote_search, quote_window) if quotation_floors else {}, QUOTE_FIELDS),
        _bounded(database.furniture_quotations,
                 _and({"floor_id": "third-floor"}, _coarse_window("created_at", bounds),
                      _text_search(term, "customer_name", ["customer_phone"], customer_selectors=customer_selectors))
                 if "third-floor" in quotation_floors else {}, FURNITURE_FIELDS),
    )
    quote_keys = {doc_key(doc) for doc in quote_candidates}
    search_extras = [*customer_selectors]
    if term:
        # A saved document number may have changed since an inbox row was
        # created. Its exact scoped quotation link is also a search match.
        for floor in floors:
            ids = [identity for scoped_floor, identity in quote_keys if scoped_floor == floor]
            if ids:
                search_extras.append({"floor_id": floor, "quotation_id": {"$in": ids}})
    task_search = _text_search(term, "customer_name", ["customer_phone"],
                               other_names=["quotation_number"], customer_selectors=search_extras)
    task_window = {"$or": [
        _and({"status": {"$in": ["open", "snoozed"]}}, _coarse_window("due_at", bounds)),
        _and({"status": {"$in": ["done", "dismissed"]}}, _coarse_window("completed_at", bounds)),
        {"completed_outcome": {"$in": ["won", "lost"]}}, {"notebook_status": {"$in": ["won", "lost"]}},
    ]} if bounds[0] else {}
    tasks = await _bounded(database.followups, _and(staff_task_match, task_search, task_window), FOLLOWUP_FIELDS)
    linked_keys = {(row["floor_id"], row["quotation_id"]) for row in tasks if row.get("quotation_id")}
    quotes = {doc_key(doc): doc for doc in quote_candidates}
    async for doc in _related(database.quotations, linked_keys - quote_keys, QUOTE_FIELDS):
        quotes[doc_key(doc)] = doc
    if sum(len(doc.get("items") or []) for doc in quotes.values()) > MAX_QUOTE_LINES:
        raise HTTPException(422, UNAVAILABLE)
    # Query links separately for reporting. Their attribution and closure
    # evidence must not vary when the employee changes the reporting window.
    reminders = defaultdict(list)
    if quote_keys:
        async for task in _related(database.followups, quote_keys, FOLLOWUP_FIELDS, field_name="quotation_id",
                                   extra={key: value for key, value in staff_task_match.items() if key != "floor_id"}):
            key = task["floor_id"], task["quotation_id"]
            quote = quotes[key]
            if quote.get("customer_id") and quote["customer_id"] == task.get("customer_id"):
                reminders[key].append(task)
    return tasks, quote_candidates, quotes, furniture_docs, reminders


async def load_planner(database, user, *, category: Category, period: Period, start: date | None, end: date | None,
                       day: date | None, week: int, assigned_to: str | None, brand: str | None,
                       department: str | None, q: str | None, page: int, page_size: int, scope: Scope = "all", now: datetime | None = None):
    today = (now or datetime.now(timezone.utc)).astimezone(IST).date()
    bounds = period_bounds(period, today, start, end)
    include_reports = scope == "all"
    if not include_reports and category in {"won", "lost", "created", "outcomes"}:
        raise HTTPException(422, "Select a work category or enable quotation reporting.")
    departments = await _authorized_departments(database, user)
    allowed = [row["id"] for row in departments]
    chosen = department or user.active_floor_id or "all"
    if chosen != "all" and chosen not in allowed:
        raise HTTPException(403, "You do not have Follow-ups access to this department.")
    floors = allowed if chosen == "all" else [chosen]
    term = (q or "").strip()
    tasks, quote_candidates, quotes, furniture_docs, reminders = await _planner_source(database, user, floors, term, bounds, include_reports)

    customer_keys = {(row["floor_id"], row.get("customer_id")) for row in [*tasks, *quote_candidates, *furniture_docs]}
    product_keys = {(doc["floor_id"], item.get("product_id")) for doc in quotes.values()
                    for item in doc.get("items") or [] if not item.get("brand_id")}
    async def customers():
        return {doc_key(row): row async for row in _related(database.customers, customer_keys,
                ["id", "floor_id", "name", "phone"], extra=LIVE_CUSTOMER)}

    async def products():
        return {doc_key(row): row async for row in _related(database.products, product_keys, ["id", "floor_id", "brand_id"])}

    customer_docs, product_docs, brand_docs, people, legacy_tiles, closures, identities = await asyncio.gather(
        customers(), products(),
        _bounded(database.brands, {"floor_id": {"$in": floors}}, ["id", "name"], cap=2_000),
        lead_scope.eligible_staff(database, floors),
        _tile_creation_evidence(database, quote_candidates),
        _quote_closure_events(database, quote_candidates, reminders),
        canonical_customer_ids(database, (identity for _, identity in customer_keys)),
    )
    brand_names = {doc["id"]: doc.get("name") or doc["id"] for doc in brand_docs}
    brand_values = {key: _brand_values(doc, product_docs, brand_names) for key, doc in quotes.items()}
    rows = []
    report_keys = {doc_key(doc) for doc in quote_candidates}
    for task in tasks:
        key = (task["floor_id"], task.get("quotation_id"))
        quote = quotes.get(key)
        if quote and quote.get("customer_id") != task.get("customer_id"):
            quote = None
        bucket = _task_category(task, quote, report_date(task.get("due_at")), today)
        if bucket is None:
            # A Follow-ups-only grant can still read the corresponding outcome
            # of a task it could already see, without inheriting a quote list.
            if quote and key not in report_keys and _task_outcome(task):
                bucket = _task_outcome(task)
            else:
                continue
        if not include_reports and bucket in {"won", "lost"}:
            continue
        timestamp = task.get("completed_at") if bucket in {"won", "lost", "completed"} else task.get("due_at")
        rows.append(_task_record(task, quote, brand_values.get(key, {}) if quote else {}, bucket, report_date(timestamp)))
        if include_reports and not task.get("quotation_id") and task.get("is_converted"):
            rows.append(_task_record(task, None, {}, "created", report_date(task.get("converted_at"))))
    for doc in quote_candidates:
        key = doc_key(doc)
        attributed = reminders[key]
        outcome = _outcome(doc)
        if not doc.get("historical_import"):
            rows.append(_quote_record(doc, "created", _created_day(doc, legacy_tiles), attributed, brand_values[key]))
        if outcome:
            closed_at = _first_day(doc.get("outcome_at"), doc.get("ordered_at") if outcome == "won" else None,
                                   _earliest_task_outcome(doc, attributed, outcome), closures.get(key, {}).get(outcome))
            rows.append(_quote_record(doc, outcome, closed_at, [task for task in attributed if _task_outcome(task) == outcome] or attributed, brand_values[key]))
    for doc in furniture_docs:
        rows.append(_quote_record(doc, "created", report_date(doc.get("created_at")), [], {}, furniture=True))

    staff = {person["id"]: person["full_name"] for person in people if person["eligible_floor_ids"] and person.get("full_name")}
    unique = {}
    for row in rows:
        floor = row.fields["floor_id"]
        auth_customer = customer_docs.get((floor, row.customer_id), {})
        row.display_name = auth_customer.get("name") or row.display_name
        row.phone = auth_customer.get("phone") or row.phone
        row.identity = identities.get(row.customer_id) or row.customer_id or f"record:{floor}:{row.fields['kind']}:{row.fields['id']}"
        for identity, name in row.assigned.items():
            staff.setdefault(identity, name or "Former employee")
        if not _matches_search(row, term) or (brand and brand not in row.brands):
            continue
        # Multiple legacy reminders linked to the same quotation can carry
        # the same outcome after the single transaction. Count that quote once.
        reference = row.quote_key if row.category in {"won", "lost", "created"} else None
        key = (row.category, reference or (floor, row.fields["kind"], row.fields["id"]))
        existing = unique.get(key)
        if existing:
            existing.assigned.update(row.assigned)
            existing.day = min((stamp for stamp in (existing.day, row.day) if stamp), default=None)
        else:
            unique[key] = row

    staff[NO_ASSIGNEE] = "Unassigned"
    matching = [row for row in unique.values() if _assignment_filter(row, assigned_to)]
    in_period = [row for row in matching if _in_period(row.day, bounds)]
    grouped = {name: [row for row in in_period if row.category == name] for name in CATEGORIES}
    grouped["active"] = [row for row in in_period if row.category in ACTIVE]
    grouped["outcomes"] = grouped["won"] + grouped["lost"]
    grouped["all"] = [row for row in in_period if row.category != "created"]
    already_listed = {row.quote_key for row in grouped["all"] if row.quote_key is not None}
    grouped["all"].extend(row for row in grouped["created"] if row.quote_key not in already_listed)
    summary = {name: _metric(records, brand) for name, records in grouped.items()}
    if bounds[0]:
        for row in matching:
            if row.day is not None:
                continue
            if row.category in CATEGORIES:
                summary[row.category]["missing_dates"] += 1
            if row.category in {"won", "lost"}:
                summary["outcomes"]["missing_dates"] += 1
            if row.category != "created":
                summary["all"]["missing_dates"] += 1
    if not include_reports:
        for report in ("created", "won", "lost", "outcomes"):
            summary.pop(report)
    selected = grouped[category]
    if category == "upcoming" and day:
        selected = [row for row in selected if row.day == day]
    items, more = _group_page(selected, page, page_size, brand, brand_names, staff)
    monday = today - timedelta(days=today.weekday()) + timedelta(weeks=week)
    return {
        "today": today.isoformat(), "summary": summary, "reports_available": include_reports,
        "schedule": _schedule(grouped["upcoming"], monday, brand),
        "employees": _employee_summary(grouped["active"], staff, brand),
        "brands": _brand_summary(in_period, brand_names, brand) if include_reports else [],
        "options": {
            "employees": [{"id": key, "name": value} for key, value in sorted(staff.items(), key=lambda pair: (pair[1].casefold(), pair[0]))],
            "brands": [{"id": key, "name": value} for key, value in sorted(brand_names.items(), key=lambda pair: (pair[1].casefold(), pair[0]))],
            "departments": sorted(departments, key=lambda row: FLOORS.index(row["id"])),
        },
        "items": items, "page": page, "page_size": page_size, "has_more": more,
    }
