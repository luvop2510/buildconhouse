"""One-time sanitary operational reset. Catalog and other floors stay intact.

Run only after all API and background writers have entered maintenance and the
old deployment has drained. A receipt prevents replay against future real data.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from services.customer_data_reset import customer_reset_maintenance

FLOOR = "first-floor"
REQUEST = "sanitary-reset-20261102"
RECEIPT = "sanitary_data_reset:" + REQUEST
# Catalog, staff, floors, permission settings and shared configuration are never
# members of this list. Suppliers/referrers are operational floor contacts.
FLOOR_COLLECTIONS = (
    "customers", "quotations", "quotation_shares", "customer_orders", "walkins", "followups",
    "payments", "purchase_orders", "ready_batches", "dispatches", "chalans",
    "purchase_shortages", "purchase_transfers", "godown_customer_transfers", "material_movements",
    "godown_stock", "godown_stock_media", "activity_events", "notifications", "event_outbox",
    "referrers", "suppliers", "followup_saved_views",
)


def any_ids(fields, ids):
    return [{field: {"$in": ids}} for field in fields] if ids else []


async def make_plan(db, session=None):
    async def fetch(name, query, projection=None):
        return await db[name].find(query, projection, session=session).to_list(None)

    scope = {"floor_id": FLOOR}
    entities = {}
    for name in ("customers", "quotations", "purchase_orders", "customer_orders", "walkins", "godown_stock", "referrers", "suppliers"):
        selector = {**scope, "shared_across_floors": {"$ne": True}} if name == "referrers" else scope
        entities[name] = [r["id"] for r in await fetch(name, selector, {"id": 1}) if r.get("id")]
    customer, quote, purchase, order, walkin, stock, referrer, supplier = (entities[k] for k in entities)
    related = (any_ids(("customer_id", "source_customer_id", "recipient_customer_id", "destination_customer_id", "imported_from_customer_id", "items.customer_id", "allocations.customer_id", "payload.customer_id", "payload.source_customer_id", "payload.recipient_customer_id"), customer)
        + any_ids(("quotation_id", "source_quotation_id", "recipient_quotation_id", "items.quotation_id", "allocations.quotation_id", "payload.quotation_id"), quote)
        + any_ids(("purchase_order_id", "purchase_id", "source_purchase_order_id", "source_po_id", "destination_po_id", "payload.po_id"), purchase)
        + any_ids(("customer_order_id", "payload.customer_order_id"), order)
        + any_ids(("walkin_id",), walkin)
        + any_ids(("stock_id", "godown_stock_id", "items.godown_stock_id", "payload.stock_id"), stock)
        + any_ids(("referrer_id",), referrer) + any_ids(("supplier_id",), supplier))
    # Do not destroy or silently orphan records belonging to another floor.
    # Unscoped legacy outbox/share records are handled by exact identity below.
    guard_names = ("customers", "quotations", "purchase_orders", "customer_orders", "walkins", "followups", "payments", "ready_batches", "dispatches", "chalans", "purchase_shortages", "purchase_transfers", "godown_customer_transfers", "godown_stock", "material_movements", "kitchen_projects", "furniture_quotations")
    if related:
        for name in guard_names:
            foreign = await db[name].find_one({"$and": [{"floor_id": {"$ne": FLOOR}}, {"$or": related}]}, {"_id": 1}, session=session)
            if foreign:
                raise RuntimeError(f"Cross-floor reference in {name}; review before resetting")
    # Supplier IDs must not be referenced by protected catalog records.
    if supplier and await db.products.find_one({"supplier_id": {"$in": supplier}}, {"_id": 1}, session=session):
        raise RuntimeError("Catalog references a sanitary supplier; review before resetting")

    queries = {name: scope for name in FLOOR_COLLECTIONS}
    # Shared contacts are used by other workspaces. Hide them on Sanitary
    # rather than deleting those identities from every floor.
    queries["referrers"] = {**scope, "shared_across_floors": {"$ne": True}}
    scoped_or_legacy = {"$in": [FLOOR, None]}
    for name in ("quotation_shares", "event_outbox", "activity_events"):
        queries[name] = {"$and": [{"floor_id": scoped_or_legacy}, {"$or": [scope, *related]}]}
    deliveries = await fetch("whatsapp_deliveries", {"source_id": {"$in": quote}}, {"message_id": 1})
    message_ids = [x["message_id"] for x in deliveries if x.get("message_id")]
    queries["whatsapp_deliveries"] = {"source_id": {"$in": quote}}
    queries["whatsapp_status_events"] = {"message_id": {"$in": message_ids}}
    # Every open editor is invalidated, including old clients, before normal
    # service resumes. Download tokens are short-lived and can be recreated.
    queries["user_sessions"] = {}
    queries["download_tokens"] = {}
    queries["settings"] = {"floor_id": FLOOR, "kind": {"$in": ["godown_transfer_completion", "payment_reversal_receipt", "stock_deletion_receipt", "stock_movement_deletion_receipt", "stock_count_deletion_receipt"]}}
    product_ids = [r["id"] for r in await fetch("products", scope, {"id": 1}) if r.get("id")]
    queries["product_usage"] = {"product_id": {"$in": product_ids}}

    files = []
    media = await fetch("godown_stock_media", scope)
    keys = [row.get("storage_key") for row in media if row.get("storage_key")]
    shared = set()
    if keys:
        for row in await fetch("product_media", {"storage_key": {"$in": keys}}, {"storage_key": 1}):
            shared.add(row.get("storage_key"))
        for row in await fetch("godown_stock_media", {"floor_id": {"$ne": FLOOR}, "storage_key": {"$in": keys}}, {"storage_key": 1}):
            shared.add(row.get("storage_key"))
        # Product documents can contain direct image URLs in several legacy
        # and denormalized fields, without a corresponding product_media row.
        image_fields = ("images", "hero_image_url", "dimension_image_urls", "seat_cover_image_urls", "gallery.url", "variants.image", "variants.images")
        projection = {field: 1 for field in image_fields}
        def strings(value):
            if isinstance(value, str):
                yield value
            elif isinstance(value, dict):
                for child in value.values():
                    yield from strings(child)
            elif isinstance(value, list):
                for child in value:
                    yield from strings(child)
        for row in await fetch("products", {"$or": [{field: {"$regex": "godown/"}} for field in image_fields]}, projection):
            for image in strings(row):
                shared.update(key for key in keys if key in image)
        # Historic images on another floor may only be saved as URLs, without
        # retaining the stock id. Preserve those images as well.
        for name, fields in (("quotations", ("items.image",)),
                             ("purchase_orders", ("items.image",)),
                             ("godown_stock", ("image",))):
            selector = {"floor_id": {"$ne": FLOOR}, "$or": [{field: {"$regex": "godown/"}} for field in fields]}
            for row in await fetch(name, selector, {field: 1 for field in fields}):
                for image in strings(row):
                    shared.update(key for key in keys if key in image)
    for row in media:
        key, bucket = row.get("storage_key"), row.get("bucket")
        if not key or not bucket or not key.startswith("godown/") or ".." in key.split("/"):
            raise RuntimeError("Unrecognized stock media key; review before resetting")
        if key in shared:
            continue
        files.append({"provider": "current", "bucket": bucket, "key": key})
        # Old account can contain the same object even after a copy to R2.
        files.append({"provider": "legacy", "bucket": bucket, "key": key})
    for row in await fetch("purchase_orders", scope):
        for entry in row.get("attachments", []):
            key = entry.get("storage_key")
            if key:
                if not key.startswith("purchase-orders/" + row["id"] + "/") or ".." in key.split("/"):
                    raise RuntimeError("Unrecognized purchase attachment key")
                files.append({"provider": "current", "bucket": entry.get("bucket"), "key": key})
    for row in await fetch("quotation_shares", queries["quotation_shares"]):
        key = row.get("storage_key")
        if key:
            if not key.startswith("quotation-shares/" + row["quotation_id"] + "/") or ".." in key.split("/"):
                raise RuntimeError("Unrecognized quotation share key")
            files.append({"provider": "current", "bucket": row.get("bucket"), "key": key})
    if any(not f["bucket"] for f in files):
        raise RuntimeError("File bucket missing; review before resetting")
    counts = {name: await db[name].count_documents(query, session=session) for name, query in queries.items()}
    counts["shared_referrers_hidden"] = await db.referrers.count_documents(
        {"shared_across_floors": True, "excluded_floor_ids": {"$ne": FLOOR}}, session=session)
    return {"queries": queries, "counts": counts, "files": files, "customer_ids": customer}


async def apply_reset(db, client):
    if not customer_reset_maintenance():
        raise RuntimeError("Reset requires maintenance across all writers")
    async def transaction(session):
        existing = await db.settings.find_one({"id": RECEIPT}, session=session)
        if existing:
            return existing
        plan = await make_plan(db, session)
        for name, query in plan["queries"].items():
            await db[name].delete_many(query, session=session)
        await db.referrers.update_many({"shared_across_floors": True},
            {"$addToSet": {"excluded_floor_ids": FLOOR}}, session=session)
        if plan["customer_ids"]:
            await db.followup_saved_views.update_many({"filters.customer_id": {"$in": plan["customer_ids"]}}, {"$unset": {"filters.customer_id": ""}}, session=session)
        receipt = {"id": RECEIPT, "kind": "sanitary_reset_receipt", "completed_at": datetime.now(timezone.utc).isoformat(), "deleted": plan["counts"], "pending_files": plan["files"]}
        await db.settings.update_one({"id": "customer-reset-generation:first-floor"},
            {"$set": {"generation": REQUEST}}, upsert=True, session=session)
        await db.settings.insert_one(receipt, session=session)
        return receipt
    async with await client.start_session() as session:
        return await session.with_transaction(transaction, read_concern=ReadConcern("snapshot"), write_concern=WriteConcern("majority"))


async def cleanup_files(db, providers):
    """Retry independently; retain failed provider/object pairs without PII logs."""
    receipt = await db.settings.find_one({"id": RECEIPT})
    if not receipt:
        raise RuntimeError("Reset receipt not found")
    semaphore = asyncio.Semaphore(8)
    async def remove(entry):
        try:
            async with semaphore:
                await providers[entry["provider"]].delete(bucket=entry["bucket"], key=entry["key"])
                await db.settings.update_one({"id": RECEIPT}, {"$pull": {"pending_files": entry}})
            return 0
        except Exception:
            return 1
    return sum(await asyncio.gather(*(remove(entry) for entry in receipt.get("pending_files", []))))
