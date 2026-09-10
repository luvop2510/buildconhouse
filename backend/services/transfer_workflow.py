"""Transactional, idempotent purchase-transfer workflow.

The command owns allocation changes and creates the transfer journal plus a
PurchaseTransferred outbox record in one Mongo transaction. Its event handler
owns payments, follow-ups, shortage/reorder automation, activities and audit.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

from auth import floor_inherit, floor_query
from db import client, db
from models import (
    ActivityEvent, CustomerPublic, Followup, Payment, PurchaseOrder,
    PurchaseOrderItem, PurchaseShortage, PurchaseStageEvent, PurchaseStatusEvent,
    Quotation, QuotationLineItem, UserPublic,
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


async def execute_transfer(
    *, item_id: str, destination_customer_id: str | None, new_customer: dict | None,
    qty: float, reason: str | None, idempotency_key: str | None, user: UserPublic,
) -> dict:
    """Run one transfer command. Repeating the same idempotency key is a no-op."""
    command_key = f"purchase-transfer:{idempotency_key or uuid4()}"
    existing_event = await db.event_outbox.find_one({"idempotency_key": command_key}, {"_id": 0})
    if existing_event:
        from services.domain_outbox import dispatch_event
        return {"idempotent": True, **(await dispatch_event(existing_event["id"]))}

    async with await client.start_session() as session:
        async with session.start_transaction():
            source_po = await db.purchase_orders.find_one(floor_query(user, {"items.id": item_id}), {"_id": 0}, session=session)
            if not source_po:
                raise HTTPException(status_code=404, detail="Source item not found")
            source_item = next((item for item in source_po.get("items", []) if item.get("id") == item_id), None)
            if not source_item:
                raise HTTPException(status_code=404, detail="Source item not found")
            source_qty = float(source_item.get("qty") or 0)
            if qty <= 0 or qty > source_qty + 1e-6:
                raise HTTPException(status_code=400, detail=f"Only {source_qty:g} available for transfer")

            source_customer_id = source_item.get("customer_id") or source_po.get("customer_id")
            source_customer = await db.customers.find_one(floor_query(user, {"id": source_customer_id}), {"_id": 0}, session=session)
            if not source_customer:
                raise HTTPException(status_code=409, detail="Source customer is unavailable")

            destination = None
            created_customer = False
            if destination_customer_id:
                if destination_customer_id == source_customer_id:
                    raise HTTPException(status_code=400, detail="Destination customer must differ from source")
                destination = await db.customers.find_one(floor_query(user, {"id": destination_customer_id}), {"_id": 0}, session=session)
                if not destination:
                    raise HTTPException(status_code=404, detail="Destination customer not found")
            elif new_customer:
                email = (new_customer.get("email") or "").strip().lower() or None
                if email:
                    destination = await db.customers.find_one(floor_query(user, {"email": email}), {"_id": 0}, session=session)
                if not destination:
                    name = (new_customer.get("name") or "").strip()
                    if not name:
                        raise HTTPException(status_code=400, detail="New customer name is required")
                    destination = CustomerPublic(
                        name=name,
                        company=(new_customer.get("company") or None),
                        email=email,
                        phone=(new_customer.get("phone") or None),
                        address=(new_customer.get("address") or None),
                        city=(new_customer.get("city") or None),
                        floor_id=floor_inherit(source_po),
                    ).dict()
                    await db.customers.insert_one(destination, session=session)
                    created_customer = True
                if destination["id"] == source_customer_id:
                    raise HTTPException(status_code=400, detail="Destination customer must differ from source")
            else:
                raise HTTPException(status_code=400, detail="Choose an existing customer or provide new customer details")

            source_quotation_id = source_po.get("quotation_id")
            source_quotation_line_id = source_item.get("quotation_line_id")
            now = now_iso()
            stage = source_item.get("stage") or "order_in_company"
            source_remaining = round(source_qty - float(qty), 4)
            transfer_id = str(uuid4())
            destination_name = destination.get("company") or destination.get("name")
            source_name = source_customer.get("company") or source_customer.get("name")
            selling_price = float(source_item.get("unit_cost") or 0)
            quote_line = QuotationLineItem(
                product_id=source_item["product_id"], sku=source_item["sku"], name=source_item["name"],
                image=source_item.get("image"), finish=source_item.get("finish"), category_id=source_item.get("category_id"), room=source_item.get("room"),
                qty=float(qty), unit_price=selling_price,
            )
            quote = Quotation(
                number=await _next_number("quotations", "FQ", session), customer_id=destination["id"],
                customer_name=destination_name, status="ordered", ordered_at=now,
                items=[quote_line], rooms=[source_item.get("room")] if source_item.get("room") else [],
                subtotal=round(quote_line.net, 2), grand_total=round(quote_line.net, 2),
                notes=f"Transfer from {source_name} · {source_po.get('number')}" + (f" — {reason}" if reason else ""),
                created_by=user.id, created_by_name=user.full_name, source="transfer",
                floor_id=floor_inherit(source_po),
            )
            destination_item_id = str(uuid4())
            destination_item = PurchaseOrderItem(
                id=destination_item_id, product_id=source_item["product_id"], sku=source_item["sku"], name=source_item["name"],
                image=source_item.get("image"), finish=source_item.get("finish"), category_id=source_item.get("category_id"), room=source_item.get("room"),
                qty=float(qty), unit_cost=float(source_item.get("unit_cost") or 0), quotation_line_id=quote_line.id,
                stage=stage, customer_id=destination["id"], customer_name=destination_name,
                brand_id=source_item.get("brand_id") or source_po.get("brand_id"), brand_name=source_item.get("brand_name") or source_po.get("brand_name"),
                last_moved_at=now, last_moved_by=user.id, last_moved_by_name=user.full_name,
                transferred_from_item_id=item_id, transferred_from_po_id=source_po["id"], transferred_from_customer_id=source_customer_id,
                stage_history=[PurchaseStageEvent(from_stage=None, to_stage=stage, by_user_id=user.id, by_user_name=user.full_name, note=reason or f"Transferred from {source_name}", action="transfer_in", ref_item_id=item_id, ref_po_id=source_po["id"], qty=float(qty))],
            )
            destination_po = PurchaseOrder(
                number=await _next_number("purchase_orders", "FPO", session), quotation_id=quote.id, quotation_number=quote.number,
                customer_id=destination["id"], customer_name=destination_name, brand_id=destination_item.brand_id, brand_name=destination_item.brand_name,
                supplier_id=source_po.get("supplier_id"), supplier_name=source_po.get("supplier_name"), status="draft", items=[destination_item],
                internal_notes=f"Transfer {transfer_id} from {source_po.get('number')} · {source_name}" + (f" — {reason}" if reason else ""),
                subtotal=round(destination_item.qty * destination_item.unit_cost, 2), grand_total=round(destination_item.qty * destination_item.unit_cost, 2),
                created_by=user.id, created_by_name=user.full_name,
                floor_id=floor_inherit(source_po),
                status_history=[PurchaseStatusEvent(from_status=None, to_status="draft", by_user_id=user.id, by_user_name=user.full_name, note="Created by customer transfer")],
            )
            quote.source_purchase_order_id = destination_po.id
            quote.source_item_id = destination_item_id
            await db.quotations.insert_one(quote.dict(), session=session)
            await db.purchase_orders.insert_one(destination_po.dict(), session=session)

            source_event = PurchaseStageEvent(
                from_stage=stage, to_stage=stage, by_user_id=user.id, by_user_name=user.full_name,
                note=reason or f"Transferred {qty:g} to {destination_name}", action="transfer_out", ref_item_id=destination_item_id, ref_po_id=destination_po.id, qty=float(qty),
            ).dict()
            if source_remaining <= 1e-6:
                await db.purchase_orders.update_one({"id": source_po["id"], "items.id": item_id}, {"$push": {"items.$.stage_history": source_event}, "$set": {"updated_at": now}}, session=session)
                await db.purchase_orders.update_one({"id": source_po["id"]}, {"$pull": {"items": {"id": item_id}}}, session=session)
            else:
                await db.purchase_orders.update_one(
                    {"id": source_po["id"], "items.id": item_id},
                    {"$set": {"items.$.qty": source_remaining, "items.$.last_moved_at": now, "items.$.last_moved_by": user.id, "items.$.last_moved_by_name": user.full_name, "updated_at": now}, "$push": {"items.$.stage_history": source_event}},
                    session=session,
                )

            transfer = {
                "id": transfer_id, "idempotency_key": command_key, "source_po_id": source_po["id"], "source_po_number": source_po.get("number"),
                "source_item_id": item_id, "source_customer_id": source_customer_id, "source_customer_name": source_name,
                "source_quotation_id": source_quotation_id, "source_quotation_line_id": source_quotation_line_id,
                "destination_po_id": destination_po.id, "destination_po_number": destination_po.number, "destination_item_id": destination_item_id,
                "destination_customer_id": destination["id"], "destination_customer_name": destination_name, "destination_quotation_id": quote.id,
                "destination_quotation_number": quote.number, "product_id": source_item["product_id"], "sku": source_item["sku"], "name": source_item["name"],
                "image": source_item.get("image"), "brand_id": destination_item.brand_id, "brand_name": destination_item.brand_name, "room": source_item.get("room"),
                "qty": float(qty), "source_qty_before": source_qty, "source_remaining_qty": max(0, source_remaining), "reason": reason,
                "created_customer": created_customer, "actor_id": user.id, "actor_name": user.full_name, "created_at": now, "updated_at": now,
                "floor_id": floor_inherit(source_po),
            }
            await db.purchase_transfers.insert_one(transfer, session=session)
            event = await enqueue_after_primary_commit(
                event_type=EVENT_PURCHASE_TRANSFERRED, idempotency_key=command_key,
                payload={"transfer_id": transfer_id}, actor=user, session=session,
            )

    from services.domain_outbox import dispatch_event
    result = await dispatch_event(event["id"])
    return {"idempotent": False, **result}


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


async def transfer_history(item_id: str) -> list[dict]:
    return await db.purchase_transfers.find({"$or": [{"source_item_id": item_id}, {"destination_item_id": item_id}]}, {"_id": 0}).sort("created_at", -1).to_list(200)
