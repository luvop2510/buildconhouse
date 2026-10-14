"""Import reviewed workbook snapshots as open Sanitary Bathroom quotations.

Private JSON: batch_id, floor_id=first-floor, actor_id, quotations, optional
new_brands/new_products/new_media. Each quotation has source_file/source_sha256,
customer, items and subtotal/discount_total/grand_total. Source dates may be
absent. Each item has sheet/row, sku/name/brand_name/category_id, optional exact
product_id, mrp/qty/unit_price/discount_pct/net_amount and presentation fields.
An explicit product_id permits a reviewed source-SKU alias; no fuzzy match runs.

Dry run is the default. Apply needs the exact file SHA256 and database name.
This command never places orders, creates payments/POs, sends notifications,
or starts the application. Storage bytes must already be verified; new_media
only registers metadata for newly added catalog products.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from models import ActivityEvent, Brand, CustomerPublic, Product, ProductMedia, Quotation, QuotationLineItem, Referrer, UserPublic  # noqa: E402
from scripts.import_customer_orders import ImportConflict, _customer_match, _private_json, _same_money, fingerprint, normalized_name, normalized_phone  # noqa: E402
from services.pricing import net_amount_list, recalc_quotation_totals  # noqa: E402
from services.quotation_catalog_prices import line_catalog_snapshot  # noqa: E402

LINE_FIELDS = {"sku", "name", "description", "notes", "mrp", "qty", "unit_price", "discount_pct", "net_amount", "category_id", "room", "area", "finish", "colour", "dimension", "image", "exclude_dimension", "included_for_line_id", "included_qty_per_parent"}
CUSTOMER_FIELDS = {"name", "phone", "alternate_phone", "company", "email", "address", "property_name", "city", "state", "pincode", "gstin", "tier", "notes"}
QUOTE_FIELDS = {"notes", "valid_until", "project_name", "phone_snapshot", "address_snapshot", "reference_source", "doc_date", "doc_number", "attended_by", "prepared_by"}
COLLECTIONS = ("customers", "referrers", "brands", "products", "product_media", "quotations", "activity_events", "event_outbox")


def identity(*parts: object) -> str:
    return str(uuid5(NAMESPACE_URL, "forge:quotation-workbook:" + json.dumps(parts, ensure_ascii=False)))


def _line(raw: dict, source_key: str, product_id: str) -> QuotationLineItem:
    return QuotationLineItem(id=identity("line", source_key, raw["sheet"], raw["row"]), product_id=product_id, quantity_unit="Pieces", **{key: value for key, value in raw.items() if key in LINE_FIELDS})


def validate_manifest(manifest: dict) -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", str(manifest.get("batch_id") or "")):
        raise ImportConflict("batch_id must be a short stable identifier")
    if manifest.get("floor_id") != "first-floor" or not manifest.get("actor_id"):
        raise ImportConflict("Only first-floor open quotations with an explicit actor are supported")
    quotes = manifest.get("quotations")
    if not isinstance(quotes, list) or not 1 <= len(quotes) <= 30:
        raise ImportConflict("A batch needs between 1 and 30 quotations")
    if sum(len(quote.get("items") or []) for quote in quotes) > 1000:
        raise ImportConflict("Split batches larger than 1000 lines")
    seen_files, seen_hashes = set(), set()
    for quote in quotes:
        source_file, source_sha = quote.get("source_file"), quote.get("source_sha256")
        if not source_file or not re.fullmatch(r"[0-9a-f]{64}", str(source_sha or "")):
            raise ImportConflict("Every quotation requires its source file and SHA256")
        if source_file in seen_files or source_sha in seen_hashes:
            raise ImportConflict("A source workbook may appear only once")
        seen_files.add(source_file); seen_hashes.add(source_sha)
        if quote.get("status", "draft") != "draft" or quote.get("ordered_at"):
            raise ImportConflict("Workbook import only creates open draft quotations")
        for field in ("date", "doc_date", "valid_until"):
            if quote.get(field):
                try:
                    date.fromisoformat(quote[field])
                except (TypeError, ValueError) as exc:
                    raise ImportConflict(f"Invalid {field}: expected YYYY-MM-DD or null") from exc
        if quote.get("date") and quote.get("doc_date") and quote["date"] != quote["doc_date"]:
            raise ImportConflict("Source date conflicts with doc_date")
        customer = quote.get("customer") or {}
        if not normalized_name(customer.get("name")):
            raise ImportConflict("Customer name is required")
        normalized_phone(customer.get("phone"))
        referrer = quote.get("referrer")
        if referrer and (not normalized_name(referrer.get("name")) or referrer.get("type") not in {"architect", "interior_designer"}):
            raise ImportConflict("Structured referrer needs a name and architect/interior_designer type")
        rows, typed = set(), []
        if not quote.get("items"):
            raise ImportConflict("Each quotation requires source product lines")
        for raw in quote["items"]:
            if not raw.get("sheet") or not isinstance(raw.get("row"), int) or isinstance(raw["row"], bool) or raw["row"] < 1:
                raise ImportConflict("Every line requires source sheet and positive row")
            key = (raw["sheet"], raw["row"])
            if key in rows:
                raise ImportConflict("Duplicate source sheet/row in a quotation")
            rows.add(key)
            for field in ("sku", "name", "brand_name", "category_id"):
                if not str(raw.get(field) or "").strip():
                    raise ImportConflict(f"Every line requires {field}")
            for field in ("mrp", "qty", "unit_price", "discount_pct", "net_amount"):
                try:
                    valid = field in raw and math.isfinite(float(raw[field]))
                except (ValueError, TypeError):
                    valid = False
                if not valid:
                    raise ImportConflict(f"Every line requires finite {field}")
            typed.append(_line(raw, source_sha, raw.get("product_id") or "preflight-unresolved"))
        for raw, actual in zip(quote["items"], net_amount_list(typed), strict=True):
            _same_money(actual, raw["net_amount"], f"Source line {raw['sheet']}:{raw['row']} net amount")
        totals = recalc_quotation_totals(typed)
        for field in ("subtotal", "discount_total", "grand_total"):
            if field not in quote:
                raise ImportConflict(f"Missing source {field}")
            _same_money(totals[field], quote[field], field)


async def _rows(database, collection: str, query: dict, *, session=None) -> list[dict]:
    return await database[collection].find(query, {"_id": 0}, session=session).to_list(None)


def _stable(value):
    if isinstance(value, dict):
        return {key: _stable(item) for key, item in value.items() if key not in {"created_at", "updated_at", "plan_fingerprint"}}
    if isinstance(value, list):
        return [_stable(item) for item in value]
    return value


async def verify_receipt(database, receipt: dict, *, session=None) -> None:
    if not receipt.get("documents"):
        raise ImportConflict("Import receipt has no verification inventory")
    for entry in receipt["documents"]:
        current = await database[entry["collection"]].find_one({"id": entry["id"]}, {"_id": 0}, session=session)
        if current is None or fingerprint(current) != entry["fingerprint"]:
            raise ImportConflict(f"An imported {entry['collection']} record changed or is missing; refusing replay")
    ids = receipt["quotation_ids"]
    for collection in ("purchase_orders", "payments", "customer_orders"):
        if await database[collection].find_one({"quotation_id": {"$in": ids}}, {"id": 1}, session=session):
            raise ImportConflict("An imported open quotation has acquired order side effects; refusing replay")


async def prepare_plan(database, manifest: dict, manifest_sha: str, *, session=None) -> dict:
    """Resolve exact floor-local identities without writing any records."""
    validate_manifest(manifest)
    floor = manifest["floor_id"]
    actor_doc = await database.users.find_one({"id": manifest["actor_id"], "active": {"$ne": False}}, {"_id": 0}, session=session)
    if not actor_doc or not await database.floors.find_one({"id": floor}, session=session):
        raise ImportConflict("Configured floor or active actor does not exist")
    actor = UserPublic(**{**actor_doc, "active_floor_id": floor})
    if actor.role not in {"owner", "admin", "manager"} or (actor.role != "owner" and floor not in actor.floor_ids) or actor.access_profile or actor.custom_access:
        raise ImportConflict("Import actor must have unrestricted management access to the exact floor")
    receipt = await database.event_outbox.find_one({"idempotency_key": f"quotation-workbook:{manifest['batch_id']}"}, {"_id": 0}, session=session)
    if receipt:
        if receipt.get("manifest_sha256") != manifest_sha or receipt.get("manifest_fingerprint") != fingerprint(manifest) or receipt.get("status") != "completed":
            raise ImportConflict("Batch already exists with a different manifest or incomplete receipt")
        await verify_receipt(database, receipt, session=session)
        return {"already_applied": True, "receipt": receipt}
    customers = await _rows(database, "customers", {"floor_id": floor}, session=session)
    existing_customers = {row["id"]: dict(row) for row in customers}
    referrers = await _rows(database, "referrers", {"floor_id": floor}, session=session)
    brands = await _rows(database, "brands", {"floor_id": floor}, session=session)
    products = await _rows(database, "products", {"floor_id": floor}, session=session)
    categories = await _rows(database, "categories", {"floor_id": floor}, session=session)
    new_brands, new_products, new_media, new_referrers, quotes = [], [], [], [], []
    category_ids = {row["id"] for row in categories}
    category_by_id = {row["id"]: row for row in categories}
    for raw in manifest.get("new_brands") or []:
        values = {**raw, "floor_id": raw.get("floor_id", floor)}
        values.setdefault("id", identity("brand", floor, normalized_name(values.get("name"))))
        brand = Brand(**values).model_dump()
        if brand["floor_id"] != floor or not brand["name"].strip() or not brand["slug"].strip() or any(row["id"] == brand["id"] or row["slug"] == brand["slug"] or normalized_name(row["name"]) == normalized_name(brand["name"]) for row in brands):
            raise ImportConflict("New brand must have a unique name/slug/id on the batch floor")
        if await database.brands.find_one({"id": brand["id"]}, session=session):
            raise ImportConflict("New brand id is already used on another floor")
        brands.append(brand); new_brands.append(brand)
    brand_by_id = {row["id"]: row for row in brands}
    for raw in manifest.get("new_products") or []:
        values = {**raw, "floor_id": raw.get("floor_id", floor)}
        values.setdefault("id", identity("product", floor, values.get("brand_id"), values.get("sku")))
        product = Product(**values).model_dump()
        for field in ("hero_image_url", "media_summary", "gallery"):
            product.pop(field, None)
        if product["floor_id"] != floor or product["brand_id"] not in brand_by_id or product["category_id"] not in category_ids or not product["active"] or not product["sku"].strip() or not product["name"].strip() or not all(math.isfinite(product[field]) for field in ("mrp", "price")):
            raise ImportConflict("New products need active, existing floor-local brand/category relations")
        if category_by_id[product["category_id"]].get("brand_id") not in (None, product["brand_id"]):
            raise ImportConflict("New product category belongs to a different brand")
        if any(row["id"] == product["id"] or (row["sku"] == product["sku"] and row["brand_id"] == product["brand_id"]) for row in products) or await database.products.find_one({"id": product["id"]}, session=session):
            raise ImportConflict("Proposed new product already exists; use its real product_id")
        products.append(product); new_products.append(product)
    product_by_id = {row["id"]: row for row in products}
    for raw in manifest.get("new_media") or []:
        values = {**raw, "floor_id": raw.get("floor_id", floor), "uploaded_by": actor.id}
        values.setdefault("id", identity("media", values.get("product_id"), values.get("sha1"), values.get("role")))
        media = ProductMedia(**values).model_dump()
        product = next((row for row in new_products if row["id"] == media["product_id"]), None)
        if not product or media["floor_id"] != floor or media.get("family_key") or media.get("brand_id") not in (None, product["brand_id"]) or not media["public_url"] or not media["storage_key"] or not re.fullmatch(r"[0-9a-f]{40}", media["sha1"]):
            raise ImportConflict("New media must belong to a new exact product with verified public storage metadata")
        if any(row["id"] == media["id"] for row in new_media) or await database.product_media.find_one({"id": media["id"]}, session=session):
            raise ImportConflict("Proposed media id already exists")
        new_media.append(media)
    planned_customers = {}
    for source in manifest["quotations"]:
        key = identity(source["source_file"], source["source_sha256"])
        quote_id = identity("quotation", floor, key)
        duplicate = {"$or": [{"id": quote_id}, {"quotation_import.source_file": source["source_file"]}, {"quotation_import.source_sha256": source["source_sha256"]}, {"historical_import.source_file": source["source_file"]}, {"historical_import.source_sha256": source["source_sha256"]}]}
        if await database.quotations.find_one(duplicate, {"id": 1}, session=session):
            raise ImportConflict("Source quotation exists outside this batch receipt")
        referral_fields = {"referrer_id": None, "referrer_name": None, "referrer_type": None}
        if source.get("referrer"):
            ref = source["referrer"]
            matches = [row for row in referrers if row["type"] == ref["type"] and normalized_name(row["name"]) == normalized_name(ref["name"])]
            if len(matches) > 1 or (matches and not matches[0].get("active", True)):
                raise ImportConflict("Referral directory match is ambiguous or archived")
            if matches:
                resolved = matches[0]
                if resolved["name"] != ref["name"]:
                    raise ImportConflict("Referral spelling differs from directory; resolve the reviewed name explicitly")
            else:
                resolved = Referrer(id=identity("referrer", floor, ref["type"], normalized_name(ref["name"])), floor_id=floor, name=ref["name"], type=ref["type"], phone=ref.get("phone"), company=ref.get("company"), normalized_name=ref["name"].strip().casefold(), created_by=actor.id).model_dump()
                referrers.append(resolved); new_referrers.append(resolved)
            referral_fields = {"referrer_id": resolved["id"], "referrer_name": resolved["name"], "referrer_type": resolved["type"]}
        raw_customer = source["customer"]
        if raw_customer.get("id"):
            matches = [row for row in customers if row["id"] == raw_customer["id"]]
            if len(matches) != 1 or not normalized_phone(raw_customer.get("phone")) or normalized_phone(matches[0].get("phone"), validate=False) != normalized_phone(raw_customer["phone"]):
                raise ImportConflict("Explicit customer id must identify an exact floor-local phone match")
            matched = matches[0]
        else:
            matched = _customer_match(raw_customer, customers)
        if matched:
            customer = dict(matched)
            if referral_fields["referrer_id"] and customer.get("referrer_id") not in (None, referral_fields["referrer_id"]):
                raise ImportConflict("Existing customer has conflicting referral attribution")
            if referral_fields["referrer_id"]:
                customer.update(referral_fields)
            else:
                referral_fields = {field: customer.get(field) for field in referral_fields}
            # Source contact/profile details cannot silently overwrite history.
            for field in CUSTOMER_FIELDS - {"name", "phone"}:
                if raw_customer.get(field) and customer.get(field) not in (None, "", raw_customer[field]):
                    raise ImportConflict(f"Existing customer has conflicting {field}")
                if raw_customer.get(field):
                    customer[field] = raw_customer[field]
        else:
            customer = CustomerPublic(id=identity("customer", floor, normalized_name(raw_customer["name"]), normalized_phone(raw_customer.get("phone"))), floor_id=floor, **{field: value for field, value in raw_customer.items() if field in CUSTOMER_FIELDS}, **referral_fields).model_dump()
            if customer.get("email") is None:
                customer.pop("email", None)
            if customer.get("email") and await database.customers.find_one({"email": customer["email"].lower()}, {"id": 1}, session=session):
                raise ImportConflict("Customer email already exists")
            if await database.customers.find_one({"id": customer["id"]}, session=session):
                raise ImportConflict("New customer id already exists on another floor")
            customers.append(customer)
        customers = [customer if row["id"] == customer["id"] else row for row in customers]
        planned_customers[customer["id"]] = {"document": customer, "previous": existing_customers.get(customer["id"])}
        items = []
        for position, raw in enumerate(source["items"]):
            if raw.get("product_id"):
                product = product_by_id.get(raw["product_id"])
            else:
                matches = [row for row in products if row["sku"] == raw["sku"] and normalized_name(brand_by_id.get(row["brand_id"], {}).get("name")) == normalized_name(raw["brand_name"])]
                if len(matches) != 1:
                    raise ImportConflict("Source SKU is absent/ambiguous; supply reviewed exact product_id")
                product = matches[0]
            if not product or not product.get("active", True) or product["category_id"] != raw["category_id"] or normalized_name(brand_by_id.get(product["brand_id"], {}).get("name")) != normalized_name(raw["brand_name"]):
                raise ImportConflict("Source product has invalid floor, brand, category or active status")
            if product["category_id"] not in category_by_id or category_by_id[product["category_id"]].get("brand_id") not in (None, product["brand_id"]):
                raise ImportConflict("Source product category is missing or belongs to a different brand")
            line = _line(raw, key, product["id"]).model_dump()
            line.update(sort_order=position, **line_catalog_snapshot(product))
            line["import_source"] = {"source_file": source["source_file"], "source_sha256": source["source_sha256"], "sheet": raw["sheet"], "row": raw["row"], "source_values": raw.get("source_values", {})}
            items.append(line)
        values = {field: value for field, value in source.items() if field in QUOTE_FIELDS}
        values.setdefault("doc_date", source.get("date"))
        values.setdefault("phone_snapshot", raw_customer.get("phone") or customer.get("phone"))
        values.setdefault("address_snapshot", raw_customer.get("address") or customer.get("address"))
        quote = Quotation(id=quote_id, number=f"IMP-{manifest['batch_id']}-{len(quotes)+1:02d}", floor_id=floor, customer_id=customer["id"], customer_name=raw_customer["name"], status="draft", items=[QuotationLineItem(**line) for line in items], rooms=list(dict.fromkeys(line["room"] for line in items if line.get("room"))), created_by=actor.id, created_by_name=actor.full_name, subtotal=source["subtotal"], discount_total=source["discount_total"], grand_total=source["grand_total"], **values, **referral_fields).model_dump()
        quote["items"] = items
        quote["quotation_import"] = {"batch_id": manifest["batch_id"], "manifest_sha256": manifest_sha, "source_file": source["source_file"], "source_sha256": source["source_sha256"], "source_metadata": source.get("source_metadata", {}), "source_summary": source.get("source_summary", {})}
        if await database.quotations.find_one({"number": quote["number"]}, session=session):
            raise ImportConflict("Import quotation number already exists")
        quotes.append(quote)
    used_products = {line["product_id"] for quote in quotes for line in quote["items"]}
    if any(row["id"] not in used_products for row in new_products) or any(not any(product["brand_id"] == row["id"] for product in new_products) for row in new_brands):
        raise ImportConflict("Manifest contains an unused new product or brand")
    plan = {"batch_id": manifest["batch_id"], "floor_id": floor, "actor_id": actor.id, "actor_name": actor.full_name, "manifest_sha256": manifest_sha, "manifest_fingerprint": fingerprint(manifest), "customers": list(planned_customers.values()), "referrers": new_referrers, "new_brands": new_brands, "new_products": new_products, "new_media": new_media, "quotations": quotes}
    plan["plan_fingerprint"] = fingerprint(_stable(plan))
    return plan


async def backup_before_apply(database, output_dir: Path) -> Path:
    snapshot = {"database": database.name, "created_at": datetime.now(timezone.utc).isoformat(), "collections": {}}
    for collection in (*COLLECTIONS, "purchase_orders", "payments", "customer_orders"):
        snapshot["collections"][collection] = await database[collection].find({}).to_list(None)
    path = output_dir / f"before-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}.json"
    _private_json(path, snapshot)
    return path


async def apply_plan(database, mongo_client, manifest: dict, manifest_sha: str, plan: dict, output_dir: Path) -> dict:
    if plan.get("already_applied"):
        await verify_receipt(database, plan["receipt"])
        return {"already_applied": True, "quotations": len(manifest["quotations"])}
    backup = await backup_before_apply(database, output_dir)
    async with await mongo_client.start_session() as session:
        async with session.start_transaction():
            current = await prepare_plan(database, manifest, manifest_sha, session=session)
            if current.get("already_applied"):
                return {"already_applied": True, "quotations": len(manifest["quotations"])}
            if current["plan_fingerprint"] != plan["plan_fingerprint"]:
                raise ImportConflict("Target data changed after dry-run/backup; regenerate the plan")
            inventory = []
            async def insert(collection, document):
                await database[collection].insert_one({"_id": document["id"], **document}, session=session)
                inventory.append({"collection": collection, "id": document["id"], "fingerprint": fingerprint(document)})
            async def activity(document, collection, event_type):
                is_quote = collection == "quotations"
                event = ActivityEvent(id=identity("activity", manifest["batch_id"], collection, document["id"]), event_type=event_type, entity_type="quotation" if is_quote else "customer", entity_id=document["id"], actor_id=plan["actor_id"], actor_name=plan["actor_name"], floor_id=plan["floor_id"], customer_id=document["customer_id"] if is_quote else document["id"], quotation_id=document["id"] if is_quote else None, summary="Open quotation imported from reviewed workbook" if is_quote else "Customer imported from reviewed workbook", payload={"batch_id": plan["batch_id"]}).model_dump()
                event["automation_key"] = f"quotation-workbook:{manifest['batch_id']}:{collection}:{document['id']}"
                await insert("activity_events", event)
            for collection, field in (("brands", "new_brands"), ("products", "new_products"), ("product_media", "new_media"), ("referrers", "referrers")):
                for document in plan[field]:
                    await insert(collection, document)
            for entry in plan["customers"]:
                customer, previous = entry["document"], entry["previous"]
                if previous is None:
                    await insert("customers", customer)
                    await activity(customer, "customers", "customer.created")
                else:
                    changes = {key: value for key, value in customer.items() if previous.get(key) != value}
                    if changes:
                        await database.customers.update_one({"id": customer["id"], "floor_id": plan["floor_id"]}, {"$set": changes}, session=session)
                        await activity(customer, "customers", "customer.updated")
                    inventory.append({"collection": "customers", "id": customer["id"], "fingerprint": fingerprint(customer)})
            for quote in plan["quotations"]:
                await insert("quotations", quote)
                await activity(quote, "quotations", "quotation.created")
            receipt = {"id": identity("receipt", manifest["batch_id"]), "event_type": "QuotationWorkbookImport", "idempotency_key": f"quotation-workbook:{manifest['batch_id']}", "status": "completed", "manifest_sha256": manifest_sha, "manifest_fingerprint": fingerprint(manifest), "plan_fingerprint": plan["plan_fingerprint"], "floor_id": plan["floor_id"], "actor_id": plan["actor_id"], "created_at": datetime.now(timezone.utc).isoformat(), "documents": inventory, "quotation_ids": [quote["id"] for quote in plan["quotations"]], "result": {"quotations": len(plan["quotations"]), "new_products": len(plan["new_products"])}}
            await database.event_outbox.insert_one({"_id": receipt["id"], **receipt}, session=session)
            await verify_receipt(database, receipt, session=session)
    from services.analytics import cache

    for collection in ("customers", "referrers", "brands", "products", "quotations", "product_media", "activity_events"):
        await cache.bump(collection)
    _private_json(output_dir / f"receipt-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}.json", receipt)
    return {"already_applied": False, "quotations": len(plan["quotations"]), "new_products": len(plan["new_products"]), "backup": str(backup), "documents": len(inventory)}


def verify_source_files(manifest: dict, manifest_path: Path) -> None:
    root = Path(manifest.get("source_root") or manifest_path.parent)
    for quote in manifest["quotations"]:
        path = Path(quote["source_file"])
        if not path.is_absolute():
            path = root / path
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != quote["source_sha256"]:
            raise ImportConflict("Source workbook missing or differs from its reviewed SHA256")


async def run(args) -> dict:
    from db import client, db

    raw = args.manifest.read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    manifest = json.loads(raw)
    validate_manifest(manifest)
    verify_source_files(manifest, args.manifest)
    if args.apply and (args.expected_db != "buildcon_house" or db.name != args.expected_db or args.manifest_sha != sha):
        raise ImportConflict("Apply requires --expected-db buildcon_house matching connection and exact --manifest-sha")
    output = (args.output_dir or Path.home() / ".codex" / "private-imports" / manifest["batch_id"]).resolve()
    if output == ROOT.parent or ROOT.parent in output.parents:
        raise ImportConflict("Private import artifacts must remain outside the checkout")
    plan = await prepare_plan(db, manifest, sha)
    path = output / f"plan-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}.json"
    _private_json(path, plan)
    if args.apply:
        return await apply_plan(db, client, manifest, sha, plan, output)
    return {"dry_run": True, "already_applied": bool(plan.get("already_applied")), "manifest_sha256": sha, "quotations": len(manifest["quotations"]), "new_products": len(plan.get("new_products", [])), "customers": len(plan.get("customers", [])), "plan": str(path)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-db")
    parser.add_argument("--manifest-sha")
    try:
        print(json.dumps(asyncio.run(run(parser.parse_args())), sort_keys=True))
    except (ImportConflict, ValueError, OSError) as exc:
        parser.exit(2, f"Import refused: {exc}\n")


if __name__ == "__main__":
    main()
