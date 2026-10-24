"""Owner-reviewed deletion of one customer graph, never a database reset.

Plans use canonical IDs and explicit import edges, never names or phone numbers.
Every Mongo mutation commits together. Private object cleanup is durable and
retryable; storage downtime cannot keep the removed data visible in the app.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import hmac
import json
import logging

from fastapi import HTTPException
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from models import now_iso
from services.purchase_stages import active_quantity, dispatched_chalan_quantity, normalized_stage
from settings import settings

LIMIT = 10000
logger = logging.getLogger(__name__)


async def rows(database, collection, query, session=None):
    result = await database[collection].find(query, session=session).to_list(LIMIT + 1)
    if len(result) > LIMIT:
        raise HTTPException(409, "This customer has too many related records for one deletion. Contact support.")
    return sorted(result, key=lambda row: str(row.get("_id", row.get("id", ""))))


def any_of(*branches):
    return {"$or": list(branches)} if branches else {"_id": {"$in": []}}


def in_ids(field, values):
    return {field: {"$in": sorted(values)}}


def selector(row):
    # _id is present on real Mongo rows. The fallback supports legacy test
    # fixtures while still binding a public ID to its exact floor.
    if "_id" in row:
        return {"_id": row["_id"]}
    return {"id": row["id"], "floor_id": row.get("floor_id")}


async def customer_ids(database, customer_id, session=None):
    found, pending = set(), {customer_id}
    while pending:
        found.update(pending)
        if len(found) > 1000:
            raise HTTPException(409, "Too many linked customer profiles to delete together")
        profiles = await rows(database, "customers", any_of(
            in_ids("id", pending), in_ids("imported_from_customer_id", pending)), session)
        parents = {row["imported_from_customer_id"] for row in profiles if row.get("imported_from_customer_id")}
        imports = await rows(database, "activity_events", {"event_type": "customer.imported", "$or": [
            in_ids("customer_id", pending), in_ids("payload.source_customer_id", pending)]}, session)
        linked = {row["id"] for row in profiles}
        for event in imports:
            linked.update(value for value in (event.get("customer_id"), (event.get("payload") or {}).get("source_customer_id")) if value)
        pending = (linked | parents) - found
    return found


def _snapshot_token(plan, actor_id):
    # Only hashes leave the service; no private row or contact enters a token.
    payload = json.dumps({"actor": actor_id, "target": plan["target"], "delete": plan["delete"],
                          "updates": plan["updates"], "files": plan["files"]},
                         sort_keys=True, default=str, separators=(",", ":")).encode()
    return hmac.new(settings.jwt_secret.encode(), payload, hashlib.sha256).hexdigest()


def _owned_line(item, po, customers, quotations):
    if item.get("customer_id"):
        return item["customer_id"] in customers
    if item.get("quotation_id"):
        return item["quotation_id"] in quotations
    return po.get("customer_id") in customers or po.get("quotation_id") in quotations


def _delivered_quantity(po, item):
    quantity = active_quantity(item)
    if normalized_stage(item, po) == "dispatched":
        return quantity
    # Partial chalans can exist before the remaining item changes stage.
    return min(quantity, max(dispatched_chalan_quantity(po, item),
        float(item.get("qty_dispatched") or 0), float(item.get("qty_delivered") or 0),
        float(item.get("boxes_dispatched") or 0)))


def _redact_customer_links(value, customers):
    if isinstance(value, list):
        return [_redact_customer_links(item, customers) for item in value]
    if not isinstance(value, dict):
        return value
    result = {key: _redact_customer_links(item, customers) for key, item in value.items()}
    for field, identity in value.items():
        if (field == "customer_id" or field.endswith("_customer_id")) and isinstance(identity, str) and identity in customers:
            prefix = field[:-3]
            for key in (field, *(prefix + suffix for suffix in ("_name", "_phone", "_address", "_email")),
                        "reason", "note", "summary", "borrowing_note"):
                result.pop(key, None)
    return result


def _surviving_chalans(po, kept):
    ids = {item["id"] for item in kept}
    result = []
    for chalan in po.get("chalans", []):
        lines = [line for line in chalan.get("items", []) if line.get("po_item_id") in ids]
        if not lines:
            continue
        survivor = {**chalan, "items": lines}
        if len(lines) != len(chalan.get("items", [])):
            # Mixed receipt free text can contain the removed customer's
            # address. Preserve the surviving lines and dispatch evidence.
            for key in ("receiver_name", "remarks", "dispatch_note"):
                survivor.pop(key, None)
        result.append(survivor)
    return result


async def plan_deletion(database, *, customer_id=None, quotation=None, furniture_ids=(), session=None):
    async def fetch(collection, query, session=None):
        # Ordinary document deletion retains floor isolation even for malformed
        # legacy children. Customer removal is explicitly owner cross-floor.
        if quotation and collection not in {"event_outbox", "whatsapp_status_events"}:
            query = {"$and": [query, {"floor_id": quotation["floor_id"]}]}
        return await rows(database, collection, query, session)

    customers = await customer_ids(database, customer_id, session) if customer_id else set()
    target = customer_id or quotation["id"]
    quotation_rows = await fetch("quotations", in_ids("customer_id", customers), session) if customers else [quotation]
    quotes = {row["id"] for row in quotation_rows}
    scope = any_of(in_ids("customer_id", customers), in_ids("quotation_id", quotes))
    plan = {"target": target, "delete": {"quotations": quotation_rows}, "updates": {}, "files": []}
    deletes, updates = plan["delete"], plan["updates"]
    if customer_id:
        deletes["customers"] = await fetch("customers", in_ids("id", customers), session)
        for collection in ("customer_orders", "furniture_quotations", "kitchen_projects"):
            deletes[collection] = await fetch(collection, scope, session)
        # Old furniture ledgers have names/phones but no canonical foreign key.
        # Similar contacts are candidates only. The owner must select exact
        # document IDs and receive a fresh preview before any deletion.
        from services.quotation_shares import whatsapp_phone
        phones = {whatsapp_phone(row.get("phone")) for row in deletes["customers"]} - {None}
        legacy = await fetch("furniture_quotations", {"floor_id": "third-floor", "$or": [
            {"customer_id": {"$exists": False}}, {"customer_id": None}, {"customer_id": ""}]}, session)
        candidates = [row for row in legacy if phones and whatsapp_phone(row.get("customer_phone")) in phones]
        candidate_ids = {row["id"] for row in candidates}
        selected = set(furniture_ids)
        if not selected <= candidate_ids:
            raise HTTPException(409, "A selected furniture quotation changed or is no longer a matching unlinked record. Review the summary again.")
        deletes["furniture_quotations"].extend(row for row in candidates if row["id"] in selected)
        plan["furniture_candidates"] = [{"id": row["id"], "customer_name": row.get("customer_name"),
            "customer_phone": row.get("customer_phone"), "total_payable_rmb": row.get("total_payable_rmb"),
            "selected": row["id"] in selected} for row in candidates]
        plan["selected_furniture_ids"] = sorted(selected)
    orders = {row["id"] for row in deletes.get("customer_orders", [])}
    projects = {row["id"] for row in deletes.get("kitchen_projects", [])}
    furniture = {row["id"] for row in deletes.get("furniture_quotations", [])}
    # Parent POs can contain independent customers' lines after a transfer.
    # Remove only owned lines; retain/reprice the supplier document if shared.
    purchases = await fetch("purchase_orders", any_of(scope, in_ids("customer_order_id", orders),
        in_ids("items.customer_id", customers)), session)
    deletes["purchase_orders"], updates["purchase_orders"] = [], []
    deleted_po_ids = set()
    for po in purchases:
        kept = [item for item in po.get("items", []) if not _owned_line(item, po, customers, quotes)]
        if not kept:
            deletes["purchase_orders"].append(po)
            deleted_po_ids.add(po["id"])
        elif kept != po.get("items", []):
            patch = {"items": kept, "subtotal": round(sum(float(i.get("qty") or 0) * float(i.get("unit_cost") or 0) for i in kept), 2)}
            patch["grand_total"] = patch["subtotal"]
            patch["chalans"] = _surviving_chalans(po, kept)
            if po.get("customer_id") in customers or po.get("quotation_id") in quotes:
                patch.update(customer_id="", customer_name="Shared supplier purchase", quotation_id=None,
                             quotation_number=None, customer_order_id=None, project_id=None, project_name=None,
                             internal_notes=None, status_history=[{key: value for key, value in event.items() if key != "note"}
                                 for event in po.get("status_history", [])])
            updates["purchase_orders"].append((po, {"$set": patch}))
    related = any_of(scope, in_ids("customer_order_id", orders), in_ids("purchase_order_id", deleted_po_ids),
                     in_ids("purchase_id", deleted_po_ids), in_ids("po_id", deleted_po_ids))
    for collection in ("payments", "followups", "walkins", "ready_batches", "dispatches", "chalans", "material_movements", "purchase_shortages"):
        deletes[collection] = await fetch(collection, related, session)
    for collection in ("quotation_shares",):
        deletes[collection] = await fetch(collection, scope, session)
    source_ids = quotes | furniture
    deletes["whatsapp_deliveries"] = await fetch("whatsapp_deliveries", in_ids("source_id", source_ids), session)
    message_ids = {row["message_id"] for row in deletes["whatsapp_deliveries"] if row.get("message_id")}
    deletes["whatsapp_status_events"] = await fetch("whatsapp_status_events", in_ids("message_id", message_ids), session)
    deletes["event_outbox"] = await fetch("event_outbox", any_of(
        in_ids("payload.quotation_id", quotes), in_ids("payload.customer_id", customers),
        in_ids("payload.po_id", deleted_po_ids), in_ids("payload.customer_order_id", orders)), session)
    entity_ids = customers | quotes | furniture | projects | deleted_po_ids | orders
    deletes["activity_events"] = await fetch("activity_events", any_of(related, in_ids("entity_id", entity_ids),
        in_ids("payload.source_customer_id", customers), in_ids("payload.recipient_customer_id", customers)), session)
    # Notification links bind exact IDs. Never delete an entire section's
    # notices or match human names that another customer may share.
    import re
    link_pattern = r"(?:^|/)(?:" + "|".join(re.escape(str(value)) for value in sorted(entity_ids)) + r")(?:[/?#]|$)"
    deletes["notifications"] = await fetch("notifications", any_of(related,
        {"link": {"$regex": link_pattern}} if entity_ids else {"_id": {"$in": []}}), session)
    if customers:
        deletes["user_sessions"] = await fetch("user_sessions", {"user_type": "customer", "user_id": {"$in": sorted(customers)}}, session)
        deletes["download_tokens"] = await fetch("download_tokens", {"kind": "customer", "user_id": {"$in": sorted(customers)}}, session)
        updates["followup_saved_views"] = [(row, {"$unset": {"filters.customer_id": ""}})
            for row in await fetch("followup_saved_views", in_ids("filters.customer_id", customers), session)]
        deletes["kitchen_file_transfers"] = await fetch("kitchen_file_transfers", in_ids("project_id", projects), session)
        transfer_ids = {row["transfer_id"] for row in deletes["kitchen_file_transfers"]}
        # Byte chunks are never copied into the plan or confirmation digest.
        parts = await database.kitchen_file_parts.find(in_ids("transfer_id", transfer_ids), {"data": 0}, session=session).to_list(LIMIT + 1)
        if len(parts) > LIMIT:
            raise HTTPException(409, "Too many unfinished file parts to delete together")
        deletes["kitchen_file_parts"] = sorted(parts, key=lambda row: str(row["_id"]))
    # A transfer shared with another customer remains their inventory history;
    # remove this customer's identity/snapshots without inventing a stock return.
    for collection in ("purchase_transfers", "godown_customer_transfers"):
        fields = ("source_customer_id", "destination_customer_id", "recipient_customer_id")
        transfers = await fetch(collection, any_of(*(in_ids(field, customers) for field in fields),
            in_ids("recipient_quotation_id", quotes)), session)
        deletes[collection], updates[collection] = [], []
        for transfer in transfers:
            endpoints = {transfer.get(field) for field in fields} - {None, ""}
            if endpoints and endpoints <= customers:
                deletes[collection].append(transfer)
            else:
                unset = {"reason": "", "note": ""}
                for prefix in ("source", "destination", "recipient"):
                    if transfer.get(prefix + "_customer_id") in customers:
                        unset.update({key: "" for key in transfer if key.startswith(prefix + "_") and key not in {prefix + "_item_id"}})
                updates[collection].append((transfer, {"$unset": unset}))
        transfer_ids = {row["id"] for row in transfers}
        pending_transfers = await fetch("event_outbox", in_ids("payload.transfer_id", transfer_ids), session)
        known = {str(row.get("_id", row.get("id"))) for row in deletes["event_outbox"]}
        deletes["event_outbox"].extend(row for row in pending_transfers if str(row.get("_id", row.get("id"))) not in known)
    stocks = await fetch("godown_stock", any_of(in_ids("source_customer_id", customers), in_ids("source_purchase_order_id", deleted_po_ids),
        in_ids("source_quotation_id", quotes), in_ids("allocations.customer_id", customers), in_ids("allocations.quotation_id", quotes)), session)
    updates["godown_stock"] = []
    source_stocks = set()
    for stock in stocks:
        allocations, released = [], 0.0
        for allocation in stock.get("allocations", []):
            if allocation.get("customer_id") in customers or allocation.get("quotation_id") in quotes:
                # An open quotation's reservation can be reused. Fulfilled
                # material remains physical history: do not fabricate a return.
                quote = next((q for q in quotation_rows if q["id"] == allocation.get("quotation_id")), {})
                qty = float(allocation.get("qty") or 0)
                backing = [(po, item) for po in purchases for item in po.get("items", [])
                    if item.get("godown_allocation_id") == allocation.get("id")]
                consumed = sum(_delivered_quantity(po, item) for po, item in backing)
                released += max(0, qty - consumed) if quote.get("status") in {"draft", "sent", "approved"} or backing else 0
            else:
                allocations.append(allocation)
        update = {"$set": {"allocations": allocations}}
        if released:
            update["$inc"] = {"available_qty": released}
        if stock.get("source_customer_id") in customers or stock.get("source_quotation_id") in quotes or stock.get("source_purchase_order_id") in deleted_po_ids:
            source_stocks.add(stock["id"])
            update["$unset"] = {key: "" for key in ("source_customer_id", "source_customer_name", "source_quotation_id",
                "source_purchase_order_id", "source_purchase_item_id", "payment_id", "reason")}
        updates["godown_stock"].append((stock, update))
    # Surviving product lines retain their actual stock, without a deleted
    # source customer's name propagated into somebody else's quotation.
    for collection in ("quotations", "purchase_orders"):
        if not source_stocks:
            continue
        surviving = await fetch(collection, {"items.godown_stock_id": {"$in": sorted(source_stocks)}}, session)
        removed = {row["id"] for row in deletes.get(collection, [])}
        for row in surviving:
            if row["id"] in removed:
                continue
            prior = next((patch for original, patch in updates.get(collection, []) if original["id"] == row["id"]), None)
            items = deepcopy((prior or {}).get("$set", {}).get("items", row.get("items", [])))
            for item in items:
                if item.get("godown_stock_id") in source_stocks:
                    item.pop("godown_source_customer_name", None)
            if prior:
                prior.setdefault("$set", {})["items"] = items
            else:
                updates.setdefault(collection, []).append((row, {"$set": {"items": items}}))
    if customers:
        # A surviving customer can hold stock borrowed/transferred from the
        # removed identity. Keep their quantities and fulfillment evidence,
        # while removing the exact deleted endpoint from every nested history.
        references = ("items.borrowed_from_customer_id", "items.transferred_from_customer_id",
            "items.customer_loan_history.destination_customer_id", "items.customer_loan_history.source_customer_id")
        for collection, fields in (("purchase_orders", references),
            ("purchase_shortages", ("transferred_to_customer_id",))):
            surviving = await fetch(collection, any_of(*(in_ids(field, customers) for field in fields)), session)
            removed = {str(row.get("_id", row.get("id"))) for row in deletes.get(collection, [])}
            for original in surviving:
                if str(original.get("_id", original.get("id"))) in removed:
                    continue
                prior = next((patch for row, patch in updates.get(collection, []) if row["id"] == original["id"]), None)
                effective = {**original, **((prior or {}).get("$set", {}))}
                for key in (prior or {}).get("$unset", {}):
                    effective.pop(key, None)
                clean = _redact_customer_links(effective, customers)
                patch = prior if prior is not None else {}
                changed = {key: value for key, value in clean.items() if key != "_id" and value != effective.get(key)}
                removed_keys = {key: "" for key in effective.keys() - clean.keys()}
                if changed:
                    patch.setdefault("$set", {}).update(changed)
                if removed_keys:
                    patch.setdefault("$unset", {}).update(removed_keys)
                if prior is None and patch:
                    updates.setdefault(collection, []).append((original, patch))
    for row in deletes.get("quotation_shares", []):
        _file(plan, row, f"quotation-shares/{row.get('quotation_id')}/")
    for row in deletes.get("purchase_orders", []):
        for attachment in row.get("attachments", []):
            from media_storage.factory import private_bucket
            _file(plan, {"bucket": private_bucket(), **attachment}, f"purchase-orders/{row['id']}/")
    for row in deletes.get("kitchen_projects", []):
        for attachment in row.get("attachments", []):
            _file(plan, attachment, f"kitchen/second-floor/{row['id']}/")
    return plan


def _file(plan, row, prefix):
    key = row.get("storage_key")
    if row.get("bucket") and key and key.startswith(prefix) and ".." not in key.split("/"):
        entry = {"bucket": row["bucket"], "key": key}
        if entry not in plan["files"]:
            plan["files"].append(entry)


def public_plan(plan, actor_id):
    return {"customer_id": plan["target"], "confirmation": _snapshot_token(plan, actor_id),
            "counts": {name: len(value) for name, value in plan["delete"].items() if value},
            "shared_records_preserved": sum(len(value) for value in plan["updates"].values()),
            "private_files": len(plan["files"]), "furniture_candidates": plan.get("furniture_candidates", []),
            "selected_furniture_ids": plan.get("selected_furniture_ids", [])}


async def apply_plan(database, plan, session):
    for collection, changes in plan["updates"].items():
        for original, update in changes:
            await database[collection].update_one(selector(original), update, session=session)
    counts = {}
    # Delete exact observed row identities, never an empty/broad collection
    # selector. Source rows last cause concurrent CAS writers to conflict.
    for collection, documents in plan["delete"].items():
        counts[collection] = 0
        if documents:
            result = await database[collection].delete_many(any_of(*(selector(document) for document in documents)), session=session)
            counts[collection] = result.deleted_count
    return counts


async def delete_customer_graph(database, client, customer_id, actor_id, confirmation, furniture_ids=()):
    async def operation(session):
        receipt_id = "customer-deletion:" + customer_id
        previous = await database.settings.find_one({"id": receipt_id}, session=session)
        if previous:
            return {"ok": True, "customer_id": customer_id, "deleted": previous["deleted"], "already_deleted": True}
        plan = await plan_deletion(database, customer_id=customer_id, furniture_ids=furniture_ids, session=session)
        if not plan["delete"].get("customers"):
            raise HTTPException(404, "Customer not found")
        if not confirmation or not hmac.compare_digest(confirmation, _snapshot_token(plan, actor_id)):
            raise HTTPException(409, "Customer data changed. Review the deletion summary again before confirming.")
        deleted = await apply_plan(database, plan, session)
        # Counts and actor are retained for accountability. Names, contacts and
        # customer snapshots are never copied into the deletion receipt.
        await database.settings.insert_one({"id": receipt_id, "kind": "customer_deletion_receipt",
            "actor_id": actor_id, "completed_at": now_iso(), "deleted": deleted,
            "pending_private_files": plan["files"]}, session=session)
        return {"ok": True, "customer_id": customer_id, "deleted": deleted}
    async with await client.start_session() as session:
        return await session.with_transaction(operation, read_concern=ReadConcern("snapshot"), write_concern=WriteConcern("majority"))


async def cleanup_deleted_customer_files(database, storage, limit=20):
    receipts = await database.settings.find({"kind": "customer_deletion_receipt", "pending_private_files.0": {"$exists": True}}).limit(limit).to_list(limit)
    for receipt in receipts:
        for entry in receipt["pending_private_files"]:
            try:
                await storage.delete(bucket=entry["bucket"], key=entry["key"])
                await database.settings.update_one({"id": receipt["id"]}, {"$pull": {"pending_private_files": entry}})
            except Exception:
                logger.warning("Private deletion cleanup will retry", exc_info=True)
                break
