"""Purchase Order routes — draft, review, order, receive, dispatch.

Design notes:
  * A Purchase Order is always scoped to a single BRAND. Multi-brand quotations
    fan out into N POs, one per brand.
  * PO numbers are of the form FPO-YYYY-NNNN, globally unique across brands.
  * Status transitions are validated against ALLOWED_TRANSITIONS. Any state
    change writes a PurchaseStatusEvent AND a domain activity event.
  * Receiving materials auto-transitions status:
        any partial → partial_received
        all lines fully received → fully_received
  * PDF/exports live in a future iteration (Payments Milestone).
"""
from __future__ import annotations
import re
from datetime import datetime, timezone
import base64
import binascii
import logging
from pathlib import PurePath
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import floor_query, require_min_role
from services.purchase_workspace import get_purchase_workspace_user as get_current_user
from db import db
from models import (
    PurchaseAttachment, PurchaseAttachmentCreate, PurchaseOrder, PurchaseOrderItem,
    PurchaseOrderUpdate, PurchaseReceivePayload, PurchaseStageEvent, PurchaseStatusEvent,
    PurchaseStatusPayload, UserPublic,
)
from services.activity_log import log_event
from services.transfer_workflow import mark_loans_due_for_replenishment

router = APIRouter(prefix="/purchase-orders", tags=["purchase-orders"])
logger = logging.getLogger(__name__)

_ATTACHMENT_MAGIC: dict[str, tuple[bytes, ...]] = {
    "application/pdf": (b"%PDF-",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/webp": (b"RIFF",),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": (b"PK\x03\x04",),
}


def _validated_attachment(body: PurchaseAttachmentCreate) -> tuple[str, bytes, str]:
    mime = body.mime.lower().split(";", 1)[0].strip()
    if mime not in _ATTACHMENT_MAGIC:
        raise HTTPException(status_code=415, detail="Only PDF, JPEG, PNG, WebP, and XLSX attachments are supported")
    if not body.data_url.startswith(f"data:{mime};base64,"):
        raise HTTPException(status_code=400, detail="Attachment data does not match its declared content type")
    try:
        raw = base64.b64decode(body.data_url.split(",", 1)[1], validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=400, detail="Attachment content is not valid base64") from exc
    if not raw.startswith(_ATTACHMENT_MAGIC[mime]):
        raise HTTPException(status_code=415, detail="Attachment content does not match its declared type")
    if mime == "image/webp" and raw[8:12] != b"WEBP":
        raise HTTPException(status_code=415, detail="Attachment content does not match its declared type")
    filename = PurePath(body.filename).name.replace("\x00", "")
    if not filename or filename in {".", ".."}:
        raise HTTPException(status_code=400, detail="Invalid attachment filename")
    return filename, raw, mime


# -----------------------------------------------------------------------------
# State machine
# -----------------------------------------------------------------------------
ALLOWED_TRANSITIONS: dict[str, list[str]] = {
    "draft": ["awaiting_review", "ordered", "cancelled"],
    "awaiting_review": ["draft", "ordered", "cancelled"],
    "ordered": ["awaiting_supplier", "partial_received", "fully_received", "cancelled"],
    "awaiting_supplier": ["partial_received", "fully_received", "cancelled"],
    "partial_received": ["partial_received", "fully_received", "cancelled"],
    "fully_received": ["packed"],
    "packed": ["ready_for_dispatch"],
    "ready_for_dispatch": ["ready_for_dispatch"],
    "cancelled": [],
}

STATUS_LABELS = {
    "draft": "Draft",
    "awaiting_review": "Awaiting Review",
    "ordered": "Ordered",
    "awaiting_supplier": "Awaiting Supplier",
    "partial_received": "Partial Received",
    "fully_received": "Fully Received",
    "packed": "Packed",
    "ready_for_dispatch": "Ready for Dispatch",
    "cancelled": "Cancelled",
}

# Statuses shown as columns on the operational dashboard, in board order.
DASHBOARD_COLUMNS = [
    "draft", "awaiting_review", "ordered", "awaiting_supplier",
    "partial_received", "fully_received", "packed", "ready_for_dispatch",
]


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
async def _next_po_number() -> str:
    year = datetime.now(timezone.utc).year
    prefix = f"FPO-{year}-"
    n = await db.purchase_orders.count_documents({"number": {"$regex": f"^{prefix}"}})
    return f"{prefix}{n + 1:04d}"


def _recalc_totals(items: list[PurchaseOrderItem]) -> dict:
    """Sum line totals — Forge uses final prices only."""
    subtotal = 0.0
    for it in items:
        subtotal += it.qty * it.unit_cost
    return {
        "subtotal": round(subtotal, 2),
        "grand_total": round(subtotal, 2),
    }


def _receipt_status(items: list[dict]) -> Optional[str]:
    """Infer status transition purely from received quantities."""
    if not items:
        return None
    any_received = any(float(it.get("qty_received", 0)) > 0 for it in items)
    all_full = all(
        float(it.get("qty_received", 0)) >= float(it.get("qty", 0)) - 1e-6
        for it in items
    )
    if all_full:
        return "fully_received"
    if any_received:
        return "partial_received"
    return None


async def _supplier_for_purchase_order(supplier_id: str, po: dict) -> dict:
    """Resolve a supplier that is valid for this purchase order's floor.

    Supplier ids are globally addressable, so an unscoped lookup can attach a
    Sanitary dealer to a Ground Floor tile PO. Keep a brand-specific supplier
    aligned with the PO's brand as well; a supplier without a brand remains a
    valid general supplier.
    """
    supplier = await db.suppliers.find_one(
        {"id": supplier_id, "floor_id": po.get("floor_id")}, {"_id": 0},
    )
    if not supplier:
        raise HTTPException(status_code=400, detail="Supplier is not available on this floor")
    if po.get("brand_id") and supplier.get("brand_id") and supplier["brand_id"] != po["brand_id"]:
        raise HTTPException(status_code=400, detail="Supplier does not match this purchase order's brand")
    return supplier


async def _apply_status_change(
    po: dict, to_status: str, user: UserPublic, note: Optional[str] = None,
) -> dict:
    """Mutates `po` (dict from Mongo), returns update patch for $set."""
    from_status = po.get("status")
    ev = PurchaseStatusEvent(
        from_status=from_status,
        to_status=to_status,
        by_user_id=user.id,
        by_user_name=user.full_name,
        note=note,
    )
    history = po.get("status_history", []) + [ev.dict()]
    patch = {
        "status": to_status,
        "status_history": history,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if to_status == "ready_for_dispatch":
        patch["delivered_at"] = datetime.now(timezone.utc).isoformat()

    await log_event(
        event_type="purchase.status_changed",
        entity_type="purchase",
        entity_id=po["id"],
        actor=user,
        customer_id=po.get("customer_id"),
        quotation_id=po.get("quotation_id"),
        purchase_id=po["id"],
        payload={"from": from_status, "to": to_status, "note": note},
        summary=f"{po.get('number')} → {STATUS_LABELS.get(to_status, to_status)}",
    )
    if to_status == "ready_for_dispatch":
        await log_event(
            event_type="purchase.dispatched",
            entity_type="purchase",
            entity_id=po["id"],
            actor=user,
            customer_id=po.get("customer_id"),
            quotation_id=po.get("quotation_id"),
            purchase_id=po["id"],
            summary=f"{po.get('number')} ready for dispatch",
        )
    return patch


# -----------------------------------------------------------------------------
# List / detail / dashboard
# -----------------------------------------------------------------------------
@router.get("/dashboard")
async def dashboard(user: UserPublic = Depends(get_current_user)):
    """Column counts + preview cards for the ops board."""
    pipeline = []
    scope = floor_query(user)
    if scope:
        pipeline.append({"$match": scope})
    pipeline += [
        {"$group": {
            "_id": "$status",
            "count": {"$sum": 1},
            "value": {"$sum": "$grand_total"},
        }},
    ]
    rows = await db.purchase_orders.aggregate(pipeline).to_list(50)
    by_status = {r["_id"]: {"count": r["count"], "value": round(r["value"], 2)} for r in rows}
    columns = []
    for st in DASHBOARD_COLUMNS:
        stats = by_status.get(st, {"count": 0, "value": 0})
        columns.append({
            "status": st,
            "label": STATUS_LABELS[st],
            "count": stats["count"],
            "value": stats["value"],
        })
    total_open = sum(c["value"] for c in columns if c["status"] not in ("ready_for_dispatch",))
    return {
        "columns": columns,
        "total_open_value": round(total_open, 2),
    }


@router.get("")
async def list_purchase_orders(
    status: Optional[str] = None,
    brand_id: Optional[str] = None,
    supplier_id: Optional[str] = None,
    customer_id: Optional[str] = None,
    quotation_id: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = Query(200, ge=1, le=1000),
    user: UserPublic = Depends(get_current_user),
):
    """Search POs. Free-text `q` matches PO number, customer, brand, supplier, SKU."""
    query: dict = {}
    if status and status != "all":
        query["status"] = status
    if brand_id:
        query["brand_id"] = brand_id
    if supplier_id:
        query["supplier_id"] = supplier_id
    if customer_id:
        query["customer_id"] = customer_id
    if quotation_id:
        query["quotation_id"] = quotation_id
    if q:
        term = {"$regex": re.escape(q), "$options": "i"}
        query["$or"] = [
            {"number": term},
            {"customer_name": term},
            {"brand_name": term},
            {"supplier_name": term},
            {"quotation_number": term},
            {"items.sku": term},
            {"items.name": term},
        ]
    docs = await db.purchase_orders.find(floor_query(user, query), {"_id": 0}).sort("created_at", -1).to_list(limit)
    return docs


# -----------------------------------------------------------------------------
# Reference config for the frontend (status columns, transitions)
#
# Keep literal routes above ``/{po_id}``: Starlette matches in declaration
# order, so otherwise ``/config/statuses`` is incorrectly treated as PO
# ``config`` and the Purchase Order detail screen fails its config request.
# -----------------------------------------------------------------------------
@router.get("/config/statuses")
async def status_config(_: UserPublic = Depends(get_current_user)):
    return {
        "columns": [{"value": s, "label": STATUS_LABELS[s]} for s in DASHBOARD_COLUMNS],
        "transitions": ALLOWED_TRANSITIONS,
        "labels": STATUS_LABELS,
    }


@router.get("/{po_id}", response_model=PurchaseOrder)
async def get_purchase_order(po_id: str, user: UserPublic = Depends(get_current_user)):
    doc = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    return PurchaseOrder(**doc)


# -----------------------------------------------------------------------------
# Update / status / receive / attachments
# -----------------------------------------------------------------------------
@router.patch("/{po_id}", response_model=PurchaseOrder)
async def update_purchase_order(
    po_id: str,
    body: PurchaseOrderUpdate,
    user: UserPublic = Depends(require_min_role("purchase")),
):
    doc = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Purchase order not found")

    patch: dict = {}
    events: list[dict] = []

    if body.supplier_id is not None and body.supplier_id != doc.get("supplier_id"):
        supplier = await _supplier_for_purchase_order(body.supplier_id, doc) if body.supplier_id else None
        patch["supplier_id"] = body.supplier_id
        patch["supplier_name"] = supplier.get("name") if supplier else body.supplier_name
        events.append({
            "event_type": "purchase.supplier_changed",
            "summary": f"Supplier set to {patch['supplier_name']}",
            "payload": {"supplier_id": body.supplier_id, "supplier_name": patch["supplier_name"]},
        })

    if body.assigned_to is not None and body.assigned_to != doc.get("assigned_to"):
        assignee = await db.users.find_one({"id": body.assigned_to}, {"_id": 0, "full_name": 1})
        patch["assigned_to"] = body.assigned_to
        patch["assigned_to_name"] = assignee.get("full_name") if assignee else None
        events.append({
            "event_type": "purchase.assigned",
            "summary": f"Assigned to {patch['assigned_to_name']}",
            "payload": {"assigned_to": body.assigned_to},
        })

    if body.internal_notes is not None and body.internal_notes != doc.get("internal_notes"):
        patch["internal_notes"] = body.internal_notes
        events.append({
            "event_type": "purchase.note_updated",
            "summary": "Internal notes updated",
            "payload": {},
        })

    if body.expected_delivery_at is not None:
        patch["expected_delivery_at"] = body.expected_delivery_at

    if body.items is not None:
        items = [i if isinstance(i, PurchaseOrderItem) else PurchaseOrderItem(**i) for i in body.items]
        patch["items"] = [i.dict() for i in items]
        patch.update(_recalc_totals(items))
        events.append({
            "event_type": "purchase.items_updated",
            "summary": f"Line items updated ({len(items)} items)",
            "payload": {"count": len(items)},
        })

    if not patch:
        return PurchaseOrder(**doc)

    patch["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.purchase_orders.update_one(floor_query(user, {"id": po_id}), {"$set": patch})

    for ev in events:
        await log_event(
            entity_type="purchase",
            entity_id=po_id,
            actor=user,
            customer_id=doc.get("customer_id"),
            quotation_id=doc.get("quotation_id"),
            purchase_id=po_id,
            **ev,
        )

    fresh = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    return PurchaseOrder(**fresh)


@router.post("/{po_id}/status", response_model=PurchaseOrder)
async def change_status(
    po_id: str,
    body: PurchaseStatusPayload,
    user: UserPublic = Depends(require_min_role("purchase")),
):
    doc = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    cur = doc.get("status", "draft")
    if body.to_status not in ALLOWED_TRANSITIONS.get(cur, []):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot move from '{cur}' to '{body.to_status}'",
        )
    if body.to_status in {"packed", "ready_for_dispatch"} and any(
        float(item.get("loan_replenishment_promised_qty") or 0) > 0
        for item in doc.get("items", []) if not item.get("cancelled")
    ):
        raise HTTPException(status_code=409, detail="A replacement in this order must return to the lending customer")
    patch = await _apply_status_change(doc, body.to_status, user, body.note)
    await db.purchase_orders.update_one(floor_query(user, {"id": po_id}), {"$set": patch})
    fresh = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    return PurchaseOrder(**fresh)


@router.post("/{po_id}/receive", response_model=PurchaseOrder)
async def receive_items(
    po_id: str,
    body: PurchaseReceivePayload,
    user: UserPublic = Depends(require_min_role("warehouse")),
):
    doc = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Purchase order not found")

    items = doc.get("items", [])
    updated_items = []
    changes = []
    stage_syncs = []
    for it in items:
        new_recv = body.receipts.get(it["id"])
        if new_recv is not None:
            clamped = max(0.0, min(float(new_recv), float(it["qty"])))
            if abs(clamped - float(it.get("qty_received", 0))) > 1e-6:
                changes.append({"sku": it["sku"], "from": it.get("qty_received", 0), "to": clamped})
                it = {**it, "qty_received": clamped}
                # Reverse sync: PO-level receiving reaching full qty on a line
                # means it has physically arrived — the Material Tracker's
                # per-item `stage` must reflect that too, or the tracker board
                # would keep showing "Order in Company" for a fully-received PO.
                if clamped >= float(it.get("qty", 0)) - 1e-6 and it.get("stage") not in {"in_box", "dispatched", "in_transit", "delivered"}:
                    prev_stage = it.get("stage") or "order_in_company"
                    next_stage = "in_box"
                    stage_ev = PurchaseStageEvent(
                        from_stage=prev_stage, to_stage=next_stage,
                        by_user_id=user.id, by_user_name=user.full_name,
                        note="Auto-synced from PO receiving", action="move",
                    ).dict()
                    it = {
                        **it,
                        "stage": next_stage,
                        "last_moved_at": datetime.now(timezone.utc).isoformat(),
                        "last_moved_by": user.id,
                        "last_moved_by_name": user.full_name,
                        "stage_history": (it.get("stage_history") or []) + [stage_ev],
                    }
                    stage_syncs.append({"item_id": it["id"], "sku": it["sku"], "from_stage": prev_stage, "to_stage": next_stage})
        updated_items.append(it)

    patch: dict = {
        "items": updated_items,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    # Auto-transition based on receipts
    inferred = _receipt_status(updated_items)
    if inferred and inferred != doc.get("status"):
        cur = doc.get("status", "draft")
        if inferred in ALLOWED_TRANSITIONS.get(cur, []) or cur in ("ordered", "awaiting_supplier", "partial_received"):
            patch.update(await _apply_status_change(doc, inferred, user, body.note))

    await db.purchase_orders.update_one(floor_query(user, {"id": po_id}), {"$set": patch})

    await log_event(
        event_type="purchase.received",
        entity_type="purchase",
        entity_id=po_id,
        actor=user,
        customer_id=doc.get("customer_id"),
        quotation_id=doc.get("quotation_id"),
        purchase_id=po_id,
        summary=(
            f"Recorded receipts on {len(changes)} lines"
            if changes else "Receipt recorded (no changes)"
        ),
        payload={"changes": changes, "note": body.note},
    )
    for sync in stage_syncs:
        await log_event(
            event_type="purchase.stage_moved",
            entity_type="purchase", entity_id=po_id, actor=user,
            customer_id=doc.get("customer_id"),
            summary=f"{sync['sku']} · auto-marked {sync['to_stage']} (fully received)",
            payload={"item_id": sync["item_id"], "from_stage": sync["from_stage"], "to_stage": sync["to_stage"], "source": "receive_sync"},
        )
        if sync["to_stage"] == "in_box":
            await mark_loans_due_for_replenishment(item_id=sync["item_id"], user=user)

    fresh = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    return PurchaseOrder(**fresh)


@router.post("/{po_id}/attachments", response_model=PurchaseOrder)
async def add_attachment(
    po_id: str,
    body: PurchaseAttachmentCreate,
    user: UserPublic = Depends(require_min_role("purchase")),
):
    doc = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Purchase order not found")

    # Security audit (Phase 1, 2026-08): this was previously "accept but log" —
    # a base64 data_url stored directly on the PO document has no hard ceiling
    # elsewhere, so an oversized payload would bloat the document and slow
    # every read of this PO. 15MB of base64 (~11MB binary) covers real
    # delivery-note/invoice photos; enforce it instead of only logging it.
    size = len(body.data_url or "")
    if size > 15 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Attachment exceeds 15MB limit")

    filename, raw, mime = _validated_attachment(body)
    att = PurchaseAttachment(
        by_user_id=user.id,
        by_user_name=user.full_name,
        filename=filename,
        mime=mime,
        size_bytes=len(raw),
        note=body.note,
    )

    # BACKEND_AUDIT_2026-07-17.md High #17: upload to the private bucket
    # instead of embedding base64 on the PO document — unlike ProductMedia,
    # this had no cap on attachment count/aggregate size, trending toward
    # MongoDB's 16MB document limit on a PO that accumulates delivery-note
    # photos. Only the storage key + metadata is persisted; a signed URL is
    # minted on demand (GET /{po_id}/attachments/{id}/url).
    try:
        from media_storage.factory import get_media_storage, private_bucket
        storage = get_media_storage()
        key = f"purchase-orders/{po_id}/{att.id}-{filename}"
        stored = await storage.upload(
            bucket=private_bucket(), key=key, data=raw,
            content_type=mime,
            cache_control="private, max-age=0",
        )
        att.storage_key = stored.key
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Could not store attachment: {e}") from e

    attachments = doc.get("attachments", []) + [att.dict()]
    await db.purchase_orders.update_one(
        floor_query(user, {"id": po_id}),
        {"$set": {"attachments": attachments, "updated_at": datetime.now(timezone.utc).isoformat()}},
    )
    await log_event(
        event_type="purchase.attachment_added",
        entity_type="purchase",
        entity_id=po_id,
        actor=user,
        customer_id=doc.get("customer_id"),
        quotation_id=doc.get("quotation_id"),
        purchase_id=po_id,
        summary=f"Attached {body.filename}",
        payload={"filename": body.filename, "mime": body.mime, "size_bytes": size},
    )
    fresh = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    return PurchaseOrder(**fresh)


@router.get("/{po_id}/attachments/{attachment_id}/url")
async def get_attachment_url(
    po_id: str,
    attachment_id: str,
    user: UserPublic = Depends(get_current_user),
):
    """Short-lived signed URL to view/download a private-bucket attachment.
    Attachments written before storage migration still carry a `data_url`
    directly — returned as-is so old POs keep working with no backfill."""
    doc = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0, "attachments": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    att = next((a for a in doc.get("attachments", []) if a.get("id") == attachment_id), None)
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    if att.get("storage_key"):
        from media_storage.factory import get_media_storage, private_bucket
        storage = get_media_storage()
        url = await storage.get_signed_url(bucket=private_bucket(), key=att["storage_key"], expires_in=300)
        return {"url": url}
    if att.get("data_url"):
        return {"url": att["data_url"]}
    raise HTTPException(status_code=404, detail="Attachment has no stored content")
