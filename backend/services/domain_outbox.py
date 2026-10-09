"""Transactional domain event outbox for the quotation production workflow.

Commands write only their primary aggregate state plus one EventOutbox record in
one MongoDB transaction. The dispatcher runs after commit and handlers own the
secondary read models. Every handler is keyed by event.idempotency_key so a
retry is safe after a process/network failure.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from auth import floor_inherit
from db import client, db
from models import ActivityEvent, Followup, Notification, Payment, PurchaseOrder, PurchaseOrderItem, PurchaseStageEvent, PurchaseStatusEvent, UserPublic
from models_tile_orders import TileCustomerOrder, TileCustomerOrderBrand, TileCustomerOrderDashboardSummary
from services.notifications import notify
from services.pricing import per_line_net_amounts
from services.sequence import next_number
from services.tile_movement_log import record_movement
from services.tile_order_status import rollup_status
from services.customer_data_reset import customer_reset_maintenance
from pymongo import ReturnDocument

EVENT_QUOTATION_GENERATED = "QuotationGenerated"
EVENT_ORDER_PLACED = "OrderPlaced"
EVENT_PURCHASE_TRANSFERRED = "PurchaseTransferred"
EVENT_PURCHASE_CHALAN_LIFECYCLE = "PurchaseChalanLifecycle"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def ensure_outbox_indexes() -> None:
    """Indexes make command/outbox and handler effects idempotent at the DB level."""
    await db.event_outbox.create_index("idempotency_key", unique=True, name="outbox_idempotency")
    await db.event_outbox.create_index([("status", 1), ("created_at", 1)], name="outbox_dispatch_queue")
    await db.purchase_orders.create_index("automation_key", unique=True, sparse=True, name="po_automation_key")
    await db.payments.create_index("automation_key", unique=True, sparse=True, name="payment_automation_key")
    await db.payments.create_index("idempotency_key", unique=True, sparse=True, name="payment_idempotency_key")
    await db.activity_events.create_index("automation_key", unique=True, sparse=True, name="activity_automation_key")
    await db.notifications.create_index("automation_key", unique=True, sparse=True, name="notification_automation_key")
    await db.followups.create_index("automation_key", unique=True, sparse=True, name="followup_automation_key")


async def enqueue_after_primary_commit(
    *,
    event_type: str,
    idempotency_key: str,
    payload: dict[str, Any],
    actor: UserPublic,
    session: Any,
) -> dict:
    """Insert exactly one outbox journal row inside the caller transaction."""
    event = {
        "id": str(uuid4()),
        "event_type": event_type,
        "idempotency_key": idempotency_key,
        "payload": payload,
        "actor_id": actor.id,
        "actor_name": actor.full_name,
        "status": "pending",
        "attempts": 0,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await db.event_outbox.insert_one(event, session=session)
    return event


# entity_type value -> collection name holding that entity. Mirrors
# migrations/0014_backfill_activity_notification_floor_id.py's map exactly —
# both the one-time backfill and this live write path must agree on where an
# entity_type/entity_id pair resolves to, or new rows would disagree with the
# history the migration already stamped.
_ENTITY_COLLECTIONS = {
    "quotation": "quotations",
    "purchase": "purchase_orders",
    "customer": "customers",
    "product": "products",
    "followup": "followups",
    "payment": "payments",
    "walkin": "walkins",
    "tile_customer_order": "customer_orders",
}


async def resolve_activity_floor_id(
    *,
    quotation_id: str | None,
    purchase_id: str | None,
    entity_type: str | None,
    entity_id: str | None,
    customer_id: str | None,
    session: Any,
) -> str | None:
    """Resolve the floor an activity event belongs to from its parent
    document, in the same decreasing order of reliability that
    migrations/0014_backfill_activity_notification_floor_id.py uses to
    backfill historical rows:

      1. quotation_id  -> that quotation's floor_id
      2. purchase_id   -> that purchase order's floor_id
      3. entity_type/entity_id -> the referenced document's floor_id
      4. customer_id   -> that customer's floor_id

    All lookups run with `session` so they see uncommitted writes from the
    same transaction (e.g. a quotation or purchase order inserted earlier in
    this same commit).

    Returns None — never a guessed default — when nothing resolves. A row
    that stays unresolved is invisible to every business unit, which is the
    accepted, deliberate behaviour; defaulting to "first-floor" here would
    file Ground Floor history under Sanitary Bathroom.
    """
    if quotation_id:
        quotation = await db.quotations.find_one({"id": quotation_id}, {"_id": 0, "floor_id": 1}, session=session)
        if quotation and quotation.get("floor_id"):
            return quotation["floor_id"]
    if purchase_id:
        purchase = await db.purchase_orders.find_one({"id": purchase_id}, {"_id": 0, "floor_id": 1}, session=session)
        if purchase and purchase.get("floor_id"):
            return purchase["floor_id"]
    collection_name = _ENTITY_COLLECTIONS.get(entity_type or "")
    if collection_name and entity_id:
        entity = await db[collection_name].find_one({"id": entity_id}, {"_id": 0, "floor_id": 1}, session=session)
        if entity and entity.get("floor_id"):
            return entity["floor_id"]
    if customer_id:
        customer = await db.customers.find_one({"id": customer_id}, {"_id": 0, "floor_id": 1}, session=session)
        if customer and customer.get("floor_id"):
            return customer["floor_id"]
    return None


async def _upsert_activity(*, key: str, event_type: str, entity_type: str, entity_id: str, actor_id: str, actor_name: str, customer_id: str | None, quotation_id: str | None, purchase_id: str | None, summary: str, payload: dict, session: Any) -> None:
    floor_id = await resolve_activity_floor_id(
        quotation_id=quotation_id, purchase_id=purchase_id,
        entity_type=entity_type, entity_id=entity_id,
        customer_id=customer_id, session=session,
    )
    event = ActivityEvent(
        event_type=event_type,
        entity_type=entity_type,  # type: ignore[arg-type]
        entity_id=entity_id,
        actor_id=actor_id,
        actor_name=actor_name,
        customer_id=customer_id,
        quotation_id=quotation_id,
        purchase_id=purchase_id,
        summary=summary,
        payload=payload,
        floor_id=floor_id,
    ).model_dump()
    event["automation_key"] = key
    await db.activity_events.update_one({"automation_key": key}, {"$setOnInsert": event}, upsert=True, session=session)


async def _upsert_notification(*, key: str, user_id: str, title: str, body: str | None, kind: str, link: str | None, floor_id: str | None, session: Any) -> None:
    notification = Notification(
        user_id=user_id,
        title=title,
        body=body,
        kind=kind,
        link=link,
        floor_id=floor_id,
    ).model_dump()
    notification["automation_key"] = key
    await db.notifications.update_one(
        {"automation_key": key},
        {"$setOnInsert": notification},
        upsert=True,
        session=session,
    )


async def _handle_purchase_chalan_lifecycle(event: dict, session: Any) -> dict:
    """Materialize one durable Chalan transition into shared read models.

    Both activity and notifications use deterministic automation keys, so a
    worker retry after an interrupted dispatch cannot duplicate either row.
    """
    payload = event["payload"]
    key = event["idempotency_key"]
    await _upsert_activity(
        key=f"{key}:activity",
        event_type=payload["activity_event_type"],
        entity_type="purchase",
        entity_id=payload["po_id"],
        actor_id=event["actor_id"],
        actor_name=event["actor_name"],
        customer_id=payload.get("customer_id"),
        quotation_id=payload.get("quotation_id"),
        purchase_id=payload["po_id"],
        summary=payload["summary"],
        payload={
            "chalan_id": payload["chalan_id"],
            "chalan_number": payload.get("chalan_number"),
            "request_key": payload.get("request_key"),
        },
        session=session,
    )
    for notification in payload.get("notifications") or []:
        notification_key = notification.get("automation_key") or f"{key}:notification:{notification['user_id']}"
        await _upsert_notification(
            key=notification_key,
            user_id=notification["user_id"],
            title=notification["title"],
            body=notification.get("body"),
            kind=notification.get("kind", "info"),
            link=notification.get("link"),
            floor_id=payload.get("floor_id"),
            session=session,
        )
    return {
        "po_id": payload["po_id"],
        "chalan_id": payload["chalan_id"],
        "stage": payload.get("stage"),
    }


async def _upsert_followup(*, key: str, quotation: dict, reason: str, category: str, session: Any) -> None:
    customer = await db.customers.find_one({"id": quotation["customer_id"]}, {"_id": 0}, session=session) or {}
    followup = Followup(
        source_key=key,
        rule_type="manual",
        category=category,  # type: ignore[arg-type]
        customer_id=quotation["customer_id"],
        customer_name=quotation.get("customer_name", ""),
        customer_phone=customer.get("phone"),
        customer_tier=customer.get("tier", "retail"),
        quotation_id=quotation["id"],
        quotation_number=quotation.get("number"),
        project_name=quotation.get("project_name"),
        value=round(float(quotation.get("grand_total") or 0), 2),
        reason=reason,
        next_action="Review with customer",
        next_action_reason="Created by the quotation workflow.",
        suggested_channel="call",
        due_at=now_iso(),
        is_automated=False,
        floor_id=floor_inherit(quotation),
    ).model_dump()
    followup["automation_key"] = key
    await db.followups.update_one({"automation_key": key}, {"$setOnInsert": followup}, upsert=True, session=session)


async def _next_po_number(session: Any) -> str:
    year = datetime.now(timezone.utc).year
    return await next_number("purchase_order", f"FPO-{year}-", collection="purchase_orders", session=session)


async def _brand_groups(quotation: dict, session: Any) -> list[dict]:
    product_ids = list({item["product_id"] for item in quotation.get("items", [])})
    products = await db.products.find(
        {"id": {"$in": product_ids}}, {"_id": 0, "id": 1, "brand_id": 1, "series": 1}, session=session,
    ).to_list(len(product_ids) + 5)
    product_by_id = {product["id"]: product for product in products}
    brand_ids = list({p.get("brand_id") for p in products if p.get("brand_id")})
    brands = await db.brands.find({"id": {"$in": brand_ids}}, {"_id": 0}, session=session).to_list(len(brand_ids) + 5)
    brand_by_id = {brand["id"]: brand for brand in brands}
    suppliers = await db.suppliers.find(
        {"brand_id": {"$in": brand_ids}, "floor_id": floor_inherit(quotation), "active": True},
        {"_id": 0}, session=session,
    ).to_list(200)
    supplier_by_brand: dict[str, dict] = {}
    for supplier in suppliers:
        supplier_by_brand.setdefault(supplier.get("brand_id"), supplier)

    groups: dict[str, dict] = {}
    for item in quotation.get("items", []):
        product = product_by_id.get(item["product_id"], {})
        brand_id = product.get("brand_id") or "__unassigned__"
        # Godown fulfilment must never be mixed into a supplier PO for the
        # same brand. It is an internal allocation and arrives directly in
        # the Purchases tracker at In Box.
        group_key = f"{brand_id}:godown" if item.get("godown_stock_id") else brand_id
        group = groups.setdefault(group_key, {
            "brand_id": None if brand_id == "__unassigned__" else brand_id,
            "brand_name": brand_by_id.get(brand_id, {}).get("name", "Unassigned"),
            "supplier": None if item.get("godown_stock_id") else supplier_by_brand.get(brand_id),
            "is_godown": bool(item.get("godown_stock_id")),
            "items": [],
        })
        # Tile Orders logistics (Task 5): series lives on Product, not on
        # the quotation line item — attach it here so _handle_order_placed
        # can copy it onto PurchaseOrderItem without a second product fetch.
        group["items"].append({**item, "series": product.get("series")})
    return list(groups.values())


async def _handle_quotation_generated(event: dict, session: Any) -> dict:
    quotation_id = event["payload"]["quotation_id"]
    quotation = await db.quotations.find_one({"id": quotation_id}, {"_id": 0}, session=session)
    if not quotation:
        raise RuntimeError(f"Quotation {quotation_id} no longer exists")
    key = event["idempotency_key"]
    await _upsert_activity(
        key=f"{key}:timeline", event_type="quotation.pdf_generated", entity_type="quotation", entity_id=quotation_id,
        actor_id=event["actor_id"], actor_name=event["actor_name"], customer_id=quotation.get("customer_id"), quotation_id=quotation_id, purchase_id=None,
        summary=f"Quotation generated · revision {event['payload']['revision']}",
        payload={"event": EVENT_QUOTATION_GENERATED, "revision": event["payload"]["revision"], "pdf": True}, session=session,
    )
    await _upsert_followup(key=f"{key}:followup", quotation=quotation, reason=f"Quotation {quotation.get('number')} generated — review with customer.", category="quotation", session=session)
    return {"quotation_id": quotation_id, "revision": event["payload"]["revision"]}


async def _handle_order_placed(event: dict, session: Any) -> dict:
    quotation_id = event["payload"]["quotation_id"]
    quotation = await db.quotations.find_one({"id": quotation_id}, {"_id": 0}, session=session)
    if not quotation:
        raise RuntimeError(f"Quotation {quotation_id} no longer exists")
    key = event["idempotency_key"]
    groups = await _brand_groups(quotation, session)
    # Resolve every line's EFFECTIVE (post product/room/category/project
    # discount) total ONCE, from the full quotation — not per brand-group —
    # so a discount configured at room/category/project level (rather than
    # stamped on the line itself) is preserved into the PO's unit_cost
    # instead of silently falling back to the full undiscounted price.
    net_by_line = per_line_net_amounts(quotation)

    # Tile Orders logistics (Task 5): _handle_order_placed runs for BOTH
    # tiles and standard (sanitaryware) quotations — tiles_stage.py's
    # can_place_order() returns True unconditionally for doc_type ==
    # "standard". A TileCustomerOrder must only ever be created for a
    # tiles quotation.
    is_tiles = quotation.get("doc_type") in ("tiles_selection", "tiles_quotation")
    customer_order: Optional[TileCustomerOrder] = None
    customer_order_key = f"{key}:customer_order"
    tile_total_products = 0
    tile_total_boxes = 0.0
    tile_total_value = 0.0
    # Tracks whether `customer_order` was rehydrated from an already-committed
    # document (a retry of this event) versus freshly constructed here. On a
    # retry the brand loop below `continue`s early for every brand (each PO
    # already exists via its own automation_key check), so the tile_total_*
    # accumulators never get repopulated — the final assignment block must
    # not use them to clobber the already-correct totals on the rehydrated
    # object.
    customer_order_is_new = False

    if is_tiles:
        existing_co = await db.customer_orders.find_one({"automation_key": customer_order_key}, {"_id": 0}, session=session)
        if existing_co:
            customer_order = TileCustomerOrder(**{k: v for k, v in existing_co.items() if k != "automation_key"})
        else:
            customer_order_is_new = True
            customer = await db.customers.find_one({"id": quotation["customer_id"]}, {"_id": 0}, session=session) or {}
            customer_order = TileCustomerOrder(
                number=await next_number(
                    "customer_order", f"TORD-{datetime.now(timezone.utc).year}-",
                    collection="customer_orders", session=session,
                ),
                quotation_id=quotation_id, quotation_number=quotation.get("number"),
                customer_id=quotation["customer_id"], customer_name=quotation.get("customer_name", ""),
                customer_phone=quotation.get("phone_snapshot") or customer.get("phone") or "",
                # Immutable delivery snapshot — prefer the quotation's own
                # address/phone lines (tiles-quotation-specific, may differ
                # from the customer's default) over the live customer record.
                delivery_name=quotation.get("customer_name") or customer.get("name") or "",
                delivery_phone=quotation.get("phone_snapshot") or customer.get("phone") or "",
                delivery_address=quotation.get("address_snapshot") or customer.get("address") or "",
                delivery_city=customer.get("city") or "",
                # KNOWN GAP: the Customer model has no pincode/state fields
                # today (models.py:85-99) — left blank until that model
                # gains them; out of scope for this pass per the frozen
                # design doc (Customer model changes are not part of it).
                delivery_pincode="",
                delivery_state="",
                floor_id=floor_inherit(quotation),
                created_by=event["actor_id"], created_by_name=event["actor_name"],
                dashboard_summary=TileCustomerOrderDashboardSummary(
                    completion_percentage=0, overall_status="Pending", supplier_statuses=[],
                ),
            )

    created_po_ids: list[str] = []
    for group in groups:
        brand_key = (group["brand_id"] or "unassigned") + (":godown" if group.get("is_godown") else "")
        po_key = f"{key}:po:{brand_key}"
        existing = await db.purchase_orders.find_one({"automation_key": po_key}, {"_id": 0, "id": 1}, session=session)
        if existing:
            created_po_ids.append(existing["id"])
            continue
        now = now_iso()
        po_items = []
        for raw in group["items"]:
            qty = float(raw.get("qty") or 0)
            net_total = net_by_line.get(raw.get("id"))
            if net_total is None:
                # Line wasn't found in the breakdown (shouldn't happen) — fall
                # back to the raw per-line discount rather than full price.
                unit_cost = round(float(raw.get("unit_price") or 0) * (1 - float(raw.get("discount_pct") or 0) / 100), 2)
            else:
                unit_cost = round(net_total / qty, 2) if qty else 0.0
            po_items.append(PurchaseOrderItem(
                product_id=raw["product_id"], sku=raw["sku"], name=raw["name"], image=raw.get("image"),
                finish=raw.get("finish"), category_id=raw.get("category_id"), room=raw.get("room"),
                qty=qty, unit_cost=unit_cost, quotation_line_id=raw.get("id"), stage="in_box" if group.get("is_godown") else "po_final",
                customer_id=quotation["customer_id"], customer_name=quotation.get("customer_name", ""),
                brand_id=group["brand_id"], brand_name=group["brand_name"],
                last_moved_at=now, last_moved_by=event["actor_id"], last_moved_by_name=event["actor_name"],
                stage_history=[PurchaseStageEvent(from_stage=None, to_stage="in_box" if group.get("is_godown") else "po_final", by_user_id=event["actor_id"], by_user_name=event["actor_name"], note=(f"Allocated from godown stock for {quotation.get('number')}" if group.get("is_godown") else f"Created from {quotation.get('number')}"), action="create")],
                godown_stock_id=raw.get("godown_stock_id"), godown_allocation_id=raw.get("godown_allocation_id"),
                godown_source_customer_name=raw.get("godown_source_customer_name"), godown_source_purchased_at=raw.get("godown_source_purchased_at"),
                godown_transferred_at=raw.get("godown_transferred_at"),
                # Tile Orders logistics (Task 5) — harmless no-op defaults
                # on non-tile orders, real data on tiles orders.
                series=raw.get("series"), size=raw.get("size"), pieces_per_box=raw.get("pcs_per_box"), quantity_unit=raw.get("quantity_unit") or "Box",
                boxes_ready=0, boxes_dispatched=0, boxes_pending=qty,
                current_location="Pending", overall_status="Pending",
            ))
        supplier = group.get("supplier") or {}
        po = PurchaseOrder(
            number=await _next_po_number(session), quotation_id=quotation_id, quotation_number=quotation.get("number"),
            customer_id=quotation["customer_id"], customer_name=quotation.get("customer_name", ""), project_name=quotation.get("project_name"),
            brand_id=group["brand_id"], brand_name=group["brand_name"], supplier_id=supplier.get("id"), supplier_name=supplier.get("name"),
            status="draft", items=po_items, subtotal=round(sum(item.qty * item.unit_cost for item in po_items), 2),
            grand_total=round(sum(item.qty * item.unit_cost for item in po_items), 2), created_by=event["actor_id"], created_by_name=event["actor_name"],
            floor_id=floor_inherit(quotation),
            status_history=[PurchaseStatusEvent(from_status=None, to_status="draft", by_user_id=event["actor_id"], by_user_name=event["actor_name"], note=f"Created from {quotation.get('number')}")],
            customer_order_id=(customer_order.id if customer_order else None),
        ).model_dump()
        po["automation_key"] = po_key
        await db.purchase_orders.insert_one(po, session=session)
        created_po_ids.append(po["id"])

        if is_tiles and customer_order is not None:
            tile_total_products += len(po_items)
            tile_total_boxes += sum(item.qty for item in po_items)
            tile_total_value += po["grand_total"]
            customer_order.brands.append(TileCustomerOrderBrand(
                brand_id=group["brand_id"], brand_name=group["brand_name"],
                supplier_id=supplier.get("id"), supplier_name=supplier.get("name") or "Unassigned",
                purchase_order_id=po["id"], status="Pending",
            ))
            await _upsert_activity(
                key=f"{key}:supplier-assigned:{brand_key}", event_type="supplier.assigned",
                entity_type="purchase", entity_id=po["id"],
                actor_id=event["actor_id"], actor_name=event["actor_name"],
                customer_id=quotation.get("customer_id"), quotation_id=quotation_id, purchase_id=po["id"],
                summary=f"Supplier {supplier.get('name') or 'Unassigned'} assigned for {group['brand_name']}",
                payload={"supplier_id": supplier.get("id"), "brand_id": group["brand_id"]}, session=session,
            )
            # Material Movement Register — "Order Created" is the first row
            # in every tile's lifecycle (Ordered → Released → Godown →
            # Dispatched → Delivered). One row per line item, boxes = qty
            # ordered. Never re-emitted on a retry because this whole branch
            # is unreachable once `existing` above is truthy.
            for po_item in po_items:
                await record_movement(
                    movement_type="order_created", purchase_order_id=po["id"], po_item_id=po_item.id,
                    customer_order_id=customer_order.id if customer_order else None,
                    floor_id=po["floor_id"], customer_id=quotation.get("customer_id"),
                    customer_name=quotation.get("customer_name", ""), brand_id=group["brand_id"],
                    brand_name=group["brand_name"], tile_name=po_item.name, series=po_item.series,
                    finish=po_item.finish, size=po_item.size, sku=po_item.sku, boxes=po_item.qty, quantity_unit=po_item.quantity_unit,
                    performed_by=event["actor_id"], performed_by_name=event["actor_name"], session=session,
                )

    if is_tiles and customer_order is not None:
        if customer_order_is_new:
            # Only recompute totals/status/dashboard when this is a freshly
            # built TileCustomerOrder. On a retry (customer_order_is_new is
            # False) `customer_order` was rehydrated from the already-
            # committed document and the tile_total_* accumulators above are
            # still at their zero initial values (the brand loop `continue`d
            # for every already-existing PO) — assigning them here would
            # clobber an already-correct stored document with zeros. It is
            # harmless TODAY only because `$setOnInsert` below is a no-op
            # against an existing document; guard it explicitly so a future
            # change to that write (e.g. to `$set`) can't silently zero out
            # real totals on a retry.
            customer_order.total_products = tile_total_products
            customer_order.total_boxes = tile_total_boxes
            customer_order.total_value = round(tile_total_value + float(quotation.get("transportation_fee") or 0), 2)
            customer_order.overall_status = rollup_status([b.status for b in customer_order.brands])
            customer_order.completion_percentage = 0.0
            customer_order.dashboard_summary = TileCustomerOrderDashboardSummary(
                completion_percentage=0.0, overall_status=customer_order.overall_status,
                supplier_statuses=[{"supplier_name": b.supplier_name, "status": b.status} for b in customer_order.brands],
            )
        customer_order.last_activity = "Order created"
        customer_order.last_activity_at = now_iso()
        co_doc = customer_order.model_dump()
        co_doc["automation_key"] = customer_order_key
        await db.customer_orders.update_one(
            {"automation_key": customer_order_key}, {"$setOnInsert": co_doc}, upsert=True, session=session,
        )
        await _upsert_activity(
            key=f"{key}:customer_order_created", event_type="customer_order.created",
            entity_type="tile_customer_order", entity_id=customer_order.id,
            actor_id=event["actor_id"], actor_name=event["actor_name"],
            customer_id=quotation.get("customer_id"), quotation_id=quotation_id, purchase_id=None,
            summary=f"Customer order {customer_order.number} created — {len(customer_order.brands)} supplier(s)",
            payload={"customer_order_id": customer_order.id, "brand_count": len(customer_order.brands)}, session=session,
        )

    payment_key = f"{key}:payment"
    payment_amount = round(float(quotation.get("grand_total") or 0), 2)
    # A ₹0 order (a Selection-derived quotation nobody priced, a free-sample
    # order, etc.) has nothing outstanding to collect — Payment.amount is
    # `Field(gt=0)`, so building one here would raise a pydantic
    # ValidationError and abort the whole transaction (rolling back the
    # Purchase Orders inserted above too), permanently dead-lettering the
    # event after 8 retries. Skip creating a Payment entirely in that case
    # instead of trying to represent "no payment" as a zero-amount one.
    if payment_amount > 0:
        payment = Payment(
            quotation_id=quotation_id, quotation_number=quotation.get("number"), customer_id=quotation["customer_id"], customer_name=quotation.get("customer_name"),
            amount=payment_amount, mode="bank", status="pending", note="Outstanding balance created by OrderPlaced automation.",
            recorded_by=event["actor_id"], recorded_by_name=event["actor_name"],
            floor_id=floor_inherit(quotation),
        ).model_dump()
        # Automation payments dedupe via automation_key, not idempotency_key —
        # the field must be OMITTED (not left as an explicit None) or it
        # collides with payments.payment_idempotency_key's unique *sparse*
        # index on every order placed after the first one ever recorded
        # (sparse only skips documents missing the key entirely, not
        # documents where it's present-but-null).
        payment.pop("idempotency_key", None)
        payment["automation_key"] = payment_key
        await db.payments.update_one({"automation_key": payment_key}, {"$setOnInsert": payment}, upsert=True, session=session)
    await _upsert_activity(
        key=f"{key}:timeline", event_type="quotation.order_placed", entity_type="quotation", entity_id=quotation_id,
        actor_id=event["actor_id"], actor_name=event["actor_name"], customer_id=quotation.get("customer_id"), quotation_id=quotation_id, purchase_id=None,
        summary=f"Order placed — {len(created_po_ids)} purchase order(s) created",
        payload={"event": EVENT_ORDER_PLACED, "purchase_order_ids": created_po_ids, "outstanding": payment_amount}, session=session,
    )
    await _upsert_followup(key=f"{key}:followup", quotation=quotation, reason=f"Order {quotation.get('number')} placed — confirm payment and delivery plan.", category="payment", session=session)
    return {
        "quotation_id": quotation_id,
        "purchase_order_ids": created_po_ids,
        "payment_amount": payment_amount,
        "count": len(created_po_ids),
        "customer_order_id": customer_order.id if customer_order else None,
        "post_commit_notification": {
            "user_id": quotation.get("created_by"),
            "title": f"Order confirmed · {quotation.get('number')}",
            "body": f"{len(created_po_ids)} purchase order(s) created for {quotation.get('customer_name')} — outstanding ₹{payment_amount:,.0f}",
            "kind": "success",
            "link": f"/quotations/{quotation_id}",
            "floor_id": floor_inherit(quotation),
        },
    }


async def _claim_event(event_id: str) -> dict | None:
    """Atomically claim one event so multiple workers cannot process it twice."""
    now = datetime.now(timezone.utc)
    stale_before = (now.timestamp() - 120)
    return await db.event_outbox.find_one_and_update(
        {
            "id": event_id,
            "$or": [
                {"status": "pending"},
                {"status": "processing", "claimed_at_epoch": {"$lt": stale_before}},
            ],
        },
        {"$set": {
            "status": "processing",
            "claim_id": str(uuid4()),
            "claimed_at": now.isoformat(),
            "claimed_at_epoch": now.timestamp(),
            "updated_at": now_iso(),
        }},
        projection={"_id": 0},
        return_document=ReturnDocument.AFTER,
    )


async def dispatch_event(event_id: str, *, claim_id: str | None = None) -> dict:
    """Run one committed outbox event. Any failure leaves it pending for retry."""
    event = await db.event_outbox.find_one({"id": event_id}, {"_id": 0})
    if not event:
        raise RuntimeError("Outbox event not found")
    if event.get("status") == "completed":
        return event.get("result") or {"already_processed": True}
    if claim_id is None:
        event = await _claim_event(event_id)
        if not event:
            current = await db.event_outbox.find_one({"id": event_id}, {"_id": 0})
            if current and current.get("status") == "completed":
                return current.get("result") or {"already_processed": True}
            return {"already_processing": True}
        claim_id = event.get("claim_id")
    result: dict
    notification: dict | None = None
    async with await client.start_session() as session:
        async with session.start_transaction():
            current = await db.event_outbox.find_one({"id": event_id, "status": "processing", "claim_id": claim_id}, {"_id": 0}, session=session)
            if not current or current.get("status") == "completed":
                return (current or {}).get("result") or {"already_processed": True}
            if current["event_type"] == EVENT_QUOTATION_GENERATED:
                result = await _handle_quotation_generated(current, session)
            elif current["event_type"] == EVENT_ORDER_PLACED:
                result = await _handle_order_placed(current, session)
            elif current["event_type"] == EVENT_PURCHASE_TRANSFERRED:
                from services.transfer_workflow import handle_purchase_transferred
                result = await handle_purchase_transferred(current, session)
            elif current["event_type"] == EVENT_PURCHASE_CHALAN_LIFECYCLE:
                result = await _handle_purchase_chalan_lifecycle(current, session)
            else:
                raise RuntimeError(f"Unsupported outbox event type {current['event_type']}")
            notification = result.pop("post_commit_notification", None)
            await db.event_outbox.update_one({"id": event_id, "claim_id": claim_id}, {"$set": {"status": "completed", "result": result, "processed_at": now_iso(), "updated_at": now_iso()}, "$inc": {"attempts": 1}}, session=session)
    # Analytics cache invalidation, after the commit for the same reason the
    # notification is: the surfaces must never be able to read a version bump
    # for a write that then rolled back. Bumping a version invalidates every
    # cached metric declaring that collection — there is no delete to forget.
    await _bump_analytics_versions(current["event_type"])

    if notification and notification.get("user_id"):
        try:
            await notify(**notification)
        except Exception:
            # The business transaction is already committed. Notification
            # delivery must not turn a completed order into a failed command.
            import logging
            logging.getLogger("forge.outbox").exception("Post-commit order notification failed")
    return result


# Which collections each event's handler writes, and therefore which cached
# analytics become stale the moment it commits.
_EVENT_COLLECTIONS: dict[str, tuple[str, ...]] = {
    EVENT_QUOTATION_GENERATED: ("quotations", "followups", "activity_events"),
    EVENT_ORDER_PLACED: ("quotations", "purchase_orders", "customer_orders", "payments", "followups", "activity_events"),
    EVENT_PURCHASE_TRANSFERRED: ("quotations", "purchase_orders", "payments", "followups", "activity_events"),
    EVENT_PURCHASE_CHALAN_LIFECYCLE: ("purchase_orders", "activity_events", "notifications"),
}


async def _bump_analytics_versions(event_type: str) -> None:
    """Never let a cache bump fail a completed business command."""
    from services.analytics import cache

    for collection in _EVENT_COLLECTIONS.get(event_type, ()):
        try:
            await cache.bump(collection)
        except Exception:
            import logging
            logging.getLogger("forge.outbox").exception(
                "Analytics cache bump failed for %s; entries will expire by TTL instead", collection,
            )


MAX_DISPATCH_ATTEMPTS = 8
WORKER_INTERVAL_SECONDS = 30


async def dispatch_pending(limit: int = 100) -> list[dict]:
    if customer_reset_maintenance():
        return []
    stale_before = datetime.now(timezone.utc).timestamp() - 120
    events = await db.event_outbox.find(
        {
            "attempts": {"$lt": MAX_DISPATCH_ATTEMPTS},
            "$or": [
                {"status": "pending"},
                {"status": "processing", "claimed_at_epoch": {"$lt": stale_before}},
            ],
        },
        {"_id": 0, "id": 1, "attempts": 1},
    ).sort("created_at", 1).to_list(limit)
    results = []
    for event in events:
        try:
            claimed = await _claim_event(event["id"])
            if not claimed:
                continue
            results.append(await dispatch_event(event["id"], claim_id=claimed["claim_id"]))
        except Exception as exc:  # Persist failure safely; retry remains possible.
            exhausted = int(event.get("attempts") or 0) + 1 >= MAX_DISPATCH_ATTEMPTS
            patch: dict = {"last_error": str(exc), "updated_at": now_iso()}
            if exhausted:
                # Dead-letter: stop retrying, keep the event for operator review
                # via GET /api/ops/outbox. Nothing is deleted.
                patch["status"] = "dead_letter"
            await db.event_outbox.update_one({"id": event["id"], "status": "processing"}, {"$set": patch, "$inc": {"attempts": 1}})
    return results


async def outbox_worker() -> None:
    """Continuously drain committed events so automation never waits for a
    restart or a lucky request. Runs for the process lifetime; each cycle is
    isolated so one bad event or a transient DB error can't kill the loop."""
    import logging
    logger = logging.getLogger("forge.outbox")
    while True:
        try:
            await dispatch_pending()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Outbox dispatch cycle failed; retrying next cycle")
        await asyncio.sleep(WORKER_INTERVAL_SECONDS)
