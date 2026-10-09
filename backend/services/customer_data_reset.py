"""Explicit, one-time customer reset; never a schema migration or demo seed.

Run only after every writer has been deployed in maintenance mode. The reset
receipt contains counts, not customer identities. Catalog and stock quantities
are untouched; customer provenance on stock is anonymized.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone

from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern


def customer_reset_maintenance() -> bool:
    return os.environ.get("FORGE_CUSTOMER_RESET_MAINTENANCE", "").lower() == "true"


# These collections contain customer workflows, including deleted/legacy rows.
CUSTOMER_COLLECTIONS = (
    "customers", "quotations", "quotation_shares", "customer_orders", "walkins", "followups",
    "payments", "ready_batches", "dispatches", "chalans",
    "purchase_shortages", "purchase_transfers", "godown_customer_transfers",
)
CUSTOMER_ENTITY_TYPES = (
    "customer", "quotation", "purchase", "purchase_order", "payment", "followup",
    "walkin", "walk_in", "tile_customer_order", "customer_order", "dispatch",
    "chalan", "tile_movement", "godown_transfer",
)
CUSTOMER_LINK = r"^/(?:\(admin\)/)?(?:quotations|customers|purchases|payments|followups|walkins|tiles/orders)(?:[/?]|$)"


def related_customer_query() -> dict:
    return {"$or": [
        {field: {"$exists": True, "$nin": [None, ""]}}
        for field in ("customer_id", "customer_name", "quotation_id", "customer_order_id")
    ]}


async def reset_customer_data(database, client, *, request_id: str) -> dict:
    """Atomic customer/transaction cleanup with a durable replay guard.

    Config variables deliberately require two deployments: maintenance first,
    then the reset request. Never set both on an actively serving old build.
    """
    if not customer_reset_maintenance():
        raise RuntimeError("Customer reset requires all writers in maintenance mode")
    if request_id != "customer-reset-20261010":
        raise ValueError("Unrecognized customer reset request")
    receipt_id = "customer_data_reset:" + request_id

    async def operation(session):
        prior = await database.settings.find_one({"id": receipt_id}, session=session)
        if prior:
            return {**prior["receipt"], "already_applied": True}
        deleted = {}
        customer_names = [row["name"] async for row in database.customers.find(
            {}, {"name": 1}, session=session) if len(row.get("name") or "") >= 3]
        name_pattern = "|".join(re.escape(name) for name in customer_names)
        purchase_ids = [row["id"] async for row in database.purchase_orders.find(
            related_customer_query(), {"id": 1}, session=session) if row.get("id")]
        storage_keys = []
        async for purchase in database.purchase_orders.find(related_customer_query(), session=session):
            for attachment in purchase.get("attachments", []):
                key = attachment.get("storage_key")
                if key and key.startswith("purchase-orders/" + purchase.get("id", "") + "/"):
                    storage_keys.append(key)
        async for share in database.quotation_shares.find({}, session=session):
            key = share.get("storage_key")
            if key and key.startswith("quotation-shares/"):
                storage_keys.append(key)
        # Delete queued events in the same transaction as their source records,
        # so a later deployment cannot recreate the workflows.
        queries = {name: {} for name in CUSTOMER_COLLECTIONS}
        queries.update({
            "purchase_orders": related_customer_query(),
            "material_movements": {"$or": [related_customer_query(),
                {"purchase_order_id": {"$in": purchase_ids}}]},
            "event_outbox": {"event_type": {"$in": ["QuotationGenerated", "OrderPlaced",
                "PurchaseTransferred", "PurchaseChalanLifecycle"]}},
            "activity_events": {"$or": [related_customer_query(),
                {"entity_type": {"$in": list(CUSTOMER_ENTITY_TYPES)}},
                {"purchase_id": {"$in": purchase_ids}}]},
            "notifications": {"$or": [{"link": {"$regex": CUSTOMER_LINK}},
                *([{"$and": [
                    {"link": {"$regex": r"^/(?:\(admin\)/)?godown-stock(?:[/?]|$)"}},
                    {"$or": [{field: {"$regex": name_pattern}} for field in ("title", "body")]},
                ]}] if name_pattern else [])]},
            # Accounts and credentials stay intact. Close existing sessions so
            # an old open editor cannot re-save a removed customer snapshot.
            "user_sessions": {},
            "download_tokens": {"$or": [{"kind": "customer"},
                {"target": {"$regex": r"^/api/(?:quotations|purchases|tiles)"}}]},
        })
        for name, query in queries.items():
            deleted[name] = (await database[name].delete_many(query, session=session)).deleted_count
        # Retain stock and its numerical accounting; remove customer snapshots
        # and references to the transactions that have just been deleted.
        stock_modified = 0
        async for stock in database.godown_stock.find({}, session=session):
            remove = {key: "" for key in (
                "source_customer_id", "source_customer_name", "source_quotation_id",
                "source_purchase_order_id", "source_purchase_item_id", "payment_id",
            ) if key in stock}
            allocations = []
            for allocation in stock.get("allocations", []):
                allocations.append({key: value for key, value in allocation.items()
                    if key not in {"customer_id", "customer_name", "quotation_id",
                        "purchase_order_id", "purchase_item_id", "customer_phone",
                        "customer_address", "project_name", "notes", "quotation_number"}})
            update = {}
            if remove:
                update["$unset"] = remove
            if allocations != stock.get("allocations", []):
                update["$set"] = {"allocations": allocations}
            if stock.get("source_customer_id") and "reason" in stock:
                update.setdefault("$unset", {})["reason"] = ""
            if update:
                stock_modified += (await database.godown_stock.update_one(
                    {"_id": stock["_id"]}, update, session=session)).modified_count
        # Saved customer filters otherwise keep deleted identifiers on the UI.
        saved_views = await database.followup_saved_views.update_many(
            {"filters.customer_id": {"$exists": True}},
            {"$unset": {"filters.customer_id": ""}}, session=session,
        )
        receipt = {"request_id": request_id, "completed_at": datetime.now(timezone.utc).isoformat(),
            "deleted": deleted, "stock_rows_anonymized": stock_modified,
            "saved_views_cleared": saved_views.modified_count, "already_applied": False,
            "pending_private_files": sorted(set(storage_keys))}
        await database.settings.insert_one({"id": receipt_id, "receipt": receipt}, session=session)
        return receipt

    async with await client.start_session() as session:
        return await session.with_transaction(operation, read_concern=ReadConcern("snapshot"),
            write_concern=WriteConcern("majority"))


async def cleanup_reset_files(database, storage, *, bucket: str, receipt: dict) -> dict:
    """Retryable external cleanup after the MongoDB commit; no catalog access."""
    keys = receipt.get("pending_private_files", [])
    for key in keys:
        await storage.delete(bucket=bucket, key=key)
    safe_receipt = {key: value for key, value in receipt.items() if key != "pending_private_files"}
    safe_receipt["private_files_deleted"] = receipt.get("private_files_deleted", len(keys))
    await database.settings.update_one({"id": "customer_data_reset:" + receipt["request_id"]},
        {"$set": {"receipt": safe_receipt}})
    return safe_receipt
