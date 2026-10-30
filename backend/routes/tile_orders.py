"""Tile Orders logistics — Ready/Dispatch/Chalan actions and the Company/
Supplier/Customer/Dispatch-List read endpoints. Order placement (creating
the TileCustomerOrder itself) lives in services/domain_outbox.py, not here
— see that file's _handle_order_placed.
"""
from __future__ import annotations
from services.money import format_indian_money
from services.multi_filters import filter_values, filter_condition

from datetime import datetime, timezone
import re
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from pymongo import InsertOne, UpdateOne
from starlette.concurrency import run_in_threadpool

from auth import TILES_FLOOR_ID, require_min_role, tiles_floor_query
from db import client, db
from models import Payment, UserPublic, now_iso
from models_tile_orders import TileChalan, TileChalanItem, TileDispatch, TileDispatchLineConsumed, TileReadyBatch
from pdf_chalan import build_tile_chalan_pdf, tile_chalan_pdf_filename
from services.activity_log import log_event
from services.export import export_response
from services.sequence import next_number
from services.purchase_images import hydrate_purchase_images
from services.tile_movement_log import record_movement
from services.tile_order_status import (
    ageing_band, completion_percentage, derive_current_location, derive_item_status,
    rollup_status, supplier_silent_days, waiting_days,
)

router = APIRouter(prefix="/tile-orders", tags=["tile-orders"])


class ReadyItemInput(BaseModel):
    po_item_id: str
    qty: float = Field(gt=0)


class BulkReadyBody(BaseModel):
    items: list[ReadyItemInput] = Field(min_length=1)


async def _sync_customer_order_brand_status(
    co_id: Optional[str], po_id: str, new_status: str, session, *, dispatched_boxes: float = 0.0,
) -> None:
    """Updates this PO's entry in TileCustomerOrder.brands[], then rolls the
    CustomerOrder's own overall_status/dashboard_summary up from all
    brands. Increments `version` as the defense-in-depth CAS guard the
    design doc calls for — the enclosing transaction is the primary safety
    net (see Task 6's transaction-strategy note).

    Also recomputes completion_percentage — the same class of bug Task 9
    already fixed once for supplier_analytics (a stored field that only a
    subset of write paths ever touched, so it went permanently stale/0
    everywhere else). Rather than re-querying every sibling PurchaseOrder
    for this order (which the codebase already avoids elsewhere), each
    brand entry carries its own PO's current boxes_dispatched — summed
    across brands, that's the numerator against the order's total_boxes
    (immutable, set once at placement) as the denominator, via the same
    completion_percentage() helper the write endpoints already use."""
    if not co_id:
        return
    co = await db.customer_orders.find_one({"id": co_id, "is_deleted": False, "floor_id": TILES_FLOOR_ID}, {"_id": 0}, session=session)
    if not co:
        return
    brands = co.get("brands", [])
    for brand in brands:
        if brand.get("purchase_order_id") == po_id:
            brand["status"] = new_status
            brand["boxes_dispatched"] = dispatched_boxes
    overall = rollup_status([b.get("status", "Pending") for b in brands])
    total_dispatched = sum(float(b.get("boxes_dispatched") or 0) for b in brands)
    pct = completion_percentage(float(co.get("total_boxes") or 0), total_dispatched)
    summary = {
        "completion_percentage": pct,
        "overall_status": overall,
        "supplier_statuses": [{"supplier_name": b.get("supplier_name"), "status": b.get("status")} for b in brands],
    }
    updated = await db.customer_orders.update_one(
        {"id": co_id, "version": co.get("version", 0)},
        {"$set": {
            "brands": brands, "overall_status": overall, "dashboard_summary": summary,
            "completion_percentage": pct,
            "last_activity": "Status changed", "last_activity_at": now_iso(),
            "version": co.get("version", 0) + 1, "updated_at": now_iso(),
        }},
        session=session,
    )
    if getattr(updated, "matched_count", 1) == 0:
        raise HTTPException(status_code=409, detail="Customer order changed — refresh and confirm delivery again")


@router.post("/purchase-orders/{po_id}/ready")
async def mark_items_ready(
    po_id: str, body: BulkReadyBody, user: UserPublic = Depends(require_min_role("warehouse")),
):
    """'Mark Ready For Pickup' — bulk, one transaction. Never creates a
    Chalan (see Task 8's Dispatch endpoint for that)."""
    session = await client.start_session()
    async with session:
        async with session.start_transaction():
            po = await db.purchase_orders.find_one(tiles_floor_query(user, {"id": po_id}), {"_id": 0}, session=session)
            if not po:
                raise HTTPException(status_code=404, detail="Purchase order not found")
            items_by_id = {item["id"]: item for item in po.get("items", [])}
            created_batches: list[dict] = []
            year = datetime.now(timezone.utc).year
            new_status: Optional[str] = None
            for entry in body.items:
                item = items_by_id.get(entry.po_item_id)
                if not item:
                    raise HTTPException(status_code=400, detail=f"Unknown item {entry.po_item_id}")
                pending = float(item.get("boxes_pending") or 0)
                if entry.qty > pending + 1e-6:
                    raise HTTPException(status_code=400, detail=f"Only {pending:g} boxes of '{item.get('name')}' are pending")

                batch_number = await next_number("ready_batch", f"RB-{year}-", collection="ready_batches", session=session)
                batch = TileReadyBatch(
                    batch_number=batch_number, purchase_order_id=po_id, po_item_id=entry.po_item_id,
                    customer_order_id=po.get("customer_order_id") or "", floor_id=po.get("floor_id", TILES_FLOOR_ID),
                    supplier_id=po.get("supplier_id"),
                    supplier_name=po.get("supplier_name") or "Unassigned", customer_id=po.get("customer_id"),
                    customer_name=po.get("customer_name") or "", tile_name=item.get("name", ""),
                    series=item.get("series"), finish=item.get("finish"), size=item.get("size"), sku=item.get("sku"), quantity_unit=item.get("quantity_unit") or "Box",
                    qty=entry.qty, remaining_qty=entry.qty, created_by=user.id, created_by_name=user.full_name,
                )
                await db.ready_batches.insert_one(batch.model_dump(), session=session)
                created_batches.append(batch.model_dump())

                item["boxes_ready"] = float(item.get("boxes_ready") or 0) + entry.qty
                item["boxes_pending"] = pending - entry.qty
                item["overall_status"] = derive_item_status(item["qty"], item["boxes_ready"], float(item.get("boxes_dispatched") or 0))
                item["current_location"] = derive_current_location(item["qty"], item["boxes_ready"], float(item.get("boxes_dispatched") or 0))

            items = list(items_by_id.values())
            ready_boxes = sum(float(i.get("boxes_ready") or 0) for i in items)
            pending_boxes = sum(float(i.get("boxes_pending") or 0) for i in items)
            dispatched_boxes = sum(float(i.get("boxes_dispatched") or 0) for i in items)
            ordered_boxes = sum(float(i.get("qty") or 0) for i in items)
            new_status = rollup_status([i["overall_status"] for i in items])
            now = now_iso()
            await db.purchase_orders.update_one(
                {"id": po_id}, {"$set": {
                    "items": items, "ready_boxes": ready_boxes, "pending_boxes": pending_boxes,
                    "dispatched_boxes": dispatched_boxes, "overall_status": new_status,
                    "completion_percentage": completion_percentage(ordered_boxes, dispatched_boxes),
                    "latest_ready_date": now, "last_supplier_activity_at": now, "updated_at": now,
                }}, session=session,
            )
            await _sync_customer_order_brand_status(
                po.get("customer_order_id"), po_id, new_status, session, dispatched_boxes=dispatched_boxes,
            )

            # Permanent stock evidence must roll back with the release.
            for batch in created_batches:
                await record_movement(
                    movement_type="release", purchase_order_id=po_id, po_item_id=batch["po_item_id"],
                    customer_order_id=po.get("customer_order_id"), floor_id=po.get("floor_id", TILES_FLOOR_ID),
                    customer_id=po.get("customer_id"), customer_name=po.get("customer_name") or "",
                    brand_id=po.get("brand_id"), brand_name=po.get("brand_name") or po.get("supplier_name") or "Unassigned",
                    tile_name=batch["tile_name"], series=batch.get("series"), finish=batch.get("finish"), quantity_unit=batch.get("quantity_unit") or "Box",
                    size=batch.get("size"), sku=batch.get("sku"), boxes=batch["qty"], source="Brand",
                    destination="BuildCon", performed_by=user.id, performed_by_name=user.full_name, session=session,
                )

    for batch in created_batches:
        await log_event(
            event_type="ready_batch.created", entity_type="purchase", entity_id=po_id, actor=user, floor_id=TILES_FLOOR_ID,
            customer_id=po.get("customer_id"), purchase_id=po_id,
            summary=f"Marked {batch['qty']:g} boxes of '{batch['tile_name']}' ready ({batch['batch_number']})",
            payload={"ready_batch_id": batch["id"], "batch_number": batch["batch_number"], "po_item_id": batch["po_item_id"], "qty": batch["qty"]},
        )
    if new_status:
        await log_event(
            event_type="status.changed", entity_type="purchase", entity_id=po_id, actor=user, floor_id=TILES_FLOOR_ID,
            customer_id=po.get("customer_id"), purchase_id=po_id,
            summary=f"Status changed to {new_status}", payload={"to": new_status},
        )
    return {"po_id": po_id, "ready_batches": created_batches, "overall_status": new_status}


class DispatchLineInput(BaseModel):
    po_item_id: str
    ready_batch_id: Optional[str] = None   # None = dispatch straight from Pending
    qty: float = Field(gt=0)


class DispatchBody(BaseModel):
    items: list[DispatchLineInput] = Field(min_length=1)
    destination_type: Literal["Customer", "Godown"]
    destination_name: str
    destination_address: str
    destination_city: str
    reference_number: Optional[str] = None
    receiver_name: Optional[str] = None
    sender_name: Optional[str] = None
    labor_cost: float = Field(default=0, ge=0, allow_inf_nan=False)


async def _resolve_dispatch_lines(po: dict, body: DispatchBody, session=None) -> tuple[list[dict], list[str]]:
    """Shared by preview and commit. Returns (resolved_lines, warnings) —
    resolved_lines carries per-line {po_item_id, qty, source
    ('existing'|'pending'), item, batch_or_none}. Raises 400 on any error
    that would make the dispatch invalid (unknown item, over-consuming a
    batch, more than what's Pending).

    Tracks cumulative qty already claimed per po_item_id (pending source)
    and per ready_batch_id (existing-batch source) as lines are walked, so
    that two lines in the SAME request drawing from the same pending pool
    or the same batch can't each independently pass validation against the
    same stale pre-mutation snapshot (which would double-spend/drive
    counters negative once actually applied)."""
    items_by_id = {item["id"]: item for item in po.get("items", [])}
    resolved: list[dict] = []
    warnings: list[str] = []
    claimed_pending: dict[str, float] = {}
    claimed_batch: dict[str, float] = {}
    batch_ids = list(dict.fromkeys(entry.ready_batch_id for entry in body.items if entry.ready_batch_id))
    batches_by_id = {}
    for start in range(0, len(batch_ids), 500):
        ids = batch_ids[start:start + 500]
        batches = await db.ready_batches.find(
            {"id": {"$in": ids}, "is_deleted": False, "floor_id": TILES_FLOOR_ID},
            {"_id": 0}, session=session,
        ).to_list(len(ids))
        batches_by_id.update((batch["id"], batch) for batch in batches)
    for entry in body.items:
        item = items_by_id.get(entry.po_item_id)
        if not item:
            raise HTTPException(status_code=400, detail=f"Unknown item {entry.po_item_id}")
        if entry.ready_batch_id:
            batch = batches_by_id.get(entry.ready_batch_id)
            if not batch or batch.get("po_item_id") != entry.po_item_id:
                raise HTTPException(status_code=400, detail=f"Ready batch {entry.ready_batch_id} not found for this item")
            already_claimed = claimed_batch.get(entry.ready_batch_id, 0.0)
            remaining = float(batch.get("remaining_qty") or 0) - already_claimed
            if entry.qty > remaining + 1e-6:
                raise HTTPException(status_code=400, detail=f"Only {remaining:g} boxes remain in batch {batch['batch_number']}")
            claimed_batch[entry.ready_batch_id] = already_claimed + entry.qty
            resolved.append({"po_item_id": entry.po_item_id, "qty": entry.qty, "source": "existing", "item": item, "batch": batch})
        else:
            already_claimed = claimed_pending.get(entry.po_item_id, 0.0)
            pending = float(item.get("boxes_pending") or 0) - already_claimed
            if entry.qty > pending + 1e-6:
                raise HTTPException(status_code=400, detail=f"Only {pending:g} boxes of '{item.get('name')}' are pending")
            claimed_pending[entry.po_item_id] = already_claimed + entry.qty
            warnings.append(f"'{item.get('name')}' will be dispatched directly from Pending — a Ready Batch is created automatically for the audit trail.")
            resolved.append({"po_item_id": entry.po_item_id, "qty": entry.qty, "source": "pending", "item": item, "batch": None})
    return resolved, warnings


@router.post("/purchase-orders/{po_id}/dispatch/preview")
async def preview_dispatch(po_id: str, body: DispatchBody, user: UserPublic = Depends(require_min_role("warehouse"))):
    po = await db.purchase_orders.find_one(tiles_floor_query(user, {"id": po_id}), {"_id": 0})
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    resolved, warnings = await _resolve_dispatch_lines(po, body)
    lines = [{
        "po_item_id": r["po_item_id"], "tile_name": r["item"].get("name"), "qty": r["qty"],
        "source": r["source"], "remaining_pending_after": float(r["item"].get("boxes_pending") or 0) - (r["qty"] if r["source"] == "pending" else 0),
    } for r in resolved]
    return {
        "po_id": po_id, "items": lines, "warnings": warnings,
        "will_create": {"dispatch_number": "assigned on confirm", "chalan_number": "assigned on confirm", "creates_dispatch_list_entry": True},
    }


async def _write_dispatch_batches(operations, *, session):
    # Ordered chunks share the dispatch transaction: no partial stock changes
    # are committed if a later chunk or chalan write fails.
    for start in range(0, len(operations), 500):
        chunk = operations[start:start + 500]
        result = await db.ready_batches.bulk_write(chunk, ordered=True, session=session)
        expected_updates = sum(isinstance(operation, UpdateOne) for operation in chunk)
        if result.matched_count != expected_updates:
            raise HTTPException(409, "Ready stock changed; refresh the dispatch preview and try again")


@router.post("/purchase-orders/{po_id}/dispatch")
async def commit_dispatch(po_id: str, body: DispatchBody, user: UserPublic = Depends(require_min_role("warehouse"))):
    session = await client.start_session()
    async with session:
        async with session.start_transaction():
            po = await db.purchase_orders.find_one(tiles_floor_query(user, {"id": po_id}), {"_id": 0}, session=session)
            if not po:
                raise HTTPException(status_code=404, detail="Purchase order not found")
            resolved, _warnings = await _resolve_dispatch_lines(po, body, session=session)
            items_by_id = {item["id"]: item for item in po.get("items", [])}
            year = datetime.now(timezone.utc).year
            consumed: list[TileDispatchLineConsumed] = []
            chalan_items: list[TileChalanItem] = []
            batch_operations = []

            for r in resolved:
                item = items_by_id[r["po_item_id"]]
                qty = r["qty"]
                if r["source"] == "existing":
                    batch = r["batch"]
                    # $inc (not $set off the stale in-memory snapshot) so that
                    # multiple lines against the same batch within one request
                    # — or genuinely concurrent dispatches — always decrement
                    # from the batch's true current state rather than each
                    # overwriting the other's decrement.
                    batch_operations.append(UpdateOne(
                        {"id": batch["id"], "floor_id": TILES_FLOOR_ID, "is_deleted": False,
                         "remaining_qty": {"$gte": qty - 1e-6}},
                        {"$inc": {"remaining_qty": -qty}},
                    ))
                    item["boxes_ready"] = float(item.get("boxes_ready") or 0) - qty
                    ready_batch_id = batch["id"]
                else:
                    batch_number = await next_number("ready_batch", f"RB-{year}-", collection="ready_batches", session=session)
                    auto_batch = TileReadyBatch(
                        batch_number=batch_number, purchase_order_id=po_id, po_item_id=r["po_item_id"],
                        customer_order_id=po.get("customer_order_id") or "", floor_id=po.get("floor_id", TILES_FLOOR_ID),
                        supplier_id=po.get("supplier_id"),
                        supplier_name=po.get("supplier_name") or "Unassigned", customer_id=po.get("customer_id"),
                        customer_name=po.get("customer_name") or "", tile_name=item.get("name", ""),
                        series=item.get("series"), finish=item.get("finish"), size=item.get("size"), sku=item.get("sku"),
                        qty=qty, remaining_qty=0, created_by=user.id, created_by_name=user.full_name, auto_created=True,
                    )
                    batch_operations.append(InsertOne(auto_batch.model_dump()))
                    ready_batch_id = auto_batch.id
                    item["boxes_pending"] = float(item.get("boxes_pending") or 0) - qty

                item["boxes_dispatched"] = float(item.get("boxes_dispatched") or 0) + qty
                item["overall_status"] = derive_item_status(item["qty"], float(item.get("boxes_ready") or 0), item["boxes_dispatched"])
                item["current_location"] = derive_current_location(item["qty"], float(item.get("boxes_ready") or 0), item["boxes_dispatched"])
                consumed.append(TileDispatchLineConsumed(ready_batch_id=ready_batch_id, po_item_id=r["po_item_id"], qty=qty))
                chalan_items.append(TileChalanItem(
                    po_item_id=r["po_item_id"], tile_name=item.get("name", ""), series=item.get("series"),
                    finish=item.get("finish"), size=item.get("size"), sku=item.get("sku"),
                    # boxes == quantity here: pieces_per_box is free text (e.g. "4" or
                    # "BOX", same convention as the old ChalanLineItem.unit field) so it
                    # cannot be reliably multiplied into a separate numeric piece count.
                    boxes=qty, pieces_per_box=item.get("pieces_per_box"), quantity_unit=item.get("quantity_unit") or "Box", quantity=qty,
                ))

            await _write_dispatch_batches(batch_operations, session=session)

            now = now_iso()
            dispatch_number = await next_number("dispatch", f"DSP-{year}-", collection="dispatches", session=session)
            # Deliberately shares the "chalan:CH-" counter key with the old
            # chalans-nested-in-purchase_orders path (routes/purchases_tracker.py)
            # so both paths draw from one continuously-incrementing sequence.
            # collection/array_field must match that old path exactly — if a
            # missing counter doc ever triggers re-seeding from THIS call site,
            # it needs to scan where legacy CH- numbers actually live
            # (purchase_orders.chalans[].number), not the (currently empty)
            # top-level chalans collection, or it would silently restart at
            # CH-0001 and collide with already-issued numbers.
            chalan_number = await next_number(
                "chalan", "CH-", collection="purchase_orders", array_field="chalans", width=4, session=session,
            )

            chalan = TileChalan(
                number=chalan_number, dispatch_id="", purchase_order_id=po_id, customer_order_id=po.get("customer_order_id") or "",
                floor_id=po.get("floor_id", TILES_FLOOR_ID),
                supplier_name=po.get("supplier_name") or "Unassigned", customer_name=po.get("customer_name") or "",
                customer_phone=po.get("customer_phone") or "",
                delivery_address=body.destination_address, delivery_city=body.destination_city,
                reference_number=body.reference_number, items=chalan_items,
                receiver_name=body.receiver_name, sender_name=body.sender_name,
                labor_cost=body.labor_cost,
                created_by=user.id, created_by_name=user.full_name,
                generated_at=now, generated_by_name=user.full_name,
            )
            dispatch = TileDispatch(
                dispatch_number=dispatch_number, purchase_order_id=po_id, customer_order_id=po.get("customer_order_id") or "",
                floor_id=po.get("floor_id", TILES_FLOOR_ID),
                supplier_id=po.get("supplier_id"), supplier_name=po.get("supplier_name") or "Unassigned",
                customer_id=po.get("customer_id"), customer_name=po.get("customer_name") or "",
                ready_batches_consumed=consumed, destination_type=body.destination_type,
                destination_name=body.destination_name, destination_address=body.destination_address,
                destination_city=body.destination_city, dispatch_date=now[:10], dispatch_time=now[11:16],
                created_by=user.id, created_by_name=user.full_name, chalan_id=chalan.id, labor_cost=body.labor_cost,
            )
            chalan.dispatch_id = dispatch.id
            await db.chalans.insert_one(chalan.model_dump(), session=session)
            await db.dispatches.insert_one(dispatch.model_dump(), session=session)
            await _apply_dispatch_labor_cost(po, dispatch.model_dump(), body.labor_cost, session)

            items = list(items_by_id.values())
            ordered_boxes = sum(float(i.get("qty") or 0) for i in items)
            dispatched_boxes = sum(float(i.get("boxes_dispatched") or 0) for i in items)
            new_status = rollup_status([i["overall_status"] for i in items])
            await db.purchase_orders.update_one(
                {"id": po_id}, {"$set": {
                    "items": items,
                    "ready_boxes": sum(float(i.get("boxes_ready") or 0) for i in items),
                    "pending_boxes": sum(float(i.get("boxes_pending") or 0) for i in items),
                    "dispatched_boxes": dispatched_boxes, "overall_status": new_status,
                    "completion_percentage": completion_percentage(ordered_boxes, dispatched_boxes),
                    "latest_dispatch_date": now, "last_supplier_activity_at": now, "updated_at": now,
                }}, session=session,
            )
            await _sync_customer_order_brand_status(
                po.get("customer_order_id"), po_id, new_status, session, dispatched_boxes=dispatched_boxes,
            )

    await log_event(
        event_type="dispatch.created", entity_type="purchase", entity_id=po_id, actor=user, floor_id=TILES_FLOOR_ID,
        customer_id=po.get("customer_id"), purchase_id=po_id,
        summary=f"Dispatch {dispatch.dispatch_number} created — {len(chalan_items)} line(s)",
        payload={"dispatch_id": dispatch.id, "dispatch_number": dispatch.dispatch_number},
    )
    await log_event(
        event_type="chalan.generated", entity_type="purchase", entity_id=po_id, actor=user, floor_id=TILES_FLOOR_ID,
        customer_id=po.get("customer_id"), purchase_id=po_id,
        summary=f"Chalan {chalan.number} generated for Dispatch {dispatch.dispatch_number}",
        payload={"chalan_id": chalan.id, "chalan_number": chalan.number, "dispatch_id": dispatch.id},
    )
    await log_event(
        event_type="status.changed", entity_type="purchase", entity_id=po_id, actor=user, floor_id=TILES_FLOOR_ID,
        customer_id=po.get("customer_id"), purchase_id=po_id,
        summary=f"Status changed to {new_status}", payload={"to": new_status},
    )
    return {"po_id": po_id, "dispatch": dispatch.model_dump(), "chalan": chalan.model_dump(), "overall_status": new_status}

async def _consume_released_pool(po_id: str, po_item_id: str, qty: float, session) -> list[TileDispatchLineConsumed]:
    """FIFO-consumes `qty` boxes from this item's active Released pool
    (ready_batches with remaining_qty > 0, oldest first), $inc-ing
    remaining_qty down on each. Used by both 'Move to Godown' and 'Dispatch
    from Released' — Godown-bound boxes are still released material, just
    parked at a different BuildCon-side location, so they draw from the
    exact same batch pool a customer dispatch would."""
    batches = await db.ready_batches.find(
        {"purchase_order_id": po_id, "po_item_id": po_item_id, "remaining_qty": {"$gt": 0},
         "is_deleted": False, "floor_id": TILES_FLOOR_ID},
        {"_id": 0}, session=session,
    ).to_list(500)
    batches.sort(key=lambda b: b.get("created_at", ""))
    remaining = qty
    consumed: list[TileDispatchLineConsumed] = []
    for batch in batches:
        if remaining <= 1e-9:
            break
        take = min(remaining, float(batch.get("remaining_qty") or 0))
        if take <= 0:
            continue
        await db.ready_batches.update_one({"id": batch["id"]}, {"$inc": {"remaining_qty": -take}}, session=session)
        consumed.append(TileDispatchLineConsumed(ready_batch_id=batch["id"], po_item_id=po_item_id, qty=take))
        remaining -= take
    if remaining > 1e-6:
        raise HTTPException(status_code=400, detail=f"Only {qty - remaining:g} of {qty:g} boxes available in Released stock for this item")
    return consumed


class GodownItemInput(BaseModel):
    po_item_id: str
    qty: float = Field(gt=0)


class MoveToGodownBody(BaseModel):
    items: list[GodownItemInput] = Field(min_length=1)


@router.post("/purchase-orders/{po_id}/items/move-to-godown")
async def move_material_to_godown(
    po_id: str, body: MoveToGodownBody, user: UserPublic = Depends(require_min_role("warehouse")),
):
    """Customer-page-only action ('Move to Godown'). Moves boxes already
    Released by the brand into BuildCon's own warehouse. Never generates a
    Chalan or a Dispatch — per the workflow redesign, Release and Move to
    Godown are internal BuildCon movements; a Chalan is generated only when
    material actually leaves for the customer (see the two dispatch-from-*
    endpoints below)."""
    session = await client.start_session()
    moved_rows: list[dict] = []
    now = now_iso()
    async with session:
        async with session.start_transaction():
            po = await db.purchase_orders.find_one(tiles_floor_query(user, {"id": po_id}), {"_id": 0}, session=session)
            if not po:
                raise HTTPException(status_code=404, detail="Purchase order not found")
            items_by_id = {item["id"]: item for item in po.get("items", [])}
            for entry in body.items:
                item = items_by_id.get(entry.po_item_id)
                if not item:
                    raise HTTPException(status_code=400, detail=f"Unknown item {entry.po_item_id}")
                released = float(item.get("boxes_ready") or 0)
                if entry.qty > released + 1e-6:
                    raise HTTPException(status_code=400, detail=f"Only {released:g} boxes of '{item.get('name')}' are Released")
                await _consume_released_pool(po_id, entry.po_item_id, entry.qty, session)
                item["boxes_ready"] = released - entry.qty
                item["boxes_godown"] = float(item.get("boxes_godown") or 0) + entry.qty
                _ensure_godown_arrival(item, now)
                item["overall_status"] = derive_item_status(
                    item["qty"], item["boxes_ready"], float(item.get("boxes_dispatched") or 0),
                )
                item["current_location"] = derive_current_location(
                    item["qty"], item["boxes_ready"], float(item.get("boxes_dispatched") or 0),
                    any_at_godown=item["boxes_godown"] > 0,
                )
                moved_rows.append({
                    "po_item_id": entry.po_item_id, "qty": entry.qty, "tile_name": item.get("name"),
                    "series": item.get("series"), "finish": item.get("finish"), "size": item.get("size"),
                    "sku": item.get("sku"),
                    "quantity_unit": item.get("quantity_unit") or "Box",
                })

            items = list(items_by_id.values())
            updated = await db.purchase_orders.update_one(tiles_floor_query(user, {"id": po_id}), {"$set": {
                "items": items,
                "ready_boxes": sum(float(i.get("boxes_ready") or 0) for i in items),
                "pending_boxes": sum(float(i.get("boxes_pending") or 0) for i in items),
                "dispatched_boxes": sum(float(i.get("boxes_dispatched") or 0) for i in items),
                "updated_at": now,
            }}, session=session)
            if getattr(updated, "matched_count", 1) == 0:
                raise HTTPException(status_code=409, detail="Purchase order changed — refresh and try again")

            for row in moved_rows:
                await record_movement(
                    movement_type="move_to_godown", purchase_order_id=po_id, po_item_id=row["po_item_id"],
                    customer_order_id=po.get("customer_order_id"), floor_id=po.get("floor_id", TILES_FLOOR_ID),
                    customer_id=po.get("customer_id"), customer_name=po.get("customer_name") or "",
                    brand_id=po.get("brand_id"), brand_name=po.get("brand_name") or po.get("supplier_name") or "Unassigned",
                    tile_name=row["tile_name"], series=row.get("series"), finish=row.get("finish"), quantity_unit=row.get("quantity_unit") or "Box", size=row.get("size"),
                    sku=row.get("sku"), boxes=row["qty"], source="Released", destination="BuildCon Godown",
                    performed_by=user.id, performed_by_name=user.full_name, session=session,
                )

    for row in moved_rows:
        await log_event(
            event_type="item.moved_to_godown", entity_type="purchase", entity_id=po_id, actor=user, floor_id=TILES_FLOOR_ID,
            customer_id=po.get("customer_id"), purchase_id=po_id,
            summary=f"Moved {row['qty']:g} boxes of '{row['tile_name']}' to Godown",
            payload={"po_item_id": row["po_item_id"], "qty": row["qty"]},
        )
    return {"po_id": po_id, "moved": moved_rows}


class SimpleDispatchItemInput(BaseModel):
    po_item_id: str
    qty: float = Field(gt=0)


class SimpleDispatchBody(BaseModel):
    items: list[SimpleDispatchItemInput] = Field(min_length=1)
    destination_name: Optional[str] = None
    destination_address: Optional[str] = None
    destination_city: Optional[str] = None
    reference_number: Optional[str] = None
    receiver_name: Optional[str] = None
    sender_name: Optional[str] = None
    # TileChalan has carried vehicle_number/driver_name since the redesign,
    # but no write path ever set them — so every Chalan PDF and every
    # Dispatch List row rendered a blank vehicle/driver. Captured here, at
    # the moment the operator raises the dispatch, which is when a warehouse
    # actually knows the truck.
    vehicle_number: Optional[str] = None
    driver_name: Optional[str] = None
    labor_cost: float = Field(default=0, ge=0, allow_inf_nan=False)


async def _apply_dispatch_labor_cost(po: dict, dispatch: dict, labor_cost: float, session) -> None:
    """Add a dispatch charge to the customer-facing order balance.

    Collections uses ``quotation.grand_total`` as its authoritative amount
    due. Record labor as its own pending ledger row rather than mutating the
    order-placement placeholder: operators can then see exactly which
    dispatch added the charge. The dispatch-specific automation key makes a
    transaction retry idempotent.
    """
    if labor_cost <= 0 or not po.get("quotation_id"):
        return
    quote_filter = {"id": po["quotation_id"], "floor_id": po.get("floor_id", TILES_FLOOR_ID)}
    quote_update = await db.quotations.update_one(
        quote_filter,
        {"$inc": {"grand_total": labor_cost, "labor_cost_total": labor_cost}, "$set": {"updated_at": now_iso()}},
        session=session,
    )
    if getattr(quote_update, "matched_count", 1) == 0:
        raise HTTPException(status_code=409, detail="Linked quotation changed — refresh and dispatch again")
    payment = Payment(
        quotation_id=po["quotation_id"], quotation_number=po.get("quotation_number"),
        customer_id=po["customer_id"], customer_name=po.get("customer_name"),
        amount=round(float(labor_cost), 2), mode="bank", status="pending",
        note=f"₹{format_indian_money(labor_cost, decimals=0)} labor cost added via dispatch {dispatch.get('dispatch_number', '')}".strip(),
        recorded_by=dispatch.get("created_by"), recorded_by_name=dispatch.get("created_by_name"),
        floor_id=po.get("floor_id", TILES_FLOOR_ID),
    ).model_dump()
    payment.pop("idempotency_key", None)
    # ``Payment`` is intentionally a general-purpose collection record, so
    # retain a small, structured display label alongside the audit note.  The
    # Payments screen can now identify this as a charge (rather than an
    # incoming bank payment) without parsing a human-written string.
    #
    # Keep this exact lower-case value stable: it is the customer-facing label
    # requested for every labour charge created at dispatch completion.
    payment["label"] = "labor cost"
    payment["automation_key"] = f"dispatch:{dispatch['id']}:labor_cost"
    await db.payments.update_one(
        {"automation_key": payment["automation_key"]}, {"$setOnInsert": payment}, upsert=True, session=session,
    )
    if po.get("customer_order_id"):
        await db.customer_orders.update_one(
            {"id": po["customer_order_id"], "floor_id": po.get("floor_id", TILES_FLOOR_ID)},
            {"$inc": {"total_value": labor_cost}, "$set": {"updated_at": now_iso()}},
            session=session,
        )


async def _commit_simple_dispatch(
    po_id: str, body: SimpleDispatchBody, source: Literal["released", "godown"], user: UserPublic,
) -> dict:
    """Shared by dispatch-from-released and dispatch-from-godown — both are
    Customer-page-only actions (per the redesign: the Brand/Supplier page's
    only action is Release; deciding Godown vs. Dispatch — and generating
    the Chalan — belongs to BuildCon on the Customer page). Always creates
    a Dispatch + immutable Chalan + PDF-ready record + a Material Movement
    Register row. Destination defaults to the customer's delivery snapshot
    on the parent CustomerOrder but can be overridden per-call."""
    session = await client.start_session()
    async with session:
        async with session.start_transaction():
            po = await db.purchase_orders.find_one(tiles_floor_query(user, {"id": po_id}), {"_id": 0}, session=session)
            if not po:
                raise HTTPException(status_code=404, detail="Purchase order not found")
            co_id = po.get("customer_order_id")
            co = None
            if co_id:
                co = await db.customer_orders.find_one({"id": co_id, "is_deleted": False, "floor_id": TILES_FLOOR_ID}, {"_id": 0}, session=session)
            destination_name = body.destination_name or (co.get("delivery_name") if co else None) or po.get("customer_name") or ""
            destination_address = body.destination_address or (co.get("delivery_address") if co else None) or ""
            destination_city = body.destination_city or (co.get("delivery_city") if co else None) or ""

            items_by_id = {item["id"]: item for item in po.get("items", [])}
            year = datetime.now(timezone.utc).year
            consumed: list[TileDispatchLineConsumed] = []
            chalan_items: list[TileChalanItem] = []
            movement_rows: list[dict] = []

            for entry in body.items:
                item = items_by_id.get(entry.po_item_id)
                if not item:
                    raise HTTPException(status_code=400, detail=f"Unknown item {entry.po_item_id}")
                qty = entry.qty
                if source == "released":
                    released = float(item.get("boxes_ready") or 0)
                    if qty > released + 1e-6:
                        raise HTTPException(status_code=400, detail=f"Only {released:g} boxes of '{item.get('name')}' are Released")
                    consumed.extend(await _consume_released_pool(po_id, entry.po_item_id, qty, session))
                    item["boxes_ready"] = released - qty
                else:
                    godown = float(item.get("boxes_godown") or 0)
                    if qty > godown + 1e-6:
                        raise HTTPException(status_code=400, detail=f"Only {godown:g} boxes of '{item.get('name')}' are at Godown")
                    item["boxes_godown"] = godown - qty

                item["boxes_dispatched"] = float(item.get("boxes_dispatched") or 0) + qty
                item["overall_status"] = derive_item_status(item["qty"], float(item.get("boxes_ready") or 0), item["boxes_dispatched"])
                item["current_location"] = derive_current_location(
                    item["qty"], float(item.get("boxes_ready") or 0), item["boxes_dispatched"],
                    any_at_godown=float(item.get("boxes_godown") or 0) > 0,
                )
                chalan_items.append(TileChalanItem(
                    po_item_id=entry.po_item_id, tile_name=item.get("name", ""), series=item.get("series"),
                    finish=item.get("finish"), size=item.get("size"), sku=item.get("sku"),
                    boxes=qty, pieces_per_box=item.get("pieces_per_box"), quantity_unit=item.get("quantity_unit") or "Box", quantity=qty,
                ))
                movement_rows.append({
                    "po_item_id": entry.po_item_id, "tile_name": item.get("name"), "series": item.get("series"),
                    "finish": item.get("finish"), "size": item.get("size"), "sku": item.get("sku"), "quantity_unit": item.get("quantity_unit") or "Box", "qty": qty,
                })

            now = now_iso()
            dispatch_number = await next_number("dispatch", f"DSP-{year}-", collection="dispatches", session=session)
            # Shares the "chalan:CH-" counter key with both the old
            # embedded-chalans path and the generic /dispatch endpoint above
            # — one continuously-incrementing sequence across all 3 code
            # paths, never restarts / collides.
            chalan_number = await next_number(
                "chalan", "CH-", collection="purchase_orders", array_field="chalans", width=4, session=session,
            )
            chalan = TileChalan(
                number=chalan_number, dispatch_id="", purchase_order_id=po_id, customer_order_id=co_id or "",
                floor_id=po.get("floor_id", TILES_FLOOR_ID), supplier_name=po.get("supplier_name") or "Unassigned",
                customer_name=po.get("customer_name") or "", customer_phone=po.get("customer_phone") or "",
                delivery_address=destination_address, delivery_city=destination_city,
                reference_number=body.reference_number, items=chalan_items,
                receiver_name=body.receiver_name, sender_name=body.sender_name,
                vehicle_number=body.vehicle_number, driver_name=body.driver_name,
                labor_cost=body.labor_cost,
                created_by=user.id, created_by_name=user.full_name, generated_at=now, generated_by_name=user.full_name,
            )
            dispatch = TileDispatch(
                dispatch_number=dispatch_number, purchase_order_id=po_id, customer_order_id=co_id or "",
                floor_id=po.get("floor_id", TILES_FLOOR_ID), supplier_id=po.get("supplier_id"),
                supplier_name=po.get("supplier_name") or "Unassigned", customer_id=po.get("customer_id"),
                customer_name=po.get("customer_name") or "", ready_batches_consumed=consumed, source=source,
                destination_type="Customer", destination_name=destination_name, destination_address=destination_address,
                destination_city=destination_city, dispatch_date=now[:10], dispatch_time=now[11:16],
                created_by=user.id, created_by_name=user.full_name, chalan_id=chalan.id, labor_cost=body.labor_cost,
            )
            chalan.dispatch_id = dispatch.id
            await db.chalans.insert_one(chalan.model_dump(), session=session)
            await db.dispatches.insert_one(dispatch.model_dump(), session=session)
            await _apply_dispatch_labor_cost(po, dispatch.model_dump(), body.labor_cost, session)

            items = list(items_by_id.values())
            ordered_boxes = sum(float(i.get("qty") or 0) for i in items)
            dispatched_boxes = sum(float(i.get("boxes_dispatched") or 0) for i in items)
            new_status = rollup_status([i["overall_status"] for i in items])
            await db.purchase_orders.update_one(
                {"id": po_id}, {"$set": {
                    "items": items,
                    "ready_boxes": sum(float(i.get("boxes_ready") or 0) for i in items),
                    "pending_boxes": sum(float(i.get("boxes_pending") or 0) for i in items),
                    "dispatched_boxes": dispatched_boxes, "overall_status": new_status,
                    "completion_percentage": completion_percentage(ordered_boxes, dispatched_boxes),
                    "latest_dispatch_date": now, "last_supplier_activity_at": now, "updated_at": now,
                }}, session=session,
            )
            await _sync_customer_order_brand_status(co_id, po_id, new_status, session, dispatched_boxes=dispatched_boxes)

            movement_type = "dispatch_from_released" if source == "released" else "dispatch_from_godown"
            source_label = "Released" if source == "released" else "Godown"
            for row in movement_rows:
                await record_movement(
                    movement_type=movement_type, purchase_order_id=po_id, po_item_id=row["po_item_id"],
                    customer_order_id=co_id, floor_id=po.get("floor_id", TILES_FLOOR_ID), customer_id=po.get("customer_id"),
                    customer_name=po.get("customer_name") or "", brand_id=po.get("brand_id"),
                    brand_name=po.get("brand_name") or po.get("supplier_name") or "Unassigned",
                    tile_name=row["tile_name"], series=row.get("series"), finish=row.get("finish"), quantity_unit=row.get("quantity_unit") or "Box", size=row.get("size"),
                    sku=row.get("sku"), boxes=row["qty"], source=source_label, destination=destination_name,
                    dispatch_id=dispatch.id, dispatch_number=dispatch.dispatch_number, chalan_id=chalan.id,
                    chalan_number=chalan.number, performed_by=user.id, performed_by_name=user.full_name, session=session,
                )
    await log_event(
        event_type="dispatch.created", entity_type="purchase", entity_id=po_id, actor=user, floor_id=TILES_FLOOR_ID,
        customer_id=po.get("customer_id"), purchase_id=po_id,
        summary=f"Dispatch {dispatch.dispatch_number} created from {source_label} — {len(chalan_items)} line(s)",
        payload={"dispatch_id": dispatch.id, "dispatch_number": dispatch.dispatch_number, "source": source},
    )
    await log_event(
        event_type="chalan.generated", entity_type="purchase", entity_id=po_id, actor=user, floor_id=TILES_FLOOR_ID,
        customer_id=po.get("customer_id"), purchase_id=po_id,
        summary=f"Chalan {chalan.number} generated for Dispatch {dispatch.dispatch_number}",
        payload={"chalan_id": chalan.id, "chalan_number": chalan.number, "dispatch_id": dispatch.id},
    )
    await log_event(
        event_type="status.changed", entity_type="purchase", entity_id=po_id, actor=user, floor_id=TILES_FLOOR_ID,
        customer_id=po.get("customer_id"), purchase_id=po_id,
        summary=f"Status changed to {new_status}", payload={"to": new_status},
    )
    return {"po_id": po_id, "dispatch": dispatch.model_dump(), "chalan": chalan.model_dump(), "overall_status": new_status}


@router.post("/purchase-orders/{po_id}/dispatch-from-released")
async def dispatch_from_released(
    po_id: str, body: SimpleDispatchBody, user: UserPublic = Depends(require_min_role("warehouse")),
):
    return await _commit_simple_dispatch(po_id, body, "released", user)


@router.post("/purchase-orders/{po_id}/dispatch-from-godown")
async def dispatch_from_godown(
    po_id: str, body: SimpleDispatchBody, user: UserPublic = Depends(require_min_role("warehouse")),
):
    return await _commit_simple_dispatch(po_id, body, "godown", user)




@router.get("/chalans/{chalan_id}/pdf")
async def chalan_pdf(chalan_id: str, user: UserPublic = Depends(require_min_role("sales"))):
    chalan = await db.chalans.find_one(tiles_floor_query(user, {"id": chalan_id, "is_deleted": False}), {"_id": 0})
    if not chalan:
        raise HTTPException(status_code=404, detail="Chalan not found")
    company = await db.settings.find_one({"key": "company"}, {"_id": 0}) or {}
    pdf_settings = await db.settings.find_one({"key": "pdf"}, {"_id": 0}) or {}
    branding = {
        "footer_company_name": pdf_settings.get("footer_company_name") or company.get("name") or "Buildcon House",
        "footer_phone": pdf_settings.get("footer_phone") or company.get("phone") or "",
    }
    pdf_bytes = await run_in_threadpool(build_tile_chalan_pdf, chalan, branding)
    filename = tile_chalan_pdf_filename(chalan, chalan.get("customer_name", "Customer"))
    return StreamingResponse(
        iter([pdf_bytes]), media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


class GodownReceivedBody(BaseModel):
    note: Optional[str] = None


@router.post("/dispatches/{dispatch_id}/godown-received")
async def mark_dispatch_godown_received(
    dispatch_id: str, body: GodownReceivedBody, user: UserPublic = Depends(require_min_role("warehouse")),
):
    dispatch = await db.dispatches.find_one(tiles_floor_query(user, {"id": dispatch_id, "is_deleted": False}), {"_id": 0})
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch not found")
    if dispatch.get("godown_received_at"):
        raise HTTPException(status_code=400, detail="Already marked received at Godown")

    now = now_iso()
    cas_result = await db.dispatches.update_one(
        {"id": dispatch_id, "godown_received_at": None},
        {"$set": {
            "godown_received_at": now, "godown_received_by": user.id,
            "godown_received_by_name": user.full_name, "updated_at": now,
        }},
    )
    if cas_result.matched_count == 0:
        raise HTTPException(status_code=409, detail={"error": "concurrent_modification", "message": "This dispatch was just updated — refresh and try again"})

    po = await db.purchase_orders.find_one(tiles_floor_query(user, {"id": dispatch["purchase_order_id"]}), {"_id": 0})
    if po:
        touched_item_ids = {c["po_item_id"] for c in dispatch.get("ready_batches_consumed", [])}
        items = po.get("items", [])
        for item in items:
            if item["id"] in touched_item_ids:
                item["current_location"] = derive_current_location(
                    item["qty"], float(item.get("boxes_ready") or 0), float(item.get("boxes_dispatched") or 0), any_at_godown=True,
                )
        await db.purchase_orders.update_one({"id": po["id"]}, {"$set": {"items": items, "updated_at": now}})

    await log_event(
        event_type="dispatch.godown_received", entity_type="purchase", entity_id=dispatch["purchase_order_id"], actor=user, floor_id=TILES_FLOOR_ID,
        customer_id=dispatch.get("customer_id"), purchase_id=dispatch["purchase_order_id"],
        summary=f"Dispatch {dispatch['dispatch_number']} received at Buildcon Godown" + (f" · {body.note}" if body.note else ""),
        payload={"dispatch_id": dispatch_id},
    )
    return {"dispatch_id": dispatch_id, "godown_received_at": now}


async def _dispatch_with_chalan(dispatch_id: str, user: UserPublic) -> tuple[dict, dict]:
    dispatch = await db.dispatches.find_one(tiles_floor_query(user, {"id": dispatch_id, "is_deleted": False}), {"_id": 0})
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch not found")
    chalan = await db.chalans.find_one(
        tiles_floor_query(user, {"id": dispatch.get("chalan_id"), "is_deleted": False}), {"_id": 0},
    ) or {}
    return dispatch, chalan


@router.get("/dispatches/{dispatch_id}")
async def dispatch_detail(dispatch_id: str, user: UserPublic = Depends(require_min_role("sales"))):
    """Full record behind one Dispatch List row — every line, the transport
    details, and the linked Chalan. The list endpoint above returns one row
    per PRODUCT LINE (so a 3-line dispatch appears 3 times); this returns
    the dispatch itself exactly once, which is what 'Open dispatch' needs."""
    dispatch, chalan = await _dispatch_with_chalan(dispatch_id, user)
    po = await db.purchase_orders.find_one(
        tiles_floor_query(user, {"id": dispatch["purchase_order_id"]}),
        {"_id": 0, "id": 1, "number": 1, "brand_id": 1, "brand_name": 1},
    ) or {}
    return {
        "dispatch": {
            **{k: dispatch.get(k) for k in (
                "id", "dispatch_number", "dispatch_date", "dispatch_time", "source", "destination_type",
                "destination_name", "destination_address", "destination_city", "customer_id", "customer_name",
                "customer_order_id", "purchase_order_id", "supplier_name", "created_by_name",
                "labor_cost",
                "godown_received_at", "godown_received_by_name", "delivered_at", "delivered_by_name",
            )},
            "status": _dispatch_status(dispatch),
        },
        "chalan": {
            "id": chalan.get("id"), "number": chalan.get("number"), "generated_at": chalan.get("generated_at"),
            "generated_by_name": chalan.get("generated_by_name"),
            "delivery_address": chalan.get("delivery_address"), "delivery_city": chalan.get("delivery_city"),
            "reference_number": chalan.get("reference_number"), "receiver_name": chalan.get("receiver_name"),
            "sender_name": chalan.get("sender_name"), "vehicle_number": chalan.get("vehicle_number"),
            "driver_name": chalan.get("driver_name"), "items": chalan.get("items", []),
            "labor_cost": float(chalan.get("labor_cost") or 0),
            "supplier_name": chalan.get("supplier_name"), "customer_name": chalan.get("customer_name"),
            "customer_phone": chalan.get("customer_phone"),
        },
        "brand": {"id": po.get("brand_id"), "name": po.get("brand_name") or dispatch.get("supplier_name")},
        "purchase_order": {"id": po.get("id"), "number": po.get("number")},
    }


@router.get("/chalans/{chalan_id}")
async def chalan_detail(chalan_id: str, user: UserPublic = Depends(require_min_role("sales"))):
    """Chalan as JSON, for the on-screen preview shown before the PDF is
    opened. The PDF route below renders the same record."""
    chalan = await db.chalans.find_one(tiles_floor_query(user, {"id": chalan_id, "is_deleted": False}), {"_id": 0})
    if not chalan:
        raise HTTPException(status_code=404, detail="Chalan not found")
    return chalan


class DispatchTransportBody(BaseModel):
    vehicle_number: Optional[str] = None
    driver_name: Optional[str] = None
    receiver_name: Optional[str] = None
    sender_name: Optional[str] = None
    reference_number: Optional[str] = None


@router.patch("/dispatches/{dispatch_id}/transport")
async def update_dispatch_transport(
    dispatch_id: str, body: DispatchTransportBody, user: UserPublic = Depends(require_min_role("warehouse")),
):
    """'Edit dispatch' — transport/handover details only.

    TileChalan is immutable in the sense the model docstring protects: the
    LINES (which product, how many boxes, from which batches) and the
    parties can never be edited — a correction there is always a new
    Dispatch + new Chalan. Vehicle number, driver, receiver/sender and the
    reference number are logistics metadata a warehouse routinely fills in
    or corrects after the chalan is cut (the truck is often assigned later),
    so those — and only those — are editable, and every change is written
    to the activity timeline below.
    """
    dispatch, chalan = await _dispatch_with_chalan(dispatch_id, user)
    if not chalan:
        raise HTTPException(status_code=404, detail="Chalan not found for this dispatch")
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    now = now_iso()
    await db.chalans.update_one({"id": chalan["id"]}, {"$set": {**updates, "updated_at": now}})
    await db.dispatches.update_one({"id": dispatch_id}, {"$set": {"updated_at": now}})
    await log_event(
        event_type="chalan.updated", entity_type="purchase", entity_id=dispatch["purchase_order_id"], actor=user, floor_id=TILES_FLOOR_ID,
        customer_id=dispatch.get("customer_id"), purchase_id=dispatch["purchase_order_id"],
        summary=f"Chalan {chalan.get('number')} transport details updated — "
                + ", ".join(f"{k.replace('_', ' ')}: {v}" for k, v in updates.items()),
        payload={"chalan_id": chalan["id"], "dispatch_id": dispatch_id, "changes": updates},
    )
    return {"dispatch_id": dispatch_id, "chalan_id": chalan["id"], **updates}


class DeliveredBody(BaseModel):
    received_by: Optional[str] = None
    note: Optional[str] = None


@router.post("/dispatches/{dispatch_id}/delivered")
async def mark_dispatch_delivered(
    dispatch_id: str, body: DeliveredBody, user: UserPublic = Depends(require_min_role("warehouse")),
):
    """Closes the workflow's final step. TileDispatch.delivered_at and the
    `all_delivered` branches of derive_item_status/derive_current_location
    were modelled by the redesign but left unreachable — nothing ever set
    the field, so 'Delivered' was a status no order could reach through the
    UI. This is the action that sets it, and it writes the matching
    Material Movement Register rows so the audit trail ends where the
    physical journey does."""
    dispatch, chalan = await _dispatch_with_chalan(dispatch_id, user)
    if dispatch.get("delivered_at"):
        raise HTTPException(status_code=400, detail="This dispatch is already marked delivered")

    now = now_iso()
    po_id = dispatch["purchase_order_id"]
    co_id = dispatch.get("customer_order_id")
    session = await client.start_session()
    async with session:
        async with session.start_transaction():
            # CAS on delivered_at — two operators confirming the same
            # delivery must not both pass, or the register would show the
            # delivery twice.
            cas = await db.dispatches.update_one(
                {"id": dispatch_id, "delivered_at": None},
                {"$set": {
                    "delivered_at": now, "delivered_by": user.id,
                    "delivered_by_name": body.received_by or user.full_name, "updated_at": now,
                }}, session=session,
            )
            if cas.matched_count == 0:
                raise HTTPException(status_code=409, detail={
                    "error": "concurrent_modification",
                    "message": "This dispatch was just updated — refresh and try again",
                })

            po = await db.purchase_orders.find_one(tiles_floor_query(user, {"id": po_id}), {"_id": 0}, session=session)
            new_status = None
            if po:
                # An item counts as Delivered only when EVERY dispatch that
                # ever moved it has been delivered — a partially-delivered
                # item stays Dispatched.
                siblings = await db.dispatches.find(
                    tiles_floor_query(user, {"purchase_order_id": po_id, "is_deleted": False}), {"_id": 0},
                ).to_list(2000)
                sibling_ids = [sibling["id"] for sibling in siblings]
                chalans = await db.chalans.find(
                    {"dispatch_id": {"$in": sibling_ids}, "is_deleted": False},
                    {"_id": 0, "dispatch_id": 1, "items": 1},
                ).to_list(2000)
                chalan_items_by_dispatch = {
                    chalan["dispatch_id"]: chalan.get("items", []) for chalan in chalans
                }
                undelivered: set[str] = set()
                dispatched_items: set[str] = set()
                for sibling in siblings:
                    is_open = sibling["id"] != dispatch_id and not sibling.get("delivered_at")
                    for line in sibling.get("ready_batches_consumed", []):
                        dispatched_items.add(line["po_item_id"])
                        if is_open:
                            undelivered.add(line["po_item_id"])
                    # Godown-origin dispatches do not consume a ReadyBatch;
                    # their immutable Chalan is the source of truth for the
                    # PO items that were actually dispatched.
                    for line in chalan_items_by_dispatch.get(sibling["id"], []):
                        dispatched_items.add(line["po_item_id"])
                        if is_open:
                            undelivered.add(line["po_item_id"])

                items = po.get("items", [])
                for item in items:
                    fully_delivered = item["id"] in dispatched_items and item["id"] not in undelivered
                    item["overall_status"] = derive_item_status(
                        item["qty"], float(item.get("boxes_ready") or 0), float(item.get("boxes_dispatched") or 0),
                        all_delivered=fully_delivered,
                    )
                    item["current_location"] = derive_current_location(
                        item["qty"], float(item.get("boxes_ready") or 0), float(item.get("boxes_dispatched") or 0),
                        any_at_godown=float(item.get("boxes_godown") or 0) > 0, all_delivered=fully_delivered,
                    )
                new_status = rollup_status([i["overall_status"] for i in items])
                await db.purchase_orders.update_one(
                    {"id": po_id}, {"$set": {"items": items, "overall_status": new_status, "updated_at": now}},
                    session=session,
                )
                await _sync_customer_order_brand_status(
                    co_id, po_id, new_status, session,
                    dispatched_boxes=sum(float(i.get("boxes_dispatched") or 0) for i in items),
                )

            for line in chalan.get("items", []):
                await record_movement(
                    movement_type="delivered", purchase_order_id=po_id, po_item_id=line.get("po_item_id"),
                    customer_order_id=co_id, floor_id=dispatch.get("floor_id", TILES_FLOOR_ID),
                    customer_id=dispatch.get("customer_id"), customer_name=dispatch.get("customer_name") or "",
                    brand_id=(po or {}).get("brand_id"),
                    brand_name=(po or {}).get("brand_name") or dispatch.get("supplier_name") or "Unassigned",
                    tile_name=line.get("tile_name") or "", series=line.get("series"), finish=line.get("finish"), quantity_unit=line.get("quantity_unit") or "Box",
                    size=line.get("size"), sku=line.get("sku"), boxes=float(line.get("boxes") or 0),
                    source="Godown" if dispatch.get("source") == "godown" else "Released",
                    destination=dispatch.get("destination_name") or "Customer",
                    dispatch_id=dispatch_id, dispatch_number=dispatch.get("dispatch_number"),
                    chalan_id=chalan.get("id"), chalan_number=chalan.get("number"),
                    performed_by=user.id, performed_by_name=user.full_name, session=session,
                )
    await log_event(
        event_type="dispatch.delivered", entity_type="purchase", entity_id=po_id, actor=user, floor_id=TILES_FLOOR_ID,
        customer_id=dispatch.get("customer_id"), purchase_id=po_id,
        summary=f"Dispatch {dispatch['dispatch_number']} delivered"
                + (f" — received by {body.received_by}" if body.received_by else "")
                + (f" · {body.note}" if body.note else ""),
        payload={"dispatch_id": dispatch_id, "chalan_id": chalan.get("id")},
    )
    return {"dispatch_id": dispatch_id, "delivered_at": now, "overall_status": new_status}


_STATUS_TO_KPI_KEY = {
    "Pending": "pending", "Ready": "ready", "Partially Dispatched": "partially_dispatched",
    "Dispatched": "completed", "Delivered": "completed",
}


def _is_fully_delivered(pos: list[dict], dispatches: list[dict]) -> bool:
    """Return whether every ordered box has a completed customer dispatch.

    This deliberately uses child counters and delivery timestamps rather than
    the denormalized customer-order status, which may lag after a concurrent
    parent rollup update.
    """
    items = [item for po in pos for item in po.get("items", [])]
    if not items or not dispatches:
        return False
    return all(
        float(item.get("qty") or 0) > 0
        and float(item.get("boxes_dispatched") or 0) >= float(item.get("qty") or 0) - 1e-6
        for item in items
    ) and all(dispatch.get("delivered_at") for dispatch in dispatches)


def _is_fully_dispatched(pos: list[dict], dispatches: list[dict]) -> bool:
    """Return whether every ordered box has left BuildCon.

    History is keyed to the user-visible 100% completion metric, which is
    based on dispatched boxes. Delivery confirmation is a later status.
    """
    items = [item for po in pos for item in po.get("items", [])]
    return bool(items and dispatches) and all(
        float(item.get("qty") or 0) > 0
        and float(item.get("boxes_dispatched") or 0) >= float(item.get("qty") or 0) - 1e-6
        for item in items
    )


def _ensure_godown_arrival(item: dict, arrived_at: str) -> None:
    """Set the first Godown arrival time, preserving it on later moves."""
    if not item.get("godown_arrived_at"):
        item["godown_arrived_at"] = arrived_at


@router.get("/suppliers")
async def list_suppliers(user: UserPublic = Depends(require_min_role("sales"))):
    pos = await db.purchase_orders.find(tiles_floor_query(user, {"customer_order_id": {"$ne": None}}), {"_id": 0}).to_list(5000)
    grouped: dict[str, dict] = {}
    for po in pos:
        key = po.get("supplier_id") or "unassigned"
        bucket = grouped.setdefault(key, {
            "supplier_id": po.get("supplier_id"), "supplier_name": po.get("supplier_name") or "Unassigned",
            "active_orders": 0, "max_supplier_silent_days": 0,
        })
        if po.get("overall_status") != "Delivered":
            bucket["active_orders"] += 1
        silent = supplier_silent_days(po.get("last_supplier_activity_at"), po["created_at"])
        bucket["max_supplier_silent_days"] = max(bucket["max_supplier_silent_days"], silent)
    suppliers = sorted(grouped.values(), key=lambda g: -g["max_supplier_silent_days"])
    return {"suppliers": suppliers}


@router.get("/brands")
async def list_brands(
    page: int = Query(1, ge=1), page_size: int = Query(30, ge=1, le=100),
    search: Optional[str] = None,
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Tile Orders 'Brands' tab landing — one card per Brand (Qutone,
    Dimore, Kajaria…), NOT per dealer/supplier company. A brand and its
    supplier can differ (Supplier.name is 'a dealership we buy from,
    normally one per brand but not strict') — grouping here is on
    PurchaseOrder.brand_id/brand_name, which is set once per-brand at
    order-placement time (services/domain_outbox.py), so this always
    matches the brand the customer actually ordered, never the dealer."""
    page = page if isinstance(page, int) else 1
    page_size = page_size if isinstance(page_size, int) else 30
    match = tiles_floor_query(user, {"customer_order_id": {"$ne": None}})
    if search:
        match["brand_name"] = {"$regex": re.escape(search[:80]), "$options": "i"}
    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": {"$ifNull": ["$brand_id", "unassigned"]},
            "brand_id": {"$first": "$brand_id"},
            "brand_name": {"$first": {"$ifNull": ["$brand_name", "Unassigned"]}},
            "active_orders": {"$sum": {"$cond": [{"$ne": ["$overall_status", "Delivered"]}, 1, 0]}},
            "oldest_activity_at": {"$min": {"$ifNull": ["$last_supplier_activity_at", "$created_at"]}},
        }},
        {"$sort": {"brand_name": 1}},
        {"$facet": {
            "rows": [{"$skip": (page - 1) * page_size}, {"$limit": page_size}],
            "meta": [{"$count": "total"}],
        }},
    ]
    result = await db.purchase_orders.aggregate(pipeline).to_list(1)
    bucket = result[0] if result else {"rows": [], "meta": []}
    total = bucket.get("meta", [{}])[0].get("total", 0) if bucket.get("meta") else 0
    brands = [{
        "brand_id": row.get("brand_id"), "brand_name": row.get("brand_name") or "Unassigned",
        "active_orders": row.get("active_orders", 0),
        "max_supplier_silent_days": supplier_silent_days(None, row.get("oldest_activity_at") or now_iso()),
    } for row in bucket.get("rows", [])]
    return {"brands": brands, "page": page, "page_size": page_size, "total": total,
            "has_more": page * page_size < total, "next_page": page + 1 if page * page_size < total else None}


async def _tile_order_page(query: dict, page: int, page_size: int, sort: str) -> tuple[list[dict], dict] | None:
    """Bound returned PO documents while retaining full-result KPI totals.

    A single facet replaces sequential count/page/summary Atlas round trips.
    The list response only needs box totals and item counts, not full image,
    transfer or stage histories from every purchase order.
    """
    if not hasattr(db.purchase_orders, "aggregate"):
        return None
    result = await db.purchase_orders.aggregate([
        {"$match": query},
        {"$facet": {
            "orders": [
                {"$sort": {"created_at": 1 if sort != "waiting_asc" else -1, "id": 1}},
                {"$skip": (page - 1) * page_size}, {"$limit": page_size},
                {"$project": {"_id": 0, "id": 1, "number": 1, "customer_id": 1,
                              "customer_name": 1, "created_at": 1, "overall_status": 1,
                              "completion_percentage": 1, "items.qty": 1,
                              "items.boxes_ready": 1, "items.boxes_pending": 1}},
            ],
            "metrics": [{"$group": {
                "_id": None, "orders": {"$sum": 1},
                "pending": {"$sum": {"$cond": [{"$eq": ["$overall_status", "Pending"]}, 1, 0]}},
                "ready": {"$sum": {"$cond": [{"$eq": ["$overall_status", "Ready"]}, 1, 0]}},
                "partially_dispatched": {"$sum": {"$cond": [{"$eq": ["$overall_status", "Partially Dispatched"]}, 1, 0]}},
                "completed": {"$sum": {"$cond": [{"$in": ["$overall_status", ["Dispatched", "Delivered"]]}, 1, 0]}},
                "other": {"$sum": {"$cond": [{"$in": ["$overall_status", ["Pending", "Ready", "Partially Dispatched", "Dispatched", "Delivered"]]}, 0, 1]}},
                "boxes_pending": {"$sum": {"$ifNull": ["$pending_boxes", 0]}},
                "boxes_ready": {"$sum": {"$ifNull": ["$ready_boxes", 0]}},
                "boxes_dispatched": {"$sum": {"$ifNull": ["$dispatched_boxes", 0]}},
                "oldest_pending_at": {"$min": {"$cond": [{"$eq": ["$overall_status", "Pending"]}, "$created_at", "9999-12-31T23:59:59+00:00"]}},
            }}],
        }},
    ]).to_list(1)
    facet = result[0] if result else {}
    metric = (facet.get("metrics") or [{}])[0]
    kpi = {key: metric.get(key, 0) for key in ("orders", "pending", "ready", "partially_dispatched", "completed")}
    kpi["other"] = metric.get("other", 0)
    kpi.update({key: float(metric.get(key) or 0) for key in ("boxes_pending", "boxes_ready", "boxes_dispatched")})
    kpi["oldest_pending_days"] = waiting_days(metric["oldest_pending_at"]) if metric.get("pending") and metric.get("oldest_pending_at") else 0
    return facet.get("orders") or [], kpi


@router.get("/brands/{brand_id}/orders")
async def brand_orders(
    brand_id: str, page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100), sort: str = "waiting_desc",
    status: Optional[str] = None, search: Optional[str] = None,
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Brand Detail page — this brand's Customer Orders only, one row per
    PO. Mirrors supplier_orders() above but grouped by brand_id, and adds
    `arrival_date` (the date this order was placed with the brand — there's
    no separate 'expected arrival' field on PurchaseOrder today, so this is
    order_date) + `boxes_released`/`boxes_remaining` for the Ordered/
    Released/Remaining columns the Brand page shows."""
    page = page if isinstance(page, int) else 1
    page_size = page_size if isinstance(page_size, int) else 20
    filters: dict = {"brand_id": brand_id}
    if status:
        filters["overall_status"] = filter_condition(status)
    if search:
        safe_search = {"$regex": re.escape(search[:80]), "$options": "i"}
        filters["$or"] = [
            {"customer_name": safe_search},
            {"number": safe_search},
        ]
    query = tiles_floor_query(user, filters)
    paged = await _tile_order_page(query, page, page_size, sort)
    database_paging = paged is not None
    if paged is not None:
        all_pos, kpi = paged
        total = int(kpi["orders"])
        kpi.pop("other", None)
        kpi["boxes_remaining"] = kpi.pop("boxes_pending")
        kpi["boxes_released"] = kpi.pop("boxes_ready")
    else:
        all_pos = await db.purchase_orders.find(query, {"_id": 0}).to_list(5000)
        total = len(all_pos)

    if not database_paging:
        kpi = {"orders": len(all_pos), "pending": 0, "ready": 0, "partially_dispatched": 0, "completed": 0,
               "boxes_remaining": 0.0, "boxes_released": 0.0, "boxes_dispatched": 0.0, "oldest_pending_days": 0}
        for po in all_pos:
            kpi[_STATUS_TO_KPI_KEY.get(po.get("overall_status"), "pending")] += 1
            kpi["boxes_remaining"] += float(po.get("pending_boxes") or 0)
            kpi["boxes_released"] += float(po.get("ready_boxes") or 0)
            kpi["boxes_dispatched"] += float(po.get("dispatched_boxes") or 0)
            if po.get("overall_status") == "Pending":
                kpi["oldest_pending_days"] = max(kpi["oldest_pending_days"], waiting_days(po["created_at"]))

    rows = []
    for po in all_pos:
        days = waiting_days(po["created_at"])
        total_boxes = sum(float(i.get("qty") or 0) for i in po.get("items", []))
        boxes_released = sum(float(i.get("boxes_ready") or 0) for i in po.get("items", []))
        boxes_remaining = sum(float(i.get("boxes_pending") or 0) for i in po.get("items", []))
        rows.append({
            "po_id": po["id"], "po_number": po.get("number"), "customer_id": po.get("customer_id"),
            "customer_name": po.get("customer_name"), "order_date": po.get("created_at"),
            "arrival_date": po.get("created_at"), "waiting_days": days, "ageing_band": ageing_band(days),
            "total_products": len(po.get("items", [])), "total_boxes": total_boxes,
            "boxes_released": boxes_released, "boxes_remaining": boxes_remaining,
            "overall_status": po.get("overall_status"), "completion_percentage": po.get("completion_percentage"),
        })
    if not database_paging:
        rows.sort(key=lambda r: r["waiting_days"], reverse=(sort != "waiting_asc"))
        rows = rows[(page - 1) * page_size:page * page_size]
    return {"kpi": kpi, "orders": rows, "page": page, "page_size": page_size, "total": total,
            "has_more": page * page_size < total, "next_page": page + 1 if page * page_size < total else None}


@router.get("/purchase-orders/{po_id}")
async def purchase_order_detail(po_id: str, user: UserPublic = Depends(require_min_role("sales"))):
    po = await db.purchase_orders.find_one(tiles_floor_query(user, {"id": po_id}), {"_id": 0})
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    # Delivery snapshot lives on the parent TileCustomerOrder (captured once
    # at placement time by domain_outbox.py's _handle_order_placed), not on
    # the PurchaseOrder itself — a Supplier-side dispatch still needs it to
    # fill in the (otherwise permanently blank) immutable Chalan's delivery
    # address/city. Defaults to "" only if there's no linked CustomerOrder
    # (e.g. a non-tiles PO) or it can't be found.
    delivery_name = delivery_phone = delivery_address = delivery_city = ""
    co_id = po.get("customer_order_id")
    if co_id:
        co = await db.customer_orders.find_one({"id": co_id, "is_deleted": False, "floor_id": TILES_FLOOR_ID}, {"_id": 0})
        if co:
            delivery_name = co.get("delivery_name") or ""
            delivery_phone = co.get("delivery_phone") or ""
            delivery_address = co.get("delivery_address") or ""
            delivery_city = co.get("delivery_city") or ""
    items = [{**item, "floor_id": po.get("floor_id")} for item in po.get("items", [])]
    await hydrate_purchase_images(items)
    return {
        "id": po["id"], "number": po.get("number"), "customer_name": po.get("customer_name"),
        "supplier_name": po.get("supplier_name"), "brand_id": po.get("brand_id"), "brand_name": po.get("brand_name"),
        "overall_status": po.get("overall_status"),
        "delivery_name": delivery_name, "delivery_phone": delivery_phone,
        "delivery_address": delivery_address, "delivery_city": delivery_city,
        "items": [{
            "id": item["id"], "name": item.get("name"), "series": item.get("series"), "finish": item.get("finish"),
            "size": item.get("size"), "sku": item.get("sku"), "qty": item.get("qty"),
            "product_id": item.get("product_id"), "image": item.get("image"),
            "boxes_ready": item.get("boxes_ready"), "boxes_godown": item.get("boxes_godown") or 0,
            "boxes_dispatched": item.get("boxes_dispatched"),
            "boxes_pending": item.get("boxes_pending"), "quantity_unit": item.get("quantity_unit") or "Box", "current_location": item.get("current_location"),
            "overall_status": item.get("overall_status"),
        } for item in items],
    }


@router.get("/suppliers/{supplier_id}/orders")
async def supplier_orders(
    supplier_id: str, page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100), sort: str = "waiting_desc",
    status: Optional[str] = None, search: Optional[str] = None,
    user: UserPublic = Depends(require_min_role("sales")),
):
    page = page if isinstance(page, int) else 1
    page_size = page_size if isinstance(page_size, int) else 20
    filters: dict = {"supplier_id": supplier_id}
    if status:
        filters["overall_status"] = filter_condition(status)
    if search:
        safe_search = {"$regex": re.escape(search[:80]), "$options": "i"}
        filters["$or"] = [
            {"customer_name": safe_search},
            {"number": safe_search},
        ]
    query = tiles_floor_query(user, filters)
    paged = await _tile_order_page(query, page, page_size, sort)
    database_paging = paged is not None
    if paged is not None:
        all_pos, kpi = paged
        total = int(kpi["orders"])
        kpi["pending"] += kpi.pop("other", 0)
    else:
        all_pos = await db.purchase_orders.find(query, {"_id": 0}).to_list(5000)
        total = len(all_pos)
        kpi = {"orders": len(all_pos), "pending": 0, "ready": 0, "partially_dispatched": 0, "completed": 0,
               "boxes_pending": 0.0, "boxes_ready": 0.0, "boxes_dispatched": 0.0, "oldest_pending_days": 0}
        for po in all_pos:
            kpi[_STATUS_TO_KPI_KEY.get(po.get("overall_status"), "pending")] += 1
            kpi["boxes_pending"] += float(po.get("pending_boxes") or 0)
            kpi["boxes_ready"] += float(po.get("ready_boxes") or 0)
            kpi["boxes_dispatched"] += float(po.get("dispatched_boxes") or 0)
            if po.get("overall_status") == "Pending":
                kpi["oldest_pending_days"] = max(kpi["oldest_pending_days"], waiting_days(po["created_at"]))

    rows = []
    for po in all_pos:
        days = waiting_days(po["created_at"])
        rows.append({
            "po_id": po["id"], "po_number": po.get("number"), "customer_id": po.get("customer_id"),
            "customer_name": po.get("customer_name"), "order_date": po.get("created_at"),
            "waiting_days": days, "ageing_band": ageing_band(days),
            "total_products": len(po.get("items", [])), "total_boxes": sum(float(i.get("qty") or 0) for i in po.get("items", [])),
            "overall_status": po.get("overall_status"), "completion_percentage": po.get("completion_percentage"),
        })
    if not database_paging:
        rows.sort(key=lambda r: r["waiting_days"], reverse=(sort != "waiting_asc"))
        rows = rows[(page - 1) * page_size:page * page_size]
    return {"kpi": kpi, "orders": rows, "page": page, "page_size": page_size, "total": total,
            "has_more": page * page_size < total, "next_page": page + 1 if page * page_size < total else None}


@router.get("/suppliers/{supplier_id}/analytics")
async def supplier_analytics(supplier_id: str, user: UserPublic = Depends(require_min_role("sales"))):
    pos = await db.purchase_orders.find(tiles_floor_query(user, {"supplier_id": supplier_id}), {"_id": 0}).to_list(5000)
    if not pos:
        return {"orders": 0, "waiting_avg_days": 0, "ready_time_avg_days": 0, "dispatch_time_avg_days": 0, "fulfilment_time_avg_days": 0, "oldest_pending_days": 0, "completion_percentage_avg": 0}

    ready_times, dispatch_times, fulfilment_times = [], [], []
    oldest_pending = 0
    for po in pos:
        created = po["created_at"]
        if po.get("overall_status") == "Pending":
            oldest_pending = max(oldest_pending, waiting_days(created))
        if po.get("latest_ready_date"):
            ready_times.append(waiting_days(created) - waiting_days(po["latest_ready_date"]))
        if po.get("latest_ready_date") and po.get("latest_dispatch_date"):
            dispatch_times.append(waiting_days(po["latest_ready_date"]) - waiting_days(po["latest_dispatch_date"]))
        if po.get("overall_status") in ("Dispatched", "Delivered"):
            fulfilment_times.append(waiting_days(created) - waiting_days(po.get("latest_dispatch_date") or created))

    def _avg(values: list[float]) -> float:
        return round(sum(values) / len(values), 1) if values else 0.0

    return {
        "orders": len(pos),
        "waiting_avg_days": _avg([waiting_days(po["created_at"]) for po in pos]),
        "ready_time_avg_days": _avg(ready_times),
        "dispatch_time_avg_days": _avg(dispatch_times),
        "fulfilment_time_avg_days": _avg(fulfilment_times),
        "oldest_pending_days": oldest_pending,
        # Computed live from each PO's ordered/dispatched box counts (the
        # same completion_percentage() used by the write endpoints above)
        # rather than trusted off po["completion_percentage"] — that stored
        # field is a write-time snapshot and this view should reflect the
        # PO's current box counters even if something upstream left it stale.
        "completion_percentage_avg": _avg([
            completion_percentage(
                sum(float(i.get("qty") or 0) for i in po.get("items", [])),
                float(po.get("dispatched_boxes") or 0),
            )
            for po in pos
        ]),
    }


@router.get("/customer-orders")
async def list_customer_orders(
    page: int = Query(1, ge=1), page_size: int = Query(30, ge=1, le=100), sort: str = "waiting_desc",
    status: Optional[str] = None, search: Optional[str] = None, customer_id: Optional[str] = None,
    user: UserPublic = Depends(require_min_role("sales")),
):
    page = page if isinstance(page, int) else 1
    page_size = page_size if isinstance(page_size, int) else 30
    # The Customer tab is the active fulfilment queue. Once every ordered box
    # has been dispatched, the dispatch records (and their Chalans) are the
    # operational source of truth, so a completed order must leave this list
    # instead of being shown alongside customers still awaiting fulfilment.
    # Every dispatch write path refreshes this field transactionally through
    # _sync_customer_order_brand_status().
    filters: dict = {"is_deleted": False, "completion_percentage": {"$lt": 100}}
    # A Customer delivery lookup must use the stable customer id rather than
    # name search: names can be duplicated and a partial search could show a
    # different customer's dispatch status.
    if customer_id:
        filters["customer_id"] = filter_condition(customer_id)
    if status:
        filters["overall_status"] = filter_condition(status)
    if search:
        safe_search = {"$regex": re.escape(search[:80]), "$options": "i"}
        filters["$or"] = [
            {"customer_name": safe_search},
            {"customer_phone": safe_search},
            {"number": safe_search},
        ]
    query = tiles_floor_query(user, filters)
    cursor = db.customer_orders.find(query, {"_id": 0})
    if hasattr(db.customer_orders, "count_documents") and hasattr(cursor, "sort"):
        total = await db.customer_orders.count_documents(query)
        direction = 1 if sort == "waiting_desc" else -1
        docs = await cursor.sort("created_at", direction).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
    else:  # lightweight unit-test collections retain the same semantics
        all_docs = await cursor.to_list(5000)
        all_docs.sort(key=lambda row: row.get("created_at", ""), reverse=(sort == "waiting_asc"))
        total = len(all_docs)
        docs = all_docs[(page - 1) * page_size:page * page_size]
    rows = []
    for co in docs:
        days = waiting_days(co["created_at"])
        rows.append({
            "id": co["id"], "number": co.get("number"), "customer_name": co.get("customer_name"),
            "customer_phone": co.get("customer_phone"), "order_date": co.get("created_at"),
            "waiting_days": days, "ageing_band": ageing_band(days), "brands": co.get("brands", []),
            "total_products": co.get("total_products"), "total_boxes": co.get("total_boxes"),
            "total_value": co.get("total_value"), "overall_status": co.get("overall_status"),
            "completion_percentage": co.get("completion_percentage"),
        })
    return {"orders": rows, "page": page, "page_size": page_size, "total": total,
            "has_more": page * page_size < total, "next_page": page + 1 if page * page_size < total else None}


@router.get("/customer-orders/{co_id}")
async def customer_order_detail(co_id: str, user: UserPublic = Depends(require_min_role("sales"))):
    co = await db.customer_orders.find_one(tiles_floor_query(user, {"id": co_id, "is_deleted": False}), {"_id": 0})
    if not co:
        raise HTTPException(status_code=404, detail="Customer order not found")
    pos = await db.purchase_orders.find(tiles_floor_query(user, {"customer_order_id": co_id}), {"_id": 0}).to_list(50)
    items_by_po = {po["id"]: [{**item, "floor_id": po.get("floor_id")} for item in po.get("items", [])] for po in pos}
    await hydrate_purchase_images([item for items in items_by_po.values() for item in items])
    suppliers = [{
        "purchase_order_id": po["id"], "supplier_name": po.get("supplier_name") or "Unassigned",
        "brand_id": po.get("brand_id"), "brand_name": po.get("brand_name") or po.get("supplier_name") or "Unassigned",
        "overall_status": po.get("overall_status"),
        "items": [{
            "po_item_id": item["id"], "tile_name": item.get("name"), "series": item.get("series"),
            "finish": item.get("finish"), "size": item.get("size"), "sku": item.get("sku"),
            "product_id": item.get("product_id"), "image": item.get("image"),
            "boxes_ordered": item.get("qty"), "boxes_ready": item.get("boxes_ready"),
            "boxes_godown": item.get("boxes_godown") or 0,
            "boxes_dispatched": item.get("boxes_dispatched"), "boxes_pending": item.get("boxes_pending"),
            "quantity_unit": item.get("quantity_unit") or "Box", "current_location": item.get("current_location"), "overall_status": item.get("overall_status"),
        } for item in items_by_po[po["id"]]],
    } for po in pos]
    days = waiting_days(co["created_at"])
    return {
        "summary": {
            "id": co["id"], "number": co.get("number"), "customer_name": co.get("customer_name"),
            "order_date": co.get("created_at"), "brand_count": len(co.get("brands", [])),
            "total_products": co.get("total_products"), "total_boxes": co.get("total_boxes"),
            "completion_percentage": co.get("completion_percentage"), "waiting_days": days,
            "ageing_band": ageing_band(days), "overall_status": co.get("overall_status"),
        },
        "suppliers": suppliers,
    }


@router.get("/customer-orders/{co_id}/timeline")
async def customer_order_timeline(co_id: str, user: UserPublic = Depends(require_min_role("sales"))):
    co = await db.customer_orders.find_one(tiles_floor_query(user, {"id": co_id, "is_deleted": False}), {"_id": 0, "id": 1})
    if not co:
        raise HTTPException(status_code=404, detail="Customer order not found")
    pos = await db.purchase_orders.find(tiles_floor_query(user, {"customer_order_id": co_id}), {"_id": 0, "id": 1}).to_list(50)
    po_ids = [po["id"] for po in pos]
    events = await db.activity_events.find(
        {"$or": [
            {"entity_type": "tile_customer_order", "entity_id": co_id},
            {"purchase_id": {"$in": po_ids}},
        ]}, {"_id": 0},
    ).to_list(500)
    # Older activity rows predate floor stamping. They are safe to retain here
    # because the parent CustomerOrder and PO ids were already floor-scoped;
    # explicitly stamped events must still belong to Ground Floor.
    events = [event for event in events if event.get("floor_id") in (None, TILES_FLOOR_ID)]
    events.sort(key=lambda e: e.get("created_at", ""), reverse=True)
    return {"events": events}


def _dispatch_status(dispatch: dict) -> str:
    if dispatch.get("delivered_at"):
        return "Delivered"
    if dispatch.get("godown_received_at"):
        return "At Godown"
    return "Dispatched"


@router.get("/dispatches")
async def list_dispatches(
    customer_id: Optional[str] = None, brand_id: Optional[str] = None, product: Optional[str] = None,
    dispatch_number: Optional[str] = None, chalan_number: Optional[str] = None, status: Optional[str] = None,
    date_from: Optional[str] = None, date_to: Optional[str] = None, search: Optional[str] = None,
    page: int = 1, page_size: int = 50, sort: str = "date_desc",
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Dispatch List — operational, dispatch-only view (Tile Orders workflow
    redesign, 2026-08). Every row is ONE dispatched product line — never a
    Release or Move-to-Godown event (those only ever appear on the
    Material Movement Register, see list_material_movements above). Built
    from TileDispatch + its 1:1 TileChalan, one row per Chalan line item."""
    filters: dict = {"is_deleted": False}
    if customer_id:
        filters["customer_id"] = filter_condition(customer_id)
    if dispatch_number:
        filters["dispatch_number"] = {"$regex": dispatch_number, "$options": "i"}
    if date_from or date_to:
        date_filter: dict = {}
        if date_from:
            date_filter["$gte"] = date_from
        if date_to:
            date_filter["$lte"] = date_to
        filters["dispatch_date"] = date_filter
    if hasattr(db.dispatches, "aggregate"):
        pipeline: list[dict] = [
            {"$match": tiles_floor_query(user, filters)},
            {"$lookup": {"from": "chalans", "localField": "chalan_id", "foreignField": "id", "as": "chalan"}},
            {"$unwind": "$chalan"},
            {"$match": {"chalan.floor_id": TILES_FLOOR_ID, "chalan.is_deleted": False}},
            {"$unwind": "$chalan.items"},
            {"$lookup": {"from": "purchase_orders", "localField": "purchase_order_id", "foreignField": "id", "as": "po"}},
            {"$unwind": {"path": "$po", "preserveNullAndEmptyArrays": True}},
            {"$project": {
                "_id": 0,
                "dispatch_id": "$id", "dispatch_number": 1, "dispatch_date": 1,
                "customer_id": 1, "customer_name": 1, "customer_order_id": 1,
                "brand_id": "$po.brand_id", "brand_name": {"$ifNull": ["$po.brand_name", {"$ifNull": ["$supplier_name", "Unassigned"]}]},
                "tile_name": "$chalan.items.tile_name", "tile_size": "$chalan.items.size", "sku": "$chalan.items.sku",
                "boxes": "$chalan.items.boxes", "quantity_unit": {"$ifNull": ["$chalan.items.quantity_unit", "Box"]},
                "source": {"$cond": [{"$eq": ["$source", "godown"]}, "Godown", "Released"]},
                "chalan_id": "$chalan.id", "chalan_number": "$chalan.number",
                "vehicle_number": "$chalan.vehicle_number", "driver_name": "$chalan.driver_name",
                "status": {"$switch": {"branches": [
                    {"case": {"$ne": [{"$ifNull": ["$delivered_at", ""]}, ""]}, "then": "Delivered"},
                    {"case": {"$ne": [{"$ifNull": ["$godown_received_at", ""]}, ""]}, "then": "At Godown"},
                ], "default": "Dispatched"}},
                "performed_by_name": "$created_by_name",
            }},
        ]
        line_filters: list[dict] = []
        contains = lambda value: {"$regex": re.escape(value[:80]), "$options": "i"}
        if brand_id: line_filters.append({"brand_id": filter_condition(brand_id)})
        if product: line_filters.append({"tile_name": contains(product)})
        if chalan_number: line_filters.append({"chalan_number": contains(chalan_number)})
        if status: line_filters.append({"status": filter_condition(status)})
        if search:
            safe_search = contains(search)
            line_filters.append({"$or": [
                {"customer_name": safe_search}, {"brand_name": safe_search}, {"tile_name": safe_search},
                {"dispatch_number": safe_search}, {"chalan_number": safe_search},
            ]})
        if line_filters:
            pipeline.append({"$match": {"$and": line_filters}})
        pipeline.extend([
            {"$sort": {"dispatch_date": 1 if sort == "date_asc" else -1}},
            {"$facet": {
                "rows": [{"$skip": (page - 1) * page_size}, {"$limit": page_size}],
                "meta": [{"$count": "total"}],
            }},
        ])
        result = await db.dispatches.aggregate(pipeline).to_list(1)
        bucket = result[0] if result else {"rows": [], "meta": []}
        total = bucket.get("meta", [{}])[0].get("total", 0) if bucket.get("meta") else 0
        return {"rows": bucket.get("rows", []), "page": page, "page_size": page_size, "total": total,
                "has_more": page * page_size < total, "next_page": page + 1 if page * page_size < total else None}

    dispatches = await db.dispatches.find(tiles_floor_query(user, filters), {"_id": 0}).to_list(5000)
    chalan_ids = [d["chalan_id"] for d in dispatches]
    chalans = await db.chalans.find(
        tiles_floor_query(user, {"id": {"$in": chalan_ids}, "is_deleted": False}), {"_id": 0},
    ).to_list(len(chalan_ids) + 5)
    chalan_by_id = {c["id"]: c for c in chalans}

    # TileDispatch itself carries no brand — brand lives on the
    # PurchaseOrder it was raised against (PurchaseOrder.brand_id/brand_name),
    # reachable one hop away via dispatch["purchase_order_id"]. Resolved here
    # so the `brand_id` filter/column below has something real to use.
    po_ids = [d["purchase_order_id"] for d in dispatches]
    purchase_orders = await db.purchase_orders.find(
        tiles_floor_query(user, {"id": {"$in": po_ids}}), {"_id": 0, "id": 1, "brand_id": 1, "brand_name": 1},
    ).to_list(len(po_ids) + 5)
    brand_by_po_id = {po["id"]: (po.get("brand_id"), po.get("brand_name")) for po in purchase_orders}

    rows = []
    for dispatch in dispatches:
        dispatch_status = _dispatch_status(dispatch)
        if status and dispatch_status not in filter_values(status):
            continue
        this_brand_id, this_brand_name = brand_by_po_id.get(dispatch["purchase_order_id"], (None, None))
        if brand_id and this_brand_id not in filter_values(brand_id):
            continue
        chalan = chalan_by_id.get(dispatch["chalan_id"], {})
        if chalan_number and chalan_number.lower() not in (chalan.get("number") or "").lower():
            continue
        source_label = "Godown" if dispatch.get("source") == "godown" else "Released"
        for line in chalan.get("items", []):
            if product and product.lower() not in (line.get("tile_name") or "").lower():
                continue
            row = {
                "dispatch_id": dispatch.get("id"), "dispatch_number": dispatch.get("dispatch_number"),
                "dispatch_date": dispatch.get("dispatch_date"),
                "customer_id": dispatch.get("customer_id"), "customer_name": dispatch.get("customer_name"),
                "customer_order_id": dispatch.get("customer_order_id"),
                "brand_id": this_brand_id, "brand_name": this_brand_name or dispatch.get("supplier_name") or "Unassigned",
                "tile_name": line.get("tile_name"), "tile_size": line.get("size"), "sku": line.get("sku"), "boxes": line.get("boxes"), "quantity_unit": line.get("quantity_unit") or "Box",
                "source": source_label,
                "chalan_id": chalan.get("id"), "chalan_number": chalan.get("number"),
                "vehicle_number": chalan.get("vehicle_number"), "driver_name": chalan.get("driver_name"),
                "status": dispatch_status, "performed_by_name": dispatch.get("created_by_name"),
            }
            if search:
                haystack = " ".join(str(row.get(k) or "") for k in (
                    "customer_name", "brand_name", "tile_name", "sku", "dispatch_number", "chalan_number",
                )).lower()
                if search.lower() not in haystack:
                    continue
            rows.append(row)
    rows.sort(key=lambda r: r["dispatch_date"] or "", reverse=(sort != "date_asc"))
    start = (page - 1) * page_size
    total = len(rows)
    return {"rows": rows[start:start + page_size], "page": page, "page_size": page_size, "total": total,
            "has_more": page * page_size < total, "next_page": page + 1 if page * page_size < total else None}


@router.get("/items/{item_id}/history")
async def item_history(item_id: str, user: UserPublic = Depends(require_min_role("sales"))):
    ready_batches = await db.ready_batches.find(
        tiles_floor_query(user, {"po_item_id": item_id, "is_deleted": False}), {"_id": 0},
    ).to_list(200)
    dispatches = await db.dispatches.find(
        tiles_floor_query(user, {"ready_batches_consumed.po_item_id": item_id, "is_deleted": False}), {"_id": 0},
    ).to_list(200)
    events = [{"kind": "ready_batch", "at": rb.get("created_at"), "detail": rb} for rb in ready_batches]
    events += [{"kind": "dispatch", "at": d.get("created_at"), "detail": d} for d in dispatches]
    events.sort(key=lambda e: e["at"] or "", reverse=True)
    return {"item_id": item_id, "events": events}


@router.get("/dashboard")
async def tile_orders_dashboard(user: UserPublic = Depends(require_min_role("sales"))):
    pos = await db.purchase_orders.find(tiles_floor_query(user, {"customer_order_id": {"$ne": None}}), {"_id": 0}).to_list(5000)
    today = now_iso()[:10]
    dispatched_today = await db.dispatches.find(tiles_floor_query(user, {"dispatch_date": today, "is_deleted": False}), {"_id": 0}).to_list(2000)
    delivered_today = [d for d in dispatched_today if (d.get("delivered_at") or "")[:10] == today]
    customer_orders = await db.customer_orders.find(tiles_floor_query(user, {"is_deleted": False}), {"_id": 0}).to_list(5000)

    pending = sum(1 for po in pos if po.get("overall_status") == "Pending")
    ready = sum(1 for po in pos if po.get("overall_status") == "Ready")
    waiting_over_15 = sum(1 for co in customer_orders if waiting_days(co["created_at"]) > 15)
    boxes_ordered = sum(float(i.get("qty") or 0) for po in pos for i in po.get("items", []))
    boxes_pending = sum(float(po.get("pending_boxes") or 0) for po in pos)
    revenue = sum(float(co.get("total_value") or 0) for co in customer_orders)

    return {
        "customer_orders": len(customer_orders), "supplier_orders": len(pos),
        "dispatched_today": len(dispatched_today), "delivered_today": len(delivered_today),
        "pending": pending, "ready": ready, "waiting_over_15_days": waiting_over_15,
        "boxes_ordered": boxes_ordered, "boxes_pending": boxes_pending, "revenue": round(revenue, 2),
    }


@router.get("/history")
async def completed_tile_order_history(
    search: Optional[str] = None, customer_id: Optional[str] = None,
    brand_id: Optional[str] = None, date_from: Optional[str] = None,
    date_to: Optional[str] = None, page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=100),
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Permanent completed-delivery ledger, derived from live Tile Orders.

    No second history collection is created: an order enters this workspace
    when its workflow status is Delivered and all linked dispatches remain
    available as the historical references.
    """
    page = page if isinstance(page, int) else 1
    page_size = page_size if isinstance(page_size, int) else 30
    # Do not trust the denormalized customer-order rollup as the inclusion
    # gate. A concurrent status update can leave that parent field stale even
    # though every linked PO/item and dispatch is complete.
    filters: dict = {"is_deleted": False}
    orders = await db.customer_orders.find(tiles_floor_query(user, filters), {"_id": 0}).to_list(5000)
    order_ids = [order["id"] for order in orders]
    if not order_ids:
        return {"rows": [], "total": 0, "page": page, "page_size": page_size,
                "has_more": False, "next_page": None, "facets": {"customers": [], "brands": []}}

    # Four bounded batch reads replace the former four reads PER customer
    # order. This keeps query count constant as history grows.
    all_pos = await db.purchase_orders.find(
        tiles_floor_query(user, {"customer_order_id": {"$in": order_ids}}), {"_id": 0}
    ).to_list(5000)
    all_dispatches = await db.dispatches.find(
        tiles_floor_query(user, {"customer_order_id": {"$in": order_ids}, "is_deleted": False}), {"_id": 0}
    ).to_list(5000)
    all_chalans = await db.chalans.find(
        tiles_floor_query(user, {"customer_order_id": {"$in": order_ids}, "is_deleted": False}), {"_id": 0}
    ).to_list(5000)
    po_ids = [po["id"] for po in all_pos]
    all_events = await db.activity_events.find(
        {"floor_id": TILES_FLOOR_ID, "$or": [
            {"entity_type": "tile_customer_order", "entity_id": {"$in": order_ids}},
            {"purchase_id": {"$in": po_ids}},
        ]}, {"_id": 0}
    ).to_list(5000)

    def grouped(rows: list[dict], key: str) -> dict[str, list[dict]]:
        result: dict[str, list[dict]] = {}
        for row in rows:
            value = row.get(key)
            if value:
                result.setdefault(value, []).append(row)
        return result

    pos_by_order = grouped(all_pos, "customer_order_id")
    dispatches_by_order = grouped(all_dispatches, "customer_order_id")
    chalans_by_order = grouped(all_chalans, "customer_order_id")
    events_by_order: dict[str, list[dict]] = {}
    order_by_po = {po["id"]: po.get("customer_order_id") for po in all_pos}
    for event in all_events:
        order_id = event.get("entity_id") if event.get("entity_type") == "tile_customer_order" else order_by_po.get(event.get("purchase_id"))
        if order_id:
            events_by_order.setdefault(order_id, []).append(event)

    rows = []
    for order in orders:
        if customer_id and order.get("customer_id") not in filter_values(customer_id):
            continue
        pos = pos_by_order.get(order["id"], [])
        if not pos:
            continue
        if brand_id and not any(po.get("brand_id") in filter_values(brand_id) for po in pos):
            continue
        haystack = " ".join([order.get("customer_name") or "", order.get("number") or ""] + [po.get("brand_name") or "" for po in pos]).lower()
        if search and search.lower() not in haystack:
            continue
        dispatches = dispatches_by_order.get(order["id"], [])
        if not _is_fully_dispatched(pos, dispatches):
            continue
        chalans = chalans_by_order.get(order["id"], [])
        completion_date = max(
            (d.get("delivered_at") or d.get("created_at") or "" for d in dispatches),
            default=None,
        ) or order.get("updated_at")
        if date_from and (completion_date or "") < date_from:
            continue
        if date_to and (completion_date or "")[:10] > date_to:
            continue
        products = []
        for po in pos:
            for item in po.get("items", []):
                pieces_per_box = item.get("pieces_per_box")
                quantity_unit = item.get("quantity_unit") or "Box"
                pieces = None
                try: pieces = float(item.get("boxes_dispatched") or 0) if quantity_unit == "Pieces" else float(item.get("boxes_dispatched") or 0) * float(pieces_per_box)
                except (TypeError, ValueError): pass
                products.append({"product": item.get("name"), "sku": item.get("sku"), "size": item.get("size"), "quantity": item.get("qty"), "boxes": item.get("boxes_dispatched") or 0, "pieces": pieces, "quantity_unit": quantity_unit})
        events = events_by_order.get(order["id"], [])
        brand_refs = []
        seen_brands = set()
        for po in pos:
            ref = (po.get("brand_id"), po.get("brand_name") or "Unassigned")
            if ref not in seen_brands:
                seen_brands.add(ref)
                brand_refs.append({"id": ref[0], "name": ref[1]})
        rows.append({
            "id": order["id"], "customer_id": order.get("customer_id"),
            "customer": order.get("customer_name"), "order_number": order.get("number"),
            "delivery_date": completion_date, "completion_date": completion_date,
            "brands": [ref["name"] for ref in brand_refs], "brand_refs": brand_refs, "products": products,
            "final_amount": order.get("total_value") or 0,
            "delivery_status": "Delivered" if all(d.get("delivered_at") for d in dispatches) else "Dispatched",
            "delivery_notes": next((d.get("delivery_note") for d in dispatches if d.get("delivery_note")), None),
            "timeline": sorted(events, key=lambda e: e.get("created_at", ""), reverse=True),
            "chalan_references": [{"id": c.get("id"), "number": c.get("number")} for c in chalans],
            "dispatch_references": [{"id": d.get("id"), "number": d.get("dispatch_number")} for d in dispatches],
        })
    rows.sort(key=lambda row: row.get("completion_date") or "", reverse=True)
    # Facets are computed before the selected customer/brand filter, so the
    # controls remain populated even when the current combination has no rows.
    customer_facets = sorted({(order.get("customer_id"), order.get("customer_name") or "Unassigned") for order in orders}, key=lambda item: item[1])
    brand_facets = sorted({(po.get("brand_id"), po.get("brand_name") or "Unassigned") for po in all_pos}, key=lambda item: item[1])
    total = len(rows)
    start = (page - 1) * page_size
    return {"rows": rows[start:start + page_size], "total": total, "page": page, "page_size": page_size,
            "has_more": page * page_size < total, "next_page": page + 1 if page * page_size < total else None,
            "facets": {
                "customers": [{"id": item[0], "name": item[1]} for item in customer_facets if item[0]],
                "brands": [{"id": item[0], "name": item[1]} for item in brand_facets if item[0]],
            }}


@router.get("/history/export")
async def export_completed_tile_order_history(
    format: str = "xlsx", search: Optional[str] = None, customer_id: Optional[str] = None,
    brand_id: Optional[str] = None, date_from: Optional[str] = None, date_to: Optional[str] = None,
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Export the same filtered, derived history view; never a second ledger."""
    if format not in {"csv", "xlsx"}:
        raise HTTPException(status_code=400, detail="format must be csv or xlsx")
    payload = await completed_tile_order_history(
        search=search, customer_id=customer_id, brand_id=brand_id,
        date_from=date_from, date_to=date_to, page=1, page_size=5000, user=user,
    )
    rows = []
    for row in payload["rows"]:
        rows.append({
            "customer": row["customer"], "order_number": row["order_number"],
            "delivery_date": row["delivery_date"], "completion_date": row["completion_date"],
            "brands": ", ".join(row["brands"]),
            "products": "; ".join(
                f'{p["product"]} ({p.get("sku") or "No SKU"} · {p.get("size") or "—"})'
                for p in row["products"]
            ),
            "quantities": ", ".join(str(p.get("quantity") or 0) for p in row["products"]),
            "boxes": sum(float(p.get("boxes") or 0) for p in row["products"]),
            "pieces": ", ".join(str(p.get("pieces") or "—") for p in row["products"]),
            "final_amount": row["final_amount"], "delivery_status": row["delivery_status"],
            "delivery_notes": row.get("delivery_notes") or "",
            "chalan_references": ", ".join(c["number"] for c in row["chalan_references"]),
            "dispatch_references": ", ".join(d["number"] for d in row["dispatch_references"]),
        })
    columns = [
        ("customer", "Customer"), ("order_number", "Order Number"), ("delivery_date", "Delivery Date"),
        ("completion_date", "Completion Date"), ("brands", "Brands"), ("products", "Products"),
        ("quantities", "Quantities"), ("boxes", "Boxes"), ("pieces", "Pieces"),
        ("final_amount", "Final Amount"), ("delivery_status", "Delivery Status"),
        ("delivery_notes", "Delivery Notes"), ("chalan_references", "Chalan References"),
        ("dispatch_references", "Dispatch References"),
    ]
    return export_response(rows, columns, "ground-floor-tile-history", format)


@router.get("/inventory")
async def godown_inventory(
    search: Optional[str] = None,
    page: int = Query(1, ge=1), page_size: int = Query(30, ge=1, le=100),
    user: UserPublic = Depends(require_min_role("sales")),
):
    page = page if isinstance(page, int) else 1
    page_size = page_size if isinstance(page_size, int) else 30
    """Live go-down inventory read model from Tile PurchaseOrder item counters."""
    # Older Tile PurchaseOrder documents predate the shared soft-delete field
    # and therefore omit `is_deleted` entirely. Treat missing as active so
    # valid Godown stock is not silently hidden by the read model.
    active_po = {"$or": [{"is_deleted": False}, {"is_deleted": {"$exists": False}}]}
    if hasattr(db.purchase_orders, "aggregate"):
        pipeline: list[dict] = [
            {"$match": tiles_floor_query(user, active_po)},
            {"$unwind": "$items"},
            {"$match": {"items.boxes_godown": {"$gt": 1e-9}}},
            {"$project": {
                "_id": 0,
                "id": {"$concat": ["$id", ":", "$items.id"]},
                "customer": "$customer_name", "name": "$items.name",
                "brand": {"$ifNull": ["$brand_name", "Unassigned"]},
                "product": "$items.sku", "size": "$items.size",
                "arrival_date": {"$ifNull": ["$items.godown_arrived_at", {"$ifNull": ["$latest_ready_date", "$created_at"]}]},
            }},
        ]
        if search:
            safe_search = {"$regex": re.escape(search[:80]), "$options": "i"}
            pipeline.append({"$match": {"$or": [
                {"customer": safe_search}, {"name": safe_search}, {"brand": safe_search},
                {"product": safe_search}, {"size": safe_search},
            ]}})
        pipeline.extend([
            {"$sort": {"name": 1, "customer": 1}},
            {"$facet": {
                "rows": [{"$skip": (page - 1) * page_size}, {"$limit": page_size}],
                "meta": [{"$count": "total"}],
            }},
        ])
        result = await db.purchase_orders.aggregate(pipeline).to_list(1)
        bucket = result[0] if result else {"rows": [], "meta": []}
        total = bucket.get("meta", [{}])[0].get("total", 0) if bucket.get("meta") else 0
        return {"rows": bucket.get("rows", []), "total": total, "page": page, "page_size": page_size,
                "has_more": page * page_size < total, "next_page": page + 1 if page * page_size < total else None}

    pos = await db.purchase_orders.find(tiles_floor_query(user, active_po), {"_id": 0}).to_list(5000)
    rows = []
    for po in pos:
        for item in po.get("items", []):
            current = float(item.get("boxes_godown") or 0)
            if current <= 1e-9:
                continue
            row = {
                "id": f'{po["id"]}:{item["id"]}',
                "customer": po.get("customer_name"),
                "name": item.get("name"),
                "brand": po.get("brand_name") or "Unassigned",
                "product": item.get("sku"),
                "size": item.get("size"),
                "arrival_date": item.get("godown_arrived_at") or po.get("latest_ready_date") or po.get("created_at"),
            }
            haystack = " ".join(str(row.get(key) or "") for key in ("customer", "name", "brand", "product", "size")).lower()
            if search and search.lower() not in haystack: continue
            rows.append(row)
    rows.sort(key=lambda row: ((row["name"] or "").lower(), (row["customer"] or "").lower()))
    total = len(rows)
    start = (page - 1) * page_size
    return {"rows": rows[start:start + page_size], "total": total, "page": page, "page_size": page_size,
            "has_more": page * page_size < total, "next_page": page + 1 if page * page_size < total else None}


@router.get("/purchase-orders/{po_id}/items/{item_id}/ready-batches")
async def item_ready_batches(po_id: str, item_id: str, user: UserPublic = Depends(require_min_role("warehouse"))):
    batches = await db.ready_batches.find(
        tiles_floor_query(user, {
            "purchase_order_id": po_id, "po_item_id": item_id,
            "remaining_qty": {"$gt": 0}, "is_deleted": False,
        }), {"_id": 0},
    ).to_list(200)
    batches.sort(key=lambda b: b.get("created_at", ""))
    return {"batches": batches}


@router.get("/movements")
async def list_material_movements(
    customer_id: Optional[str] = None, brand_id: Optional[str] = None, movement_type: Optional[str] = None,
    date_from: Optional[str] = None, date_to: Optional[str] = None,
    chalan_number: Optional[str] = None, dispatch_number: Optional[str] = None, search: Optional[str] = None,
    page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200),
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Material Movement Register — the permanent, chronological audit
    trail of every box's journey (Order Created → Release → Move to
    Godown → Dispatch from Released/Godown → Delivered). One immutable row
    per event, written transactionally by services/tile_movement_log.py at
    the moment each action happens — never reconstructed here from other
    collections, so this is a straight filtered read."""
    filters: dict = {"is_deleted": False}
    if customer_id:
        filters["customer_id"] = filter_condition(customer_id)
    if brand_id:
        filters["brand_id"] = filter_condition(brand_id)
    if movement_type:
        filters["movement_type"] = movement_type
    def contains(value: str) -> dict:
        return {"$regex": re.escape(value[:80]), "$options": "i"}
    if chalan_number:
        filters["chalan_number"] = contains(chalan_number)
    if dispatch_number:
        filters["dispatch_number"] = contains(dispatch_number)
    if date_from or date_to:
        date_filter: dict = {}
        if date_from:
            date_filter["$gte"] = date_from
        if date_to:
            date_filter["$lte"] = date_to + "T23:59:59.999999"
        filters["created_at"] = date_filter
    if search:
        safe_search = contains(search)
        filters["$or"] = [
            {"customer_name": safe_search}, {"brand_name": safe_search},
            {"tile_name": safe_search}, {"sku": safe_search},
            {"chalan_number": safe_search}, {"dispatch_number": safe_search},
        ]
    query = tiles_floor_query(user, filters)
    total = await db.material_movements.count_documents(query)
    start = (page - 1) * page_size
    rows = await db.material_movements.find(query, {"_id": 0}).sort("created_at", -1).skip(start).limit(page_size).to_list(page_size)
    return {"rows": rows, "page": page, "page_size": page_size, "total": total,
            "has_more": page * page_size < total, "next_page": page + 1 if page * page_size < total else None}
