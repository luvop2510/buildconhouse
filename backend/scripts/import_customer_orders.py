"""Controlled, retry-safe import of reviewed historical customer orders.

The private JSON manifest contains ``batch_id``, ``floor_id``, ``actor_id``,
``orders`` and optional ``new_products``. Each order contains source_file,
source_sha256, customer, date, referrer, items and the three quotation totals.
Every line contains sheet, row, exact sku/name, brand_name, category_id,
product_id (recommended), mrp, qty, unit_price, discount_pct and net_amount.
An explicit product_id is the only permitted alias of a source SKU.

Dry run is the default. Apply additionally requires the exact manifest SHA256
and database name. Backups/plans are private local BSON-preserving artifacts,
outside the checkout. No server startup, migration, invitation, notification,
PDF generation or received-payment command runs here.

    python -m scripts.import_customer_orders --manifest /private/orders.json
    python -m scripts.import_customer_orders --manifest /private/orders.json \
      --apply --expected-db buildcon_house --manifest-sha <sha256>
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import re
import sys
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from models import Brand, CustomerPublic, Product, Quotation, QuotationLineItem, Referrer, UserPublic  # noqa: E402
from services.pricing import net_amount_list, recalc_quotation_totals  # noqa: E402


class ImportConflict(ValueError):
    """Reviewed source and current target cannot safely be reconciled."""


def identity(*parts: object) -> str:
    return str(uuid5(NAMESPACE_URL, "forge:historical-order:" + json.dumps(parts, ensure_ascii=False)))


def fingerprint(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def normalized_name(value: object) -> str:
    return " ".join(str(value or "").split()).casefold()


def normalized_phone(value: object, *, validate: bool = True) -> str:
    phone = re.sub(r"\D", "", str(value or ""))
    if len(phone) == 12 and phone.startswith("91"):
        phone = phone[2:]
    if validate and phone and not 7 <= len(phone) <= 15:
        raise ImportConflict("A supplied customer phone is not a valid real contact number")
    return phone


def cents(value: object) -> Decimal:
    try:
        result = Decimal(str(value))
        if not result.is_finite():
            raise InvalidOperation
        return result.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ImportConflict("Money must be a finite number") from exc


def _same_money(actual: object, expected: object, label: str) -> None:
    if cents(actual) != cents(expected):
        raise ImportConflict(f"{label} does not reconcile to the quotation pricing engine")


def _source_key(order: dict) -> str:
    return identity(str(order["source_file"]), order["source_sha256"])


def validate_manifest(manifest: dict) -> None:
    """Validate source arithmetic and stable line identity before any DB access."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", str(manifest.get("batch_id") or "")):
        raise ImportConflict("batch_id must be a short stable identifier")
    if not manifest.get("floor_id") or not manifest.get("actor_id"):
        raise ImportConflict("floor_id and actor_id are required")
    orders = manifest.get("orders")
    if not isinstance(orders, list) or not orders or len(orders) > 30:
        raise ImportConflict("A batch must contain between 1 and 30 orders")
    if sum(len(order.get("items") or []) for order in orders) > 250:
        raise ImportConflict("Split batches larger than 250 source lines")
    sources = set()
    for order in orders:
        if not order.get("source_file") or not re.fullmatch(r"[0-9a-f]{64}", order.get("source_sha256", "")):
            raise ImportConflict("Every order requires its source file and SHA256")
        source_key = _source_key(order)
        if source_key in sources:
            raise ImportConflict("A workbook may appear only once in a batch")
        sources.add(source_key)
        try:
            source_date = date.fromisoformat(order["date"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ImportConflict("Every order requires its actual YYYY-MM-DD date") from exc
        if source_date > datetime.now(timezone.utc).date():
            raise ImportConflict("A historical order cannot have a future date")
        customer = order.get("customer") or {}
        if not normalized_name(customer.get("name")):
            raise ImportConflict("Customer name is required")
        normalized_phone(customer.get("phone"))
        referrer = order.get("referrer")
        if referrer and (not normalized_name(referrer.get("name")) or referrer.get("type") not in {"architect", "interior_designer"}):
            raise ImportConflict("Referrers require an exact name and supported type")
        if customer.get("referrer_name") and (not referrer or normalized_name(customer["referrer_name"]) != normalized_name(referrer["name"])):
            raise ImportConflict("Customer referral and order referral disagree")
        items = order.get("items") or []
        if not items:
            raise ImportConflict("An order must contain source product lines")
        seen = set()
        typed_items = []
        for item in items:
            if not item.get("sheet") or type(item.get("row")) is not int or item["row"] < 1:
                raise ImportConflict("Each line needs its source sheet and positive row number")
            key = (item["sheet"], item["row"])
            if key in seen:
                raise ImportConflict("Duplicate source sheet/row in an order")
            seen.add(key)
            for field in ("sku", "name", "brand_name", "category_id"):
                if not str(item.get(field) or "").strip():
                    raise ImportConflict(f"Each line requires {field}")
            for field in ("mrp", "qty", "unit_price", "discount_pct", "net_amount"):
                if field not in item or not math.isfinite(float(item[field])):
                    raise ImportConflict(f"Each line requires finite {field}")
            typed_items.append(_line(item, source_key, item.get("product_id") or "preflight-unresolved"))
        for item, calculated in zip(items, net_amount_list(typed_items), strict=True):
            _same_money(calculated, item["net_amount"], f"Source line {item['sheet']}:{item['row']} net amount")
        calculated = recalc_quotation_totals(typed_items)
        for field in ("subtotal", "discount_total", "grand_total"):
            if field not in order:
                raise ImportConflict(f"Missing source {field}")
            _same_money(calculated[field], order[field], field)
        if cents(order["grand_total"]) <= 0:
            raise ImportConflict("This customer/payment import requires positive order totals")


def _line(item: dict, source_key: str, product_id: str) -> QuotationLineItem:
    allowed = {"sku", "name", "description", "mrp", "qty", "unit_price", "discount_pct", "net_amount", "category_id", "room", "area", "finish", "colour", "dimension", "image"}
    values = {key: value for key, value in item.items() if key in allowed}
    return QuotationLineItem(id=identity(source_key, item["sheet"], item["row"]), product_id=product_id, quantity_unit="Pieces", **values)


async def _rows(database, collection: str, query: dict, *, session=None) -> list[dict]:
    return await database[collection].find(query, {"_id": 0}, session=session).to_list(None)


def _customer_match(source: dict, candidates: list[dict]) -> dict | None:
    name, phone = normalized_name(source["name"]), normalized_phone(source.get("phone"))
    by_name = [row for row in candidates if normalized_name(row.get("name")) == name]
    if phone:
        by_phone = [row for row in candidates if normalized_phone(row.get("phone"), validate=False) == phone]
        if by_phone:
            if len(by_phone) != 1 or normalized_name(by_phone[0].get("name")) != name:
                raise ImportConflict("Customer phone matches an ambiguous or differently named existing customer")
            return by_phone[0]
        if by_name:
            raise ImportConflict("Customer name already exists with a different/missing phone; resolve explicitly")
        return None
    if len(by_name) > 1:
        raise ImportConflict("Customer name without a phone is ambiguous")
    return by_name[0] if by_name else None


async def prepare_plan(database, manifest: dict, manifest_sha: str, *, session=None) -> dict:
    """Read-only identity resolution; its fingerprint pins apply preconditions."""
    validate_manifest(manifest)
    floor = manifest["floor_id"]
    floor_doc = await database.floors.find_one({"id": floor}, {"_id": 0}, session=session)
    actor_doc = await database.users.find_one({"id": manifest["actor_id"], "active": {"$ne": False}}, {"_id": 0}, session=session)
    if not floor_doc or not actor_doc:
        raise ImportConflict("Configured floor or active import actor does not exist")
    actor = UserPublic(**{**actor_doc, "active_floor_id": floor})
    if actor.role not in {"owner", "admin", "manager"} or (actor.role != "owner" and floor not in actor.floor_ids):
        raise ImportConflict("Import actor must have management access to the exact floor")
    receipt_key = f"historical-import:{manifest['batch_id']}"
    receipt = await database.event_outbox.find_one({"idempotency_key": receipt_key}, {"_id": 0}, session=session)
    if receipt:
        if receipt.get("manifest_sha256") != manifest_sha or receipt.get("manifest_fingerprint") != fingerprint(manifest) or receipt.get("status") != "completed":
            raise ImportConflict("Batch already exists with a different manifest or incomplete receipt")
        await verify_receipt(database, receipt, session=session)
        return {"already_applied": True, "receipt": receipt, "manifest_sha256": manifest_sha}

    customers = await _rows(database, "customers", {"floor_id": floor}, session=session)
    referrers = await _rows(database, "referrers", {"floor_id": floor}, session=session)
    brands = await _rows(database, "brands", {"floor_id": floor}, session=session)
    brand_by_id = {row["id"]: row for row in brands}
    new_brands = []
    for raw in manifest.get("new_brands") or []:
        values = {**raw, "floor_id": raw.get("floor_id", floor)}
        values.setdefault("id", identity("brand", floor, normalized_name(values.get("name"))))
        brand = Brand(**values).model_dump()
        if brand["floor_id"] != floor or not brand["name"].strip() or not brand["slug"].strip():
            raise ImportConflict("New brands require a name, slug and the batch floor")
        if brand["id"] in brand_by_id or any(row["slug"] == brand["slug"] or normalized_name(row["name"]) == normalized_name(brand["name"]) for row in brands):
            raise ImportConflict("A proposed new brand name, slug or id already exists")
        brands.append(brand)
        brand_by_id[brand["id"]] = brand
        new_brands.append(brand)
    categories = await _rows(database, "categories", {"floor_id": floor}, session=session)
    category_ids = {row["id"] for row in categories}
    products = await _rows(database, "products", {"floor_id": floor}, session=session)
    product_by_id = {row["id"]: row for row in products}
    new_products = []
    for raw in manifest.get("new_products") or []:
        values = {**raw, "floor_id": raw.get("floor_id", floor)}
        values.setdefault("id", identity("product", floor, values.get("brand_id"), values.get("sku")))
        product = Product(**values).model_dump()
        if product["floor_id"] != floor or product["brand_id"] not in brand_by_id or product["category_id"] not in category_ids or not product["active"]:
            raise ImportConflict("New catalog products require active, existing floor-scoped brand/category relations")
        if product["id"] in product_by_id or any(row["sku"] == product["sku"] and row["brand_id"] == product["brand_id"] for row in products):
            raise ImportConflict("A proposed new product already exists; use its real product_id instead")
        product_by_id[product["id"]] = product
        products.append(product)
        new_products.append(product)

    planned_customers, planned_referrers, orders = {}, {}, []
    for order in manifest["orders"]:
        source_key = _source_key(order)
        historical_at = datetime.fromisoformat(f"{order['date']}T00:00:00+05:30").astimezone(timezone.utc).isoformat()
        quotation_id = identity("quotation", floor, source_key)
        if await database.quotations.find_one({"$or": [{"id": quotation_id}, {"historical_import.source_file": order["source_file"]}, {"historical_import.source_sha256": order["source_sha256"]}]}, {"id": 1}, session=session) or await database.event_outbox.find_one({"idempotency_key": f"order-placed:{quotation_id}"}, {"id": 1}, session=session):
            raise ImportConflict("Source order exists outside this batch receipt")
        referral_fields = {"referrer_id": None, "referrer_name": None, "referrer_type": None}
        referrer = order.get("referrer")
        if referrer:
            matches = [row for row in referrers if row.get("type") == referrer["type"] and normalized_name(row.get("name")) == normalized_name(referrer["name"])]
            if len(matches) > 1 or (matches and matches[0].get("active") is False):
                raise ImportConflict("Referral directory match is ambiguous or archived")
            if matches:
                resolved = matches[0]
                if resolved["name"] != referrer["name"]:
                    raise ImportConflict("Referral spelling differs from existing directory; resolve the reviewed name explicitly")
            else:
                resolved = Referrer(id=identity("referrer", floor, referrer["type"], normalized_name(referrer["name"])), floor_id=floor, name=referrer["name"], type=referrer["type"], normalized_name=referrer["name"].strip().casefold(), created_by=actor.id).model_dump()
                referrers.append(resolved)
                planned_referrers[resolved["id"]] = resolved
            referral_fields = {"referrer_id": resolved["id"], "referrer_name": resolved["name"], "referrer_type": resolved["type"]}
        customer_source = order["customer"]
        existing = _customer_match(customer_source, customers)
        if existing:
            if existing.get("referrer_id") and referral_fields["referrer_id"] and existing["referrer_id"] != referral_fields["referrer_id"]:
                raise ImportConflict("Existing customer has conflicting referral attribution")
            customer = dict(existing)
            if referral_fields["referrer_id"]:
                customer.update(referral_fields)
            else:
                referral_fields = {key: customer.get(key) for key in referral_fields}
        else:
            allowed = {"name", "phone", "alternate_phone", "company", "email", "address", "property_name", "city", "state", "pincode", "gstin", "tier"}
            values = {key: value for key, value in customer_source.items() if key in allowed}
            values.update(referral_fields)
            values.update(id=identity("customer", floor, normalized_name(values["name"]), normalized_phone(values.get("phone"))), floor_id=floor)
            customer = CustomerPublic(created_at=historical_at, **values).model_dump()
            if customer.get("email") is None:
                customer.pop("email", None)
            if customer.get("email") and await database.customers.find_one({"email": customer["email"].lower()}, {"id": 1}, session=session):
                raise ImportConflict("Customer email already exists")
            customers.append(customer)
        previous_plan = planned_customers.get(customer["id"])
        if previous_plan and previous_plan["document"] != customer:
            raise ImportConflict("One customer has inconsistent identity/referral data across source orders")
        planned_customers[customer["id"]] = {"document": customer, "previous": existing if existing and customer["id"] not in planned_customers else (previous_plan or {}).get("previous")}
        items = []
        for sort_order, raw in enumerate(order["items"]):
            product_id = raw.get("product_id")
            if product_id:
                product = product_by_id.get(product_id)
            else:
                matches = [p for p in products if p["sku"] == raw["sku"] and normalized_name(brand_by_id.get(p["brand_id"], {}).get("name")) == normalized_name(raw["brand_name"])]
                if len(matches) != 1:
                    raise ImportConflict("Source SKU is absent/ambiguous; supply a reviewed exact product_id")
                product = matches[0]
            if not product or not product.get("active", True) or product.get("category_id") != raw["category_id"] or normalized_name(brand_by_id.get(product["brand_id"], {}).get("name")) != normalized_name(raw["brand_name"]):
                raise ImportConflict("Source product has invalid floor, brand, category or active status")
            line = _line(raw, source_key, product["id"]).model_dump()
            line["sort_order"] = sort_order
            line.update(catalog_price=product.get("price"), catalog_mrp=product.get("mrp"), catalog_version=product.get("catalog_version", 0))
            line["import_source"] = {"source_file": order["source_file"], "source_sha256": order["source_sha256"], "sheet": raw["sheet"], "row": raw["row"], "source_values": raw.get("source_values", {})}
            items.append(line)
        quotation = Quotation(id=quotation_id, number=f"HIST-{manifest['batch_id']}-{len(orders) + 1:02d}", floor_id=floor, customer_id=customer["id"], customer_name=customer_source["name"], phone_snapshot=customer_source.get("phone"), address_snapshot=customer_source.get("address"), doc_date=order["date"], ordered_at=historical_at, created_at=historical_at, status="ordered", created_by=actor.id, created_by_name=actor.full_name, reference_source="Reference" if referral_fields["referrer_id"] else None, items=[QuotationLineItem(**line) for line in items], rooms=list(dict.fromkeys(line["room"] for line in items if line.get("room"))), subtotal=order["subtotal"], discount_total=order["discount_total"], grand_total=order["grand_total"], **referral_fields).model_dump()
        quotation["items"] = items
        quotation["historical_import"] = {"batch_id": manifest["batch_id"], "manifest_sha256": manifest_sha, "source_file": order["source_file"], "source_sha256": order["source_sha256"]}
        if await database.quotations.find_one({"number": quotation["number"]}, {"id": 1}, session=session):
            raise ImportConflict("Historical quotation number already exists")
        orders.append(quotation)
    used_new = {line["product_id"] for quote in orders for line in quote["items"]}
    if any(product["id"] not in used_new for product in new_products):
        raise ImportConflict("Manifest contains an unused new product")
    if any(not any(product["brand_id"] == brand["id"] for product in new_products) for brand in new_brands):
        raise ImportConflict("Manifest contains an unused new brand")
    plan = {"batch_id": manifest["batch_id"], "floor_id": floor, "actor_id": actor.id, "actor_name": actor.full_name, "manifest_sha256": manifest_sha, "manifest_fingerprint": fingerprint(manifest), "customers": list(planned_customers.values()), "referrers": list(planned_referrers.values()), "new_brands": new_brands, "new_products": new_products, "orders": orders}
    # Pydantic defaults contain timestamps. Exclude those from concurrency pin.
    plan["plan_fingerprint"] = fingerprint(_stable(plan))
    return plan


def _stable(value):
    if isinstance(value, dict):
        return {key: _stable(item) for key, item in value.items() if key not in {"created_at", "updated_at", "plan_fingerprint"}}
    if isinstance(value, list):
        return [_stable(item) for item in value]
    return value


async def verify_receipt(database, receipt: dict, *, session=None) -> None:
    """A retry must prove that all committed documents still match the receipt."""
    for entry in receipt.get("documents") or []:
        current = await database[entry["collection"]].find_one({"id": entry["id"]}, {"_id": 0}, session=session)
        if current is None or fingerprint(current) != entry["fingerprint"]:
            raise ImportConflict(f"An imported {entry['collection']} record changed or is missing; refusing replay")
    if not receipt.get("documents"):
        raise ImportConflict("Import receipt has no verification inventory")


def _private_json(path: Path, payload: object) -> None:
    from bson import json_util

    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    encoded = json_util.dumps(payload, ensure_ascii=False, indent=2).encode()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(encoded)


async def backup_before_apply(database, output_dir: Path) -> Path:
    """Capture complete affected collections, including Mongo internal IDs."""
    collections = ("customers", "referrers", "brands", "products", "quotations", "purchase_orders", "payments", "followups", "event_outbox", "activity_events", "counters")
    snapshot = {"database": database.name, "created_at": datetime.now(timezone.utc).isoformat(), "collections": {}}
    for collection in collections:
        snapshot["collections"][collection] = await database[collection].find({}).to_list(None)
    path = output_dir / f"before-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}.json"
    _private_json(path, snapshot)
    return path


async def apply_plan(database, mongo_client, manifest: dict, manifest_sha: str, plan: dict, output_dir: Path) -> dict:
    """Apply one atomic batch; caller has verified CLI destination/hash guards."""
    from services import domain_outbox, sequence
    from routes.quotation_routes import _complete_order_notebook_followups, _complete_pre_confirmation_followups

    if plan.get("already_applied"):
        return {"already_applied": True, "orders": len(manifest["orders"])}
    # Backup precedes even sequence seeding, the sole write outside the batch.
    backup_path = await backup_before_apply(database, output_dir)
    year = datetime.now(timezone.utc).year
    await sequence._seed_from_existing(f"purchase_order:FPO-{year}-", "purchase_orders", f"FPO-{year}-")
    async with await mongo_client.start_session() as session:
        async with session.start_transaction():
            current_plan = await prepare_plan(database, manifest, manifest_sha, session=session)
            if current_plan.get("already_applied"):
                return {"already_applied": True, "orders": len(manifest["orders"])}
            if current_plan["plan_fingerprint"] != plan["plan_fingerprint"]:
                raise ImportConflict("Target data changed after dry-run/backup; regenerate and review the plan")
            for brand in plan["new_brands"]:
                await database.brands.insert_one(brand, session=session)
            for product in plan["new_products"]:
                await database.products.insert_one(product, session=session)
            for referrer in plan["referrers"]:
                await database.referrers.insert_one(referrer, session=session)
            for entry in plan["customers"]:
                customer, previous = entry["document"], entry["previous"]
                if previous is None:
                    await database.customers.insert_one(customer, session=session)
                elif customer != previous:
                    referral = {key: customer.get(key) for key in ("referrer_id", "referrer_name", "referrer_type")}
                    await database.customers.update_one({"id": customer["id"], "floor_id": plan["floor_id"]}, {"$set": referral}, session=session)
                if previous is None:
                    await domain_outbox._upsert_activity(key=f"historical-import:{manifest['batch_id']}:customer:{customer['id']}", event_type="customer.created", entity_type="customer", entity_id=customer["id"], actor_id=plan["actor_id"], actor_name=plan["actor_name"], customer_id=customer["id"], quotation_id=None, purchase_id=None, summary="Historical customer imported from reviewed workbook", payload={"batch_id": plan["batch_id"]}, session=session)
            results = []
            for quotation in plan["orders"]:
                await database.quotations.insert_one(quotation, session=session)
                await domain_outbox._upsert_activity(key=f"historical-import:{manifest['batch_id']}:quotation:{quotation['id']}", event_type="quotation.created", entity_type="quotation", entity_id=quotation["id"], actor_id=plan["actor_id"], actor_name=plan["actor_name"], customer_id=quotation["customer_id"], quotation_id=quotation["id"], purchase_id=None, summary="Historical order imported from reviewed workbook", payload=quotation["historical_import"], session=session)
                await _complete_order_notebook_followups(quotation, session=session)
                await _complete_pre_confirmation_followups(quotation["id"], quotation["number"], session=session, floor_id=plan["floor_id"], creator_id=plan["actor_id"], creator_name=plan["actor_name"], customer_id=quotation["customer_id"])
                event = {"_id": identity("event", quotation["id"]), "id": identity("event", quotation["id"]), "event_type": domain_outbox.EVENT_ORDER_PLACED, "idempotency_key": f"order-placed:{quotation['id']}", "payload": {"quotation_id": quotation["id"], "historical_import_batch": plan["batch_id"]}, "actor_id": plan["actor_id"], "actor_name": plan["actor_name"], "status": "completed", "attempts": 1, "created_at": datetime.now(timezone.utc).isoformat()}
                result = await domain_outbox._handle_order_placed(event, session)
                result.pop("post_commit_notification", None)
                event.update(result=result, processed_at=datetime.now(timezone.utc).isoformat(), updated_at=datetime.now(timezone.utc).isoformat())
                await database.event_outbox.insert_one(event, session=session)
                results.append(result)
            inventory = []
            quote_ids = [quotation["id"] for quotation in plan["orders"]]
            selectors = {"customers": {"id": {"$in": [entry["document"]["id"] for entry in plan["customers"]]}}, "referrers": {"id": {"$in": [row["id"] for row in plan["referrers"]]}}, "brands": {"id": {"$in": [row["id"] for row in plan["new_brands"]]}}, "products": {"id": {"$in": [row["id"] for row in plan["new_products"]]}}, "quotations": {"id": {"$in": quote_ids}}, "purchase_orders": {"quotation_id": {"$in": quote_ids}}, "payments": {"quotation_id": {"$in": quote_ids}}, "event_outbox": {"payload.quotation_id": {"$in": quote_ids}}, "activity_events": {"$or": [{"quotation_id": {"$in": quote_ids}}, {"automation_key": {"$regex": f"^historical-import:{re.escape(plan['batch_id'])}:"}}]}}
            for collection, selector in selectors.items():
                for document in await _rows(database, collection, selector, session=session):
                    if collection == "purchase_orders" and any(item.get("stage") != "po_final" for item in document.get("items", [])):
                        raise ImportConflict("Historical import produced a non PO-final purchase item")
                    if collection == "payments" and document.get("status") != "pending":
                        raise ImportConflict("Historical import must never fabricate completed payments")
                    inventory.append({"collection": collection, "id": document["id"], "fingerprint": fingerprint(document)})
            receipt = {"_id": identity("receipt", manifest["batch_id"]), "id": identity("receipt", manifest["batch_id"]), "event_type": "HistoricalOrderImport", "idempotency_key": f"historical-import:{manifest['batch_id']}", "status": "completed", "manifest_sha256": manifest_sha, "manifest_fingerprint": fingerprint(manifest), "plan_fingerprint": plan["plan_fingerprint"], "floor_id": plan["floor_id"], "actor_id": plan["actor_id"], "created_at": datetime.now(timezone.utc).isoformat(), "documents": inventory, "result": {"orders": len(results), "results": results}}
            await database.event_outbox.insert_one(receipt, session=session)
    await domain_outbox._bump_analytics_versions(domain_outbox.EVENT_ORDER_PLACED)
    from services.analytics import cache

    for collection in ("customers", "referrers", "brands", "products"):
        await cache.bump(collection)
    _private_json(output_dir / f"receipt-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}.json", receipt)
    return {"already_applied": False, "orders": len(results), "backup": str(backup_path), "documents": len(inventory)}


def verify_source_files(manifest: dict, manifest_path: Path) -> None:
    root = Path(manifest.get("source_root") or manifest_path.parent)
    for order in manifest["orders"]:
        source = Path(order["source_file"])
        if not source.is_absolute():
            source = root / source
        if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != order["source_sha256"]:
            raise ImportConflict("A source workbook is missing or differs from its reviewed SHA256")


async def run(args) -> dict:
    from db import client, db

    raw = args.manifest.read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    manifest = json.loads(raw)
    validate_manifest(manifest)
    verify_source_files(manifest, args.manifest)
    if args.apply and (args.expected_db != "buildcon_house" or db.name != args.expected_db or args.manifest_sha != sha):
        raise ImportConflict("Apply requires --expected-db buildcon_house matching the connection and exact --manifest-sha")
    output = (args.output_dir or Path.home() / ".codex" / "private-imports" / manifest["batch_id"]).resolve()
    if output == ROOT.parent or ROOT.parent in output.parents:
        raise ImportConflict("Private import artifacts must remain outside the Git checkout")
    plan = await prepare_plan(db, manifest, sha)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    _private_json(output / f"plan-{stamp}.json", plan)
    if args.apply:
        return await apply_plan(db, client, manifest, sha, plan, output)
    return {"dry_run": True, "already_applied": bool(plan.get("already_applied")), "manifest_sha256": sha, "orders": len(manifest["orders"]), "new_products": len(plan.get("new_products", [])), "customers": len(plan.get("customers", [])), "plan": str(output / f"plan-{stamp}.json")}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-db")
    parser.add_argument("--manifest-sha")
    args = parser.parse_args()
    try:
        result = asyncio.run(run(args))
    except (ImportConflict, ValueError) as exc:
        parser.exit(2, f"Import refused: {exc}\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
