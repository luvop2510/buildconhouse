"""Read the canonical Sanitary quote and customer-order snapshots."""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Literal
from urllib.parse import urlsplit

from pydantic import ValidationError

from models import QuotationLineItem, RoomDiscountCfg
from services.analytics.unified import INDIA
from services.pricing import net_amount_list
from services.sanitary_sales_pdf import SANITARY_FLOOR, archive_availability
OPEN_STATUSES = ("draft", "pending", "pending_approval", "approved", "sent", "won", None)
OTHER_BRANDS = "other"
HIGHLIGHT_BRANDS = {"grohe", "hansgrohe", "vitra"}
MAX_RECORDS = 20_000
MAX_LINES = 100_000
READ_BATCH = 500
PAISE = Decimal("0.01")
STANDARD = {"$in": [None, "", "standard"]}
QUOTE_SCOPE = {"floor_id": SANITARY_FLOOR, "deleted_at": None, "is_deleted": {"$ne": True}, "doc_type": STANDARD}
PRODUCT_FIELDS = ("id", "brand_id", "name", "sku", "size", "dimensions", "finish", "colour", "images")
LINE_FIELDS = (
    "id", "product_id", "variant_id", "sku", "name", "brand_id", "brand_name", "qty",
    "unit", "unit_of_measure", "quantity_unit", "pcs_per_box", "box_sqft", "price_basis",
    "mrp", "catalog_mrp", "net_amount", "unit_price", "discount_pct", "category_id",
    "room", "size", "dimension", "finish", "colour", "image", "cancelled", "canceled", "import_source.source_sha256",
)
QUOTE_FIELDS = (
    "id", "number", "doc_number", "status", "doc_date", "created_at", "ordered_at", "updated_at", "customer_id",
    "customer_name", "phone_snapshot", "referrer_id", "referrer_name", "referrer_type",
    "project_discount_pct", "category_discounts", "room_discounts",
    "historical_import.batch_id", "quotation_import.batch_id",
    "sent_at", "customer_outcome", "source", "grand_total", "payment_extra_history.amount", "payment_extra_amount",
    "payment_due_date", "payment_due_at", "created_by_name", "sent_by_name",
)
REFERRER_TYPES = {"architect", "interior_designer"}
PRINTED_DATE_FORMATS = ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d-%b-%y", "%d-%b-%Y", "%d %b %Y")


class SanitarySalesLimitError(Exception):
    """The selected source scope cannot be processed without truncation."""


def _projection(fields) -> dict:
    return {"_id": 0, **dict.fromkeys(fields, 1)}


def _text(value) -> str | None:
    return value.strip() or None if isinstance(value, str) else None


def _decimal(value) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = value.to_decimal() if hasattr(value, "to_decimal") else Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return number if number.is_finite() and number >= 0 else None


def _rupees(value) -> Decimal | None:
    number = _decimal(value)
    try:
        return number.quantize(PAISE) if number is not None else None
    except InvalidOperation:
        return None


def _stamp(value) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=INDIA)
        except ValueError:
            return None
    return None


def _quotation_stamp(doc: dict) -> datetime | None:
    # Imported quotations retain the original printed day while created_at
    # records the import. Use the same accepted date forms as the saved PDF.
    printed = _text(doc.get("doc_date"))
    if printed:
        for date_format in PRINTED_DATE_FORMATS:
            try:
                return datetime.strptime(printed, date_format).replace(tzinfo=INDIA)
            except ValueError:
                continue
    return _stamp(doc.get("created_at"))


def _calendar_date(value: datetime | None) -> str | None:
    try:
        return value.astimezone(INDIA).date().isoformat() if value else None
    except OverflowError:
        return None


def _indexed_dates(field: str, start: datetime | None, end: datetime | None) -> dict:
    # The indexed coarse match supports the app's ISO strings and legacy BSON
    # dates. ISO offsets can move a calendar prefix by one day, so compare
    # parsed instants exactly after this shortlist. Prefix bounds also avoid
    # ISO fractional-second and Z/+00:00 lexical boundary errors.
    string_bounds, bson_bounds = {}, {}
    if start:
        start_day = start.astimezone(timezone.utc).date()
        string_bounds["$gte"] = (start_day - timedelta(days=1) if start_day > date.min else date.min).isoformat()
        bson_bounds["$gte"] = start
    if end:
        end_day = end.astimezone(timezone.utc).date()
        # A nearly maximal custom date is still a valid open ISO bound.
        if end_day <= date.max - timedelta(days=2):
            string_bounds["$lt"] = (end_day + timedelta(days=2)).isoformat()
        bson_bounds["$lt"] = end
    return {"$or": [{field: string_bounds}, {field: bson_bounds}]} if string_bounds else {}


async def _by_ids(collection, ids, fields, *, key="id", scope=None):
    projection = _projection(fields)
    ids = sorted(set(ids) - {None, ""})
    for offset in range(0, len(ids), READ_BATCH):
        query = {key: {"$in": ids[offset:offset + READ_BATCH]}, **(scope or {})}
        async for row in collection.find(query, projection).max_time_ms(8000):
            yield row


async def list_brands(db) -> list[dict]:
    return [
        {"id": row["id"], "name": row["name"]}
        async for row in db.brands.find(
            {"floor_id": SANITARY_FLOOR, "is_deleted": {"$ne": True}},
            _projection(("id", "name")),
        ).sort([("name", 1), ("id", 1)]).max_time_ms(8000)
        if _text(row.get("id")) and _text(row.get("name"))
    ]


async def _brand_candidates(db, brand_id: str, placed: bool) -> dict:
    # The catalogue covers legacy quote lines without a saved brand. An
    # original company can still be attributed after a product changes brand,
    # so keep purchase-linked quotes as candidates and match exact lines later.
    products = await db.products.distinct("id", {
        "floor_id": SANITARY_FLOOR, "brand_id": brand_id, "id": {"$type": "string"},
    }, maxTimeMS=5000)
    matches = [{"items.brand_id": brand_id}, {"items.product_id": {"$in": products}}]
    if placed:
        linked = await db.purchase_orders.distinct("quotation_id", {
            "floor_id": SANITARY_FLOOR, "quotation_id": {"$type": "string"},
            "$or": [{"brand_id": brand_id}, {"items.brand_id": brand_id}],
        }, maxTimeMS=5000)
        if linked:
            matches.append({"id": {"$in": linked}})
    return {"$or": matches}


async def _purchase_brands(db, quote_ids) -> dict:
    """Exact placement provenance helps when a SKU's catalogue brand changed."""
    events = {}
    async for event in _by_ids(
        db.event_outbox, ("order-placed:" + quote_id for quote_id in quote_ids),
        ("idempotency_key", "payload.quotation_id", "result.purchase_order_ids"),
        key="idempotency_key", scope={"event_type": "OrderPlaced", "status": "completed"},
    ):
        quote_id = _text((event.get("payload") or {}).get("quotation_id"))
        if quote_id in quote_ids and event["idempotency_key"] == f"order-placed:{quote_id}":
            for po_id in (event.get("result") or {}).get("purchase_order_ids") or []:
                if _text(po_id):
                    events[po_id] = quote_id
    candidates = defaultdict(set)
    async for po in _by_ids(
        db.purchase_orders, events, ("id", "quotation_id", "brand_id", "items.quotation_line_id",
                                       "items.product_id", "items.brand_id"),
        scope={"floor_id": SANITARY_FLOOR},
    ):
        quote_id = po.get("quotation_id")
        if quote_id != events[po["id"]]:
            continue
        for item in po.get("items") or []:
            brand_id = _text(item.get("brand_id")) or _text(po.get("brand_id"))
            line_id, product_id = _text(item.get("quotation_line_id")), _text(item.get("product_id"))
            if line_id and product_id and brand_id:
                candidates[(quote_id, line_id, product_id)].add(brand_id)
    return {key: next(iter(brands)) for key, brands in candidates.items() if len(brands) == 1}


def _offers(doc: dict, items: list[dict]) -> list[Decimal | None]:
    known = [_rupees(item.get("net_amount")) for item in items]
    if all(amount is not None for amount in known):
        return known
    if any(_decimal(item.get("unit_price")) is None or _decimal(item.get("qty")) is None for item in items):
        return known
    try:
        recalculated = net_amount_list(
            [QuotationLineItem(**item) for item in items],
            doc.get("project_discount_pct") or 0,
            doc.get("category_discounts") or {},
            {room: RoomDiscountCfg(**config) for room, config in (doc.get("room_discounts") or {}).items()},
        )
    except (ArithmeticError, AttributeError, TypeError, ValueError, ValidationError):
        return known
    return [
        saved if saved is not None else _rupees(fallback)
        for saved, fallback in zip(known, recalculated, strict=True)
    ]


def _unit(item: dict) -> str:
    raw = _text(item.get("unit_of_measure")) or _text(item.get("unit"))
    if not raw:
        # QuotationLineItem historically stamped "Box" as a tiles-only
        # default on ordinary sanitary items. Actual box lines must carry a
        # unit or box-pricing/coverage evidence.
        box = item.get("pcs_per_box") or item.get("box_sqft") or item.get("price_basis") == "box"
        recorded = _text(item.get("quantity_unit"))
        raw = (recorded or "Box") if box else "Pieces"
    return {"pc": "Pieces", "pcs": "Pieces", "piece": "Pieces", "pieces": "Pieces",
            "box": "Box", "boxes": "Box"}.get((raw or "").lower(), raw or "Pieces")


def _image(item: dict, product: dict) -> str | None:
    candidates = [item.get("image"), *(product.get("images") or [])]
    for url in candidates:
        if not isinstance(url, str) or len(url) > 2048:
            continue
        try:
            parsed = urlsplit(url)
            if parsed.scheme in {"http", "https"} and parsed.hostname and parsed.username is None:
                return url
        except ValueError:
            continue
    return None


def _line_fact(doc: dict, item: dict, index: int, offer: Decimal | None,
               products: dict, brands: dict, purchased_brands: dict) -> dict:
    product_id = _text(item.get("product_id"))
    product = products.get(product_id, {})
    brand_id = (_text(item.get("brand_id"))
                or purchased_brands.get((doc["id"], _text(item.get("id")), product_id))
                or _text(product.get("brand_id")))
    quantity = _decimal(item.get("qty"))
    if not quantity:
        quantity = None
    rate = _decimal(item.get("mrp"))
    imported = doc.get("historical_import") or doc.get("quotation_import") or item.get("import_source")
    # Import tools snapshot the then-current catalogue for future edits.
    # That batch-time price is not evidence of a historic transaction's MRP.
    if rate is None and not imported:
        rate = _decimal(item.get("catalog_mrp"))
    return {
        # Positions keep separate saved lines (including identical products
        # in two rooms) distinct even for old documents with reused line IDs.
        "id": f"{doc['id']}:{index}",
        "product_id": product_id,
        "variant_id": _text(item.get("variant_id")),
        "name": _text(item.get("name")) or _text(product.get("name")) or "Product unavailable",
        "sku": _text(item.get("sku")) or _text(product.get("sku")),
        "brand_id": brand_id,
        "brand_name": _text(item.get("brand_name")) or brands.get(brand_id) or "Unassigned company",
        "size": (_text(item.get("size")) or _text(item.get("dimension"))
                 or _text(product.get("size")) or _text(product.get("dimensions"))),
        "finish": (_text(item.get("finish")) or _text(item.get("colour"))
                   or _text(product.get("finish")) or _text(product.get("colour"))),
        "image": _image(item, product),
        "quantity": quantity,
        "unit": _unit(item),
        "mrp": _rupees(quantity * rate) if quantity is not None and rate is not None else None,
        "offer": offer,
    }


def _record(doc, timestamp, customers, referrers, pdf_ids, products, brands, purchased_brands, brand_id):
    customer_id = _text(doc.get("customer_id"))
    customer = customers.get(customer_id, {})
    # A saved quotation link is its historical attribution. When it has
    # no stable link, use the same-floor customer's directory relationship.
    attribution = doc if _text(doc.get("referrer_id")) else customer
    referrer_id = _text(attribution.get("referrer_id"))
    referrer = referrers.get(referrer_id, {})
    referrer_type = _text(attribution.get("referrer_type")) or referrer.get("type")
    interior_id = referrer_id if referrer_type in REFERRER_TYPES else None
    interior_name = (_text(attribution.get("referrer_name")) or _text(referrer.get("name"))
                     or "Unnamed interior or architect") if interior_id else "Unassigned"
    items = [item for item in doc.get("items") or [] if not (item.get("cancelled") or item.get("canceled"))]
    lines = [
        _line_fact(doc, item, index, offer, products, brands, purchased_brands)
        for index, (item, offer) in enumerate(zip(items, _offers(doc, items), strict=True))
    ]
    def matches_brand(line):
        if brand_id == OTHER_BRANDS:
            name = brands.get(line["brand_id"], line["brand_name"])
            return line["brand_id"] and name.casefold() not in HIGHLIGHT_BRANDS
        return not brand_id or line["brand_id"] == brand_id

    return {
        "id": doc["id"],
        "number": _text(doc.get("doc_number")) or _text(doc.get("number")) or doc["id"],
        "date": _calendar_date(timestamp),
        "quotation_date": _calendar_date(_quotation_stamp(doc)),
        "status": _text(doc.get("status")) or "draft",
        "sent_at": doc.get("sent_at"),
        "outcome": doc.get("customer_outcome"),
        "source": doc.get("source"),
        "historical_order": bool(doc.get("historical_import")),
        "created_at": doc.get("created_at"),
        "employee": _text(doc.get("sent_by_name")) or _text(doc.get("created_by_name")),
        "grand_total": doc.get("grand_total"),
        "payment_extra_history": doc.get("payment_extra_history"),
        "payment_extra_amount": doc.get("payment_extra_amount"),
        "payment_due_date": doc.get("payment_due_date") or doc.get("payment_due_at"),
        "fulfillment_line_ids": {_text(item.get("id")) for item in items},
        "fulfillment_products": {_text(item.get("product_id")) for item in items},
        "customer_id": customer_id or f"unlinked:{doc['id']}",
        "customer_identity_known": customer_id is not None,
        "customer_name": _text(doc.get("customer_name")) or _text(customer.get("name")) or "Unknown customer",
        "phone": _text(doc.get("phone_snapshot")) or _text(customer.get("phone")),
        "interior_id": interior_id,
        "interior_name": interior_name,
        "interior_type": referrer_type if interior_id else None,
        "pdf_available": doc["id"] in pdf_ids,
        "lines": [line for line in lines if matches_brand(line)],
    }


async def load_records(
    db, *, kind: Literal["pending", "placed", "opportunities"], start: str | None = None,
    end: str | None = None, brand_id: str | None = None, include_pdfs: bool = True,
) -> list[dict]:
    """Retrieve only the exact floor, lifecycle and date range for a report."""
    placed = kind == "placed"
    opportunities = kind == "opportunities"
    field = "ordered_at" if placed else "created_at"
    first, after_last = _stamp(start), _stamp(end)
    match = {
        **QUOTE_SCOPE,
        "id": {"$type": "string", "$ne": ""},
        "status": "ordered" if placed else {"$in": OPEN_STATUSES},
        "customer_outcome": {"$ne": "lost"} if placed else {"$nin": ["lost", "won"]},
        "cancelled": {"$ne": True},
        "canceled": {"$ne": True},
    }
    dates = _indexed_dates(field, first, after_last)
    if dates and not placed:
        # Include the optional historical printed-date cohort, then apply
        # exact bounds after normalizing dates. Ordinary quotes still use
        # the canonical, indexed creation timestamp.
        dates["$or"].append({"doc_date": {"$type": "string", "$ne": ""}})
    match_filters = [dates]
    if brand_id and brand_id != OTHER_BRANDS:
        match_filters.append(await _brand_candidates(db, brand_id, placed or opportunities))
    if clauses := [clause for clause in match_filters if clause]:
        match["$and"] = clauses
    if opportunities:
        match["status"] = {"$in": [*OPEN_STATUSES, "ordered", "lost", "rejected"]}
        match.pop("customer_outcome")
    elif not placed:
        match["ordered_at"] = {"$in": [None, ""]}
    projection = _projection((*QUOTE_FIELDS, *(f"items.{field}" for field in LINE_FIELDS)))
    selected = {}
    line_count = 0
    cursor = db.quotations.find(match, projection).max_time_ms(8000)
    async for doc in cursor:
        timestamp = _stamp(doc.get(field)) if placed else _quotation_stamp(doc)
        if ((first and (not timestamp or timestamp < first))
                or (after_last and (not timestamp or timestamp >= after_last))):
            continue
        if doc["id"] in selected:
            raise SanitarySalesLimitError("Duplicate quotation identities need review before sales totals can be shown.")
        # Fully cancelled orders have no active customer order lines. Empty
        # drafts are valid open quotations and remain visible under all brands.
        if placed and not any(not (item.get("cancelled") or item.get("canceled")) for item in doc.get("items") or []):
            continue
        selected[doc["id"]] = doc, timestamp
        line_count += len(doc.get("items") or [])
        if len(selected) > MAX_RECORDS or line_count > MAX_LINES:
            raise SanitarySalesLimitError("This selection is too large for a complete report. Choose a shorter date range or a company.")
    if not selected:
        return []
    docs = [doc for doc, _ in selected.values()]

    async def load_customers():
        return {
            row["id"]: row
            async for row in _by_ids(
                db.customers, (_text(doc.get("customer_id")) for doc in docs),
                ("id", "name", "phone", "referrer_id", "referrer_name", "referrer_type"),
                scope={"floor_id": SANITARY_FLOOR, "deleted_at": None},
            )
        }

    async def load_products():
        return {
            row["id"]: row
            async for row in _by_ids(
                db.products,
                (_text(item.get("product_id")) for doc in docs for item in doc.get("items") or []),
                PRODUCT_FIELDS,
                scope={"floor_id": SANITARY_FLOOR},
            )
        }

    async def load_purchase_brands():
        ids = {doc["id"] for doc in docs if doc.get("status") == "ordered"}
        return await _purchase_brands(db, ids) if ids else {}

    async def load_pdfs():
        return await archive_availability(db, docs) if include_pdfs and not placed else set()

    customers, products, brands, pdf_ids, purchased_brands = await asyncio.gather(
        load_customers(), load_products(), list_brands(db), load_pdfs(), load_purchase_brands(),
    )
    brand_names = {brand["id"]: brand["name"] for brand in brands}
    referrer_ids = {_text(doc.get("referrer_id")) for doc in [*docs, *customers.values()]}
    referrers = {
        row["id"]: row
        async for row in _by_ids(
            db.referrers, referrer_ids, ("id", "name", "type"),
            scope={"$or": [{"floor_id": SANITARY_FLOOR}, {"shared_across_floors": True,
                         "excluded_floor_ids": {"$ne": SANITARY_FLOOR}}]},
        )
    }
    result = [
        _record(doc, timestamp, customers, referrers, pdf_ids, products, brand_names, purchased_brands, brand_id)
        for doc, timestamp in selected.values()
    ]
    return [record for record in result if record["lines"] or not brand_id]
