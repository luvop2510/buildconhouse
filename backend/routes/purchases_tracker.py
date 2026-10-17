"""Purchases — Material Tracker.

A per-LINE-ITEM lifecycle tracker built on top of the PO document store.

New PO line items flow through:
    po_final → order_in_company → company_billing → in_box → dispatched
Dispatched means delivered in this business process.

Endpoints:
    GET  /purchases/items                     — flat cross-PO items list
    GET  /purchases/brands                    — brand facets w/ counts
    GET  /purchases/customers                 — customer facets w/ counts
    GET  /purchases/stages                    — stage catalog + counts
    GET  /purchases/dispatch-record           — history for dispatched+ stages
    GET  /purchases/settings                  — {sla_days}
    POST /purchases/settings                  — update SLA
    POST /purchases/items/{item_id}/move      — advance a single item
    POST /purchases/items/bulk-move           — advance many items in one call
    POST /purchases/items/{item_id}/transfer  — reduce qty on source, create
                                                new PO for destination customer
    GET  /purchases/export.xlsx               — filtered .xlsx export

The tracker does NOT concern itself with taxes — Forge uses final prices only.
"""
from __future__ import annotations
from services.multi_filters import filter_values, filter_condition

from services.export import spreadsheet_cell
import asyncio
import hashlib
import io
import json
import logging
import math
import re
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional, TypeVar
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from auth import (
    TILES_FLOOR_ID, floor_inherit, floor_query, floor_scope_ids,
    get_floor_scoped_or_404, require_min_role,
)
from services.purchase_workspace import get_purchase_workspace_user as get_current_user
from db import client, db
from models import (
    Chalan, ChalanLineItem, PurchaseCancellationEvent, PurchaseOrder, PurchaseOrderItem, PurchaseShortage, PurchaseStageEvent, PurchaseStatusEvent,
    PURCHASE_STAGES, PurchaseStage, Quotation, QuotationLineItem, UserPublic, now_iso,
)
from routes.purchase_routes import STATUS_LABELS
from routes.quotation_routes import _next_number as _next_quotation_number, _pdf_branding
from services.activity_log import log_event, timeline_for
from services.chalan_stage import compute_order_stage, remaining_qty_by_item
from services.domain_outbox import (
    EVENT_PURCHASE_CHALAN_LIFECYCLE,
    dispatch_event,
    enqueue_after_primary_commit,
)
from services.followup_engine import reconcile_followups
from services.purchase_images import hydrate_purchase_images
from services.customer_completion import completed_customer_ids, completed_customer_pipeline, confirmed_customer_ids
from services.purchase_stages import active_quantity, active_quantity_expression, delivery_timestamp, delivery_timestamp_expression, normalized_stage, stage_expression
from services.sequence import next_number
from services.transfer_workflow import execute_transfer, mark_loans_due_for_replenishment, settle_loan_transfer, transfer_history

router = APIRouter(prefix="/purchases", tags=["purchases"])
logger = logging.getLogger("forge.purchases_tracker")


# =============================================================================
# Stage catalog — the ONE source of truth used by both backend + frontend.
# =============================================================================
STAGE_LABELS: dict[str, str] = {
    "po_final":        "PO Final",
    "order_in_company": "Order in Company",
    "company_billing":  "Company Billing",
    "in_box":           "Inbox",
    "dispatched":       "Dispatched",
}

# UI tones aligned with the reference (light-mode badges).
STAGE_TONES: dict[str, dict[str, str]] = {
    "po_final":        {"bg": "#FFEDD5", "fg": "#9A3412"},
    "order_in_company": {"bg": "#FFEDD5", "fg": "#9A3412"},   # amber
    "company_billing":  {"bg": "#FEF3C7", "fg": "#92400E"},   # yellow
    "in_box":           {"bg": "#DBEAFE", "fg": "#1E40AF"},   # blue
    "dispatched":       {"bg": "#DCFCE7", "fg": "#166534"},   # green
}

EARLY_STAGES = ("po_final", "order_in_company", "company_billing", "in_box")
DISPATCH_STAGES = ("dispatched",)

DEFAULT_SLA_DAYS = 7
SETTINGS_KEY = "purchases_tracker"


# =============================================================================
# Settings — data-driven Blocked SLA (default 7d, configurable)
# =============================================================================
class TrackerSettings(BaseModel):
    sla_days: int = Field(default=DEFAULT_SLA_DAYS, ge=1, le=365)


async def _load_settings() -> TrackerSettings:
    doc = await db.settings.find_one({"key": SETTINGS_KEY}, {"_id": 0})
    if not doc:
        return TrackerSettings()
    return TrackerSettings(**{k: v for k, v in doc.items() if k in TrackerSettings.__fields__})


@router.get("/settings", response_model=TrackerSettings)
async def get_settings(_: UserPublic = Depends(get_current_user)):
    return await _load_settings()


@router.post("/settings", response_model=TrackerSettings)
async def update_settings(
    body: TrackerSettings,
    user: UserPublic = Depends(require_min_role("manager")),
):
    await db.settings.update_one(
        {"key": SETTINGS_KEY},
        {"$set": {
            "key": SETTINGS_KEY,
            "sla_days": int(body.sla_days),
            "updated_at": now_iso(),
            "updated_by": user.id,
            "updated_by_name": user.full_name,
        }},
        upsert=True,
    )
    await log_event(
        event_type="purchase.settings.updated",
        entity_type="settings", entity_id=SETTINGS_KEY, actor=user,
        summary=f"Purchases SLA set to {body.sla_days} days",
        payload={"sla_days": body.sla_days},
    )
    return body


# =============================================================================
# Helpers
# =============================================================================
def _iso(ts: datetime) -> str:
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.isoformat()


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        # Support trailing Z
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _age_days(iso_ts: Optional[str]) -> Optional[int]:
    dt = _parse_iso(iso_ts)
    if not dt:
        return None
    now = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return max(0, (now - dt).days)


def _flatten_item(po: dict, it: dict, sla_days: int) -> dict:
    """Materialize a single tracker row from a PO doc + its item sub-doc."""
    stage = normalized_stage(it, po)
    last_moved_at = it.get("last_moved_at") or po.get("created_at")
    age = _age_days(last_moved_at) or 0
    blocked = (stage in EARLY_STAGES) and (age >= sla_days)
    response = {
        "item_id": it["id"],
        "po_id": po["id"],
        "po_number": po.get("number"),
        "po_status": po.get("status"),
        "quotation_id": po.get("quotation_id"),
        "quotation_number": po.get("quotation_number"),
        "quotation_line_id": it.get("quotation_line_id"),
        "product_id": it.get("product_id"),
        "floor_id": po.get("floor_id"),
        "sku": it.get("sku"),
        "name": it.get("name"),
        "image": it.get("image"),
        "finish": it.get("finish"),
        "colour": it.get("colour"),
        "customer_id": it.get("customer_id") or po.get("customer_id"),
        "customer_name": it.get("customer_name") or po.get("customer_name"),
        "brand_id": it.get("brand_id") or po.get("brand_id"),
        "brand_name": it.get("brand_name") or po.get("brand_name"),
        "supplier_id": po.get("supplier_id"),
        "supplier_name": po.get("supplier_name"),
        "dispatched_at": delivery_timestamp(po, it) if stage == "dispatched" else None,
        "delivered_at": delivery_timestamp(po, it) if stage == "dispatched" else None,
        "stage": stage,
        "stage_label": STAGE_LABELS.get(stage, stage),
        "stage_tone": STAGE_TONES.get(stage, {"bg": "#F4F4F5", "fg": "#3F3F46"}),
        "qty": max(0.0, float(it.get("qty") or 0) - float(it.get("godown_transferred_qty") or 0) - float(it.get("loan_replenishment_returned_qty") or 0)),
        "unit_cost": float(it.get("unit_cost") or 0),
        "room": it.get("room"),
        "expected_delivery_at": po.get("expected_delivery_at"),
        "last_moved_at": last_moved_at,
        "last_moved_by_name": it.get("last_moved_by_name") or po.get("created_by_name"),
        "age_days": age,
        "blocked": blocked,
        "sla_days": sla_days,
        "split_from_item_id": it.get("split_from_item_id"),
        "transferred_from_item_id": it.get("transferred_from_item_id"),
        "transferred_from_customer_id": it.get("transferred_from_customer_id"),
        "loaned_qty": float(it.get("loaned_qty") or 0),
        "customer_loan_history": it.get("customer_loan_history") or [],
        "loan_transfer_id": it.get("loan_transfer_id"),
        "borrowed_from_customer_id": it.get("borrowed_from_customer_id"),
        "borrowed_from_customer_name": it.get("borrowed_from_customer_name"),
        "borrowed_at": it.get("borrowed_at"),
        "borrowing_note": it.get("borrowing_note"),
        "loan_return_status": it.get("loan_return_status"),
        "loan_return_due": bool(it.get("loan_return_due")),
        "loan_replenishment_for_customer_name": it.get("loan_replenishment_for_customer_name"),
        "loan_replenishment_status": it.get("loan_replenishment_status"),
        "loan_replenishment_returned_qty": float(it.get("loan_replenishment_returned_qty") or 0),
        "return_due_on_replenishment": bool(it.get("return_due_on_replenishment")),
        # Sanitary godown provenance is a snapshot on the purchase item so
        # both the stock tracker and the client workspace can explain where a
        # reused product came from (or that part of this line was returned).
        "godown_transferred_qty": float(it.get("godown_transferred_qty") or 0),
        "godown_transfer_history": it.get("godown_transfer_history") or [],
        "godown_stock_id": it.get("godown_stock_id"),
        "godown_allocation_id": it.get("godown_allocation_id"),
        "godown_source_customer_name": it.get("godown_source_customer_name"),
        "godown_source_purchased_at": it.get("godown_source_purchased_at"),
        "godown_transferred_at": it.get("godown_transferred_at"),
    }
    return response


async def _hydrate_workspace_images(rows: list[dict]) -> None:
    """Replace stale PO image snapshots with current catalog hero images.

    Purchase orders preserve the original line details, but old image URLs can
    be empty or expired. The catalog snapshot is in memory, so this resolves
    every workspace row without N+1 database queries or cross-floor leakage.
    """
    await hydrate_purchase_images(rows)


async def _iter_items(
    view: str,
    brand: Optional[str],
    customer: Optional[str],
    stage: Optional[str],
    q: Optional[str],
    sla_days: int,
    limit: int = 2000,
    product_id: Optional[str] = None,
    floor_ids: Optional[list[str]] = None,
) -> list[dict]:
    """Return a flat list of tracker rows across all POs, filtered."""
    match: dict = {"status": {"$ne": "cancelled"}}
    if floor_ids is not None:
        match["floor_id"] = {"$in": floor_ids}
    if q and q.strip():
        term = {"$regex": re.escape(q.strip()), "$options": "i"}
        match["$or"] = [
            {"number": term},
            {"customer_name": term},
            {"items.sku": term},
            {"items.name": term},
            {"brand_name": term},
        ]
    if brand and brand.lower() != "all":
        match["brand_id"] = filter_condition(brand)
    if product_id:
        match["items.product_id"] = product_id

    pipeline: list[dict] = [
        {"$match": match},
        {"$unwind": "$items"},
        {"$match": {"items.cancelled": {"$ne": True}}},
        {"$match": {"$expr": {"$gt": [{"$subtract": [{"$ifNull": ["$items.qty", 0]}, {"$add": [{"$ifNull": ["$items.godown_transferred_qty", 0]}, {"$ifNull": ["$items.loan_replenishment_returned_qty", 0]}]}]}, 0]}}},
        {"$project": {
            "_id": 0,
            "id": 1, "number": 1, "customer_id": 1, "customer_name": 1,
            "brand_id": 1, "brand_name": 1, "quotation_id": 1, "quotation_number": 1,
            "created_at": 1, "created_by_name": 1, "status": 1, "floor_id": 1,
            "supplier_id": 1, "supplier_name": 1, "expected_delivery_at": 1,
            "items": 1, "chalans": 1,
        }},
    ]

    pipeline.append({"$set": {"items.stage": stage_expression()}})
    if customer:
        pipeline.append({"$match": {"$expr": {"$in": [{"$ifNull": ["$items.customer_id", "$customer_id"]}, filter_values(customer)]}}})
    if product_id:
        pipeline.append({"$match": {"items.product_id": product_id}})
    if view == "dispatch_record":
        pipeline.append({"$match": {"items.stage": {"$in": list(DISPATCH_STAGES)}}})
    if stage:
        if any(value not in PURCHASE_STAGES for value in filter_values(stage)):
            raise HTTPException(status_code=400, detail=f"Unknown stage '{stage}'")
        pipeline.append({"$match": {"items.stage": filter_condition(stage)}})

    docs = await db.purchase_orders.aggregate(pipeline).to_list(limit * 3)

    rows: list[dict] = []
    for d in docs:
        po = {k: v for k, v in d.items() if k != "items"}
        po["id"] = d.get("id")
        it = d.get("items") or {}
        rows.append(_flatten_item(po, it, sla_days))

    # Item-level search (for the sub-doc match already done, but also allow
    # customer_name text search post-unwind).
    if q and q.strip():
        term = q.strip().lower()
        rows = [r for r in rows if any(term in str(r.get(k) or "").lower() for k in ("sku", "name", "customer_name", "po_number", "brand_name"))]

    if view == "today":
        # Blocked/aging early-stage items first, newest activity next.
        rows = [r for r in rows if r["stage"] not in DISPATCH_STAGES or r["stage"] == "dispatched"]
        rows.sort(key=lambda r: (not r["blocked"], -(r.get("age_days") or 0)))
    elif view == "stock":
        rows.sort(key=lambda r: (r["stage"] == "dispatched", -(r.get("age_days") or 0)))
    elif view == "customers":
        rows.sort(key=lambda r: ((r.get("customer_name") or "").lower(), r.get("po_number") or ""))
    elif view == "dispatch_record":
        rows.sort(key=lambda r: r.get("last_moved_at") or "", reverse=True)
    else:
        rows.sort(key=lambda r: r.get("last_moved_at") or "", reverse=True)

    return rows[:limit]


def _items_page_pipeline(
    *,
    view: str,
    brand: Optional[str],
    customer: Optional[str],
    stage: Optional[str],
    q: Optional[str],
    product_id: Optional[str],
    floor_ids: Optional[list[str]],
    sla_days: int,
    skip: int,
    limit: int,
) -> list[dict]:
    """Build the paged tracker query.

    Filtering happens after unwind so a search matching one line does not leak
    every other line from the same PO into the result.  The final facet keeps
    page rows, totals and summary counts in one bounded database round-trip.
    """
    po_match: dict[str, Any] = {"status": {"$ne": "cancelled"}}
    if floor_ids is not None:
        po_match["floor_id"] = {"$in": floor_ids}

    item_match: dict[str, Any] = {}
    if brand and brand.lower() != "all":
        item_match["brand_id"] = filter_condition(brand)
    if customer:
        item_match["customer_id"] = filter_condition(customer)
    if stage:
        if any(value not in PURCHASE_STAGES for value in filter_values(stage)):
            raise HTTPException(status_code=400, detail=f"Unknown stage '{stage}'")
        item_match["stage"] = filter_condition(stage)
    if product_id:
        item_match["product_id"] = product_id
    if q and q.strip():
        term = {"$regex": re.escape(q.strip()), "$options": "i"}
        item_match["$or"] = [
            {"sku": term}, {"name": term}, {"customer_name": term},
            {"po_number": term}, {"brand_name": term},
        ]
    if view == "dispatch_record":
        selected_stages = filter_values(stage)
        item_match["stage"] = {"$in": [value for value in DISPATCH_STAGES if not selected_stages or value in selected_stages]}
    elif view == "today":
        item_match.setdefault("stage", {"$in": [*EARLY_STAGES, "dispatched"]})

    cutoff = datetime.now(timezone.utc).timestamp() - (sla_days * 86400)
    cutoff_iso = datetime.fromtimestamp(cutoff, timezone.utc).isoformat()
    sort: dict[str, int]
    if view == "today":
        sort = {"blocked": -1, "age_sort": 1, "last_moved_at": -1, "item_id": 1}
    elif view == "customers":
        sort = {"customer_name": 1, "po_number": 1, "item_id": 1}
    elif view == "stock":
        sort = {"delivered_sort": 1, "last_moved_at": 1, "item_id": 1}
    else:
        sort = {"last_moved_at": -1, "item_id": 1}

    return [
        {"$match": po_match},
        {"$unwind": "$items"},
        {"$match": {"items.cancelled": {"$ne": True}}},
        {"$match": {"$expr": {"$gt": [{"$subtract": [{"$ifNull": ["$items.qty", 0]}, {"$add": [{"$ifNull": ["$items.godown_transferred_qty", 0]}, {"$ifNull": ["$items.loan_replenishment_returned_qty", 0]}]}]}, 0]}}},
        {"$project": {
            "_id": 0,
            "item_id": "$items.id", "po_id": "$id", "po_number": "$number",
            "po_status": "$status", "quotation_id": 1, "quotation_number": 1, "floor_id": 1,
            "quotation_line_id": "$items.quotation_line_id", "product_id": "$items.product_id",
            "sku": "$items.sku", "name": "$items.name", "image": "$items.image",
            "finish": "$items.finish", "colour": "$items.colour",
            "customer_id": {"$ifNull": ["$items.customer_id", "$customer_id"]},
            "customer_name": {"$ifNull": ["$items.customer_name", "$customer_name"]},
            "brand_id": {"$ifNull": ["$items.brand_id", "$brand_id"]},
            "brand_name": {"$ifNull": ["$items.brand_name", "$brand_name"]},
            "supplier_id": 1, "supplier_name": 1,
            "stage": stage_expression(),
            "dispatched_at": delivery_timestamp_expression(),
            "delivered_at": delivery_timestamp_expression(),
            "qty": {"$subtract": [{"$ifNull": ["$items.qty", 0]}, {"$add": [{"$ifNull": ["$items.godown_transferred_qty", 0]}, {"$ifNull": ["$items.loan_replenishment_returned_qty", 0]}]}]},
            "unit_cost": {"$ifNull": ["$items.unit_cost", 0]},
            "room": "$items.room", "expected_delivery_at": 1,
            "last_moved_at": {"$ifNull": ["$items.last_moved_at", "$created_at"]},
            "last_moved_by_name": {"$ifNull": ["$items.last_moved_by_name", "$created_by_name"]},
            "split_from_item_id": "$items.split_from_item_id",
            "transferred_from_item_id": "$items.transferred_from_item_id",
            "transferred_from_customer_id": "$items.transferred_from_customer_id",
            "loaned_qty": {"$ifNull": ["$items.loaned_qty", 0]},
            "customer_loan_history": {"$ifNull": ["$items.customer_loan_history", []]},
            "loan_transfer_id": "$items.loan_transfer_id",
            "borrowed_from_customer_id": "$items.borrowed_from_customer_id",
            "borrowed_from_customer_name": "$items.borrowed_from_customer_name",
            "borrowed_at": "$items.borrowed_at",
            "borrowing_note": "$items.borrowing_note",
            "loan_return_status": "$items.loan_return_status",
            "loan_return_due": "$items.loan_return_due",
            "loan_replenishment_for_customer_name": "$items.loan_replenishment_for_customer_name",
            "loan_replenishment_status": "$items.loan_replenishment_status",
            "loan_replenishment_returned_qty": "$items.loan_replenishment_returned_qty",
            "return_due_on_replenishment": "$items.return_due_on_replenishment",
            "godown_transferred_qty": "$items.godown_transferred_qty",
            "godown_transfer_history": "$items.godown_transfer_history",
            "godown_stock_id": "$items.godown_stock_id",
            "godown_source_customer_name": "$items.godown_source_customer_name",
            "godown_transferred_at": "$items.godown_transferred_at",
        }},
        *([{"$match": item_match}] if item_match else []),
        {"$set": {
            "blocked": {"$and": [
                {"$in": ["$stage", list(EARLY_STAGES)]},
                {"$lte": ["$last_moved_at", cutoff_iso]},
            ]},
            "age_sort": "$last_moved_at",
            "delivered_sort": {"$cond": [{"$eq": ["$stage", "dispatched"]}, 1, 0]},
        }},
        {"$facet": {
            "items": [{"$sort": sort}, {"$skip": skip}, {"$limit": limit}],
            "total": [{"$count": "value"}],
            "blocked": [{"$match": {"blocked": True}}, {"$count": "value"}],
            "stages": [{"$group": {"_id": "$stage", "count": {"$sum": 1}}}],
        }},
    ]


def _hydrate_page_item(row: dict, sla_days: int) -> dict:
    """Add presentation fields which are cheaper and clearer in application code."""
    result = dict(row)
    stage = result.get("stage") or "order_in_company"
    result["stage"] = stage
    result["stage_label"] = STAGE_LABELS.get(stage, stage)
    result["stage_tone"] = STAGE_TONES.get(stage, {"bg": "#F4F4F5", "fg": "#3F3F46"})
    if stage != "dispatched":
        result["dispatched_at"] = None
        result["delivered_at"] = None
    result["qty"] = float(result.get("qty") or 0)
    result["unit_cost"] = float(result.get("unit_cost") or 0)
    result["age_days"] = _age_days(result.get("last_moved_at")) or 0
    result["sla_days"] = sla_days
    result.pop("age_sort", None)
    result.pop("delivered_sort", None)
    return result


# =============================================================================
# Read endpoints
# =============================================================================
@router.get("/stages")
async def stage_catalog(user: UserPublic = Depends(get_current_user)):
    """Stage list with counts across ALL non-cancelled items on the caller's floor(s)."""
    match: dict = {"status": {"$ne": "cancelled"}}
    floor_ids = floor_scope_ids(user)
    if floor_ids is not None:
        match["floor_id"] = {"$in": floor_ids}
    pipeline = [
        {"$match": match},
        {"$unwind": "$items"},
        {"$match": {"items.cancelled": {"$ne": True}}},
        {"$match": {"$expr": {"$gt": [{"$subtract": [{"$ifNull": ["$items.qty", 0]}, {"$add": [{"$ifNull": ["$items.godown_transferred_qty", 0]}, {"$ifNull": ["$items.loan_replenishment_returned_qty", 0]}]}]}, 0]}}},
        {"$group": {"_id": stage_expression(), "count": {"$sum": 1}}},
    ]
    rows = await db.purchase_orders.aggregate(pipeline).to_list(20)
    counts = {r["_id"]: r["count"] for r in rows}
    return [
        {"key": k, "label": STAGE_LABELS[k], "count": counts.get(k, 0), "tone": STAGE_TONES[k]}
        for k in PURCHASE_STAGES
    ]


@router.get("/brands")
async def brand_facets(user: UserPublic = Depends(get_current_user)):
    """Brand list with counts of tracked items on the caller's floor(s)."""
    match: dict = {"status": {"$ne": "cancelled"}}
    floor_ids = floor_scope_ids(user)
    if floor_ids is not None:
        match["floor_id"] = {"$in": floor_ids}
    pipeline = [
        {"$match": match},
        {"$unwind": "$items"},
        {"$match": {"items.cancelled": {"$ne": True}}},
        {"$match": {"$expr": {"$gt": [{"$subtract": [{"$ifNull": ["$items.qty", 0]}, {"$add": [{"$ifNull": ["$items.godown_transferred_qty", 0]}, {"$ifNull": ["$items.loan_replenishment_returned_qty", 0]}]}]}, 0]}}},
        {"$group": {
            "_id": {"id": "$brand_id", "name": "$brand_name"},
            "count": {"$sum": 1},
        }},
        {"$sort": {"count": -1}},
    ]
    rows = await db.purchase_orders.aggregate(pipeline).to_list(50)
    total = sum(r["count"] for r in rows)
    facets = [
        {"id": r["_id"].get("id"), "name": r["_id"].get("name") or "Unbranded", "count": r["count"]}
        for r in rows if r["_id"].get("id")
    ]
    return {"all": total, "brands": facets}


@router.get("/customers")
async def customer_facets(user: UserPublic = Depends(get_current_user)):
    """Customers with open (non-delivered) tracked items on the caller's floor(s)."""
    match: dict = {"status": {"$ne": "cancelled"}}
    floor_ids = floor_scope_ids(user)
    if floor_ids is not None:
        match["floor_id"] = {"$in": floor_ids}
    pipeline = [
        {"$match": match},
        {"$unwind": "$items"},
        {"$match": {"items.cancelled": {"$ne": True}}},
        {"$match": {"$expr": {"$gt": [{"$subtract": [{"$ifNull": ["$items.qty", 0]}, {"$add": [{"$ifNull": ["$items.godown_transferred_qty", 0]}, {"$ifNull": ["$items.loan_replenishment_returned_qty", 0]}]}]}, 0]}}},
        {"$group": {
            "_id": {"id": {"$ifNull": ["$items.customer_id", "$customer_id"]}, "name": {"$ifNull": ["$items.customer_name", "$customer_name"]}},
            "count": {"$sum": 1},
            "open": {"$sum": {"$cond": [{"$eq": [stage_expression(), "dispatched"]}, 0, 1]}},
        }},
        {"$sort": {"open": -1, "count": -1}},
    ]
    rows = await db.purchase_orders.aggregate(pipeline).to_list(500)
    return [
        {
            "id": r["_id"].get("id"),
            "name": r["_id"].get("name"),
            "count": r["count"],
            "open": r["open"],
        }
        for r in rows if r["_id"].get("id")
    ]


def _completed_customer_pipeline(user: UserPublic, skip: int = 0, limit: int = 100) -> list[dict]:
    return completed_customer_pipeline(user) + [
        {"$sort": {"last_delivered_at": -1, "_id": 1}}, {"$skip": skip}, {"$limit": limit},
    ]


@router.get("/customer-workspaces")
async def active_customer_workspaces(
    include_completed: bool = Query(False), user: UserPublic = Depends(get_current_user),
):
    """Confirmed buyers on this floor; completed buyers move to their register.

    Walk-in prospects stay in Walk-ins until they have an actual order. Derive
    eligibility from orders, preserving legacy buyers and transferred owners.
    """
    eligible_ids, complete_ids = await asyncio.gather(
        confirmed_customer_ids(db, user),
        completed_customer_ids(db, user) if not include_completed else asyncio.sleep(0, result=set()),
    )
    rows = await db.customers.aggregate([
        {"$match": floor_query(user, {"id": {"$in": sorted(eligible_ids - complete_ids)}})},
        {"$sort": {"name": 1, "id": 1}},
        {"$project": {"_id": 0, "id": 1, "name": 1, "company": 1, "email": 1, "phone": 1, "city": 1, "tier": 1}},
    ]).to_list(None)
    return rows


@router.get("/customers/completed")
async def completed_customer_facets(
    skip: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=100),
    user: UserPublic = Depends(get_current_user),
):
    """Only customers with every positive, active line dispatched (delivered).

    Aggregation examines every PO before paging, so an older pending line,
    partial split or customer rename cannot falsely produce 100% completion.
    """
    rows = await db.purchase_orders.aggregate(_completed_customer_pipeline(user, skip, limit)).to_list(limit)
    return [{"id": r["_id"], "name": r.get("name"), "count": r["item_count"],
             "quantity": r.get("quantity", 0), "completed_at": r.get("last_delivered_at")}
            for r in rows]


@router.get("/customers/{customer_id}/workspace")
async def customer_workspace(
    customer_id: str,
    q: Optional[str] = None,
    brand: Optional[str] = None,
    stage: Optional[str] = None,
    user: UserPublic = Depends(get_current_user),
):
    """One-call aggregate powering the Customer Purchase Workspace: summary,
    products ordered, brand/stage breakdowns, POs, outstanding items, recent
    activity, and expected delivery. Everything here is derived live from the
    same PO/item documents the rest of Purchases uses — no separate cache to
    go stale. When `q`, `brand`, or `stage` filters are active, the summary
    inventory totals (`total_items`, `total_value`, outstanding counts/values,
    blocked counts, delivered counts) are scoped to that filtered item set.
    `order_value` is the customer's full confirmed commercial order value.
    """
    customer, settings = await asyncio.gather(
        db.customers.find_one(floor_query(user, {"id": customer_id}), {"_id": 0}),
        _load_settings(),
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")

    async def load_workspace_rows() -> list[dict]:
        items = await _iter_items(
            "stock", brand, customer_id, stage, q, settings.sla_days, limit=2000,
            floor_ids=floor_scope_ids(user),
        )
        await _hydrate_workspace_images(items)
        return items

    # These reads have no data dependency on each other. Fetching them in
    # parallel removes several Atlas round trips from a commonly opened page.
    rows, pos, activity, shortages, order_quotes, payments, followups = await asyncio.gather(
        load_workspace_rows(),
        db.purchase_orders.find(floor_query(user, {"customer_id": customer_id}), {"_id": 0}).sort("created_at", -1).to_list(200),
        timeline_for(customer_id=customer_id, limit=15, floor_ids=floor_scope_ids(user)),
        db.purchase_shortages.find(
            floor_query(user, {"customer_id": customer_id, "status": "awaiting_reorder"}), {"_id": 0},
        ).sort("created_at", -1).to_list(100),
        db.quotations.find(
            floor_query(user, {"customer_id": customer_id, "status": {"$in": ["ordered", "won"]}}),
            {"_id": 0, "id": 1, "grand_total": 1, "payment_extra_amount": 1, "payment_extra_history": 1},
        ).to_list(500),
        db.payments.find(floor_query(user, {"customer_id": customer_id}), {"_id": 0}).sort("created_at", -1).to_list(100),
        db.followups.find(
            floor_query(user, {"customer_id": customer_id, "status": {"$in": ["open", "snoozed"]}}), {"_id": 0},
        ).sort("due_at", 1).to_list(100),
    )

    total_value = round(sum(r["qty"] * r["unit_cost"] for r in rows), 2)
    # The rows above describe currently visible purchase tracker quantities.
    # A loan replacement is physically returned to its owner, but remains part
    # of the recipient's confirmed sale.  Payments likewise use the confirmed
    # quotation, so derive the commercial value from those same orders.  A
    # transfer into godown is a genuine reduction and receives a matching
    # payment credit; subtract its sold value once, at the source PO.
    order_quote_ids = {quote["id"] for quote in order_quotes}
    from routes.payment_routes import _collection_total, _godown_value_by_quotation, _paid_by_quotation
    # The PO list above is capped for the UI.  Use a server-side group over
    # every quote-linked PO so older godown intakes still affect the ledger.
    godown_by_quote = await _godown_value_by_quotation(
        list(order_quote_ids), floor_ids=floor_scope_ids(user), purchase_orders=db.purchase_orders,
    )
    godown_value = sum(godown_by_quote.values())
    order_value = round(max(0.0, sum(_collection_total(quote) for quote in order_quotes) - godown_value), 2)
    outstanding_rows = [r for r in rows if r["stage"] != "dispatched"]
    outstanding_value = round(sum(r["qty"] * r["unit_cost"] for r in outstanding_rows), 2)
    blocked_rows = [r for r in rows if r["blocked"]]
    delivered_rows = [r for r in rows if r["stage"] == "dispatched"]

    brand_map: dict = {}
    for r in rows:
        key = r.get("brand_id") or "unbranded"
        b = brand_map.setdefault(key, {"id": r.get("brand_id"), "name": r.get("brand_name") or "Unbranded", "count": 0})
        b["count"] += 1
    stage_counts = {k: 0 for k in PURCHASE_STAGES}
    for r in rows:
        stage_counts[r["stage"]] = stage_counts.get(r["stage"], 0) + 1
    stages = [
        {"key": k, "label": STAGE_LABELS[k], "count": stage_counts.get(k, 0), "tone": STAGE_TONES[k]}
        for k in PURCHASE_STAGES
    ]

    # Customer IDs can exist on more than one business floor.  Keep the
    # activity stream in the same floor scope as the products and POs above;
    # otherwise Sanitary Bathroom movement events leak into Ground Floor.
    paid_map = await _paid_by_quotation([quote["id"] for quote in order_quotes])
    cash_map = await _paid_by_quotation([quote["id"] for quote in order_quotes], cash_only=True)
    outstanding_balance = round(sum(
        max(0.0, _collection_total(quote) - paid_map.get(quote["id"], 0.0))
        for quote in order_quotes
    ), 2)
    refund_due = round(sum(
        max(0.0, cash_map.get(quote["id"], 0.0)
            - max(0.0, _collection_total(quote) - godown_by_quote.get(quote["id"], 0.0)))
        for quote in order_quotes
    ), 2)
    def visible_po_items(po: dict) -> list[dict]:
        return [item for item in po.get("items") or [] if not item.get("cancelled") and float(item.get("qty") or 0) > float(item.get("godown_transferred_qty") or 0) + float(item.get("loan_replenishment_returned_qty") or 0)]

    def current_po_value(po: dict) -> float:
        # A loan does not change the source PO sale.  Only stock permanently
        # moved to godown is credited against the source customer's order.
        from services.godown_valuation import transferred_sold_value
        moved_value = sum(transferred_sold_value(item)
                          for item in po.get("items") or [] if not item.get("cancelled"))
        return round(max(0.0, float(po.get("grand_total") or 0) - moved_value), 2)

    visible_pos = [p for p in pos if visible_po_items(p)]
    open_pos = [p for p in visible_pos if p.get("status") != "cancelled"]
    expected = sorted(
        [
            {"po_id": p["id"], "po_number": p.get("number"), "expected_delivery_at": p.get("expected_delivery_at")}
            for p in open_pos if p.get("expected_delivery_at")
        ],
        key=lambda x: x["expected_delivery_at"],
    )

    response = {
        "customer": {
            "id": customer["id"], "name": customer.get("name"), "company": customer.get("company"),
            "tier": customer.get("tier"), "email": customer.get("email"), "phone": customer.get("phone"),
        },
        "summary": {
            "total_items": len(rows),
            "total_value": total_value,
            "order_value": order_value,
            "outstanding_value": outstanding_value,
            "outstanding_count": len(outstanding_rows),
            "open_pos": len(open_pos),
            "blocked_count": len(blocked_rows),
            "delivered_count": len(delivered_rows),
            "shortage_count": len(shortages),
            "outstanding_balance": outstanding_balance,
            "refund_due": refund_due,
            "open_followup_count": len(followups),
        },
        "shortages": shortages,
        "payments": payments,
        "followups": followups,
        "products": rows,
        "brands": sorted(brand_map.values(), key=lambda x: -x["count"]),
        "stages": stages,
        "purchase_orders": [
            {
                "id": p["id"], "number": p.get("number"), "status": p.get("status"),
                "brand_name": p.get("brand_name"), "supplier_name": p.get("supplier_name"),
                "grand_total": p.get("grand_total"), "created_at": p.get("created_at"),
                "current_order_value": current_po_value(p),
                "expected_delivery_at": p.get("expected_delivery_at"),
                "item_count": len(visible_po_items(p)),
            }
            for p in visible_pos
        ],
        "outstanding_items": outstanding_rows,
        "recent_activity": activity,
        "expected_delivery": {
            "next_at": expected[0]["expected_delivery_at"] if expected else None,
            "purchase_orders": expected[:5],
        },
    }
    # The sanitary purchases profile may open any customer's purchasing
    # workspace, but it is not a customer/receivables account.  Keep the
    # redirect target useful while removing payment balances, payment history,
    # follow-ups and general CRM activity from the response itself.
    if user.access_profile == "sanitary_purchases":
        response["customer"] = {"id": customer["id"], "name": customer.get("name"), "company": customer.get("company")}
        response["summary"].pop("outstanding_balance", None)
        response["summary"].pop("refund_due", None)
        response.pop("payments", None)
        response.pop("followups", None)
        response.pop("recent_activity", None)
    return response


@router.get("/items")
async def list_items(
    view: str = Query("stock", pattern="^(today|stock|customers|dispatch_record)$"),
    brand: Optional[str] = None,
    customer: Optional[str] = None,
    stage: Optional[str] = None,
    q: Optional[str] = None,
    product_id: Optional[str] = None,
    limit: int = Query(500, ge=1, le=2000),
    user: UserPublic = Depends(get_current_user),
):
    """Flat tracker rows filtered by view/brand/customer/stage/q/product_id."""
    settings = await _load_settings()
    rows = await _iter_items(
        view, brand, customer, stage, q, settings.sla_days, limit, product_id,
        floor_ids=floor_scope_ids(user),
    )
    await _hydrate_workspace_images(rows)

    blocked_count = sum(1 for r in rows if r["blocked"])
    return {
        "sla_days": settings.sla_days,
        "count": len(rows),
        "blocked_count": blocked_count,
        "items": rows,
    }


@router.get("/items/page")
async def list_items_page(
    view: str = Query("stock", pattern="^(today|stock|customers|dispatch_record)$"),
    brand: Optional[str] = None,
    customer: Optional[str] = None,
    stage: Optional[str] = None,
    q: Optional[str] = None,
    product_id: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(30, ge=1, le=100),
    user: UserPublic = Depends(get_current_user),
):
    """Database-paged tracker rows for mobile and other incremental clients.

    The legacy ``/items`` response remains available while callers migrate.
    Summary counts cover the complete filtered result, not only this page.
    """
    settings = await _load_settings()
    pipeline = _items_page_pipeline(
        view=view, brand=brand, customer=customer, stage=stage, q=q,
        product_id=product_id, floor_ids=floor_scope_ids(user),
        sla_days=settings.sla_days, skip=skip, limit=limit,
    )
    result = await db.purchase_orders.aggregate(pipeline).to_list(1)
    facet = result[0] if result else {}
    total = int((facet.get("total") or [{}])[0].get("value", 0)) if facet.get("total") else 0
    blocked_count = int((facet.get("blocked") or [{}])[0].get("value", 0)) if facet.get("blocked") else 0
    stage_counts = {row.get("_id"): int(row.get("count", 0)) for row in facet.get("stages") or []}
    items = [_hydrate_page_item(row, settings.sla_days) for row in facet.get("items") or []]
    await _hydrate_workspace_images(items)
    next_skip = skip + len(items)
    has_more = next_skip < total
    return {
        "items": items,
        "total": total,
        "has_more": has_more,
        "next_skip": next_skip if has_more else None,
        "summaries": {
            "sla_days": settings.sla_days,
            "blocked_count": blocked_count,
            "stage_counts": stage_counts,
        },
    }


@router.get("/dispatch-record")
async def dispatch_record(
    brand: Optional[str] = None,
    customer: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = Query(500, ge=1, le=2000),
    user: UserPublic = Depends(get_current_user),
):
    settings = await _load_settings()
    rows = await _iter_items(
        "dispatch_record", brand, customer, None, q, settings.sla_days, limit,
        floor_ids=floor_scope_ids(user),
    )
    return {"count": len(rows), "items": rows}


@router.get("/items/{item_id}")
async def get_item(item_id: str, user: UserPublic = Depends(get_current_user)):
    # An item link can outlive the floor header that was active when the
    # tracker rendered it (notably after a mobile floor switch).  Authorize
    # against the PO's own floor, rather than pre-filtering by ambient state;
    # otherwise a user assigned to both floors receives a false "Item not
    # found" for a perfectly accessible item.
    po = await get_floor_scoped_or_404(
        db.purchase_orders,
        item_id,
        user,
        id_field="items.id",
        not_found="Item not found",
        projection={"_id": 0},
    )
    it = next((i for i in po.get("items", []) if i.get("id") == item_id), None)
    if not it:
        raise HTTPException(status_code=404, detail="Item not found")
    settings = await _load_settings()
    row = _flatten_item(po, it, settings.sla_days)
    row["stage_history"] = it.get("stage_history") or []
    row["po_status"] = po.get("status")
    return row


# =============================================================================
# Mutations — move, bulk move, transfer
# =============================================================================
class MoveBody(BaseModel):
    stage: PurchaseStage
    note: Optional[str] = None
    qty: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)  # partial move — e.g. "3 of 20"


class BulkMoveBody(BaseModel):
    item_ids: list[str]
    stage: PurchaseStage
    note: Optional[str] = None


class TransferBody(BaseModel):
    destination_customer_id: Optional[str] = None
    new_customer_id: Optional[str] = None  # legacy request compatibility
    new_customer: Optional[dict] = None
    qty: float = Field(..., gt=0)
    reason: Optional[str] = None
    idempotency_key: Optional[str] = None


class CancelItemBody(BaseModel):
    reason: Optional[str] = Field(default=None, max_length=1000)


async def _cancel_parent_po_if_empty(po: dict, user: UserPublic, now: str, reason: Optional[str]) -> bool:
    """Cancel the PO iff every line has been cancelled.

    The conditional update makes the parent transition safe when two final
    active lines are cancelled concurrently. A cancelled PO still retains all
    of its line and cancellation history for detail/audit views.
    """
    status_event = PurchaseStatusEvent(
        from_status=po.get("status"), to_status="cancelled",
        by_user_id=user.id, by_user_name=user.full_name,
        note="All purchase items cancelled" + (f": {reason}" if reason else ""),
    ).model_dump()
    result = await db.purchase_orders.update_one(
        {
            "id": po["id"],
            "status": {"$ne": "cancelled"},
            "items": {"$not": {"$elemMatch": {"cancelled": {"$ne": True}}}},
        },
        {"$set": {"status": "cancelled", "updated_at": now}, "$push": {"status_history": status_event}},
    )
    return bool(result.matched_count)


async def _cancel_item(
    item_id: str,
    reason: Optional[str],
    user: UserPublic,
    purchase_filter: Optional[dict] = None,
) -> dict:
    po = await db.purchase_orders.find_one(
        purchase_filter or floor_query(user, {"items.id": item_id}), {"_id": 0}
    )
    if not po:
        raise HTTPException(status_code=404, detail="Item not found")
    if po.get("status") == "cancelled":
        raise HTTPException(status_code=409, detail="Purchase order is already cancelled")
    item = next((candidate for candidate in po.get("items", []) if candidate.get("id") == item_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    if item.get("cancelled"):
        raise HTTPException(status_code=409, detail="Item is already cancelled")
    if item.get("loan_replenishment_for_customer_name"):
        raise HTTPException(status_code=409, detail="This ordered product is reserved to return a customer loan; move it to godown stock instead")
    if normalized_stage(item, po) == "dispatched":
        raise HTTPException(status_code=400, detail="Delivered items cannot be cancelled")

    now = now_iso()
    cancellation = PurchaseCancellationEvent(
        by_user_id=user.id, by_user_name=user.full_name, reason=reason,
    ).model_dump()
    # The element match is a compare-and-set guard: a concurrent cancellation
    # or delivery move cannot overwrite this item's active state.
    result = await db.purchase_orders.update_one(
        {"id": po["id"], "chalans": po.get("chalans"), "items": {"$elemMatch": {
            "id": item_id, "cancelled": {"$ne": True}, "stage": {"$nin": ["dispatched", "in_transit", "delivered"]},
        }}},
        {"$set": {
            "items.$.cancelled": True,
            "items.$.cancelled_at": now,
            "items.$.cancelled_by": user.id,
            "items.$.cancelled_by_name": user.full_name,
            "items.$.cancellation_reason": reason,
            "updated_at": now,
        }, "$push": {"items.$.cancellation_history": cancellation}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=409, detail="Item changed concurrently — refresh and try again")

    parent_cancelled = await _cancel_parent_po_if_empty(po, user, now, reason)
    await log_event(
        event_type="purchase.cancelled", entity_type="purchase", entity_id=po["id"], actor=user,
        customer_id=po.get("customer_id"), purchase_id=po["id"], floor_id=floor_inherit(po),
        summary=f"Cancelled {item.get('name') or 'purchase item'}" + (f" · {reason}" if reason else ""),
        payload={
            "item_id": item_id, "po_number": po.get("number"), "sku": item.get("sku"),
            "qty": item.get("qty"), "reason": reason, "parent_po_cancelled": parent_cancelled,
            "cancellation": cancellation,
        },
    )
    return {"po_id": po["id"], "item_id": item_id, "cancelled": True, "parent_po_cancelled": parent_cancelled}


def _derive_po_status_from_stages(items: list[dict], current_status: str) -> Optional[str]:
    """Reconcile the PO-level `status` (purchase_routes.py state machine) with
    the per-item `stage` (Material Tracker). These are two views of the same
    physical reality — incoming-from-supplier receiving progress — and MUST
    never silently diverge (e.g. Kanban shows "Draft" while every line is
    physically "Delivered"). Returns the target status, or None if no forward
    sync is warranted (PO is cancelled, or already at/past the target).

    Mapping (supplier → our warehouse):
        po_final / order_in_company / company_billing / in_box → still "ordered" once
            procurement has actually started moving it (was draft/awaiting_review)
        dispatched / in_transit                       → "awaiting_supplier"
        delivered (some, not all)                     → "partial_received"
        delivered (all)                                → "fully_received"

    We only ever move status FORWARD relative to ALLOWED_TRANSITIONS reachability
    from the current status, and we never touch a PO that is "cancelled" or has
    already progressed to "packed"/"ready_for_dispatch" (post-receiving, dispatch
    to the customer is a distinct, later concern the Material Tracker doesn't
    own).
    """
    if current_status in ("cancelled", "packed", "ready_for_dispatch"):
        return None
    if not items:
        return None
    active_items = [i for i in items if not i.get("cancelled") and active_quantity(i) > 0]
    if not active_items:
        return None
    stages = [normalized_stage(i) for i in active_items]

    if all(s == "dispatched" for s in stages):
        target = "fully_received"
    elif any(s == "dispatched" for s in stages):
        target = "partial_received"
    elif any(s in ("dispatched", "in_transit") for s in stages):
        target = "awaiting_supplier"
    elif any(s in ("company_billing", "in_box") for s in stages):
        target = "ordered"
    else:
        return None  # every item is still in its initial stage

    if target == current_status:
        return None

    # Rank statuses so we never move backwards (e.g. a late single-item
    # re-move to an earlier stage shouldn't downgrade a PO that's otherwise
    # fully_received from other items already reconciled).
    rank = ["draft", "awaiting_review", "ordered", "awaiting_supplier",
            "partial_received", "fully_received"]
    try:
        if rank.index(target) <= rank.index(current_status):
            return None
    except ValueError:
        pass
    return target


async def _sync_po_status_with_stages(po_id: str, user: UserPublic) -> Optional[str]:
    """Fetch the fresh PO, derive the correct status from item stages, and
    persist it (+ status_history + qty_received bookkeeping + activity event)
    if a forward sync is warranted. Returns the new status, or None."""
    fresh = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    if not fresh:
        return None
    target = _derive_po_status_from_stages(fresh.get("items", []), fresh.get("status", "draft"))
    if not target:
        return None

    now = now_iso()
    ev = PurchaseStatusEvent(
        from_status=fresh.get("status"), to_status=target,
        by_user_id=user.id, by_user_name=user.full_name,
        note="Auto-synced from Material Tracker stage change",
    ).model_dump()
    set_fields: dict = {"status": target, "updated_at": now}
    await db.purchase_orders.update_one(
        {"id": po_id},
        {"$set": set_fields, "$push": {"status_history": ev}},
    )
    # Keep qty_received consistent with /receive bookkeeping for every item
    # that has physically reached "delivered" — otherwise the receive-progress
    # math (partial vs full) on the PO-lifecycle side would still read 0.
    for it2 in fresh.get("items", []):
        if normalized_stage(it2) == "dispatched" and float(it2.get("qty_received") or 0) < float(it2.get("qty") or 0):
            await db.purchase_orders.update_one(
                {"id": po_id, "items.id": it2["id"]},
                {"$set": {"items.$.qty_received": it2.get("qty")}},
            )

    await log_event(
        event_type="purchase.status_changed",
        entity_type="purchase", entity_id=po_id, actor=user,
        customer_id=fresh.get("customer_id"),
        summary=f"Status auto-synced to {STATUS_LABELS.get(target, target)} (Material Tracker)",
        payload={"from": fresh.get("status"), "to": target, "source": "material_tracker_sync"},
    )
    return target


async def _apply_stage_change(
    item_id: str, to_stage: str, user: UserPublic, note: Optional[str],
    qty: Optional[float] = None, *, max_attempts: int = 3,
) -> dict:
    """Retry wrapper around `_attempt_stage_change`. Each attempt re-reads the
    item fresh, so a lost optimistic-concurrency race (another move landed
    first) is resolved transparently by recomputing against the new state —
    this is what makes an accidental double-click/near-simultaneous request
    "just work" instead of surfacing an error in the common case. Only after
    `max_attempts` genuine conflicts in a row do we give up and tell the
    caller, with enough state to refresh intelligently."""
    for _ in range(max_attempts):
        result = await _attempt_stage_change(item_id, to_stage, user, note, qty)
        if not result.get("conflict"):
            if to_stage == "in_box":
                arrived_item_id = result.get("new_item_id") or result.get("item_id") or item_id
                result["loans_due"] = (await mark_loans_due_for_replenishment(item_id=arrived_item_id, user=user))["return_due_transfer_ids"]
            return result

    logger.warning("Concurrent inventory conflict on item %s after %d attempts", item_id, max_attempts)
    po = await db.purchase_orders.find_one(floor_query(user, {"items.id": item_id}), {"_id": 0})
    it = next((i for i in (po or {}).get("items", []) if i.get("id") == item_id), None) if po else None
    raise HTTPException(status_code=409, detail={
        "error": "concurrent_modification",
        "message": "This item was modified concurrently — refresh and try again",
        "item_id": item_id,
        "expected_qty": result.get("expected_qty"),
        "current_qty": (it or {}).get("qty"),
        "current_stage": (it or {}).get("stage"),
    })


async def _attempt_stage_change(
    item_id: str, to_stage: str, user: UserPublic, note: Optional[str],
    qty: Optional[float] = None,
) -> dict:
    """One attempt at an atomic update of a single item's stage — writes a
    stage_history entry. Returns `{"conflict": True, "expected_qty": ...}`
    (never raises) when another request changed the item first, so the
    caller (`_apply_stage_change`) can decide whether to retry.

    If `qty` is given and is LESS than the item's current quantity, this is a
    PARTIAL move ("3 of 20") — the line is split: a brand-new tracked item is
    created at `to_stage` carrying `qty` units, and the original item's
    quantity is reduced by that amount and stays at its current stage. Full
    lineage is recorded both ways (split_out on the original, split_in on the
    new piece) so the Movement History for either piece traces back to the
    other.
    """
    po = await db.purchase_orders.find_one(floor_query(user, {"items.id": item_id}), {"_id": 0})
    if not po:
        raise HTTPException(status_code=404, detail="Item not found")
    it = next((i for i in po.get("items", []) if i.get("id") == item_id), None)
    if not it:
        raise HTTPException(status_code=404, detail="Item not found")
    if it.get("cancelled"):
        raise HTTPException(status_code=409, detail="Cancelled items cannot be moved")
    if float(it.get("loan_replenishment_promised_qty") or 0) > 0 and to_stage in {"dispatched", "in_transit", "delivered"}:
        raise HTTPException(status_code=409, detail="This ordered product is promised back to the lending customer")
    from_stage = it.get("stage") or "order_in_company"
    full_qty = float(it.get("qty") or 0)
    available_qty = active_quantity(it)
    move_qty = float(qty) if qty is not None else available_qty
    if not all(math.isfinite(value) for value in (full_qty, available_qty, move_qty)):
        raise HTTPException(status_code=400, detail="Move quantities must be finite numbers")
    if move_qty <= 0:
        raise HTTPException(status_code=400, detail="Move quantity must be greater than 0")
    if move_qty > available_qty + 1e-6:
        raise HTTPException(status_code=400, detail=f"Only {available_qty} available to move")
    if float(it.get("loan_replenishment_promised_qty") or 0) > 0 and move_qty < full_qty - 1e-6:
        raise HTTPException(status_code=409, detail="A promised replacement cannot be split")

    loaned_qty = float(it.get("loaned_qty") or 0)
    if loaned_qty > 0 and (to_stage != from_stage or move_qty < full_qty - 1e-6) and move_qty > available_qty - loaned_qty + 1e-6:
        raise HTTPException(status_code=409, detail=f"{loaned_qty:g} units are lent to another customer and must be returned before moving them")

    is_partial = move_qty < full_qty - 1e-6

    if not is_partial and from_stage == to_stage:
        return {"po_id": po["id"], "item_id": item_id, "no_change": True}

    now = now_iso()
    # Guard every quantity input and active state used in this calculation.
    # Stage-only comparisons cannot detect concurrent cancellation/returns.
    item_guard = {
        "id": item_id, "qty": full_qty, "stage": it.get("stage"),
        "cancelled": {"$ne": True},
        **{field: it.get(field) for field in (
            "godown_transferred_qty", "loan_replenishment_returned_qty", "loaned_qty", "loan_replenishment_promised_qty",
        )},
    }
    mutation_guard = {
        "id": po["id"], "floor_id": po.get("floor_id"), "status": {"$ne": "cancelled"},
        "items": {"$elemMatch": item_guard}, "chalans": po.get("chalans"),
    }

    # -------------------------------------------------------------------
    # PARTIAL MOVE — split the line into two tracked pieces.
    # -------------------------------------------------------------------
    if is_partial:
        remaining = round(full_qty - move_qty, 4)
        new_item_id = str(uuid4())

        move_ev = PurchaseStageEvent(
            from_stage=from_stage, to_stage=to_stage,
            by_user_id=user.id, by_user_name=user.full_name,
            note=note, action="split_in",
            ref_item_id=item_id, ref_po_id=po["id"], qty=move_qty,
        ).model_dump()
        new_item = dict(it)
        new_item["id"] = new_item_id
        new_item["qty"] = move_qty
        new_item["qty_received"] = 0
        # Returned quantities stay on the source; copying them to the child
        # would subtract the same physical returns from active stock twice.
        new_item["godown_transferred_qty"] = 0
        new_item["godown_transfer_history"] = []
        new_item["loan_replenishment_returned_qty"] = 0
        # The original line retains every active customer loan; the moved
        # unloaned piece must not inherit its reservation or transfer journal.
        new_item["loaned_qty"] = 0
        new_item["customer_loan_history"] = []
        new_item["dispatched_at"] = now if to_stage == "dispatched" else None
        new_item["delivered_at"] = now if to_stage == "dispatched" else None
        new_item["stage"] = to_stage
        new_item["last_moved_at"] = now
        new_item["last_moved_by"] = user.id
        new_item["last_moved_by_name"] = user.full_name
        new_item["split_from_item_id"] = item_id
        new_item["split_into_item_id"] = None
        new_item["stage_history"] = list(it.get("stage_history") or []) + [move_ev]

        src_ev = PurchaseStageEvent(
            from_stage=from_stage, to_stage=from_stage,
            by_user_id=user.id, by_user_name=user.full_name,
            note=note or f"Split {move_qty} of {full_qty} → {STAGE_LABELS.get(to_stage, to_stage)}",
            action="split_out",
            ref_item_id=new_item_id, ref_po_id=po["id"], qty=move_qty,
        ).model_dump()

        # The source shrink and new child append are one document update.
        # A read can never observe the source removed without its child, and
        # an interrupted request cannot lose the moved stock. Literal wrappers
        # prevent user names/notes beginning with "$" becoming expressions.
        source_fields = {
            "qty": remaining, "split_into_item_id": new_item_id,
            "last_moved_at": now, "last_moved_by": user.id,
            "last_moved_by_name": user.full_name,
        }
        cas_result = await db.purchase_orders.update_one(
            mutation_guard,
            [{"$set": {
                "items": {"$concatArrays": [
                    {"$map": {"input": "$items", "as": "current", "in": {"$cond": [
                        {"$eq": ["$$current.id", {"$literal": item_id}]},
                        {"$mergeObjects": ["$$current", {"$literal": source_fields}, {
                            "stage_history": {"$concatArrays": [
                                {"$ifNull": ["$$current.stage_history", []]}, {"$literal": [src_ev]},
                            ]},
                        }]}, "$$current",
                    ]}}},
                    {"$literal": [new_item]},
                ]},
                "updated_at": now,
            }}],
        )
        if cas_result.matched_count == 0:
            return {"conflict": True, "expected_qty": full_qty}

        await log_event(
            event_type="purchase.stage_split",
            entity_type="purchase", entity_id=po["id"], actor=user,
            customer_id=po.get("customer_id"),
            summary=(
                f"{it.get('name')} · split {move_qty} of {full_qty} · "
                f"{STAGE_LABELS.get(from_stage, from_stage)} → {STAGE_LABELS.get(to_stage, to_stage)}"
                + (f" · {note}" if note else "")
            ),
            payload={
                "item_id": item_id, "new_item_id": new_item_id, "po_number": po.get("number"),
                "from_stage": from_stage, "to_stage": to_stage,
                "sku": it.get("sku"), "qty_moved": move_qty, "qty_remaining": remaining,
            },
        )

        new_status = await _sync_po_status_with_stages(po["id"], user)
        if to_stage in ("dispatched", "in_transit", "delivered") or new_status:
            asyncio.create_task(reconcile_followups())

        return {
            "po_id": po["id"], "item_id": item_id, "split": True,
            "new_item_id": new_item_id,
            "from_stage": from_stage, "to_stage": to_stage,
            "qty_moved": move_qty, "qty_remaining": remaining,
            "po_status_synced_to": new_status,
        }

    # -------------------------------------------------------------------
    # FULL MOVE — existing behaviour, whole line advances together.
    # -------------------------------------------------------------------
    ev = PurchaseStageEvent(
        from_stage=from_stage, to_stage=to_stage,
        by_user_id=user.id, by_user_name=user.full_name,
        note=note, action="move", qty=move_qty,
    ).model_dump()

    # Same $elemMatch CAS guard as the partial-move branch, applied to `stage`
    # instead of `qty` — lower severity here (a lost update just means a
    # last-write-wins stage instead of corrupted quantities), but the same
    # primitive is essentially free and keeps both branches consistent.
    cas_result = await db.purchase_orders.update_one(
        mutation_guard,
        {
            "$set": {
                "items.$.stage": to_stage,
                "items.$.dispatched_at": now if to_stage == "dispatched" else None,
                "items.$.delivered_at": now if to_stage == "dispatched" else None,
                "items.$.last_moved_at": now,
                "items.$.last_moved_by": user.id,
                "items.$.last_moved_by_name": user.full_name,
                "updated_at": now,
            },
            "$push": {"items.$.stage_history": ev},
        },
    )
    if cas_result.matched_count == 0:
        return {"conflict": True, "expected_qty": full_qty}

    await log_event(
        event_type="purchase.stage_moved",
        entity_type="purchase", entity_id=po["id"], actor=user,
        customer_id=po.get("customer_id"),
        summary=(
            f"{it.get('name')} · {STAGE_LABELS.get(from_stage, from_stage)} → "
            f"{STAGE_LABELS.get(to_stage, to_stage)}"
            + (f" · {note}" if note else "")
        ),
        payload={
            "item_id": item_id, "po_number": po.get("number"),
            "from_stage": from_stage, "to_stage": to_stage,
            "sku": it.get("sku"), "qty": it.get("qty"),
        },
    )

    # Reconcile the PO-level status with the new item-stage reality — this is
    # THE fix for the two-systems divergence (Kanban `status` vs Tracker
    # `stage` silently disagreeing). Runs on every move, not just dispatch+.
    new_status = await _sync_po_status_with_stages(po["id"], user)

    if to_stage in ("dispatched", "in_transit", "delivered") or new_status:
        # Dispatch/delivery reminders derive from item stage/PO status —
        # event-triggered refresh right here, not a cron job.
        asyncio.create_task(reconcile_followups())
    return {
        "po_id": po["id"], "item_id": item_id,
        "from_stage": from_stage, "to_stage": to_stage,
        "po_status_synced_to": new_status,
    }


@router.post("/items/{item_id}/move")
async def move_item(
    item_id: str,
    body: MoveBody,
    user: UserPublic = Depends(require_min_role("warehouse")),
):
    if body.stage not in PURCHASE_STAGES:
        raise HTTPException(status_code=400, detail=f"Unknown stage '{body.stage}'")
    return await _apply_stage_change(item_id, body.stage, user, body.note, body.qty)


@router.post("/items/{item_id}/cancel")
async def cancel_item(
    item_id: str,
    body: CancelItemBody,
    user: UserPublic = Depends(require_min_role("warehouse")),
):
    """Cancel one active, undelivered purchase item without deleting history."""
    return await _cancel_item(
        item_id, body.reason, user,
        purchase_filter=floor_query(user, {"items.id": item_id}),
    )


def _bulk_move_error_payload(exc: HTTPException) -> dict:
    code_map = {
        403: "forbidden",
        404: "not_found",
        409: "conflict",
    }
    error_code = code_map.get(exc.status_code, "validation" if 400 <= exc.status_code < 500 else "error")

    detail = exc.detail
    if isinstance(detail, dict):
        message = detail.get("message") or detail.get("detail") or detail.get("error") or "Request failed"
        payload = {"error": message, "error_code": error_code}
        for key, value in detail.items():
            if key not in {"message", "detail", "error"}:
                payload[key] = value
        return payload

    return {"error": str(detail), "error_code": error_code}


@router.post("/items/bulk-move")
async def bulk_move(
    body: BulkMoveBody,
    user: UserPublic = Depends(require_min_role("warehouse")),
):
    if body.stage not in PURCHASE_STAGES:
        raise HTTPException(status_code=400, detail=f"Unknown stage '{body.stage}'")
    if not body.item_ids:
        raise HTTPException(status_code=400, detail="No items selected")
    results: list[dict] = []
    succeeded = 0
    for iid in body.item_ids:
        try:
            r = await _apply_stage_change(iid, body.stage, user, body.note)
            results.append({"item_id": iid, "ok": True, **r})
            succeeded += 1
        except HTTPException as e:
            results.append({"item_id": iid, "ok": False, **_bulk_move_error_payload(e)})
    failed = len(results) - succeeded
    return {
        "count": len(results),
        "succeeded": succeeded,
        "failed": failed,
        "results": results,
    }


async def _next_po_number() -> str:
    """Atomic PO numbering — shares the same counter (kind="purchase_order")
    as domain_outbox.py's order-placed path, since both write into the same
    `purchase_orders.number` space. BACKEND_AUDIT_2026-07-17.md High #13: this
    previously sorted-then-parsed-then-incremented — a check-then-act race
    that let two concurrent transfers/creates collide on the same number."""
    year = datetime.now(timezone.utc).year
    return await next_number("purchase_order", f"FPO-{year}-", collection="purchase_orders")


async def _selling_price_for(item: dict, po: dict) -> float:
    """Best-effort customer-facing unit price for an auto-generated order.

    Preference order: (1) the ORIGINAL quotation line this item traces back
    to — the fairest number, since it's literally what the customer already
    agreed to pay for this exact SKU; (2) the product's current catalogue
    price; (3) the PO's unit_cost as an honest last resort (better than 0).
    """
    quotation_id = po.get("quotation_id")
    line_id = item.get("quotation_line_id")
    if quotation_id and line_id:
        q = await db.quotations.find_one({"id": quotation_id}, {"_id": 0, "items": 1})
        if q:
            line = next((l for l in q.get("items", []) if l.get("id") == line_id), None)
            if line and line.get("unit_price") is not None:
                return float(line["unit_price"])
    prod = await db.products.find_one({"id": item.get("product_id")}, {"_id": 0, "price": 1})
    if prod and prod.get("price"):
        return float(prod["price"])
    return float(item.get("unit_cost") or 0)


async def _reconcile_shortage_for_line(
    *, quotation_id: Optional[str], quotation_line_id: Optional[str],
    customer_id: str, customer_name: str, product_id: str, sku: str, name: str,
    image: Optional[str], dest_customer_id: str, dest_customer_name: str,
    transferred_qty: float, user: UserPublic,
) -> Optional[dict]:
    """Recompute the shortage for ONE customer's ONE original commitment after
    a transfer moved units away from them. Purely additive — never blocks the
    transfer, only opens/updates/auto-resolves a `purchase_shortages` record.
    """
    if not quotation_id or not quotation_line_id:
        return None  # this item was never tied to a customer commitment — nothing to protect

    q = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    if not q:
        return None
    line = next((l for l in q.get("items", []) if l.get("id") == quotation_line_id), None)
    if not line:
        return None
    committed_qty = float(line.get("qty") or 0)
    if committed_qty <= 0:
        return None

    # Allocated = everything still sitting under this customer's name across
    # every PO that traces back to this exact quotation line.
    pipeline = [
        {"$match": {"items.quotation_line_id": quotation_line_id}},
        {"$unwind": "$items"},
        {"$match": {"items.quotation_line_id": quotation_line_id, "items.customer_id": customer_id}},
        {"$group": {"_id": None, "total": {"$sum": "$items.qty"}}},
    ]
    rows = await db.purchase_orders.aggregate(pipeline).to_list(1)
    allocated_qty = float(rows[0]["total"]) if rows else 0.0
    shortage_qty = round(committed_qty - allocated_qty, 4)

    existing = await db.purchase_shortages.find_one(
        {"quotation_line_id": quotation_line_id, "customer_id": customer_id, "status": "awaiting_reorder"},
        {"_id": 0},
    )
    now = now_iso()

    if shortage_qty > 1e-6:
        reason = (
            f"{transferred_qty:g} unit(s) of {name} transferred to {dest_customer_name} — "
            f"{shortage_qty:g} of the original {committed_qty:g} still need to be reordered."
        )
        fields = {
            "customer_id": customer_id, "customer_name": customer_name,
            "quotation_id": quotation_id, "quotation_number": q.get("number"),
            "quotation_line_id": quotation_line_id,
            "product_id": product_id, "sku": sku, "name": name, "image": image,
            "committed_qty": committed_qty, "allocated_qty": allocated_qty, "shortage_qty": shortage_qty,
            "status": "awaiting_reorder", "reason": reason,
            "transferred_to_customer_id": dest_customer_id, "transferred_to_customer_name": dest_customer_name,
            "updated_at": now,
            "floor_id": floor_inherit(q),
        }
        if existing:
            await db.purchase_shortages.update_one({"id": existing["id"]}, {"$set": fields})
            shortage_id = existing["id"]
        else:
            doc = PurchaseShortage(**fields)
            await db.purchase_shortages.insert_one(doc.model_dump())
            shortage_id = doc.id
        await log_event(
            event_type="purchase.shortage_flagged",
            entity_type="purchase", entity_id=shortage_id, actor=user,
            customer_id=customer_id, quotation_id=quotation_id,
            summary=f"⚠ Awaiting reorder — {shortage_qty:g} × {name}",
            payload={**fields, "id": shortage_id},
        )
        return {"id": shortage_id, **fields}

    # No shortage (or resolved itself) — close out any previously-open record.
    if existing:
        await db.purchase_shortages.update_one(
            {"id": existing["id"]},
            {"$set": {
                "status": "resolved", "resolved_at": now,
                "resolved_by": user.id, "resolved_by_name": user.full_name,
                "allocated_qty": allocated_qty, "shortage_qty": 0, "updated_at": now,
            }},
        )
    return None

@router.post("/items/{item_id}/transfer")
async def transfer_item_command(
    item_id: str,
    body: TransferBody,
    user: UserPublic = Depends(require_min_role("warehouse")),
):
    """Transactional, idempotent transfer command for existing or new customers."""
    return await execute_transfer(
        item_id=item_id,
        destination_customer_id=body.destination_customer_id,
        new_customer=body.new_customer,
        qty=float(body.qty),
        reason=body.reason,
        idempotency_key=body.idempotency_key,
        user=user,
    )


@router.get("/items/{item_id}/eligible-recipients")
async def eligible_purchase_recipients(item_id: str, user: UserPublic = Depends(get_current_user)):
    source_po = await db.purchase_orders.find_one(floor_query(user, {"items.id": item_id}), {"_id": 0})
    if not source_po:
        raise HTTPException(status_code=404, detail="Source item not found")
    item = next(row for row in source_po.get("items", []) if row.get("id") == item_id)
    source_customer_id = item.get("customer_id") or source_po.get("customer_id")
    matches = await db.purchase_orders.find(floor_query(user, {
        "customer_id": {"$ne": source_customer_id},
        "status": {"$ne": "cancelled"},
        "items": {"$elemMatch": {"product_id": item.get("product_id"),
                                  "cancelled": {"$ne": True},
                                  "stage": {"$nin": ["dispatched", "in_transit", "delivered"]}}},
    }), {"_id": 0, "customer_id": 1, "customer_name": 1}).to_list(500)
    recipients = {po["customer_id"]: {"id": po["customer_id"], "name": po.get("customer_name") or "Customer"}
                  for po in matches if po.get("customer_id")}
    return sorted(recipients.values(), key=lambda row: row["name"].lower())


@router.post("/transfers/{transfer_id}/return")
async def return_purchase_transfer(
    transfer_id: str,
    user: UserPublic = Depends(require_min_role("warehouse")),
):
    await get_floor_scoped_or_404(db.purchase_transfers, transfer_id, user, not_found="Loan transfer not found", projection={"_id": 0, "id": 1})
    return await settle_loan_transfer(transfer_id=transfer_id, user=user)


@router.get("/items/{item_id}/transfer-history")
async def item_transfer_history(item_id: str, user: UserPublic = Depends(get_current_user)):
    po = await db.purchase_orders.find_one(floor_query(user, {"items.id": item_id}), {"_id": 0, "floor_id": 1})
    if not po:
        raise HTTPException(status_code=404, detail="Item not found")
    floor_ids = floor_scope_ids(user)
    if floor_ids is not None and po.get("floor_id") not in floor_ids:
        raise HTTPException(status_code=404, detail="Item not found")
    return {"item_id": item_id, "transfers": await transfer_history(item_id)}




@router.post("/legacy/items/{item_id}/transfer")
async def transfer_item(
    item_id: str,
    body: TransferBody,
    user: UserPublic = Depends(require_min_role("warehouse")),
):
    """Move `qty` units of an item to another customer.

    Steps (atomic per document):
      1. Load source PO and the item.
      2. Validate the requested qty is ≤ current qty.
      3. Reduce qty on source item (deletes the item if it hits 0).
      4. Create a NEW draft PO for the destination customer with a single item
         carrying the transferred qty, at the same stage as the source.
      5. Emit `purchase.transferred_out` on the source and `purchase.transferred_in`
         on the destination — both entries also live in each item's stage_history.
    """
    if body.qty <= 0:
        raise HTTPException(status_code=400, detail="Transfer qty must be > 0")

    po = await db.purchase_orders.find_one(floor_query(user, {"items.id": item_id}), {"_id": 0})
    if not po:
        raise HTTPException(status_code=404, detail="Source item not found")
    it = next((i for i in po.get("items", []) if i.get("id") == item_id), None)
    if not it:
        raise HTTPException(status_code=404, detail="Source item not found")

    cur_qty = float(it.get("qty") or 0)
    if body.qty > cur_qty + 1e-6:
        raise HTTPException(status_code=400, detail=f"Only {cur_qty} available for transfer")

    src_customer_id = it.get("customer_id") or po.get("customer_id")
    if body.new_customer_id == src_customer_id:
        raise HTTPException(status_code=400, detail="Destination customer must differ from source")

    # Floor-scoped, not a bare id lookup: an unscoped lookup let a caller
    # transfer a purchase item to ANY customer id they could guess, including
    # one in the other business unit — a cross-unit write, since this handler
    # goes on to auto-create a quotation/PO for that destination customer.
    # 404 (not 403) on a cross-unit id so the response can't be used to probe
    # whether an id exists in the other unit.
    new_cust = await db.customers.find_one(floor_query(user, {"id": body.new_customer_id}), {"_id": 0})
    if not new_cust:
        raise HTTPException(status_code=404, detail="Destination customer not found")

    now = now_iso()
    stage = it.get("stage") or "order_in_company"

    # Auto-generate the "order" this transfer represents for the destination
    # customer BEFORE building the PO — Payments/Follow-ups only ever look at
    # Quotations with status ordered/won, so this one insert is what makes
    # "Customer B appears in Payments automatically" true with ZERO changes
    # to the Payments module itself.
    unit_price = await _selling_price_for(it, po)
    auto_line = QuotationLineItem(
        product_id=it["product_id"], sku=it["sku"], name=it["name"],
        image=it.get("image"), category_id=it.get("category_id"), room=it.get("room"),
        qty=float(body.qty), unit_price=unit_price,
    )
    auto_quotation_number = await _next_quotation_number()
    auto_quotation = Quotation(
        number=auto_quotation_number,
        customer_id=body.new_customer_id,
        customer_name=new_cust.get("company") or new_cust.get("name"),
        status="ordered",
        # Born ordered, so this is its confirmation moment. Without the stamp
        # the row carries no ordered_at and drops out of every revenue report,
        # which dates by that field and never by updated_at.
        ordered_at=now_iso(),
        items=[auto_line],
        subtotal=round(auto_line.net, 2),
        grand_total=round(auto_line.net, 2),
        notes=(
            f"Auto-created by transfer — {body.qty:g} × {it['name']} from "
            f"{po.get('customer_name')} ({po.get('number')})"
            + (f" — {body.reason}" if body.reason else "")
        ),
        created_by=user.id, created_by_name=user.full_name,
        source="transfer",
        floor_id=floor_inherit(po),
    )

    # Build the destination item — same shape, fresh id, transfer bookkeeping.
    dest_item_id = str(uuid4())
    dest_item = PurchaseOrderItem(
        id=dest_item_id,
        product_id=it["product_id"], sku=it["sku"], name=it["name"],
        image=it.get("image"), category_id=it.get("category_id"), room=it.get("room"),
        qty=float(body.qty), unit_cost=float(it.get("unit_cost") or 0),
        quotation_line_id=auto_line.id,     # now owned by the auto-generated order, not the old one
        stage=stage,
        customer_id=body.new_customer_id,
        customer_name=new_cust.get("company") or new_cust.get("name"),
        brand_id=it.get("brand_id") or po.get("brand_id"),
        brand_name=it.get("brand_name") or po.get("brand_name"),
        last_moved_at=now, last_moved_by=user.id, last_moved_by_name=user.full_name,
        transferred_from_item_id=item_id,
        transferred_from_po_id=po["id"],
        transferred_from_customer_id=src_customer_id,
        stage_history=[
            PurchaseStageEvent(
                from_stage=None, to_stage=stage,
                by_user_id=user.id, by_user_name=user.full_name,
                note=body.reason or f"Transferred from {po.get('customer_name')}",
                action="transfer_in",
                ref_item_id=item_id, ref_po_id=po["id"],
            )
        ],
    )

    # Create destination PO — one-item, draft.
    number = await _next_po_number()
    dest_po = PurchaseOrder(
        number=number,
        quotation_id=auto_quotation.id,
        quotation_number=auto_quotation.number,
        customer_id=body.new_customer_id,
        customer_name=new_cust.get("company") or new_cust.get("name"),
        brand_id=it.get("brand_id") or po.get("brand_id"),
        brand_name=it.get("brand_name") or po.get("brand_name"),
        supplier_id=po.get("supplier_id"),
        supplier_name=po.get("supplier_name"),
        status="draft",
        items=[dest_item],
        internal_notes=(
            f"Transferred from {po.get('number')} · "
            f"{po.get('customer_name')}" + (f" — {body.reason}" if body.reason else "")
        ),
        subtotal=round(dest_item.qty * dest_item.unit_cost, 2),
        grand_total=round(dest_item.qty * dest_item.unit_cost, 2),
        created_by=user.id,
        created_by_name=user.full_name,
        floor_id=floor_inherit(po),
        status_history=[
            PurchaseStatusEvent(
                from_status=None, to_status="draft",
                by_user_id=user.id, by_user_name=user.full_name,
                note=f"Customer transfer from {po.get('number')}",
            ).model_dump()
        ],
    )
    await db.purchase_orders.insert_one(dest_po.model_dump())
    auto_quotation.source_purchase_order_id = dest_po.id
    auto_quotation.source_item_id = dest_item_id
    await db.quotations.insert_one(auto_quotation.model_dump())
    await log_event(
        event_type="quotation.auto_created_from_transfer",
        entity_type="quotation", entity_id=auto_quotation.id, actor=user,
        customer_id=body.new_customer_id, quotation_id=auto_quotation.id,
        summary=(
            f"Order {auto_quotation.number} auto-created — ₹{auto_quotation.grand_total:,.0f} due "
            f"from a {body.qty:g}-unit transfer"
        ),
        payload={
            "quotation_id": auto_quotation.id, "quotation_number": auto_quotation.number,
            "grand_total": auto_quotation.grand_total, "dest_po_id": dest_po.id,
            "dest_po_number": dest_po.number, "src_po_number": po.get("number"),
        },
    )

    # Update source — reduce qty or drop the item if 0.
    remaining = round(cur_qty - float(body.qty), 4)
    src_event = PurchaseStageEvent(
        from_stage=stage, to_stage=stage,
        by_user_id=user.id, by_user_name=user.full_name,
        note=body.reason or f"Transferred {body.qty} → {new_cust.get('name')}",
        action="transfer_out",
        ref_item_id=dest_item_id, ref_po_id=dest_po.id,
    ).model_dump()

    if remaining <= 1e-6:
        # Push an audit event onto the item, then pull it from the array.
        await db.purchase_orders.update_one(
            {"id": po["id"], "items.id": item_id},
            {"$push": {"items.$.stage_history": src_event},
             "$set": {"updated_at": now}},
        )
        await db.purchase_orders.update_one(
            {"id": po["id"]},
            {"$pull": {"items": {"id": item_id}}},
        )
    else:
        await db.purchase_orders.update_one(
            {"id": po["id"], "items.id": item_id},
            {
                "$set": {
                    "items.$.qty": remaining,
                    "items.$.last_moved_at": now,
                    "items.$.last_moved_by": user.id,
                    "items.$.last_moved_by_name": user.full_name,
                    "updated_at": now,
                },
                "$push": {"items.$.stage_history": src_event},
            },
        )

    # Activity events on BOTH ends — customer timelines pick these up.
    await log_event(
        event_type="purchase.transferred_out",
        entity_type="purchase", entity_id=po["id"], actor=user,
        customer_id=src_customer_id,
        summary=(
            f"Transferred {body.qty} × {it.get('name')} to "
            f"{new_cust.get('company') or new_cust.get('name')}"
            + (f" — {body.reason}" if body.reason else "")
        ),
        payload={
            "src_po_id": po["id"], "src_po_number": po.get("number"),
            "dest_po_id": dest_po.id, "dest_po_number": dest_po.number,
            "dest_customer_id": body.new_customer_id,
            "item_id": item_id, "new_item_id": dest_item_id,
            "sku": it.get("sku"), "qty": body.qty, "reason": body.reason,
        },
    )
    await log_event(
        event_type="purchase.transferred_in",
        entity_type="purchase", entity_id=dest_po.id, actor=user,
        customer_id=body.new_customer_id,
        summary=(
            f"Received {body.qty} × {it.get('name')} from "
            f"{po.get('customer_name')}"
            + (f" — {body.reason}" if body.reason else "")
        ),
        payload={
            "src_po_id": po["id"], "src_po_number": po.get("number"),
            "dest_po_id": dest_po.id, "dest_po_number": dest_po.number,
            "src_customer_id": src_customer_id,
            "item_id": item_id, "new_item_id": dest_item_id,
            "sku": it.get("sku"), "qty": body.qty, "reason": body.reason,
        },
    )

    # ---- Shortage tracking for the ORIGINAL customer -------------------------
    # If this item traced back to a real quotation commitment, check whether
    # that commitment is now under-fulfilled and raise/refresh the alert.
    shortage = await _reconcile_shortage_for_line(
        quotation_id=po.get("quotation_id"),
        quotation_line_id=it.get("quotation_line_id"),
        customer_id=src_customer_id, customer_name=po.get("customer_name"),
        product_id=it["product_id"], sku=it["sku"], name=it["name"], image=it.get("image"),
        dest_customer_id=body.new_customer_id,
        dest_customer_name=new_cust.get("company") or new_cust.get("name"),
        transferred_qty=float(body.qty), user=user,
    )

    # Payment/Follow-up automation must reflect this transfer immediately —
    # the new order needs its own reminder timeline, and a shortage (if any)
    # needs to surface as a "recommend reorder" card. Event-triggered, no cron.
    asyncio.create_task(reconcile_followups())

    return {
        "source": {
            "po_id": po["id"], "po_number": po.get("number"),
            "item_id": item_id, "remaining_qty": max(0, remaining),
            "removed": remaining <= 1e-6,
        },
        "destination": {
            "po_id": dest_po.id, "po_number": dest_po.number,
            "item_id": dest_item_id, "qty": float(body.qty),
            "customer_id": body.new_customer_id,
            "customer_name": new_cust.get("company") or new_cust.get("name"),
            "order": {
                "quotation_id": auto_quotation.id, "quotation_number": auto_quotation.number,
                "grand_total": auto_quotation.grand_total, "unit_price": unit_price,
            },
        },
        "shortage": shortage,
    }


# =============================================================================
# Shortages — "Awaiting Reorder" alerts opened by the transfer workflow above.
# =============================================================================
class ShortageDismissBody(BaseModel):
    note: Optional[str] = None


@router.get("/shortages")
async def list_shortages(
    customer_id: Optional[str] = None,
    status_filter: str = Query("awaiting_reorder", alias="status"),
    limit: int = Query(200, ge=1, le=1000),
    user: UserPublic = Depends(get_current_user),
):
    query: dict = {}
    if status_filter and status_filter != "all":
        query["status"] = status_filter
    if customer_id:
        query["customer_id"] = customer_id
    floor_ids = floor_scope_ids(user)
    if floor_ids is not None:
        query["floor_id"] = {"$in": floor_ids}
    docs = await db.purchase_shortages.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return {"count": len(docs), "items": docs}


@router.post("/shortages/{shortage_id}/create-po")
async def create_po_for_shortage(
    shortage_id: str,
    user: UserPublic = Depends(require_min_role("purchase")),
):
    """One click on the "Create Purchase Order" recommendation — opens a new
    draft PO for exactly the missing quantity, for the same customer, at the
    first stage. Never runs automatically; a human always presses this."""
    # Floor-scoped, not a bare id lookup: acting on another business unit's
    # shortage created a purchase order on that unit (the new PO inherits the
    # shortage's floor via floor_inherit below), so an id was enough to write
    # into a floor the caller has no access to.
    s = await db.purchase_shortages.find_one(floor_query(user, {"id": shortage_id}), {"_id": 0})
    if not s:
        raise HTTPException(status_code=404, detail="Shortage not found")
    if s.get("status") != "awaiting_reorder":
        raise HTTPException(status_code=400, detail="Shortage is not open")

    now = now_iso()
    item = PurchaseOrderItem(
        product_id=s["product_id"], sku=s["sku"], name=s["name"], image=s.get("image"),
        qty=float(s["shortage_qty"]), unit_cost=0,
        quotation_line_id=s.get("quotation_line_id"),
        stage="po_final",
        customer_id=s["customer_id"], customer_name=s["customer_name"],
        last_moved_at=now, last_moved_by=user.id, last_moved_by_name=user.full_name,
        stage_history=[
            PurchaseStageEvent(
                from_stage=None, to_stage="po_final",
                by_user_id=user.id, by_user_name=user.full_name,
                note="Reorder for shortage created by a customer transfer", action="create",
            )
        ],
    )
    number = await _next_po_number()
    new_po = PurchaseOrder(
        number=number,
        quotation_id=s.get("quotation_id"), quotation_number=s.get("quotation_number"),
        customer_id=s["customer_id"], customer_name=s["customer_name"],
        status="draft", items=[item],
        internal_notes=f"Reorder — {s.get('reason')}",
        subtotal=0, grand_total=0,
        created_by=user.id, created_by_name=user.full_name,
        floor_id=floor_inherit(s),
        status_history=[
            PurchaseStatusEvent(
                from_status=None, to_status="draft",
                by_user_id=user.id, by_user_name=user.full_name,
                note="Created from a shortage recommendation",
            ).model_dump()
        ],
    )
    await db.purchase_orders.insert_one(new_po.model_dump())
    await db.purchase_shortages.update_one(
        {"id": shortage_id},
        {"$set": {
            "status": "reordered", "resolved_po_id": new_po.id, "resolved_po_number": new_po.number,
            "resolved_at": now, "resolved_by": user.id, "resolved_by_name": user.full_name,
            "updated_at": now,
        }},
    )
    await log_event(
        event_type="purchase.shortage_reordered",
        entity_type="purchase", entity_id=new_po.id, actor=user,
        customer_id=s["customer_id"], quotation_id=s.get("quotation_id"),
        summary=f"Reorder PO {new_po.number} created for {s['shortage_qty']:g} × {s['name']}",
        payload={"shortage_id": shortage_id, "po_id": new_po.id, "po_number": new_po.number},
    )
    asyncio.create_task(reconcile_followups())
    return {"po_id": new_po.id, "po_number": new_po.number, "shortage_id": shortage_id}


@router.post("/shortages/{shortage_id}/dismiss")
async def dismiss_shortage(
    shortage_id: str,
    body: ShortageDismissBody,
    user: UserPublic = Depends(require_min_role("purchase")),
):
    s = await db.purchase_shortages.find_one(floor_query(user, {"id": shortage_id}), {"_id": 0})
    if not s:
        raise HTTPException(status_code=404, detail="Shortage not found")
    now = now_iso()
    await db.purchase_shortages.update_one(
        {"id": shortage_id},
        {"$set": {
            "status": "dismissed", "resolved_at": now,
            "resolved_by": user.id, "resolved_by_name": user.full_name,
            "reason": body.note or s.get("reason"), "updated_at": now,
        }},
    )
    asyncio.create_task(reconcile_followups())
    return {"ok": True}


# =============================================================================
# Chalan / material-release workflow shared by floor-scoped purchase orders.
# Sanitary Bathroom orders remain first-floor; embedded PO chalans are the
# lifecycle source of truth for every floor.
# =============================================================================
class ChalanItemInput(BaseModel):
    po_item_id: str
    qty: float = Field(gt=0)


class GenerateChalanBody(BaseModel):
    items: list[ChalanItemInput] = Field(min_length=1)
    reference_number: Optional[str] = None
    receiver_name: Optional[str] = None
    sender_name: Optional[str] = None
    transport: Optional[str] = None
    remarks: Optional[str] = None
    idempotency_key: Optional[str] = Field(default=None, min_length=1, max_length=200)


def _chalan_order_link(po: dict) -> str:
    """Return the existing order-detail route for the PO's business unit."""
    if floor_inherit(po) == TILES_FLOOR_ID:
        return f"/tiles/orders/{po['id']}"
    return f"/purchase-orders/{po['id']}"


def _generation_request_key(po_id: str, body: GenerateChalanBody, *, lifecycle_version: int) -> str:
    if body.idempotency_key:
        return body.idempotency_key.strip()
    canonical = {
        "po_id": po_id,
        "items": sorted(
            ({"po_item_id": item.po_item_id, "qty": float(item.qty)} for item in body.items),
            key=lambda item: (item["po_item_id"], item["qty"]),
        ),
        "reference_number": body.reference_number or "",
        "receiver_name": body.receiver_name or "",
        "sender_name": body.sender_name or "",
        "transport": body.transport or "",
        "remarks": body.remarks or "",
        # Embedded chalans are append-only for release accounting, so their
        # count is the PO's release-lifecycle version. Concurrent replays read
        # the same version and deduplicate; a later identical-sized release
        # reads the next version and receives a new derived key.
        "lifecycle_version": lifecycle_version,
    }
    digest = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return f"derived:{digest}"


def _chalan_by_request_key(po: dict, request_key: str) -> dict | None:
    return next((chalan for chalan in po.get("chalans", []) if chalan.get("request_key") == request_key), None)


def _first_item_value(item: dict, *keys: str, default: Any = None) -> Any:
    """Resolve a populated PO-item value while preserving numeric zero."""
    return next(
        (item.get(key) for key in keys if item.get(key) is not None and item.get(key) != ""),
        default,
    )


def _chalan_notifications(po: dict, *, title: str, body: str, automation_key: str | None = None) -> list[dict]:
    return [
        {
            "user_id": recipient,
            "title": title,
            "body": body,
            "kind": "success",
            "link": _chalan_order_link(po),
            **({"automation_key": f"{automation_key}:notification:{recipient}"} if automation_key else {}),
        }
        for recipient in sorted({po.get("created_by"), po.get("assigned_to")} - {None})
    ]


async def _dispatch_chalan_outbox(event: dict | None) -> None:
    """Attempt immediate synchronization; the durable worker repairs failure."""
    if not event:
        return
    try:
        await dispatch_event(event["id"])
    except Exception:  # noqa: BLE001 - committed outbox row remains retryable
        logger.exception("Chalan outbox dispatch failed for %s; worker will retry", event.get("id"))


class _ChalanCASConflict(Exception):
    pass


_TransactionResult = TypeVar("_TransactionResult")
_CHALAN_TRANSACTION_ATTEMPTS = 3
_CHALAN_COMMIT_ATTEMPTS = 3
_MONGO_WRITE_CONFLICT_CODE = 112


class _ChalanTransactionRetryExhausted(Exception):
    def __init__(self, cause: Exception, *, outcome_unknown: bool = False):
        super().__init__(str(cause))
        self.cause = cause
        self.outcome_unknown = outcome_unknown


def _has_mongo_error_label(exc: Exception, label: str) -> bool:
    has_error_label = getattr(exc, "has_error_label", None)
    if not callable(has_error_label):
        return False
    try:
        return bool(has_error_label(label))
    except Exception:  # noqa: BLE001 - malformed third-party exception metadata
        return False


def _is_transient_transaction_error(exc: Exception) -> bool:
    if _has_mongo_error_label(exc, "TransientTransactionError"):
        return True
    raw_details = getattr(exc, "details", None)
    details = raw_details if isinstance(raw_details, dict) else {}
    return (
        getattr(exc, "code", None) == _MONGO_WRITE_CONFLICT_CODE
        or details.get("code") == _MONGO_WRITE_CONFLICT_CODE
        or details.get("codeName") == "WriteConflict"
    )


def _is_unknown_commit_result(exc: Exception) -> bool:
    return _has_mongo_error_label(exc, "UnknownTransactionCommitResult")


async def _abort_transaction_quietly(session: Any) -> None:
    try:
        await session.abort_transaction()
    except Exception:  # noqa: BLE001 - transaction may already be aborted by Mongo
        pass


async def _run_chalan_transaction_with_retry(
    operation: Callable[[Any], Awaitable[_TransactionResult]],
) -> _TransactionResult:
    """Run a Chalan transaction with bounded MongoDB-recommended retries.

    Unknown commit results retry the same commit because the transaction may
    already be durable. Transient transaction errors and write conflicts
    restart the complete operation; its CAS writes, completion claim, and
    deterministic outbox key make that replay safe.
    """
    async with await client.start_session() as session:
        last_error: Exception | None = None
        for transaction_attempt in range(_CHALAN_TRANSACTION_ATTEMPTS):
            session.start_transaction()
            try:
                result = await operation(session)
            except Exception as exc:
                await _abort_transaction_quietly(session)
                if not _is_transient_transaction_error(exc):
                    raise
                last_error = exc
                if transaction_attempt + 1 == _CHALAN_TRANSACTION_ATTEMPTS:
                    raise _ChalanTransactionRetryExhausted(exc) from exc
                continue

            commit_outcome_unknown = False
            for commit_attempt in range(_CHALAN_COMMIT_ATTEMPTS):
                try:
                    await session.commit_transaction()
                    return result
                except Exception as exc:
                    last_error = exc
                    if _is_unknown_commit_result(exc):
                        commit_outcome_unknown = True
                        if commit_attempt + 1 < _CHALAN_COMMIT_ATTEMPTS:
                            continue
                        raise _ChalanTransactionRetryExhausted(
                            exc, outcome_unknown=True,
                        ) from exc
                    if commit_outcome_unknown:
                        # Once Mongo says a commit result is unknown, never
                        # replay the callback: the first commit may have
                        # succeeded. Reconcile its durable identities instead.
                        raise _ChalanTransactionRetryExhausted(
                            exc, outcome_unknown=True,
                        ) from exc
                    if _is_transient_transaction_error(exc):
                        await _abort_transaction_quietly(session)
                        break
                    raise

            if transaction_attempt + 1 == _CHALAN_TRANSACTION_ATTEMPTS:
                assert last_error is not None
                raise _ChalanTransactionRetryExhausted(last_error) from last_error

    raise RuntimeError("Chalan transaction retry loop exited unexpectedly")


@router.post("/{po_id}/chalans")
async def generate_chalan(
    po_id: str, body: GenerateChalanBody,
    user: UserPublic = Depends(require_min_role("warehouse")),
):
    """'Release Material' — generates a Chalan covering the given quantities.
    Multiple chalans can cover one order over time (batched release); the
    order only reaches the "material_released" customer-facing stage once
    every item's quantity is covered (see services/chalan_stage.py)."""
    po = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")

    request_key = _generation_request_key(po_id, body, lifecycle_version=len(po.get("chalans") or []))
    event_key = f"purchase-chalan:{po_id}:generate:{request_key}"
    existing = _chalan_by_request_key(po, request_key)
    if existing:
        event = await db.event_outbox.find_one({"idempotency_key": event_key}, {"_id": 0})
        await _dispatch_chalan_outbox(event)
        return {"po_id": po_id, "chalan": existing, "stage": compute_order_stage(po), "idempotent": True}

    items_by_id = {item["id"]: item for item in po.get("items", [])}
    remaining = remaining_qty_by_item(po)
    chalan_items: list[ChalanLineItem] = []
    for entry in body.items:
        source = items_by_id.get(entry.po_item_id)
        if not source:
            raise HTTPException(status_code=400, detail=f"Unknown item {entry.po_item_id}")
        # Decrement the running snapshot as each line is accepted (not just
        # validated against the pre-loop read) so two lines in the SAME
        # request against the same po_item_id can't both pass against the
        # same stale "available" figure and jointly over-release it.
        available = remaining.get(entry.po_item_id, 0.0)
        if entry.qty > available + 1e-6:
            raise HTTPException(
                status_code=400,
                detail=f"Only {available:g} of '{source.get('name')}' remains to release",
            )
        remaining[entry.po_item_id] = available - entry.qty
        chalan_items.append(ChalanLineItem(
            po_item_id=entry.po_item_id,
            name=source.get("name", ""),
            brand_name=_first_item_value(
                source, "brand_name", "brand", default=po.get("brand_name") or po.get("brand"),
            ),
            size=source.get("size"),
            finish=source.get("finish"),
            qty=entry.qty,
            unit=_first_item_value(source, "unit", "quantity_unit", default="Box"),
            rate=_first_item_value(source, "rate", "unit_rate", "unit_cost"),
        ))

    chalan = Chalan(
        number=await next_number("chalan", "CH-", collection="purchase_orders", width=4, array_field="chalans"),
        created_by=user.id, created_by_name=user.full_name,
        items=chalan_items, reference_number=body.reference_number,
        receiver_name=body.receiver_name, sender_name=body.sender_name,
        transport=body.transport, remarks=body.remarks,
    )
    chalan_doc = chalan.model_dump()
    chalan_doc["request_key"] = request_key
    now = now_iso()
    # Optimistic concurrency: the filter requires the chalans array to still
    # have the length we just validated `remaining` against. If another
    # release lands between our read and this write, the length filter no
    # longer matches (matched_count == 0) and we retry against fresh state
    # instead of silently stacking a new chalan on top of a stale snapshot —
    # the same race `_attempt_stage_change` above already guards against for
    # stock moves, applied here to the chalans array. `$exists: False` covers
    # purchase orders that predate the Chalan field entirely (see the
    # order-detail 500 fixed in 765e26b) where the key isn't stored at all.
    chalan_count = len(po.get("chalans", []))
    size_filter = (
        {"$or": [{"chalans": {"$exists": False}}, {"chalans": {"$size": 0}}]}
        if chalan_count == 0
        else {"chalans": {"$size": chalan_count}}
    )
    projected = {**po, "chalans": [*(po.get("chalans") or []), chalan_doc]}
    projected_stage = compute_order_stage(projected)
    event: dict | None = None
    try:
        async with await client.start_session() as session:
            async with session.start_transaction():
                cas_result = await db.purchase_orders.update_one(
                    floor_query(user, {
                        "id": po_id,
                        "items": po.get("items", []),
                        **size_filter,
                    }),
                    {"$push": {"chalans": chalan_doc}, "$set": {"updated_at": now}},
                    session=session,
                )
                if cas_result.matched_count == 0:
                    raise _ChalanCASConflict()
                event = await enqueue_after_primary_commit(
                    event_type=EVENT_PURCHASE_CHALAN_LIFECYCLE,
                    idempotency_key=event_key,
                    payload={
                        "activity_event_type": "purchase.chalan_generated",
                        "po_id": po_id,
                        "customer_id": po.get("customer_id"),
                        "quotation_id": po.get("quotation_id"),
                        "floor_id": floor_inherit(po),
                        "chalan_id": chalan.id,
                        "chalan_number": chalan.number,
                        "request_key": request_key,
                        "stage": projected_stage,
                        "summary": f"Generated Chalan {chalan.number} · {len(chalan_items)} item(s)",
                        "notifications": _chalan_notifications(
                            po,
                            title="Material released by the supplier",
                            body=f"Chalan {chalan.number} generated for {po.get('customer_name')} · {po.get('number')}",
                        ),
                    },
                    actor=user,
                    session=session,
                )
    except _ChalanCASConflict:
        fresh = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
        replay = _chalan_by_request_key(fresh or {}, request_key)
        if replay:
            event = await db.event_outbox.find_one({"idempotency_key": event_key}, {"_id": 0})
            await _dispatch_chalan_outbox(event)
            return {"po_id": po_id, "chalan": replay, "stage": compute_order_stage(fresh), "idempotent": True}
        raise HTTPException(status_code=409, detail={
            "error": "concurrent_modification",
            "message": "Purchase items or released quantities changed concurrently — refresh and try again",
        })
    except HTTPException:
        raise
    except Exception as exc:
        fresh = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
        replay = _chalan_by_request_key(fresh or {}, request_key)
        if replay:
            event = await db.event_outbox.find_one({"idempotency_key": event_key}, {"_id": 0})
            await _dispatch_chalan_outbox(event)
            return {"po_id": po_id, "chalan": replay, "stage": compute_order_stage(fresh), "idempotent": True}
        raise HTTPException(status_code=500, detail=f"Could not journal Chalan generation: {exc}") from exc

    await _dispatch_chalan_outbox(event)
    fresh = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    if not fresh:
        raise HTTPException(status_code=409, detail="Purchase order changed after Chalan generation")
    stage = compute_order_stage(fresh)
    return {"po_id": po_id, "chalan": chalan_doc, "stage": stage, "idempotent": False}


@router.post("/{po_id}/chalans/{chalan_id}/godown-received")
async def mark_chalan_godown_received(
    po_id: str, chalan_id: str,
    user: UserPublic = Depends(require_min_role("warehouse")),
):
    """Records that this batch reached the Buildcon Godown — optional, only
    used on the "via godown" route (Route B). A chalan can also go straight
    from released to dispatched with this step skipped entirely."""
    po = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    chalan = next((c for c in po.get("chalans", []) if c.get("id") == chalan_id), None)
    if not chalan:
        raise HTTPException(status_code=404, detail="Chalan not found")
    if chalan.get("stage") != "released":
        if chalan.get("stage") == "at_godown":
            existing_event = await db.event_outbox.find_one(
                {"idempotency_key": f"purchase-chalan:{po_id}:{chalan_id}:godown-received"},
                {"_id": 0},
            )
            await _dispatch_chalan_outbox(existing_event)
        raise HTTPException(status_code=400, detail=f"Chalan is already {chalan.get('stage')}")

    now = now_iso()
    # Compare-and-swap: the filter re-requires stage == "released" at write
    # time, not just at the read above. Two near-simultaneous calls (double
    # tap, retried request) both pass the read-time check above, but Mongo
    # serializes the two update_one calls — whichever lands first flips the
    # stage away from "released" and the second call's filter no longer
    # matches (matched_count == 0) instead of both silently writing.
    event_key = f"purchase-chalan:{po_id}:{chalan_id}:godown-received"
    event: dict | None = None
    stage: str | None = None
    try:
        async with await client.start_session() as session:
            async with session.start_transaction():
                cas_result = await db.purchase_orders.update_one(
                    floor_query(user, {"id": po_id, "chalans": {"$elemMatch": {"id": chalan_id, "stage": "released"}}}),
                    {"$set": {
                        "chalans.$.stage": "at_godown",
                        "chalans.$.godown_received_at": now,
                        "chalans.$.godown_received_by": user.id,
                        "chalans.$.godown_received_by_name": user.full_name,
                        "updated_at": now,
                    }},
                    session=session,
                )
                if cas_result.matched_count == 0:
                    raise _ChalanCASConflict()
                fresh = await db.purchase_orders.find_one(
                    floor_query(user, {"id": po_id}), {"_id": 0}, session=session,
                )
                if not fresh:
                    raise _ChalanCASConflict()
                stage = compute_order_stage(fresh)
                event = await enqueue_after_primary_commit(
                    event_type=EVENT_PURCHASE_CHALAN_LIFECYCLE,
                    idempotency_key=event_key,
                    payload={
                        "activity_event_type": "purchase.chalan_godown_received",
                        "po_id": po_id,
                        "customer_id": po.get("customer_id"),
                        "quotation_id": po.get("quotation_id"),
                        "floor_id": floor_inherit(po),
                        "chalan_id": chalan_id,
                        "chalan_number": chalan.get("number"),
                        "stage": stage,
                        "summary": f"Chalan {chalan.get('number')} received at Godown",
                        "notifications": [],
                    },
                    actor=user,
                    session=session,
                )
    except _ChalanCASConflict:
        raise HTTPException(status_code=409, detail={
            "error": "concurrent_modification",
            "message": "This chalan's stage changed concurrently — refresh and try again",
        })
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not journal Chalan transition: {exc}") from exc
    await _dispatch_chalan_outbox(event)
    return {"po_id": po_id, "chalan_id": chalan_id, "stage": stage}


class DispatchChalanBody(BaseModel):
    dispatch_note: Optional[str] = None


@router.post("/{po_id}/chalans/{chalan_id}/dispatch")
async def dispatch_chalan(
    po_id: str, chalan_id: str, body: DispatchChalanBody,
    user: UserPublic = Depends(require_min_role("warehouse")),
):
    """Final delivery for this batch — from the supplier directly, or from
    the Godown. When this is the LAST outstanding chalan on the order, the
    order-level stage becomes "completed" and the creator/assignee are
    notified the order has fully shipped."""
    po = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    chalan = next((c for c in po.get("chalans", []) if c.get("id") == chalan_id), None)
    if not chalan:
        raise HTTPException(status_code=404, detail="Chalan not found")
    chalan_stage = chalan.get("stage")
    if chalan_stage == "dispatched":
        existing_event = await db.event_outbox.find_one(
            {"idempotency_key": f"purchase-chalan:{po_id}:{chalan_id}:dispatch"}, {"_id": 0},
        )
        await _dispatch_chalan_outbox(existing_event)
        raise HTTPException(status_code=400, detail="Chalan is already dispatched")
    if chalan_stage not in {"released", "at_godown"}:
        raise HTTPException(status_code=400, detail=f"Chalan cannot be dispatched from {chalan_stage or 'unknown'}")

    now = now_iso()
    # Compare-and-swap on the stage we just read (either "released" or
    # "at_godown" — dispatch can happen from either route), same reasoning as
    # the godown-received guard above: a second near-simultaneous dispatch
    # call can't land once the first has already flipped the stage.
    event_key = f"purchase-chalan:{po_id}:{chalan_id}:dispatch"
    completion_key = f"purchase-chalan:{po_id}:completed"
    event: dict | None = None
    stage: str | None = None

    async def _dispatch_transaction(session: Any) -> tuple[dict, str]:
        cas_result = await db.purchase_orders.update_one(
            floor_query(user, {"id": po_id, "chalans": {"$elemMatch": {"id": chalan_id, "stage": chalan_stage}}}),
            {"$set": {
                "chalans.$.stage": "dispatched",
                "chalans.$.dispatched_at": now,
                "chalans.$.dispatched_by": user.id,
                "chalans.$.dispatched_by_name": user.full_name,
                "chalans.$.dispatch_note": body.dispatch_note,
                "updated_at": now,
            }},
            session=session,
        )
        if cas_result.matched_count == 0:
            raise _ChalanCASConflict()
        fresh = await db.purchase_orders.find_one(
            floor_query(user, {"id": po_id}), {"_id": 0}, session=session,
        )
        if not fresh:
            raise _ChalanCASConflict()
        transaction_stage = compute_order_stage(fresh)
        owns_completion = False
        if transaction_stage == "completed":
            completion_result = await db.purchase_orders.update_one(
                floor_query(user, {
                    "id": po_id,
                    "$or": [
                        {"chalan_completion_event_key": {"$exists": False}},
                        {"chalan_completion_event_key": None},
                    ],
                }),
                {"$set": {
                    "chalan_completion_event_key": completion_key,
                    "chalan_completed_at": now,
                    "updated_at": now,
                }},
                session=session,
            )
            owns_completion = bool(getattr(completion_result, "modified_count", 0))
        notifications = (
            _chalan_notifications(
                po,
                title=(
                    "Your tile order has been dispatched"
                    if floor_inherit(po) == TILES_FLOOR_ID
                    else "Your purchase order has been dispatched"
                ),
                body=f"{po.get('number')} for {po.get('customer_name')} is fully dispatched",
                automation_key=completion_key,
            )
            if owns_completion else []
        )
        transaction_event = await enqueue_after_primary_commit(
            event_type=EVENT_PURCHASE_CHALAN_LIFECYCLE,
            idempotency_key=event_key,
            payload={
                "activity_event_type": "purchase.chalan_dispatched",
                "po_id": po_id,
                "customer_id": po.get("customer_id"),
                "quotation_id": po.get("quotation_id"),
                "floor_id": floor_inherit(po),
                "chalan_id": chalan_id,
                "chalan_number": chalan.get("number"),
                "stage": transaction_stage,
                "summary": f"Chalan {chalan.get('number')} dispatched" + (f" · {body.dispatch_note}" if body.dispatch_note else ""),
                "notifications": notifications,
            },
            actor=user,
            session=session,
        )
        return transaction_event, transaction_stage

    try:
        event, stage = await _run_chalan_transaction_with_retry(_dispatch_transaction)
    except _ChalanCASConflict:
        raise HTTPException(status_code=409, detail={
            "error": "concurrent_modification",
            "message": "This chalan's stage changed concurrently — refresh and try again",
        })
    except _ChalanTransactionRetryExhausted as exc:
        # Every successful transaction commits the embedded transition and
        # outbox row atomically. If all commit acknowledgements were unknown,
        # reconcile by those two durable identities before asking the caller
        # to retry; this avoids reporting a 500 after a successful commit.
        detail = {
            "error": "transaction_outcome_unknown" if exc.outcome_unknown else "transaction_retry_exhausted",
            "message": "Could not confirm Chalan dispatch; retrying this request is safe",
        }
        try:
            fresh = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
            committed_chalan = next(
                (candidate for candidate in (fresh or {}).get("chalans", []) if candidate.get("id") == chalan_id),
                None,
            )
            existing_event = await db.event_outbox.find_one({"idempotency_key": event_key}, {"_id": 0})
        except Exception as reconciliation_error:
            raise HTTPException(status_code=503, detail=detail) from reconciliation_error
        if committed_chalan and committed_chalan.get("stage") == "dispatched" and existing_event:
            event = existing_event
            stage = compute_order_stage(fresh)
        else:
            raise HTTPException(status_code=503, detail=detail) from exc.cause
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not journal Chalan dispatch: {exc}") from exc
    await _dispatch_chalan_outbox(event)
    return {"po_id": po_id, "chalan_id": chalan_id, "stage": stage}


@router.get("/{po_id}/chalans/{chalan_id}/pdf")
async def chalan_pdf(po_id: str, chalan_id: str, user: UserPublic = Depends(get_current_user)):
    po = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    chalan = next((c for c in po.get("chalans", []) if c.get("id") == chalan_id), None)
    if not chalan:
        raise HTTPException(status_code=404, detail="Chalan not found")
    customer = await db.customers.find_one(
        floor_query(user, {"id": po.get("customer_id")}),
        {"_id": 0, "password_hash": 0},
    ) or {}
    from pdf_chalan import build_chalan_pdf, chalan_pdf_filename
    pdf_bytes = await run_in_threadpool(build_chalan_pdf, chalan, po, customer, await _pdf_branding())
    filename = chalan_pdf_filename(chalan, po.get("customer_name") or "")
    return StreamingResponse(
        iter([pdf_bytes]), media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _order_card(po: dict, customer_phone: Optional[str]) -> dict:
    total_value = round(sum(float(i.get("qty") or 0) * float(i.get("unit_cost") or 0) for i in po.get("items", [])), 2)
    return {
        "po_id": po["id"],
        "po_number": po.get("number"),
        "customer_id": po.get("customer_id"),
        "customer_name": po.get("customer_name") or "Unknown customer",
        "customer_phone": customer_phone,
        "supplier_id": po.get("supplier_id"),
        "supplier_name": po.get("supplier_name"),
        "status": po.get("status"),
        "stage": compute_order_stage(po),
        "total_products": len(po.get("items", [])),
        "total_value": total_value,
        "chalan_count": len(po.get("chalans", [])),
        "created_at": po.get("created_at"),
    }


@router.get("/orders/customer-view")
async def customer_view_orders(user: UserPublic = Depends(get_current_user)):
    """Order cards grouped by customer — Ground Floor Tiles Customer-wise
    view. Reads live from purchase_orders; nothing is cached or
    denormalized, so this always reflects the exact same record the
    Company-wise view and order-detail page show."""
    pos = await db.purchase_orders.find(floor_query(user), {"_id": 0}).sort("created_at", -1).to_list(2000)
    customer_ids = list({po.get("customer_id") for po in pos if po.get("customer_id")})
    customers = await db.customers.find(
        {"id": {"$in": customer_ids}}, {"_id": 0, "id": 1, "phone": 1},
    ).to_list(len(customer_ids) or 1)
    phone_by_customer = {c["id"]: c.get("phone") for c in customers}
    return {"orders": [_order_card(po, phone_by_customer.get(po.get("customer_id"))) for po in pos]}


@router.get("/orders/company-view")
async def company_view_orders(user: UserPublic = Depends(get_current_user)):
    """Same orders as customer-view, grouped by supplier instead — Ground
    Floor Tiles Company-wise view. Same underlying documents, no separate
    write path, so an update here is the exact same update the
    Customer-wise view sees."""
    pos = await db.purchase_orders.find(floor_query(user), {"_id": 0}).sort("created_at", -1).to_list(2000)
    grouped: dict[str, dict] = {}
    for po in pos:
        key = po.get("supplier_id") or "unassigned"
        bucket = grouped.setdefault(key, {
            "supplier_id": po.get("supplier_id"),
            "supplier_name": po.get("supplier_name") or "Unassigned",
            "orders": [],
        })
        bucket["orders"].append(_order_card(po, None))
    return {"suppliers": sorted(grouped.values(), key=lambda g: -len(g["orders"]))}


@router.get("/{po_id}/order-detail")
async def order_detail(po_id: str, user: UserPublic = Depends(get_current_user)):
    """Full order (items + every chalan) plus the computed stage and
    per-item remaining-to-release quantity — everything the order detail
    page and the Generate Chalan form need in one call."""
    po = await db.purchase_orders.find_one(floor_query(user, {"id": po_id}), {"_id": 0})
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    customer = await db.customers.find_one(
        {"id": po.get("customer_id"), "floor_id": po.get("floor_id")}, {"_id": 0, "phone": 1},
    ) or {}
    return {
        **po,
        # Orders written before the Chalan field existed have no "chalans"
        # key at all in Mongo (Pydantic's list default never backfills
        # already-stored documents) — default it so every consumer of this
        # endpoint can rely on `chalans` always being an array.
        "chalans": po.get("chalans") or [],
        "customer_phone": customer.get("phone"),
        "stage": compute_order_stage(po),
        "remaining_qty_by_item": remaining_qty_by_item(po),
    }


# =============================================================================
# Excel export (real .xlsx via openpyxl)
# =============================================================================
@router.get("/export.xlsx")
async def export_xlsx(
    view: str = Query("stock", pattern="^(today|stock|customers|dispatch_record)$"),
    brand: Optional[str] = None,
    customer: Optional[str] = None,
    stage: Optional[str] = None,
    q: Optional[str] = None,
    user: UserPublic = Depends(get_current_user),
):
    settings = await _load_settings()
    rows = await _iter_items(
        view, brand, customer, stage, q, settings.sla_days, limit=2000,
        floor_ids=floor_scope_ids(user),
    )

    wb = Workbook()
    ws = wb.active
    ws.title = "Purchases"

    # Header block
    ws["A1"] = "Forge — Purchases Tracker Export"
    ws["A1"].font = Font(bold=True, size=14)
    ws.merge_cells("A1:H1")
    stamp = datetime.now(timezone.utc).strftime("%d %b %Y · %H:%M UTC")
    filter_bits = [f"View: {view}"]
    if brand:
        filter_bits.append(f"Brand: {brand}")
    if customer:
        filter_bits.append(f"Customer: {customer}")
    if stage:
        filter_bits.append(f"Stage: {STAGE_LABELS.get(stage, stage)}")
    if q:
        filter_bits.append(f"Search: {q}")
    ws["A2"] = " · ".join(filter_bits) + f" · Exported {stamp}"
    ws["A2"].font = Font(color="6B7280", size=10)
    ws.merge_cells("A2:H2")

    headers = [
        "PO Number", "SKU", "Product", "Customer", "Brand", "Stage",
        "Qty", "Last Move (UTC)", "Moved By", "Age (days)", "Blocked",
    ]
    header_fill = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")
    for col, h in enumerate(headers, start=1):
        cell = ws.cell(row=4, column=col, value=spreadsheet_cell(h))
        cell.font = Font(bold=True, color="374151", size=11)
        cell.fill = header_fill
        cell.alignment = Alignment(vertical="center")

    for i, r in enumerate(rows, start=5):
        ws.cell(row=i, column=1, value=spreadsheet_cell(r.get("po_number")))
        ws.cell(row=i, column=2, value=spreadsheet_cell(r.get("sku")))
        ws.cell(row=i, column=3, value=spreadsheet_cell(r.get("name")))
        ws.cell(row=i, column=4, value=spreadsheet_cell(r.get("customer_name")))
        ws.cell(row=i, column=5, value=spreadsheet_cell(r.get("brand_name")))
        ws.cell(row=i, column=6, value=spreadsheet_cell(r.get("stage_label")))
        ws.cell(row=i, column=7, value=spreadsheet_cell(r.get("qty")))
        ws.cell(row=i, column=8, value=spreadsheet_cell(r.get("last_moved_at")))
        ws.cell(row=i, column=9, value=spreadsheet_cell(r.get("last_moved_by_name")))
        ws.cell(row=i, column=10, value=spreadsheet_cell(r.get("age_days")))
        ws.cell(row=i, column=11, value=spreadsheet_cell("Yes" if r.get("blocked") else ""))

    # Column widths — heuristic
    widths = [16, 14, 40, 26, 14, 20, 8, 24, 20, 12, 10]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w

    ws.freeze_panes = "A5"

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    filename = f"forge-purchases-{view}-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
