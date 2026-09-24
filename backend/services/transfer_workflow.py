"""Transactional, idempotent customer stock loans and transfer history."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError, PyMongoError

from auth import floor_inherit, floor_query
from db import client, db
from models import (
    ActivityEvent, CustomerPublic, Followup, Payment, PurchaseOrder,
    PurchaseOrderItem, PurchaseShortage, PurchaseStageEvent, PurchaseStatusEvent,
    UserPublic,
)
from services.domain_outbox import enqueue_after_primary_commit, resolve_activity_floor_id
from services.sequence import next_number as _atomic_next_number

EVENT_PURCHASE_TRANSFERRED = "PurchaseTransferred"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def ensure_transfer_indexes() -> None:
    await db.purchase_transfers.create_index("idempotency_key", unique=True, name="transfer_idempotency")
    await db.purchase_transfers.create_index([("source_item_id", 1), ("created_at", -1)], name="transfer_source_history")
    await db.purchase_transfers.create_index([("destination_item_id", 1), ("created_at", -1)], name="transfer_destination_history")
    await db.purchase_transfers.create_index([("source_item_id", 1), ("status", 1)], name="transfer_outstanding_loans")
    await db.purchase_shortages.create_index("automation_key", unique=True, sparse=True, name="shortage_automation_key")


async def _next_number(collection: str, prefix: str, session: Any) -> str:
    # BACKEND_AUDIT_2026-07-17.md High #13: was count_documents-then-format
    # (check-then-act race — two concurrent transfers could be handed the
    # same number). Delegates to the atomic findOneAndUpdate counter that
    # quotation_routes.py/domain_outbox.py already use for the primary
    # create/order-placed paths.
    #
    # CRITICAL: `kind` here MUST exactly match what the primary path for the
    # same collection uses ("quotation" / "purchase_order") — transfer-
    # created and normally-created documents share the same number space
    # (both live in `db.quotations` / `db.purchase_orders`), so they must
    # draw from the same counter. Using a different kind string here would
    # give transfers their own independent counter starting at 1, which
    # would re-introduce exactly the duplicate-number bug this fixes.
    kind = "quotation" if collection == "quotations" else "purchase_order"
    year = datetime.now(timezone.utc).year
    stem = f"{prefix}-{year}-"
    return await _atomic_next_number(kind, stem, collection=collection, session=session)


async def _upsert_activity(*, key: str, event_type: str, entity_type: str, entity_id: str, actor_id: str, actor_name: str, customer_id: str, quotation_id: str | None, purchase_id: str | None, summary: str, payload: dict, session: Any) -> None:
    floor_id = await resolve_activity_floor_id(
        quotation_id=quotation_id, purchase_id=purchase_id,
        entity_type=entity_type, entity_id=entity_id,
        customer_id=customer_id, session=session,
    )
    activity = ActivityEvent(event_type=event_type, entity_type=entity_type, entity_id=entity_id, actor_id=actor_id, actor_name=actor_name, customer_id=customer_id, quotation_id=quotation_id, purchase_id=purchase_id, summary=summary, payload=payload, floor_id=floor_id).model_dump()
    activity["automation_key"] = key
    await db.activity_events.update_one({"automation_key": key}, {"$setOnInsert": activity}, upsert=True, session=session)


async def handle_purchase_transferred(event: dict, session: Any) -> dict:
    transfer = await db.purchase_transfers.find_one({"id": event["payload"]["transfer_id"]}, {"_id": 0}, session=session)
    if not transfer:
        raise RuntimeError("Transfer journal entry not found")
    if transfer.get("type") == "loan":
        return await _handle_loan_transfer(event, transfer, session)
    key = event["idempotency_key"]
    dest_quote = await db.quotations.find_one({"id": transfer["destination_quotation_id"]}, {"_id": 0}, session=session)
    source_quote_id = transfer.get("source_quotation_id")
    source_line_id = transfer.get("source_quotation_line_id")

    shortage = None
    if source_quote_id and source_line_id:
        original_quote = await db.quotations.find_one({"id": source_quote_id}, {"_id": 0}, session=session)
        original_line = next((line for line in (original_quote or {}).get("items", []) if line.get("id") == source_line_id), None)
        if original_line:
            committed = float(original_line.get("qty") or 0)
            allocation_rows = await db.purchase_orders.aggregate([
                {"$match": {"items.quotation_line_id": source_line_id}},
                {"$unwind": "$items"},
                {"$match": {"items.quotation_line_id": source_line_id, "items.customer_id": transfer["source_customer_id"]}},
                {"$group": {"_id": None, "total": {"$sum": "$items.qty"}}},
            ], session=session).to_list(1)
            allocated = round(float(allocation_rows[0]["total"]) if allocation_rows else 0.0, 4)
            missing = round(max(0, committed - allocated), 4)
            shortage_key = f"shortage:{source_quote_id}:{source_line_id}:{transfer['source_customer_id']}"
            if missing > 1e-6:
                shortage = PurchaseShortage(
                    customer_id=transfer["source_customer_id"], customer_name=transfer["source_customer_name"], quotation_id=source_quote_id,
                    quotation_number=(original_quote or {}).get("number"), quotation_line_id=source_line_id, product_id=transfer["product_id"], sku=transfer["sku"], name=transfer["name"], image=transfer.get("image"),
                    committed_qty=committed, allocated_qty=allocated, shortage_qty=missing, status="awaiting_reorder",
                    reason=f"{transfer['qty']:g} unit(s) transferred to {transfer['destination_customer_name']} — {missing:g} unit(s) need re-order.",
                    transferred_to_customer_id=transfer["destination_customer_id"], transferred_to_customer_name=transfer["destination_customer_name"],
                    floor_id=floor_inherit(transfer),
                ).dict()
                shortage["automation_key"] = shortage_key
                fields = {k: v for k, v in shortage.items() if k not in {"id", "created_at"}}
                insert_fields = {k: v for k, v in shortage.items() if k not in fields}
                await db.purchase_shortages.update_one(
                    {"automation_key": shortage_key},
                    {"$set": fields, "$setOnInsert": insert_fields},
                    upsert=True,
                    session=session,
                )
            else:
                await db.purchase_shortages.update_one(
                    {"automation_key": shortage_key, "status": "awaiting_reorder"},
                    {"$set": {"status": "resolved", "allocated_qty": allocated, "shortage_qty": 0, "resolved_at": now_iso(), "updated_at": now_iso()}},
                    session=session,
                )

    transfer_payment_amount = round(float(dest_quote.get("grand_total") or 0), 2)
    # See domain_outbox._handle_order_placed's identical fix: Payment.amount
    # is Field(gt=0), so a ₹0 destination quotation would raise a
    # ValidationError here and dead-letter the whole transfer event (rolling
    # back the shortage/allocation writes above too). Skip the Payment
    # entirely rather than trying to represent "nothing outstanding" as a
    # zero-amount one.
    if transfer_payment_amount > 0:
        payment = Payment(
            quotation_id=transfer["destination_quotation_id"], quotation_number=transfer["destination_quotation_number"], customer_id=transfer["destination_customer_id"], customer_name=transfer["destination_customer_name"],
            amount=transfer_payment_amount, mode="bank", status="pending", note=f"Pending balance from transfer {transfer['id']}", recorded_by=event["actor_id"], recorded_by_name=event["actor_name"],
            floor_id=floor_inherit(transfer),
        ).dict()
        # automation payments dedupe via automation_key, so idempotency_key
        # must be omitted rather than left as an explicit None (which
        # collides with payments.payment_idempotency_key's unique *sparse*
        # index after the first transfer-created payment ever inserted).
        payment.pop("idempotency_key", None)
        payment["automation_key"] = f"{key}:payment"
        await db.payments.update_one({"automation_key": payment["automation_key"]}, {"$setOnInsert": payment}, upsert=True, session=session)

    destination_customer = await db.customers.find_one({"id": transfer["destination_customer_id"]}, {"_id": 0}, session=session) or {}
    followup = Followup(
        source_key=f"{key}:followup", rule_type="manual", category="purchase", customer_id=transfer["destination_customer_id"], customer_name=transfer["destination_customer_name"], customer_phone=destination_customer.get("phone"), customer_tier=destination_customer.get("tier", "retail"),
        quotation_id=transfer["destination_quotation_id"], quotation_number=transfer["destination_quotation_number"], purchase_id=transfer["destination_po_id"], purchase_number=transfer["destination_po_number"],
        value=transfer_payment_amount, reason=f"Transferred {transfer['qty']:g} × {transfer['name']} received from {transfer['source_customer_name']}.", next_action="Confirm transfer and payment plan", next_action_reason="Transfer-specific operational follow-up.", suggested_channel="call", due_at=now_iso(), is_automated=False,
        floor_id=floor_inherit(transfer),
    ).dict()
    followup["automation_key"] = f"{key}:followup"
    await db.followups.update_one({"automation_key": followup["automation_key"]}, {"$setOnInsert": followup}, upsert=True, session=session)

    shared = {"transfer_id": transfer["id"], "qty": transfer["qty"], "sku": transfer["sku"], "reason": transfer.get("reason"), "source_remaining_qty": transfer["source_remaining_qty"]}
    await _upsert_activity(key=f"{key}:source-activity", event_type="purchase.transferred_out", entity_type="purchase", entity_id=transfer["source_po_id"], actor_id=event["actor_id"], actor_name=event["actor_name"], customer_id=transfer["source_customer_id"], quotation_id=source_quote_id, purchase_id=transfer["source_po_id"], summary=f"Transferred {transfer['qty']:g} × {transfer['name']} to {transfer['destination_customer_name']}", payload=shared, session=session)
    await _upsert_activity(key=f"{key}:destination-activity", event_type="purchase.transferred_in", entity_type="purchase", entity_id=transfer["destination_po_id"], actor_id=event["actor_id"], actor_name=event["actor_name"], customer_id=transfer["destination_customer_id"], quotation_id=transfer["destination_quotation_id"], purchase_id=transfer["destination_po_id"], summary=f"Received {transfer['qty']:g} × {transfer['name']} from {transfer['source_customer_name']}", payload=shared, session=session)
    await db.purchase_transfers.update_one({"id": transfer["id"]}, {"$set": {"automation_status": "completed", "updated_at": now_iso()}}, session=session)
    return {"transfer_id": transfer["id"], "source": {"po_id": transfer["source_po_id"], "item_id": transfer["source_item_id"], "remaining_qty": transfer["source_remaining_qty"]}, "destination": {"po_id": transfer["destination_po_id"], "po_number": transfer["destination_po_number"], "item_id": transfer["destination_item_id"], "customer_id": transfer["destination_customer_id"], "customer_name": transfer["destination_customer_name"], "quotation_id": transfer["destination_quotation_id"], "quotation_number": transfer["destination_quotation_number"]}, "payment_amount": transfer_payment_amount, "shortage": {"id": shortage["id"], "status": shortage["status"]} if shortage else None}


async def _handle_loan_transfer(event: dict, transfer: dict, session: Any) -> dict:
    """Publish bilateral loan notes without touching quotations or payments."""
    key = event["idempotency_key"]
    shared = {
        "transfer_id": transfer["id"], "loan_status": transfer["status"],
        "qty": transfer["qty"], "sku": transfer["sku"],
        "return_due_on_replenishment": True, "reason": transfer.get("reason"),
    }
    await _upsert_activity(
        key=f"{key}:source-activity", event_type="purchase.lent_out",
        entity_type="purchase", entity_id=transfer["source_po_id"],
        actor_id=event["actor_id"], actor_name=event["actor_name"],
        customer_id=transfer["source_customer_id"],
        quotation_id=transfer.get("source_quotation_id"),
        purchase_id=transfer["source_po_id"],
        summary=f"Lent {transfer['qty']:g} × {transfer['name']} to {transfer['destination_customer_name']}; return due when replacement arrives",
        payload=shared, session=session,
    )
    await _upsert_activity(
        key=f"{key}:destination-activity", event_type="purchase.borrowed_in",
        entity_type="purchase", entity_id=transfer["destination_po_id"],
        actor_id=event["actor_id"], actor_name=event["actor_name"],
        customer_id=transfer["destination_customer_id"],
        quotation_id=None, purchase_id=transfer["destination_po_id"],
        summary=f"Borrowed {transfer['qty']:g} × {transfer['name']} from {transfer['source_customer_name']}; return when ordered product arrives",
        payload=shared, session=session,
    )
    await db.purchase_transfers.update_one(
        {"id": transfer["id"]},
        {"$set": {"automation_status": "completed", "updated_at": now_iso()}},
        session=session,
    )
    return {
        "transfer_id": transfer["id"], "type": "loan", "status": transfer["status"],
        "source": {"po_id": transfer["source_po_id"],
                   "item_id": transfer["source_item_id"],
                   "remaining_qty": transfer["source_remaining_qty"],
                   "loaned_qty": transfer["source_loaned_qty_after"]},
        "destination": {"po_id": transfer["destination_po_id"],
                        "po_number": transfer["destination_po_number"],
                        "item_id": transfer["destination_item_id"],
                        "customer_id": transfer["destination_customer_id"],
                        "customer_name": transfer["destination_customer_name"]},
        "payment_amount": 0, "shortage": None,
        "return_due_on_replenishment": True,
    }


async def transfer_history(item_id: str) -> list[dict]:
    return await db.purchase_transfers.find({"$or": [{"source_item_id": item_id}, {"destination_item_id": item_id}]}, {"_id": 0}).sort("created_at", -1).to_list(200)


async def execute_transfer(
    *, item_id: str, destination_customer_id: str | None, new_customer: dict | None,
    qty: float, reason: str | None, idempotency_key: str | None, user: UserPublic,
) -> dict:
    """Lend In Box stock while preserving the source order and both balances."""
    key = f"purchase-transfer:{idempotency_key or uuid4()}"
    for attempt in range(3):
        prior = await db.event_outbox.find_one({"idempotency_key": key}, {"_id": 0})
        if prior:
            from services.domain_outbox import dispatch_event
            return {"idempotent": True, **await dispatch_event(prior["id"])}
        try:
            event = await _create_loan_transfer(
                item_id=item_id, destination_customer_id=destination_customer_id,
                new_customer=new_customer, qty=qty, reason=reason, key=key, user=user,
            )
            break
        except DuplicateKeyError:
            prior = await db.event_outbox.find_one({"idempotency_key": key}, {"_id": 0})
            if prior:
                from services.domain_outbox import dispatch_event
                return {"idempotent": True, **await dispatch_event(prior["id"])}
            raise
        except PyMongoError as exc:
            if attempt == 2 or not exc.has_error_label("TransientTransactionError"):
                raise
    from services.domain_outbox import dispatch_event
    return {"idempotent": False, **await dispatch_event(event["id"])}


async def _create_loan_transfer(
    *, item_id: str, destination_customer_id: str | None, new_customer: dict | None,
    qty: float, reason: str | None, key: str, user: UserPublic,
) -> dict:
    async with await client.start_session() as session:
        async with session.start_transaction():
            source_po = await db.purchase_orders.find_one(
                floor_query(user, {"items.id": item_id}), {"_id": 0}, session=session,
            )
            if not source_po:
                raise HTTPException(status_code=404, detail="Source item not found")
            item = next((i for i in source_po.get("items", []) if i.get("id") == item_id), None)
            if not item:
                raise HTTPException(status_code=404, detail="Source item not found")
            if item.get("cancelled") or item.get("stage") != "in_box" or item.get("loan_transfer_id"):
                raise HTTPException(status_code=409, detail="Only active In Box products can be transferred")
            source_qty = float(item.get("qty") or 0)
            loaned = float(item.get("loaned_qty") or 0)
            godown_transferred = float(item.get("godown_transferred_qty") or 0)
            available = round(max(0, source_qty - loaned - godown_transferred), 4)
            if qty <= 0 or qty > available:
                raise HTTPException(status_code=400, detail=f"Only {available:g} available for transfer")

            source_customer_id = item.get("customer_id") or source_po.get("customer_id")
            source_customer = await db.customers.find_one(
                floor_query(user, {"id": source_customer_id}), {"_id": 0}, session=session,
            )
            if not source_customer:
                raise HTTPException(status_code=409, detail="Source customer is unavailable")
            destination = None
            created_customer = False
            if destination_customer_id:
                if destination_customer_id == source_customer_id:
                    raise HTTPException(status_code=400, detail="Destination customer must differ from source")
                destination = await db.customers.find_one(
                    floor_query(user, {"id": destination_customer_id}), {"_id": 0}, session=session,
                )
                if not destination:
                    raise HTTPException(status_code=404, detail="Destination customer not found")
            elif new_customer:
                email = (new_customer.get("email") or "").strip().lower() or None
                if email:
                    destination = await db.customers.find_one(
                        {"email": email}, {"_id": 0}, session=session,
                    )
                    if destination and destination.get("floor_id") != floor_inherit(source_po):
                        raise HTTPException(status_code=409, detail="Customer email belongs to another floor")
                if not destination:
                    name = (new_customer.get("name") or "").strip()
                    if not name:
                        raise HTTPException(status_code=400, detail="New customer name is required")
                    destination = CustomerPublic(
                        name=name, company=new_customer.get("company") or None,
                        email=email, phone=new_customer.get("phone") or None,
                        address=new_customer.get("address") or None,
                        city=new_customer.get("city") or None,
                        floor_id=floor_inherit(source_po),
                    ).model_dump()
                    if not email:
                        destination.pop("email", None)
                    await db.customers.insert_one(destination, session=session)
                    created_customer = True
                if destination["id"] == source_customer_id:
                    raise HTTPException(status_code=400, detail="Destination customer must differ from source")
            else:
                raise HTTPException(status_code=400, detail="Choose an existing customer or provide new customer details")

            now = now_iso()
            transfer_id = str(uuid4())
            dest_item_id = str(uuid4())
            dest_name = destination.get("company") or destination.get("name")
            source_name = source_customer.get("company") or source_customer.get("name")
            note_in = f"Borrowed from {source_name}; return when ordered product arrives."
            note_out = f"Lent to {dest_name}; replacement is due when ordered product arrives."
            if reason:
                note_in += f" {reason}"
                note_out += f" {reason}"
            dest_item = PurchaseOrderItem(
                id=dest_item_id, product_id=item["product_id"], sku=item["sku"],
                name=item["name"], image=item.get("image"), finish=item.get("finish"),
                category_id=item.get("category_id"), room=item.get("room"),
                qty=float(qty), unit_cost=0, stage="in_box",
                customer_id=destination["id"], customer_name=dest_name,
                brand_id=item.get("brand_id") or source_po.get("brand_id"),
                brand_name=item.get("brand_name") or source_po.get("brand_name"),
                last_moved_at=now, last_moved_by=user.id, last_moved_by_name=user.full_name,
                transferred_from_item_id=item_id, transferred_from_po_id=source_po["id"],
                transferred_from_customer_id=source_customer_id,
                loan_transfer_id=transfer_id, borrowed_from_customer_id=source_customer_id,
                borrowed_from_customer_name=source_name, return_due_on_replenishment=True,
                loan_return_status="awaiting_return", notes=note_in,
                stage_history=[PurchaseStageEvent(
                    from_stage=None, to_stage="in_box", by_user_id=user.id,
                    by_user_name=user.full_name, note=note_in, action="transfer_in",
                    ref_item_id=item_id, ref_po_id=source_po["id"], qty=float(qty),
                )],
            )
            dest_po = PurchaseOrder(
                number=await _next_number("purchase_orders", "FPO", session),
                customer_id=destination["id"], customer_name=dest_name,
                brand_id=dest_item.brand_id, brand_name=dest_item.brand_name,
                status="draft", items=[dest_item], internal_notes=note_in,
                subtotal=0, grand_total=0, created_by=user.id,
                created_by_name=user.full_name, floor_id=floor_inherit(source_po),
                status_history=[PurchaseStatusEvent(
                    from_status=None, to_status="draft", by_user_id=user.id,
                    by_user_name=user.full_name, note="Created for borrowed stock",
                )],
            )
            source_event = PurchaseStageEvent(
                from_stage="in_box", to_stage="in_box", by_user_id=user.id,
                by_user_name=user.full_name, note=note_out, action="transfer_out",
                ref_item_id=dest_item_id, ref_po_id=dest_po.id, qty=float(qty),
            ).model_dump()
            loan_history_entry = {
                "transfer_id": transfer_id, "qty": float(qty),
                "destination_customer_id": destination["id"],
                "destination_customer_name": dest_name,
                "destination_po_id": dest_po.id,
                "destination_item_id": dest_item_id,
                "created_at": now, "status": "awaiting_return",
            }
            reserve_limit = round(source_qty - godown_transferred - float(qty), 4)
            godown_cas = ({"$or": [{"godown_transferred_qty": {"$exists": False}},
                                   {"godown_transferred_qty": 0}]}
                          if godown_transferred == 0 else
                          {"godown_transferred_qty": godown_transferred})
            result = await db.purchase_orders.update_one(
                floor_query(user, {"id": source_po["id"], "items": {"$elemMatch": {
                    "id": item_id, "stage": "in_box", "cancelled": {"$ne": True},
                    "qty": source_qty,
                    "$and": [
                        {"$or": [{"loaned_qty": {"$exists": False}},
                                 {"loaned_qty": {"$lte": reserve_limit}}]},
                        godown_cas,
                    ],
                }}}),
                {"$inc": {"items.$.loaned_qty": float(qty)},
                 "$push": {"items.$.stage_history": source_event,
                           "items.$.customer_loan_history": loan_history_entry},
                 "$set": {"updated_at": now}}, session=session,
            )
            if result.modified_count != 1:
                raise HTTPException(status_code=409, detail="Stock changed; refresh and try again")
            await db.customers.update_one(
                floor_query(user, {"id": source_customer_id}),
                {"$addToSet": {"lent_stock_transfer_ids": transfer_id}}, session=session,
            )
            await db.customers.update_one(
                floor_query(user, {"id": destination["id"]}),
                {"$addToSet": {"borrowed_stock_transfer_ids": transfer_id}}, session=session,
            )
            await db.purchase_orders.insert_one(dest_po.model_dump(), session=session)
            await db.purchase_transfers.insert_one({
                "id": transfer_id, "type": "loan", "status": "awaiting_return",
                "idempotency_key": key,
                "source_po_id": source_po["id"], "source_po_number": source_po.get("number"),
                "source_item_id": item_id, "source_customer_id": source_customer_id,
                "source_customer_name": source_name,
                "source_quotation_id": source_po.get("quotation_id"),
                "source_quotation_line_id": item.get("quotation_line_id"),
                "destination_po_id": dest_po.id, "destination_po_number": dest_po.number,
                "destination_item_id": dest_item_id,
                "destination_customer_id": destination["id"],
                "destination_customer_name": dest_name,
                "product_id": item["product_id"], "sku": item["sku"],
                "name": item["name"], "image": item.get("image"),
                "brand_id": dest_item.brand_id, "brand_name": dest_item.brand_name,
                "room": item.get("room"), "qty": float(qty),
                "source_qty_before": source_qty, "source_remaining_qty": source_qty,
                "source_loaned_qty_after": round(loaned + float(qty), 4),
                "return_due_on_replenishment": True, "reason": reason,
                "created_customer": created_customer,
                "actor_id": user.id, "actor_name": user.full_name,
                "created_at": now, "updated_at": now,
                "floor_id": floor_inherit(source_po),
            }, session=session)
            return await enqueue_after_primary_commit(
                event_type=EVENT_PURCHASE_TRANSFERRED, idempotency_key=key,
                payload={"transfer_id": transfer_id}, actor=user, session=session,
            )


async def settle_loan_transfer(*, transfer_id: str, user: UserPublic, reason: str | None = None) -> dict:
    """Record physical return of a loan while keeping both purchase lines visible."""
    async with await client.start_session() as session:
        async with session.start_transaction():
            loan = await db.purchase_transfers.find_one(
                floor_query(user, {"id": transfer_id, "type": "loan"}),
                {"_id": 0}, session=session,
            )
            if not loan:
                raise HTTPException(status_code=404, detail="Loan transfer not found")
            if loan.get("status") == "returned":
                return {"transfer_id": transfer_id, "status": "returned", "idempotent": True}
            if loan.get("status") not in {"awaiting_return", "return_due"}:
                raise HTTPException(status_code=409, detail="Loan cannot be returned in its current state")
            now = now_iso()
            qty = float(loan["qty"])
            updated = await db.purchase_transfers.update_one(
                floor_query(user, {"id": transfer_id, "type": "loan",
                                   "status": loan["status"]}),
                {"$set": {"status": "returned", "returned_at": now,
                          "returned_by": user.id, "returned_by_name": user.full_name,
                          "return_reason": reason, "updated_at": now}},
                session=session,
            )
            if updated.modified_count != 1:
                raise HTTPException(status_code=409, detail="Loan changed; refresh and try again")
            source_note = f"{qty:g} × {loan['name']} returned from {loan['destination_customer_name']}."
            dest_note = f"Returned {qty:g} × {loan['name']} to {loan['source_customer_name']}."
            if reason:
                source_note += f" {reason}"
                dest_note += f" {reason}"
            source_event = PurchaseStageEvent(
                from_stage="in_box", to_stage="in_box", by_user_id=user.id,
                by_user_name=user.full_name, note=source_note, action="transfer_in",
                ref_item_id=loan["destination_item_id"],
                ref_po_id=loan["destination_po_id"], qty=qty,
            ).model_dump()
            source_update = await db.purchase_orders.update_one(
                floor_query(user, {"id": loan["source_po_id"], "items": {"$elemMatch": {
                    "id": loan["source_item_id"], "loaned_qty": {"$gte": qty},
                }}}),
                {"$inc": {"items.$[source].loaned_qty": -qty},
                 "$set": {"items.$[source].customer_loan_history.$[history].status": "returned",
                          "items.$[source].customer_loan_history.$[history].returned_at": now,
                          "updated_at": now},
                 "$push": {"items.$[source].stage_history": source_event}},
                array_filters=[{"source.id": loan["source_item_id"]},
                               {"history.transfer_id": transfer_id}],
                session=session,
            )
            if source_update.modified_count != 1:
                raise HTTPException(status_code=409, detail="Source loan reservation is unavailable")
            dest_event = PurchaseStageEvent(
                from_stage="in_box", to_stage="in_box", by_user_id=user.id,
                by_user_name=user.full_name, note=dest_note, action="transfer_out",
                ref_item_id=loan["source_item_id"],
                ref_po_id=loan["source_po_id"], qty=qty,
            ).model_dump()
            dest_update = await db.purchase_orders.update_one(
                floor_query(user, {"id": loan["destination_po_id"], "items": {"$elemMatch": {
                    "id": loan["destination_item_id"],
                    "loan_transfer_id": transfer_id,
                    "loan_return_status": {"$in": ["awaiting_return", "return_due"]},
                }}}),
                {"$set": {"items.$.loan_return_status": "returned",
                          "items.$.loan_return_due": False,
                          "items.$.loan_returned_at": now, "updated_at": now},
                 "$push": {"items.$.stage_history": dest_event}},
                session=session,
            )
            if dest_update.modified_count != 1:
                raise HTTPException(status_code=409, detail="Borrowed item is unavailable")
            return {"transfer_id": transfer_id, "status": "returned",
                    "source_item_id": loan["source_item_id"],
                    "destination_item_id": loan["destination_item_id"],
                    "qty": qty, "idempotent": False}


async def mark_loans_due_for_replenishment(*, item_id: str, user: UserPublic) -> dict:
    """Flag matching loans when the recipient's own ordered item reaches In Box.

    The incoming item's reservation counter ensures its quantity cannot be
    promised against more than one borrowed line, even on repeated calls.
    """
    po = await db.purchase_orders.find_one(
        floor_query(user, {"items.id": item_id}), {"_id": 0},
    )
    if not po:
        raise HTTPException(status_code=404, detail="Purchase item not found")
    item = next((row for row in po.get("items", []) if row.get("id") == item_id), None)
    if not item or item.get("stage") not in {"in_box", "delivered"} or item.get("loan_transfer_id") or item.get("cancelled"):
        return {"item_id": item_id, "return_due_transfer_ids": []}
    customer_id = item.get("customer_id") or po.get("customer_id")
    cursor = db.purchase_transfers.find(floor_query(user, {
        "type": "loan", "status": "awaiting_return",
        "destination_customer_id": customer_id,
        "product_id": item.get("product_id"),
    }), {"_id": 0}).sort("created_at", 1)
    candidates = await cursor.to_list(200)
    marked: list[str] = []
    for loan in candidates:
        if loan.get("destination_item_id") == item_id:
            continue
        qty = float(loan["qty"])
        limit = round(float(item.get("qty") or 0) - qty, 4)
        if limit < 0:
            continue
        async with await client.start_session() as session:
            async with session.start_transaction():
                reserved = await db.purchase_orders.update_one(
                    floor_query(user, {"id": po["id"], "items": {"$elemMatch": {
                        "id": item_id, "stage": item["stage"], "cancelled": {"$ne": True},
                        "qty": item["qty"],
                        "$or": [{"loan_replenishment_reserved_qty": {"$exists": False}},
                                {"loan_replenishment_reserved_qty": {"$lte": limit}}],
                    }}}),
                    {"$inc": {"items.$.loan_replenishment_reserved_qty": qty}},
                    session=session,
                )
                if reserved.modified_count != 1:
                    continue
                now = now_iso()
                updated = await db.purchase_transfers.update_one(
                    floor_query(user, {"id": loan["id"], "type": "loan",
                                       "status": "awaiting_return"}),
                    {"$set": {"status": "return_due", "return_due_at": now,
                              "replenishment_item_id": item_id,
                              "replenishment_po_id": po["id"], "updated_at": now}},
                    session=session,
                )
                if updated.modified_count != 1:
                    # Roll back the quantity reservation as well.
                    raise HTTPException(status_code=409, detail="Loan changed; refresh and try again")
                await db.purchase_orders.update_one(
                    floor_query(user, {"id": loan["destination_po_id"],
                                       "items.id": loan["destination_item_id"]}),
                    {"$set": {"items.$.loan_return_status": "return_due",
                              "items.$.loan_return_due": True,
                              "updated_at": now}}, session=session,
                )
                marked.append(loan["id"])
    return {"item_id": item_id, "return_due_transfer_ids": marked}
