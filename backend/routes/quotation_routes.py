"""Quotation Builder API — v2 with multi-level discounts, autosave, duplicate."""
import asyncio
import logging
from typing import Literal
from datetime import datetime, timezone
from urllib.parse import quote
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pymongo import ReturnDocument
from starlette.concurrency import run_in_threadpool

from auth import (
    TILES_FLOOR_ID, accessible_floor_ids, floor_for_write, floor_inherit, floor_query,
    get_current_customer,
    get_current_user, get_floor_scoped_or_404, require_floor_access, require_min_role,
    tiles_floor_query,
)
from db import db
from models import (
    CustomerPublic,
    Quotation, QuotationCreate, QuotationLineItem, QuotationRevision,
    QuotationUpdate, RoomDiscountCfg, UserPublic, now_iso,
)
from pdf_generator import build_quotation_pdf, quotation_pdf_filename
from pdf_tiles import build_tiles_quotation_pdf, build_tiles_selection_pdf, tiles_pdf_filename
from services.quotation_catalog_prices import price_review, apply_price_choice, line_catalog_snapshot
from services.quotation_ppt import build_product_ppt, presentation_filename
from services import catalog_service
from services.customer_completion import completed_customer_ids
from services.activity_log import log_event
from services.domain_outbox import (
    EVENT_ORDER_PLACED,
    EVENT_QUOTATION_GENERATED,
    dispatch_event,
    enqueue_after_primary_commit,
)
from services.followup_engine import reconcile_followups
from services.pricing import _resolve_line_rows, net_amount_list, normalize_tile_line_item, per_line_net_amounts, stamp_net_amounts
from services.pagination import normalize_pagination
from services.multi_filters import filter_values
from services.pricing import recalc_quotation_totals as _recalc
from services.sequence import next_number
from services.po_final import _line_changes
from services.tiles_stage import can_move_to_quotation, can_place_order

router = APIRouter(prefix="/quotations", tags=["quotations"])
logger = logging.getLogger("forge.quotations")


class QuotationLineMutation(BaseModel):
    """A focused product edit used by the customer/order-management UI.

    The full-quotation PATCH remains supported for the builder's autosave,
    while these commands give customer support an auditable distinction
    between adding, swapping, deleting and cancelling an ordered product.
    """
    item: QuotationLineItem
    reason: str | None = None
    silent: bool = False


class QuotationLineRemoval(BaseModel):
    reason: str | None = None
    silent: bool = False


async def _render_pdf(builder, document: dict, customer: dict, branding: dict) -> bytes:
    """Keep CPU-bound ReportLab/Pillow work off the async request loop."""
    return await run_in_threadpool(builder, document, customer, branding)


async def _next_number() -> str:
    year = datetime.now(timezone.utc).year
    return await next_number("quotation", f"FQ-{year}-", collection="quotations")


TILES_DOC_TYPES = ("tiles_selection", "tiles_quotation")

# A document stops being actionable in the main workspace as soon as it has
# been approved or an order has been placed.  ``won`` is the legacy standard
# quotation spelling for approved, so keep it with the completed records
# while older live documents are gradually normalised.
PENDING_QUOTATION_STATUSES = ("draft", "pending_approval", "sent")
COMPLETED_QUOTATION_STATUSES = ("approved", "ordered", "won")


async def _canonicalize_item_images(items, floor_id: str | None = None) -> list[dict]:
    """Resolve line-item images from current product media with snapshot fallback.

    Quotation rows intentionally retain an image snapshot for audit/history, but
    that snapshot can be the only image left after a catalog product or its
    media is removed. Current media is eligible only for the document's exact
    product SKU and floor; historic foreign-floor references are cleared.
    The warmed catalog supplies ownership and media without a database roundtrip.
    Retired/manual products retain their snapshots as a fallback. The PDF
    image pipeline normalizes old portrait assets before placing them.
    """
    raw_items = [item.model_dump() if isinstance(item, QuotationLineItem) else dict(item) for item in (items or [])]
    product_ids = {str(item.get("product_id")) for item in raw_items if item.get("product_id")}
    if not product_ids:
        return raw_items
    eligible_ids = product_ids
    snapshot = None
    if floor_id:
        # Ownership proof and media come from the existing warmed catalog,
        # avoiding a fresh Atlas lookup for every quotation read/autosave.
        snapshot = await catalog_service.get_catalog_snapshot()
        if getattr(snapshot, "database_backed", False):
            snapshot = await catalog_service.snapshot_for_product_ids(list(product_ids))
        eligible_ids = set()
        for item in raw_items:
            product = snapshot.product_by_id.get(str(item.get("product_id")))
            if product and product.get("floor_id") != floor_id:
                # Malformed historic references must not render even their
                # persisted snapshot of another department's product.
                item.update(image=None, seat_cover_image_urls=[], dimension_image_urls=[])
            elif product and str(product.get("sku") or "").strip() == str(item.get("sku") or "").strip():
                eligible_ids.add(str(item.get("product_id")))
        media_rows = [row for product_id in eligible_ids
                      for row in snapshot.media_rows_by_product.get(product_id, ()) if row.get("public_url")]
    else:
        media_rows = await db.product_media.find(
            {"product_id": {"$in": list(product_ids)}, "public_url": {"$nin": [None, ""]}},
            {"_id": 0, "product_id": 1, "public_url": 1, "is_primary": 1,
             "role": 1, "sort_order": 1, "source_type": 1, "quality": 1},
        ).to_list(max(len(product_ids) * 8, 100))
    priority = {"manufacturer": 0, "supplier": 1, "internal": 2}
    quality_rank = {"excellent": 4, "good": 3, "acceptable": 2, "poor": 1, "missing": 0}
    grouped: dict[str, list[dict]] = {}
    cover_fallback: dict[str, str] = {}
    for row in media_rows:
        if row.get("role") == "seat-cover":
            cover_fallback.setdefault(str(row.get("product_id")), str(row.get("public_url")))
            continue
        if row.get("role") == "dimension":
            continue
        grouped.setdefault(str(row.get("product_id")), []).append(row)
    for rows in grouped.values():
        rows.sort(key=lambda row: (
            0 if row.get("is_primary") else 1,
            0 if row.get("role") == "hero" else 1,
            priority.get(row.get("source_type"), 3),
            int(row.get("sort_order", 100) or 100),
        ))

    def best_current_media(rows: list[dict]) -> dict:
        """Prefer real detail over an outdated low-resolution primary image.

        The explicit primary/hero remains authoritative when it is at least as
        detailed as its alternatives. A better current image from the same
        product is safer for a customer-facing PDF than enlarging a thumbnail.
        """
        preferred = rows[0]
        best = max(
            rows,
            key=lambda row: (
                quality_rank.get(str(row.get("quality") or "missing").lower(), 0),
                1 if row.get("is_primary") else 0,
                1 if row.get("role") == "hero" else 0,
                -priority.get(row.get("source_type"), 3),
                -int(row.get("sort_order", 100) or 100),
            ),
        )
        preferred_quality = quality_rank.get(str(preferred.get("quality") or "missing").lower(), 0)
        best_quality = quality_rank.get(str(best.get("quality") or "missing").lower(), 0)
        return best if best_quality > preferred_quality else preferred

    def resolved_image(item: dict):
        product_id = str(item.get("product_id"))
        if snapshot is not None:
            product = snapshot.product_by_id.get(product_id)
            if not product or product.get("floor_id") != floor_id or str(product.get("sku") or "").strip() != str(item.get("sku") or "").strip():
                # Retired/manual products retain historical photos, but never
                # acquire current media from an unverified or renamed SKU.
                return item.get("image")
            if not grouped.get(product_id):
                # A removed snapshot URL must not mask the exact catalog's
                # surviving legacy or seat-cover photo. Ownership/SKU checks
                # above apply before using the current product preview.
                return catalog_service.product_hero_image(product, snapshot) or item.get("image")
        return (
            best_current_media(grouped[str(item.get("product_id"))]).get("public_url")
            if grouped.get(str(item.get("product_id")))
            else cover_fallback.get(product_id) or item.get("image")
        )

    return [{**item, "image": resolved_image(item)} for item in raw_items]


def _require_tiles_quotation_address(doc_type: str, address: str | None) -> None:
    """Reject tile quotations that cannot print a complete customer header."""
    if doc_type == "tiles_quotation" and not str(address or "").strip():
        raise HTTPException(
            status_code=400,
            detail="An address is required before a tile quotation can be generated.",
        )


def _require_tile_item_images(items: list[dict]) -> None:
    """Require a product image on every tile-document PDF line."""
    missing = [
        str(item.get("sku") or item.get("name") or index + 1)
        for index, item in enumerate(items)
        if not str(item.get("image") or "").strip()
    ]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Every tile product requires an image before generating a PDF. Missing image: {', '.join(missing[:3])}.",
        )


def _normalize_tile_items(items: list[QuotationLineItem], doc_type: str) -> list[QuotationLineItem]:
    """Apply tile-only defaults before totals and downstream reads."""
    if doc_type not in TILES_DOC_TYPES:
        return items
    for item in items:
        normalize_tile_line_item(item)
    return items


def _tile_totals(totals: dict, transportation_fee: float, doc_type: str) -> dict:
    if doc_type not in TILES_DOC_TYPES:
        return totals
    fee = round(float(transportation_fee or 0), 2)
    return {
        **totals,
        "grand_total": round(float(totals.get("grand_total") or 0) + fee, 2),
    }


def _floor_for_tiles_document(user: UserPublic, item_floor_ids: set[str]) -> str:
    """Tile documents belong to Ground Floor, always.

    Deriving their floor from the line items (see
    `_floor_id_for_new_quotation`) is right for standard quotations but
    wrong here: a Tiles builder opened against Sanitary-Bathroom products
    used to save a tiles_quotation stamped `first-floor`, which then
    produced a first-floor TileCustomerOrder and made Sanitary Bathroom
    grow a Tile Orders workflow it must never have. Reject the mixed case
    outright instead of silently restamping the products' own floor.
    """
    require_floor_access(TILES_FLOOR_ID, user)
    foreign = item_floor_ids - {TILES_FLOOR_ID}
    if foreign:
        raise HTTPException(
            status_code=400,
            detail="Tile documents can only contain Ground Floor tile products.",
        )
    return TILES_FLOOR_ID


def _floor_id_for_new_quotation(user: UserPublic, item_floor_ids: set[str]) -> str:
    """The ground truth for a new quotation's floor is the floor its own
    product line items actually belong to, not the caller's ambient
    active-floor request state — that state can lag behind for an
    all-floors (owner/manager) user who reaches a floor-specific screen
    (e.g. the Ground Floor Tiles builders) by direct URL/refresh/bookmark
    instead of the sidebar link that explicitly switches it first. Falls
    back to the previous `floor_for_write(user)` behavior when the items
    don't agree on exactly one floor (no items yet, or a genuinely mixed
    set), and never stamps a floor the caller isn't allowed to write to."""
    if len(item_floor_ids) == 1:
        candidate = next(iter(item_floor_ids))
        allowed = accessible_floor_ids(user)
        if allowed is None or candidate in allowed:
            return candidate
    return floor_for_write(user)


async def _track_product_usage(user_id: str, product_ids: list[str]):
    """Bump usage counters for the picker's Recent/Frequent tabs."""
    now = datetime.now(timezone.utc).isoformat()
    await asyncio.gather(*[
        db.product_usage.update_one(
            {"user_id": user_id, "product_id": pid},
            {"$inc": {"count": 1}, "$set": {"last_used_at": now}},
            upsert=True,
        )
        for pid in set(product_ids)
    ])
    await catalog_service.note_product_usage(user_id, product_ids, now)


def _customer_referrer_fields(customer: dict) -> dict:
    """Freeze customer-owned referral attribution onto a quotation."""
    if not customer.get("referrer_id"):
        return {"referrer_type": None, "referrer_id": None, "referrer_name": None}
    return {
        "referrer_type": customer.get("referrer_type"),
        "referrer_id": customer["referrer_id"],
        "referrer_name": customer.get("referrer_name"),
    }


# Compatibility helper retained for historical unit coverage and legacy data
# repair scripts. New quotation writes must use _customer_referrer_fields.
def _referrer_fields(referrer_type: str | None, referrer_doc: dict | None) -> dict:
    if not referrer_doc:
        return {"referrer_type": None, "referrer_id": None, "referrer_name": None}
    return {"referrer_type": referrer_type, "referrer_id": referrer_doc["id"], "referrer_name": referrer_doc["name"]}


@router.get("")
async def list_quotations(
    doc_type: str | None = None,
    view: str | None = Query(None, pattern="^(pending|completed)$"),
    completion: str | None = Query(None, pattern="^(active|completed)$"),
    status: str | None = None,
    customer_id: str | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1),
    user: UserPublic = Depends(get_current_user),
):
    skip, limit = normalize_pagination(skip, limit)
    query: dict = {}
    if customer_id:
        query["customer_id"] = customer_id
    if doc_type == "standard":
        # `doc_type` was added with the Tiles module; every quotation created
        # before that has no such field at all. `{"doc_type": "standard"}`
        # does not match a missing key, so filtering on it hid every legacy
        # quotation from the Quotations list (6 of 49 visible on the live
        # database). Null matches missing in Mongo, which is what makes this
        # cover both shapes.
        query["doc_type"] = {"$in": ["standard", None]}
    elif doc_type:
        query["doc_type"] = doc_type
    if view == "pending":
        query["status"] = {"$in": list(PENDING_QUOTATION_STATUSES)}
    elif view == "completed":
        query["status"] = {"$in": list(COMPLETED_QUOTATION_STATUSES)}
    selected_statuses = filter_values(status)
    if selected_statuses:
        allowed_statuses = query.get("status", {}).get("$in")
        if allowed_statuses is not None:
            selected_statuses = [value for value in selected_statuses if value in allowed_statuses]
        query["status"] = {"$in": selected_statuses}
    # Asking for a tile document type is a Ground Floor request by
    # definition — never scope those by the caller's ambient floor.
    scoped = tiles_floor_query(user, query) if doc_type in TILES_DOC_TYPES else floor_query(user, query)
    complete_ids = None
    if completion in ("active", "completed"):
        completion_user = user.model_copy(update={"active_floor_id": TILES_FLOOR_ID}) if doc_type in TILES_DOC_TYPES else user
        complete_ids = await completed_customer_ids(db, completion_user)
        scoped = {"$and": [scoped, {"customer_id": {"$in" if completion == "completed" else "$nin": sorted(complete_ids)}}]}
    docs = await db.quotations.find(scoped, {"_id": 0}).sort("created_at", -1).skip(skip).limit(limit).to_list(limit)
    # Resolve each floor's entire page together. List responses must obey the
    # same image ownership contract as detail/export without one lookup per
    # quotation or an additional Atlas call.
    by_floor: dict[str, list[tuple[int, dict]]] = {}
    for index, doc in enumerate(docs):
        by_floor.setdefault(floor_inherit(doc), []).append((index, doc))
    result = list(docs)
    for document_floor, entries in by_floor.items():
        items = await _canonicalize_item_images(
            [item for _, doc in entries for item in doc.get("items") or []], document_floor,
        )
        offset = 0
        for index, doc in entries:
            count = len(doc.get("items") or [])
            result[index] = {**doc, "items": items[offset:offset + count], **({"purchase_completion_status": "completed" if doc.get("customer_id") in complete_ids else "active"} if complete_ids is not None else {})}
            offset += count
    return result


@router.get("/recent")
async def recent_quotations(
    limit: int = 8,
    user: UserPublic = Depends(get_current_user),
):
    """Compact list of recent quotations for the Builder V4 left-rail panel.

    Returns just the fields the mini-list card needs — number, customer,
    project, amount, updated_at, status, revision count. Ordered by
    updated_at DESC so the most-recently-touched quote sits on top.
    """
    # Standard quotations only — this list feeds the Quotation Builder's
    # left rail and the dashboard, neither of which can open a tile
    # document. Tile documents have their own Ground Floor screens.
    docs = await db.quotations.find(
        floor_query(user, {"doc_type": {"$nin": list(TILES_DOC_TYPES)}}),
        {
            "_id": 0, "id": 1, "number": 1, "customer_id": 1, "customer_name": 1,
            "project_name": 1, "phone_snapshot": 1, "grand_total": 1, "status": 1,
            "revisions": 1, "updated_at": 1, "created_at": 1,
        },
    ).sort("updated_at", -1).limit(limit).to_list(limit)
    out = []
    for d in docs:
        out.append({
            "id": d.get("id"),
            "number": d.get("number"),
            "customer_id": d.get("customer_id"),
            "customer_name": d.get("customer_name"),
            "project_name": d.get("project_name"),
            "phone": d.get("phone_snapshot"),
            "grand_total": d.get("grand_total") or 0,
            "status": d.get("status") or "draft",
            "revision_count": len(d.get("revisions") or []),
            "updated_at": d.get("updated_at"),
            "created_at": d.get("created_at"),
        })
    return out


async def _manual_stock_line(item: QuotationLineItem, user: UserPublic, *, floor_id: str | None = None) -> dict | None:
    """Allow a stock-only product only when its actual godown lot backs the line.

    Synthetic ids cannot be used to invent catalog products or cross floors.
    The ordinary stock allocation path still reserves quantity atomically.
    """
    if not item.godown_stock_id or item.product_id != f"godown:{item.godown_stock_id}":
        return None
    query = {"id": item.godown_stock_id, "product_id": item.product_id, "source_type": "manual"}
    if floor_id:
        query["floor_id"] = floor_id
    return await db.godown_stock.find_one(floor_query(user, query), {"_id": 0, "floor_id": 1, "category_id": 1})


@router.post("", response_model=Quotation)
async def create_quotation(
    body: QuotationCreate,
    user: UserPublic = Depends(require_min_role("sales")),
):
    _require_tiles_quotation_address(body.doc_type, body.address_snapshot)
    customer = await get_floor_scoped_or_404(
        db.customers, body.customer_id, user, not_found="Customer not found", projection={"_id": 0},
    )

    # Fill category_id on items so category discounts can resolve later, and
    # collect each item's own product floor_id (see `_floor_id_for_new_quotation`).
    items = body.items or []
    # Client image URLs are only a convenience for the picker. Persist the
    # current canonical media URL so newly-created quotations cannot capture a
    # stale/portrait snapshot.
    item_floor_ids: set[str] = set()
    for it in items:
        p = await db.products.find_one(
            floor_query(user, {"id": it.product_id}),
            {"_id": 0, "category_id": 1, "floor_id": 1, "specs": 1, "price": 1, "mrp": 1, "catalog_version": 1},
        )
        if not p:
            p = await _manual_stock_line(it, user)
        if not p:
            raise HTTPException(status_code=400, detail="One or more quotation products are unavailable on this floor.")
        for key, value in line_catalog_snapshot(p).items():
            setattr(it, key, value)
        if not it.category_id:
            it.category_id = p.get("category_id")
        if p.get("floor_id"):
            item_floor_ids.add(p["floor_id"])

    items = _normalize_tile_items(items, body.doc_type)

    # A standard quotation must never mix catalog floors. This makes the
    # document's business unit a server-enforced invariant rather than a
    # best-effort inference from client-supplied item data.
    if body.doc_type not in TILES_DOC_TYPES and len(item_floor_ids) > 1:
        raise HTTPException(status_code=400, detail="A quotation can only contain products from one floor.")

    quotation_floor_id = (
        _floor_for_tiles_document(user, item_floor_ids)
        if body.doc_type in TILES_DOC_TYPES else _floor_id_for_new_quotation(user, item_floor_ids)
    )
    items = [QuotationLineItem(**item) for item in await _canonicalize_item_images(items, quotation_floor_id)]

    totals = _tile_totals(
        _recalc(items, body.project_discount_pct or 0, body.category_discounts or {}, body.room_discounts or {}),
        body.transportation_fee, body.doc_type,
    )
    # Denormalize each line's post-discount total so analytics can sum one
    # field instead of re-deriving the discount cascade per report.
    # Positional, not id-keyed: line ids are client-supplied and a duplicate
    # would silently collapse two lines onto one value.
    for _it, _net in zip(items, net_amount_list(items, body.project_discount_pct or 0, body.category_discounts or {}, body.room_discounts or {}), strict=True):
        _it.net_amount = _net
    quot = Quotation(
        number=await _next_number(),
        customer_id=customer["id"],
        customer_name=customer.get("company") or customer["name"],
        project_name=body.project_name,
        phone_snapshot=body.phone_snapshot or customer.get("phone"),
        reference_source=body.reference_source,
        **_customer_referrer_fields(customer),
        items=items,
        rooms=body.rooms or [],
        project_discount_pct=body.project_discount_pct or 0,
        category_discounts=body.category_discounts or {},
        room_discounts=body.room_discounts or {},
        notes=body.notes,
        valid_until=body.valid_until,
        doc_type=body.doc_type,
        attended_by=body.attended_by,
        prepared_by=body.prepared_by,
        address_snapshot=body.address_snapshot,
        doc_date=body.doc_date,
        doc_number=body.doc_number,
        transportation_fee=body.transportation_fee if body.doc_type in TILES_DOC_TYPES else 0,
        created_by=user.id,
        created_by_name=user.full_name,
        floor_id=quotation_floor_id,
        **totals,
    )
    # A builder can be opened from a godown-stock card.  Claim the requested
    # lot exactly once, at the same boundary that creates the quotation; the
    # resulting allocation id comes back with later autosaves and therefore
    # cannot be claimed twice.
    for line in quot.items:
        if not line.godown_stock_id or line.godown_allocation_id:
            continue
        allocation_at = now_iso()
        allocation = {
            "id": str(__import__("uuid").uuid4()), "quotation_id": quot.id,
            "quotation_number": quot.number, "customer_id": quot.customer_id,
            "customer_name": quot.customer_name, "qty": line.qty,
            "allocated_at": allocation_at, "allocated_by": user.id,
            "allocated_by_name": user.full_name,
        }
        lot = await db.godown_stock.find_one_and_update(
            floor_query(user, {"id": line.godown_stock_id, "$expr": {"$gte": [
                {"$subtract": [{"$ifNull": ["$available_qty", 0]}, {"$ifNull": ["$loaned_out_qty", 0]}]}, line.qty,
            ]}}),
            {"$inc": {"available_qty": -line.qty}, "$push": {"allocations": allocation}, "$set": {"updated_at": allocation_at}},
            return_document=ReturnDocument.AFTER,
        )
        if not lot:
            raise HTTPException(status_code=409, detail=f"Godown stock for {line.name} is no longer available in the requested quantity.")
        line.godown_allocation_id = allocation["id"]
        line.godown_source_customer_name = lot.get("source_customer_name")
        line.godown_source_purchased_at = lot.get("source_purchased_at")
        line.godown_transferred_at = lot.get("transferred_at")
        line.godown_allocated_at = allocation_at
    await db.quotations.insert_one(quot.model_dump())
    for line in quot.items:
        if line.godown_allocation_id:
            await log_event(
                event_type="godown_stock.allocated", entity_type="quotation", entity_id=quot.id,
                actor=user, floor_id=quot.floor_id, customer_id=quot.customer_id, quotation_id=quot.id,
                summary=f"Added {line.qty:g} × {line.name} from godown stock",
                payload={"stock_id": line.godown_stock_id, "allocation_id": line.godown_allocation_id,
                         "source_customer": line.godown_source_customer_name,
                         "source_purchased_at": line.godown_source_purchased_at,
                         "allocated_at": line.godown_allocated_at},
            )
    # Usage ranking is helpful to the picker, but it is not part of creating
    # the commercial document.  In particular, a slow catalog analytics
    # write must not make the customer-facing quotation request time out.
    if items:
        asyncio.create_task(_track_product_usage(user.id, [it.product_id for it in items]))
    await log_event(
        event_type="quotation.created",
        entity_type="quotation",
        entity_id=quot.id,
        actor=user,
        # From the document, not the request header: a Tiles document reached
        # by direct URL/refresh carries a stale ambient floor, and the floor
        # resolved above is the one the document is actually filed under.
        floor_id=quot.floor_id,
        customer_id=customer["id"],
        quotation_id=quot.id,
        summary=f"{quot.number} · {quot.customer_name} · {len(items)} items",
        payload={"items": len(items), "grand_total": quot.grand_total},
    )
    if quot.doc_type == "tiles_selection":
        from services.walkin_service import on_selection_created
        await on_selection_created(customer["id"], quot.id, quot.number)
    # Every quotation family enters the same idempotent follow-up engine at
    # creation time. Tile Selections additionally update the walk-in lifecycle
    # above, but Sanitary quotations must not wait for a later status change or
    # cron pass before their quotation-stage follow-up becomes visible.
    asyncio.create_task(reconcile_followups())
    return quot


@router.get("/{quotation_id}", response_model=Quotation)
async def get_quotation(quotation_id: str, with_completion: bool = False, user: UserPublic = Depends(get_current_user)):
    doc = await get_floor_scoped_or_404(db.quotations, quotation_id, user, not_found="Quotation not found", projection={"_id": 0})
    doc = {**doc, "items": await _canonicalize_item_images(doc.get("items", []), floor_inherit(doc))}
    if with_completion:
        completion_user = user.model_copy(update={"active_floor_id": doc["floor_id"]})
        complete_ids = await completed_customer_ids(db, completion_user, [doc.get("customer_id")])
        doc["purchase_completion_status"] = "completed" if doc.get("customer_id") in complete_ids else "active"
    return Quotation(**doc)


def _ordered_at_patch(doc: dict, new_status: str) -> dict:
    """Return the ordered_at fragment for a status transition, or {}.

    Write-once by design — an order confirmed in June must keep dating to
    June no matter how many times it is edited afterwards.
    """
    if new_status == "ordered" and not doc.get("ordered_at"):
        return {"ordered_at": now_iso()}
    return {}


async def _complete_pre_confirmation_followups(
    quotation_id: str,
    quotation_number: str | None,
    *,
    session=None,
    floor_id: str | None = None,
) -> int:
    """Close reminders that existed before this quotation became an order.

    The order-confirmed Operations handoff is deliberately excluded: it is
    created *after* this transition and remains actionable until Operations
    starts releasing material.  All other open or snoozed cards linked to the
    quotation (including staff-created reminders) are sales follow-ups whose
    purpose has been fulfilled by the confirmation.
    """
    completed_at = now_iso()
    query = {
        "quotation_id": quotation_id,
        "status": {"$in": ["open", "snoozed"]},
        "rule_type": {"$ne": "order_confirmed_ops"},
        "purchase_id": None,
        "$or": [{"notebook_key": None}, {"notebook_key": ""}],
    }
    if floor_id:
        query["floor_id"] = floor_id
    result = await db.followups.update_many(
        query,
        {"$set": {
            "status": "done",
            "auto_resolved": True,
            "completed_at": completed_at,
            # An order placed from a quotation is a won sale, not merely a
            # converted task. This outcome powers the dedicated Won orders
            # view in Follow-ups and is written only by the order transition.
            "completed_outcome": "won",
            "snoozed_until": None,
            "resolution_note": (
                f"Completed automatically — order {quotation_number or quotation_id} was confirmed."
            ),
            "updated_at": completed_at,
        }},
        session=session,
    )
    return int(result.modified_count)


async def _complete_order_notebook_followups(doc: dict, *, session=None) -> int:
    """Derive notebook Won only from this customer's committed order.

    Unlinked notebook leads belong to the customer on this floor; a linked
    notebook remains tied to its specific quotation. Operational handoffs and
    already closed rows are never changed, including on confirmation retries.
    """
    if not doc.get("customer_id") or not doc.get("floor_id"):
        return 0
    now = now_iso()
    result = await db.followups.update_many(
        {
            "floor_id": doc["floor_id"], "customer_id": doc["customer_id"],
            "notebook_key": {"$type": "string", "$ne": ""},
            "notebook_status": {"$in": ["new", "pending"]},
            "status": {"$in": ["open", "snoozed"]},
            "rule_type": {"$ne": "order_confirmed_ops"},
            "purchase_id": None,
            "$or": [{"quotation_id": doc["id"]}, {"quotation_id": None}, {"quotation_id": ""}],
        },
        {"$set": {
            "notebook_status": "won", "status": "done", "completed_outcome": "won",
            "auto_resolved": True, "completed_at": now, "updated_at": now,
            "snoozed_until": None,
            "quotation_id": doc["id"], "quotation_number": doc.get("number"),
            "resolution_note": f"Completed automatically — order {doc.get('number') or doc['id']} was confirmed.",
        }}, session=session,
    )
    return int(result.modified_count)


def _stamped_items_for_update(
    update: dict,
    doc: dict,
    project_discount_pct: float,
    category_discounts: dict,
    room_discounts: dict,
) -> list[dict]:
    """Re-stamp net_amount on the items about to be persisted.

    Takes the SAME resolved pricing inputs the caller passed to _recalc, so
    grand_total and the per-line net_amounts cannot be computed from
    different values. A discount-only edit carries no items in the body but
    still re-prices every line, so the stored items are re-stamped too.
    """
    items = update.get("items", doc.get("items", []) or [])
    return stamp_net_amounts(
        [dict(raw) for raw in items], project_discount_pct, category_discounts, room_discounts,
    )


@router.patch("/{quotation_id}", response_model=Quotation)
async def update_quotation(
    quotation_id: str,
    body: QuotationUpdate,
    user: UserPublic = Depends(require_min_role("sales")),
):
    doc = await get_floor_scoped_or_404(db.quotations, quotation_id, user, not_found="Quotation not found", projection={"_id": 0})
    _require_tiles_quotation_address(
        doc.get("doc_type", "standard"),
        body.address_snapshot if body.address_snapshot is not None else doc.get("address_snapshot"),
    )

    update: dict = {}
    customer_changed_from: str | None = None
    if body.customer_id is not None:
        # Re-sending the SAME customer_id is a legal snapshot refresh — the
        # tiles builders PATCH the customer record (name/phone corrections)
        # and then re-send the id so customer_name here follows suit.
        new_customer = await get_floor_scoped_or_404(
            db.customers, body.customer_id, user, not_found="Customer not found", projection={"_id": 0},
        )
        if body.customer_id != doc.get("customer_id"):
            customer_changed_from = doc.get("customer_name")
        update["customer_id"] = new_customer["id"]
        update["customer_name"] = new_customer.get("company") or new_customer["name"]
        update.update(_customer_referrer_fields(new_customer))
        # Refresh the frozen phone snapshot to the new customer's phone unless
        # this same request is also explicitly setting one.
        if body.phone_snapshot is None:
            update["phone_snapshot"] = new_customer.get("phone")

    usage_product_ids: list[str] = []
    if body.items is not None:
        items_typed = [
            QuotationLineItem(**i.model_dump()) if not isinstance(i, dict) else QuotationLineItem(**i)
            for i in body.items
        ]
        # Backfill category_id and ensure replacement lines stay in the
        # quotation's established floor. Product ids are client-controlled,
        # so an unscoped lookup here would let a caller splice a foreign-floor
        # catalog item into an otherwise valid quotation.
        # This endpoint receives the complete builder state on autosave. A
        # sequential product lookup made a moderately sized quotation take
        # longer than the request proxy timeout. Resolve the independent
        # catalog rows concurrently, while keeping the validation and item
        # order exactly the same.
        products = await asyncio.gather(*[
            db.products.find_one(
                floor_query(user, {"id": it.product_id, "floor_id": doc.get("floor_id")}),
                {"_id": 0, "category_id": 1, "specs": 1, "price": 1, "mrp": 1, "catalog_version": 1},
            )
            for it in items_typed
        ])
        for it, p in zip(items_typed, products, strict=True):
            if not p:
                p = await _manual_stock_line(it, user, floor_id=doc.get("floor_id"))
            if not p:
                raise HTTPException(status_code=400, detail="One or more quotation products are unavailable on this quotation's floor.")
            if not it.category_id:
                it.category_id = p.get("category_id")
        previous_by_id = {raw["id"]: raw for raw in doc.get("items", [])}
        for it, p in zip(items_typed, products, strict=True):
            old = previous_by_id.get(it.id)
            snapshot = old if old and old.get("product_id") == it.product_id else line_catalog_snapshot(p or {})
            for key in ("catalog_price", "catalog_mrp", "catalog_version"):
                setattr(it, key, snapshot.get(key))
        canonical_items = await _canonicalize_item_images(items_typed, floor_inherit(doc))
        update["items"] = [i.model_dump() for i in _normalize_tile_items(
            [QuotationLineItem(**item) for item in canonical_items], doc.get("doc_type", "standard")
        )]
        usage_product_ids = [it.product_id for it in items_typed if not it.product_id.startswith("godown:")]

    if body.rooms is not None:
        update["rooms"] = body.rooms
    if body.collapsed_rooms is not None:
        update["collapsed_rooms"] = body.collapsed_rooms
    if body.notes is not None:
        update["notes"] = body.notes
    if body.valid_until is not None:
        update["valid_until"] = body.valid_until
    if body.project_discount_pct is not None:
        update["project_discount_pct"] = float(body.project_discount_pct)
    if body.category_discounts is not None:
        update["category_discounts"] = body.category_discounts
    if body.room_discounts is not None:
        update["room_discounts"] = {k: v.model_dump() for k, v in body.room_discounts.items()}
    if body.status is not None:
        requested_status = body.status
        doc_type = doc.get("doc_type", "standard")
        current_status = doc.get("status", "draft")
        if requested_status in {"won", "ordered"} and requested_status != current_status:
            raise HTTPException(status_code=409, detail="Use Place Order to confirm this sale; Won is recorded only after an order is placed")
        if doc_type in {"tiles_selection", "tiles_quotation"}:
            # Older deployments used the generic quotation status names. Map
            # them into the tile workflow before validating the transition so
            # those documents never strand the mobile CTA on Place Order.
            current_status = {"sent": "pending_approval", "won": "approved"}.get(current_status, current_status)
            requested_status = {"sent": "pending_approval", "won": "approved"}.get(requested_status, requested_status)
            allowed = {
                "tiles_selection": {"draft": {"pending_approval"}, "pending_approval": {"approved"}},
                "tiles_quotation": {"draft": {"pending_approval"}, "pending_approval": {"approved"}},
            }[doc_type]
            if requested_status not in allowed.get(current_status, set()):
                raise HTTPException(status_code=409, detail=f"Invalid tile quotation transition: {current_status} → {requested_status}")
        update["status"] = requested_status
        if requested_status == "approved":
            update["approved_by"] = user.id
        update.update(_ordered_at_patch(doc, requested_status))
    if body.project_name is not None:
        update["project_name"] = body.project_name
    if body.phone_snapshot is not None:
        update["phone_snapshot"] = body.phone_snapshot
    if body.reference_source is not None:
        update["reference_source"] = body.reference_source
    # The builder's Architect / Interior Designer picker supplies an id and
    # may include a stale display type. Resolve the directory row here rather
    # than trusting either client field; this is what makes the attribution
    # durable for the Sales Data architect/interior-designer workspaces.
    if "referrer_id" in body.model_fields_set:
        if not body.referrer_id:
            update.update({"referrer_id": None, "referrer_name": None, "referrer_type": None})
        else:
            referrer = await get_floor_scoped_or_404(
                db.referrers, body.referrer_id, user, not_found="Referrer not found", projection={"_id": 0},
            )
            if referrer.get("active") is False:
                raise HTTPException(status_code=400, detail="This referrer is archived")
            update.update({
                "referrer_id": referrer["id"], "referrer_name": referrer["name"],
                "referrer_type": referrer["type"],
            })
    elif "referrer_type" in body.model_fields_set:
        raise HTTPException(status_code=422, detail="Select an architect or interior designer from the directory")
    if body.attended_by is not None:
        update["attended_by"] = body.attended_by
    if body.prepared_by is not None:
        update["prepared_by"] = body.prepared_by
    if body.address_snapshot is not None:
        update["address_snapshot"] = body.address_snapshot
    if body.doc_date is not None:
        update["doc_date"] = body.doc_date
    if body.doc_number is not None:
        update["doc_number"] = body.doc_number
    if body.transportation_fee is not None:
        if doc.get("doc_type") not in TILES_DOC_TYPES:
            raise HTTPException(status_code=400, detail="Transportation Fee is only supported for Ground Floor tile documents")
        update["transportation_fee"] = float(body.transportation_fee)
    if body.ui_state is not None:
        update["ui_state"] = body.ui_state

    # Recalc totals if anything pricing-related changed
    if any(k in update for k in ("items", "project_discount_pct", "category_discounts", "room_discounts", "transportation_fee")):
        items_for_calc = _normalize_tile_items([
            QuotationLineItem(**i) for i in update.get("items", doc.get("items", []))
        ], doc.get("doc_type", "standard"))
        update["items"] = [i.model_dump() for i in items_for_calc]
        project_discount_pct_for_calc = update.get("project_discount_pct", doc.get("project_discount_pct", 0))
        category_discounts_for_calc = update.get("category_discounts", doc.get("category_discounts", {}))
        room_discounts_for_calc = {
            k: RoomDiscountCfg(**v) for k, v in update.get("room_discounts", doc.get("room_discounts", {}) or {}).items()
        }
        totals = _tile_totals(_recalc(
            items_for_calc,
            project_discount_pct_for_calc,
            category_discounts_for_calc,
            room_discounts_for_calc,
        ), update.get("transportation_fee", doc.get("transportation_fee", 0)), doc.get("doc_type", "standard"))
        update.update(totals)
        update["items"] = _stamped_items_for_update(
            update, doc,
            project_discount_pct_for_calc, category_discounts_for_calc, room_discounts_for_calc,
        )

    if not update:
        return Quotation(**doc)

    # Builder autosaves intentionally skip public quotation revisions, but
    # PO Final must still retain material product and amount edits. Record a
    # compact audit delta only when the sale itself changed.
    if body.silent:
        at = datetime.now(timezone.utc).isoformat()
        material = _line_changes(doc, {**doc, **update}, at, str(uuid4()))
        if material:
            update["po_final_changes"] = [*(doc.get("po_final_changes") or []), *material]

    # revision snapshot (unless silent autosave)
    if not body.silent:
        revisions = doc.get("revisions", [])
        rev = QuotationRevision(
            revision_no=len(revisions) + 1,
            created_by=user.id,
            reason=body.reason,
            snapshot={k: doc.get(k) for k in (
                "items", "rooms", "notes", "status", "grand_total", "project_discount_pct",
                "category_discounts", "room_discounts", "customer_id", "customer_name", "transportation_fee",
            )},
        )
        update["revisions"] = revisions + [rev.model_dump()]

    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.quotations.update_one({"id": quotation_id}, {"$set": update})

    fresh = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    # Editing a quotation is intentionally document-local, including after
    # its order has been placed. Purchase orders, payments and follow-ups are
    # immutable operational records created at order confirmation; revising a
    # quote must never rewrite those records or delay this request waiting on
    # their reconciliation.
    if usage_product_ids:
        asyncio.create_task(_track_product_usage(user.id, usage_product_ids))

    # Activity logging (non-silent only — silent = autosave)
    if not body.silent:
        events: list[tuple[str, str, dict]] = []
        prev_items = doc.get("items", [])
        new_items = update.get("items", prev_items)
        if "items" in update:
            prev_ids = {i["product_id"] for i in prev_items}
            new_ids = {i["product_id"] for i in new_items}
            added = new_ids - prev_ids
            removed = prev_ids - new_ids
            for pid in added:
                match = next((i for i in new_items if i["product_id"] == pid), None)
                if match:
                    events.append(("quotation.product_added", f"Added {match.get('name', 'product')}", {"sku": match.get("sku")}))
            for pid in removed:
                match = next((i for i in prev_items if i["product_id"] == pid), None)
                if match:
                    events.append(("quotation.product_removed", f"Removed {match.get('name', 'product')}", {"sku": match.get("sku")}))
            if not added and not removed and prev_items != new_items:
                events.append(("quotation.product_reordered", "Line items updated", {}))
        if "project_discount_pct" in update or "category_discounts" in update:
            events.append(("quotation.discount_changed", "Discount changed", {
                "project": update.get("project_discount_pct", doc.get("project_discount_pct")),
                "categories": update.get("category_discounts", doc.get("category_discounts")),
            }))
        if "rooms" in update:
            prev = doc.get("rooms", [])
            new = update["rooms"]
            added = [r for r in new if r not in prev]
            removed = [r for r in prev if r not in new]
            for r in added:
                events.append(("quotation.room_created", f"Room '{r}' added", {"room": r}))
            for r in removed:
                events.append(("quotation.room_deleted", f"Room '{r}' removed", {"room": r}))
        if "status" in update:
            events.append((
                "quotation.status_changed",
                f"Status changed to {update['status'].replace('_', ' ')}",
                {"from": doc.get("status"), "to": update["status"]},
            ))
        if "notes" in update:
            events.append(("quotation.saved", "Notes updated", {}))
        if customer_changed_from is not None:
            events.append((
                "quotation.customer_changed",
                f"Customer changed from {customer_changed_from} to {update.get('customer_name')}",
                {"from": customer_changed_from, "to": update.get("customer_name"), "to_customer_id": update.get("customer_id")},
            ))
        if "room_discounts" in update and update["room_discounts"] != (doc.get("room_discounts") or {}):
            events.append(("quotation.discount_changed", "Room discount changed", {"room_discounts": update["room_discounts"]}))
        # revision event captured separately below (already appended to revisions)
        events.append(("quotation.revision_created", f"Revision {len(revisions) + 1} saved", {"reason": body.reason}))

        for etype, summary, payload in events:
            await log_event(
                event_type=etype, entity_type="quotation", entity_id=quotation_id,
                actor=user, floor_id=floor_inherit(doc),
                customer_id=doc.get("customer_id"), quotation_id=quotation_id,
                summary=summary, payload=payload,
            )

    if "status" in update:
        # Event-triggered (not cron) reconciliation — a status change is
        # exactly the moment quotation-stage follow-ups should refresh/close.
        asyncio.create_task(reconcile_followups())
    return Quotation(**fresh)


async def _apply_line_items_command(
    quotation_id: str,
    items: list[dict],
    *,
    reason: str | None,
    silent: bool,
    user: UserPublic,
) -> Quotation:
    """Route focused product commands through the canonical PATCH workflow."""
    return await update_quotation(
        quotation_id,
        QuotationUpdate(items=[QuotationLineItem(**item) for item in items], reason=reason, silent=silent),
        user,
    )


@router.post("/{quotation_id}/items", response_model=Quotation)
async def add_quotation_item(
    quotation_id: str,
    body: QuotationLineMutation,
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Add a product to a draft or a still-unfulfilled confirmed order."""
    doc = await get_floor_scoped_or_404(
        db.quotations, quotation_id, user, not_found="Quotation not found", projection={"_id": 0},
    )
    if any(item.get("id") == body.item.id for item in doc.get("items") or []):
        raise HTTPException(status_code=409, detail="This product line already exists on the quotation.")
    updated = await _apply_line_items_command(
        quotation_id, [*doc.get("items", []), body.item.model_dump()],
        reason=body.reason or "Product added", silent=body.silent, user=user,
    )
    await log_event(
        event_type="quotation.product_added", entity_type="quotation", entity_id=quotation_id, actor=user,
        floor_id=floor_inherit(doc), customer_id=doc.get("customer_id"), quotation_id=quotation_id,
        summary=f"Added {body.item.name}", payload={"line_id": body.item.id, "sku": body.item.sku, "source": "product_command"},
    )
    return updated


@router.patch("/{quotation_id}/items/{line_id}", response_model=Quotation)
async def edit_or_swap_quotation_item(
    quotation_id: str,
    line_id: str,
    body: QuotationLineMutation,
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Edit a line or swap it by changing ``item.product_id``.

    Keeping the line id lets the UI retain selection state; the ordered-line
    reconciler preserves the old PO item as cancelled and creates a new PO
    item whenever the product changes.
    """
    doc = await get_floor_scoped_or_404(
        db.quotations, quotation_id, user, not_found="Quotation not found", projection={"_id": 0},
    )
    old = next((item for item in doc.get("items") or [] if item.get("id") == line_id), None)
    if not old:
        raise HTTPException(status_code=404, detail="Quotation product line not found")
    replacement = {**body.item.model_dump(), "id": line_id}
    items = [replacement if item.get("id") == line_id else item for item in doc.get("items") or []]
    action = "swapped" if old.get("product_id") != replacement.get("product_id") else "updated"
    updated = await _apply_line_items_command(
        quotation_id, items, reason=body.reason or f"Product {action}", silent=body.silent, user=user,
    )
    await log_event(
        event_type="quotation.product_swapped" if action == "swapped" else "quotation.product_updated",
        entity_type="quotation", entity_id=quotation_id, actor=user, floor_id=floor_inherit(doc),
        customer_id=doc.get("customer_id"), quotation_id=quotation_id,
        summary=f"{old.get('name')} {action}" if action == "swapped" else f"Updated {replacement.get('name')}",
        payload={"line_id": line_id, "from_product_id": old.get("product_id"), "to_product_id": replacement.get("product_id"), "reason": body.reason},
    )
    return updated


async def _remove_quotation_item(
    quotation_id: str,
    line_id: str,
    body: QuotationLineRemoval,
    user: UserPublic,
    *,
    cancellation: bool,
    document: dict | None = None,
) -> Quotation:
    doc = document or await get_floor_scoped_or_404(
        db.quotations, quotation_id, user, not_found="Quotation not found", projection={"_id": 0},
    )
    removed = next((item for item in doc.get("items") or [] if item.get("id") == line_id), None)
    if not removed:
        raise HTTPException(status_code=404, detail="Quotation product line not found")
    items = [item for item in doc.get("items") or [] if item.get("id") != line_id]
    action = "Product cancelled" if cancellation else "Product deleted"
    updated = await _apply_line_items_command(
        quotation_id, items, reason=body.reason or action, silent=body.silent, user=user,
    )
    await log_event(
        event_type="quotation.product_cancelled" if cancellation else "quotation.product_deleted",
        entity_type="quotation", entity_id=quotation_id, actor=user, floor_id=floor_inherit(doc),
        customer_id=doc.get("customer_id"), quotation_id=quotation_id,
        summary=f"{action}: {removed.get('name')}",
        payload={"line_id": line_id, "product_id": removed.get("product_id"), "sku": removed.get("sku"), "reason": body.reason},
    )
    return updated


@router.post("/{quotation_id}/items/{line_id}/cancel", response_model=Quotation)
async def cancel_quotation_item(
    quotation_id: str,
    line_id: str,
    body: QuotationLineRemoval,
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Cancel a customer product while retaining the linked PO audit line."""
    document = await get_floor_scoped_or_404(
        db.quotations, quotation_id, user, not_found="Quotation not found", projection={"_id": 0},
    )
    return await _remove_quotation_item(quotation_id, line_id, body, user, cancellation=True, document=document)


@router.delete("/{quotation_id}/items/{line_id}", response_model=Quotation)
async def delete_quotation_item(
    quotation_id: str,
    line_id: str,
    body: QuotationLineRemoval,
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Delete a product line; post-order deletes remain auditable in PO history."""
    document = await get_floor_scoped_or_404(
        db.quotations, quotation_id, user, not_found="Quotation not found", projection={"_id": 0},
    )
    return await _remove_quotation_item(quotation_id, line_id, body, user, cancellation=False, document=document)


@router.delete("/{quotation_id}")
async def delete_quotation(
    quotation_id: str,
    user: UserPublic = Depends(require_min_role("manager")),
):
    # Resolve by the document's own floor rather than the ambient floor header.
    # This is important for tile selections/quotations, which always belong to
    # Ground Floor even when a manager is currently viewing another unit.
    existing = await get_floor_scoped_or_404(
        db.quotations, quotation_id, user, not_found="Quotation not found", projection={"_id": 0},
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Quotation not found")
    # BACKEND_AUDIT_2026-07-17.md Medium #20: deleting a quotation that
    # already has purchase orders and/or payments recorded against it
    # orphaned those documents — they still reference a quotation_id that no
    # longer resolves to anything, silently breaking every screen that joins
    # back to the quotation (order detail, payment history, PO lineage).
    # A draft/pending quotation with nothing built on it yet is still safe
    # to delete outright.
    po_count, completed_payment_count = await asyncio.gather(
        db.purchase_orders.count_documents({"quotation_id": quotation_id}),
        db.payments.count_documents({"quotation_id": quotation_id, "status": "completed"}),
    )
    if po_count or completed_payment_count:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot delete — {po_count} purchase order(s) and {completed_payment_count} completed payment(s) "
                "reference this quotation. Cancel/void the order instead of deleting it."
            ),
        )
    customer_id = existing.get("customer_id")
    followups_result, pending_payments_result = await asyncio.gather(
        db.followups.delete_many({"quotation_id": quotation_id}),
        db.payments.delete_many({"quotation_id": quotation_id, "status": {"$ne": "completed"}}),
    )
    # Gender was never part of the current schema, but removing the legacy key
    # here keeps old imported records from retaining data the product no longer
    # collects. The updates are intentionally limited to this customer's data.
    gender_cleanup = 0
    if customer_id:
        cleanup_results = await asyncio.gather(
            db.customers.update_one({"id": customer_id}, {"$unset": {"gender": ""}}),
            db.walkins.update_many({"customer_id": customer_id}, {"$unset": {"gender": ""}}),
            db.followups.update_many({"customer_id": customer_id}, {"$unset": {"gender": ""}}),
            db.quotations.update_many({"customer_id": customer_id}, {"$unset": {"gender": ""}}),
        )
        gender_cleanup = sum(getattr(result, "modified_count", 0) for result in cleanup_results)
    res = await db.quotations.delete_one({"id": quotation_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Quotation not found")
    return {
        "ok": True,
        "quotation_id": quotation_id,
        "doc_type": existing.get("doc_type", "standard"),
        "deleted": {
            "quotations": res.deleted_count,
            "followups": followups_result.deleted_count,
            "pending_payments": pending_payments_result.deleted_count,
            "legacy_gender_fields": gender_cleanup,
        },
    }


@router.post("/{quotation_id}/duplicate", response_model=Quotation)
async def duplicate_quotation(
    quotation_id: str,
    user: UserPublic = Depends(require_min_role("sales")),
):
    src = await db.quotations.find_one(floor_query(user, {"id": quotation_id}), {"_id": 0})
    if not src:
        raise HTTPException(status_code=404, detail="Quotation not found")

    body = QuotationCreate(
        customer_id=src["customer_id"],
        items=[],
        rooms=src.get("rooms", []),
        notes=src.get("notes"),
        valid_until=src.get("valid_until"),
        project_name=src.get("project_name"),
        phone_snapshot=src.get("phone_snapshot"),
        reference_source=src.get("reference_source"),
        project_discount_pct=src.get("project_discount_pct", 0),
        category_discounts=src.get("category_discounts", {}),
        room_discounts=src.get("room_discounts", {}),
        # A duplicate remains the same document family, but starts a fresh
        # lifecycle as QuotationCreate's default draft status. Losing this
        # field used to turn a copied tile selection/quotation into a
        # standard quotation with the wrong PDF and workflow.
        doc_type=src.get("doc_type") or "standard",
        attended_by=src.get("attended_by"),
        prepared_by=src.get("prepared_by"),
        address_snapshot=src.get("address_snapshot"),
        transportation_fee=src.get("transportation_fee", 0),
    )
    # Build fresh line items so ids are regenerated by the default_factory.
    body.items = [
        QuotationLineItem(
            product_id=i["product_id"], sku=i["sku"], name=i["name"], image=i.get("image"),
            category_id=i.get("category_id"), room=i.get("room"),
            qty=i["qty"], unit_price=i["unit_price"],
            offer_rate=i.get("offer_rate"), quantity_unit=i.get("quantity_unit") or "Box",
            size=i.get("size"), rate_sqft=i.get("rate_sqft"), box_sqft=i.get("box_sqft"), pcs_per_box=i.get("pcs_per_box"),
            discount_pct=i.get("discount_pct"),
            notes=i.get("notes"), description=i.get("description"),
            sort_order=i.get("sort_order", 0),
        )
        for i in src.get("items", [])
    ]
    return await create_quotation(body, user)


@router.post("/{quotation_id}/move-to-quotation", response_model=Quotation)
async def move_to_quotation(
    quotation_id: str,
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Promote an approved Tiles Selection into the Quotation stage — see
    docs/superpowers/specs/2026-07-27-quotation-tiles-workflow-design.md.
    Metadata-only: doc_type flips, status resets to draft for a fresh
    pricing pass. `items` (products/area/size/rate_sqft already entered) is
    left completely untouched so everything already filled in at Selection
    carries over automatically — there is nothing to copy, it's the same
    array on the same document."""
    doc = await get_floor_scoped_or_404(
        db.quotations, quotation_id, user, not_found="Quotation not found", projection={"_id": 0},
    )
    require_floor_access(TILES_FLOOR_ID, user)
    if doc.get("floor_id") != TILES_FLOOR_ID:
        raise HTTPException(status_code=400, detail="Tile documents live on Ground Floor only")
    if not can_move_to_quotation(doc.get("doc_type", ""), doc.get("status", "")):
        raise HTTPException(
            status_code=400,
            detail="Only an approved Tiles Selection can be moved to the Quotation stage",
        )
    await db.quotations.update_one(
        {"id": quotation_id},
        {"$set": {"doc_type": "tiles_quotation", "status": "draft", "updated_at": now_iso()}},
    )
    from services.walkin_service import on_moved_to_quotation
    await on_moved_to_quotation(quotation_id, doc.get("number"))
    asyncio.create_task(reconcile_followups())
    fresh = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    return fresh


@router.get("/tiles/product-history")
async def tiles_product_history(
    customer_id: str, product_id: str,
    user: UserPublic = Depends(get_current_user),
):
    """Most recent tiles line item this customer had for this exact
    product, across any Selection/Quotation (any stage) — powers the
    product picker's "used last time" hint."""
    docs = await db.quotations.find(
        tiles_floor_query(user, {
            "customer_id": customer_id,
            "doc_type": {"$in": list(TILES_DOC_TYPES)},
            "items.product_id": product_id,
        }),
        {"_id": 0, "number": 1, "doc_date": 1, "created_at": 1, "items": 1},
    ).sort("created_at", -1).to_list(20)
    for doc in docs:
        for item in doc.get("items", []):
            if item.get("product_id") == product_id:
                return {
                    "found": True,
                    "quotation_number": doc.get("number"),
                    "doc_date": doc.get("doc_date") or doc.get("created_at"),
                    "size": item.get("size"),
                    "rate_sqft": item.get("rate_sqft"),
                    "rate_box": item.get("rate_box") if item.get("rate_box") is not None else item.get("unit_price"),
                    "pcs_per_box": item.get("pcs_per_box"),
                    "box_sqft": item.get("box_sqft"),
                }
    return {"found": False}


# --- Breakdown (for line + totals transparency) ---
def _breakdown_lines(doc: dict) -> list[dict]:
    """Per-line transparency rows: gross, the effective discount and where it
    came from, and the resulting net."""
    items = [QuotationLineItem(**raw) for raw in doc.get("items", [])]
    rows = _resolve_line_rows(
        items,
        doc.get("project_discount_pct", 0),
        doc.get("category_discounts", {}) or {},
        {k: RoomDiscountCfg(**v) for k, v in (doc.get("room_discounts") or {}).items()},
    )

    lines_out = []
    for it, row in zip(items, rows, strict=True):
        gross, disc = row["gross"], row["disc"]
        net = gross - disc
        # A room-amount line's pct is back-derived from an allocated rupee
        # figure, so it is quantized to 4dp before the display round — the
        # behaviour this endpoint has always had.
        row_pct = round(row["pct"], 4) if row["source"] == "room_amount" else row["pct"]
        lines_out.append({
            "line_id": it.id, "product_id": it.product_id, "sku": it.sku, "name": it.name,
            "room": it.room, "qty": it.qty, "unit_price": it.unit_price, "gross": round(gross, 2),
            "discount_pct": round(row_pct, 2), "discount_source": row["source"].replace("room_amount", "room"),
            "discount_amount": round(disc, 2),
            "net": round(net, 2),
            "total": round(net, 2),
        })
    return lines_out


@router.get("/{quotation_id}/breakdown")
async def quotation_breakdown(quotation_id: str, user: UserPublic = Depends(get_current_user)):
    """How the final numbers were calculated — per line + summary."""
    doc = await db.quotations.find_one(floor_query(user, {"id": quotation_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Quotation not found")

    project_pct = doc.get("project_discount_pct", 0)
    cat_discs = doc.get("category_discounts", {}) or {}
    room_discs_raw = doc.get("room_discounts", {}) or {}
    room_discs = {k: RoomDiscountCfg(**v) for k, v in room_discs_raw.items()}

    lines_out = _breakdown_lines(doc)
    totals = _tile_totals(
        _recalc([QuotationLineItem(**i) for i in doc.get("items", [])], project_pct, cat_discs, room_discs),
        doc.get("transportation_fee", 0), doc.get("doc_type", "standard"),
    )
    return {
        "lines": lines_out,
        "totals": totals,
        "project_discount_pct": project_pct,
        "category_discounts": cat_discs,
        "room_discounts": room_discs_raw,
        "transportation_fee": doc.get("transportation_fee", 0),
    }


def _enriched_items_for_pdf(doc: dict) -> list[dict]:
    """Line items with `discount_pct` overridden to the EFFECTIVE resolved
    pct (product/room/category/project), so the PDF's per-line Disc% column
    always matches the grand total — instead of only ever showing product-
    level overrides and leaving inherited discounts blank."""
    raws = doc.get("items", [])
    rows = _resolve_line_rows(
        [QuotationLineItem(**raw) for raw in raws],
        doc.get("project_discount_pct", 0),
        doc.get("category_discounts", {}) or {},
        {k: RoomDiscountCfg(**v) for k, v in (doc.get("room_discounts") or {}).items()},
    )
    return [{**raw, "offer_rate": raw.get("offer_rate") if raw.get("offer_rate") is not None else (raw.get("rate_sqft") if raw.get("rate_sqft") is not None else raw.get("unit_price")), "discount_pct": round(row["pct"], 2)} for raw, row in zip(raws, rows, strict=True)]


async def _pdf_items(doc: dict) -> list[dict]:
    """Return discount-enriched rows with current media URLs."""
    return _enriched_items_for_pdf({**doc, "items": await _canonicalize_item_images(doc.get("items", []), floor_inherit(doc))})


async def _diagram_items(items: list[dict], floor_id: str) -> list[dict]:
    """Attach diagrams from the current product whose SKU still matches the line."""
    ids = {item.get("product_id") for item in items if item.get("product_id")}
    if not ids:
        return items
    products = await db.products.find(
        {"id": {"$in": list(ids)}, "floor_id": floor_id},
        {"_id": 0, "id": 1, "sku": 1, "images": 1, "dimension_image_urls": 1, "seat_cover_image_urls": 1},
    ).to_list(len(ids))
    by_id = {product["id"]: product for product in products}
    result = []
    for item in items:
        product = by_id.get(item.get("product_id"))
        if product and str(product.get("sku") or "").strip() == str(item.get("sku") or "").strip():
            # Older concealed articles can carry images on the product itself
            # without product_media rows. Keep their exact SKU visible in both
            # PDF and PPT; never substitute a family representative's picture.
            fallback_image = next((url for url in product.get("images") or [] if str(url or "").strip()), None)
            result.append({**item,
                "image": item.get("image") or fallback_image,
                "dimension_image_urls": product.get("dimension_image_urls") or [],
                "seat_cover_image_urls": product.get("seat_cover_image_urls") or [],
            })
        else:
            result.append({**item, "dimension_image_urls": [], "seat_cover_image_urls": []})
    return result


# --- PDF branding (Settings > Company + Settings > PDF, merged) -----------
async def _pdf_branding() -> dict:
    """Merge Settings > Company + Settings > PDF into the flat dict
    pdf_generator.build_quotation_pdf expects. Every key falls back to the
    same value that used to be hardcoded in pdf_generator.py, so a quotation
    PDF renders identically until someone actually edits these in Settings."""
    company = await db.settings.find_one({"key": "company"}, {"_id": 0}) or {}
    pdf = await db.settings.find_one({"key": "pdf"}, {"_id": 0}) or {}
    return {
        "footer_company_name": pdf.get("footer_company_name") or company.get("name") or "Buildcon House",
        "footer_phone": pdf.get("footer_phone") or company.get("phone") or "+91 99099 06652",
        "footer_email": pdf.get("footer_email") or company.get("email") or "buildconhouse10@gmail.com",
        "footer_tagline": pdf.get("footer_tagline") or company.get("tagline") or "One Destination. Infinite Possibilities.",
        "terms_text": pdf.get("terms_text"),
        "signature_name": pdf.get("signature_name"),
        "signature_title": pdf.get("signature_title"),
        "show_watermark": pdf.get("show_watermark", True),
        "company_address": company.get("address"),
    }


# --- Official PDF command (staff) ---
@router.get("/{quotation_id}/pptx")
async def quotation_pptx(quotation_id: str, user: UserPublic = Depends(get_current_user)):
    """Download the customer's image-only room and area presentation."""
    doc = await get_floor_scoped_or_404(db.quotations, quotation_id, user, not_found="Quotation not found", projection={"_id": 0})
    if (doc.get("doc_type") or "standard") != "standard":
        raise HTTPException(status_code=400, detail="Product PPT is available for sanitary quotations")
    items = await _diagram_items(await _canonicalize_item_images(doc.get("items", []), floor_inherit(doc)), floor_inherit(doc))
    try:
        ppt = await run_in_threadpool(build_product_ppt, {**doc, "items": items})
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    filename = presentation_filename(doc.get("customer_name") or "Customer")
    return StreamingResponse(
        iter([ppt]),
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


async def _build_quotation_file(doc: dict, customer: dict, include_dimensions: bool = False) -> tuple[bytes, str]:
    """Use the same PDF render contract for downloads and customer snapshots."""
    doc_type = doc.get("doc_type") or "standard"
    _require_tiles_quotation_address(doc_type, doc.get("address_snapshot"))
    branding = await _pdf_branding()
    pdf_items = await _pdf_items(doc)
    if doc_type not in TILES_DOC_TYPES:
        pdf_items = await _diagram_items(pdf_items, doc.get("floor_id"))
    if doc_type in TILES_DOC_TYPES:
        _require_tile_item_images(pdf_items)
    if doc_type == "tiles_selection":
        pdf_bytes = await _render_pdf(build_tiles_selection_pdf, {**doc, "items": pdf_items}, customer, branding)
        filename = tiles_pdf_filename(doc)
    elif doc_type == "tiles_quotation":
        pdf_bytes = await _render_pdf(build_tiles_quotation_pdf, {**doc, "items": pdf_items}, customer, branding)
        filename = tiles_pdf_filename(doc)
    else:
        pdf_doc = {**doc, "items": pdf_items, "include_dimensions": include_dimensions}
        pdf_bytes = await _render_pdf(build_quotation_pdf, pdf_doc, customer, branding)
        filename = quotation_pdf_filename(doc.get("customer_name") or customer.get("name"))
    return pdf_bytes, filename


@router.get("/{quotation_id}/pdf")
async def quotation_pdf(quotation_id: str, include_dimensions: bool = False, user: UserPublic = Depends(get_current_user)):
    """Build the PDF, then journal QuotationGenerated before dispatching automation.

    The PDF is the primary output. Its outbox record is committed first; timeline
    and follow-up handlers only run after that commit succeeds.
    """
    doc = await get_floor_scoped_or_404(db.quotations, quotation_id, user, not_found="Quotation not found", projection={"_id": 0})
    customer = await db.customers.find_one(
        {"id": doc["customer_id"], "floor_id": doc.get("floor_id")}, {"_id": 0, "password_hash": 0},
    ) or {}
    doc_type = doc.get("doc_type") or "standard"
    _require_tiles_quotation_address(doc_type, doc.get("address_snapshot"))
    pdf_bytes, filename = await _build_quotation_file(doc, customer, include_dimensions)
    revision = len(doc.get("revisions") or [])
    key = f"quotation-generated:{quotation_id}:revision:{revision}"
    event = await db.event_outbox.find_one({"idempotency_key": key}, {"_id": 0})
    if not event:
        from db import client
        try:
            async with await client.start_session() as session:
                async with session.start_transaction():
                    event = await enqueue_after_primary_commit(
                        event_type=EVENT_QUOTATION_GENERATED,
                        idempotency_key=key,
                        payload={"quotation_id": quotation_id, "revision": revision},
                        actor=user,
                        session=session,
                    )
        except Exception as exc:
            # A unique-index collision is an idempotent duplicate request.
            event = await db.event_outbox.find_one({"idempotency_key": key}, {"_id": 0})
            if not event:
                raise HTTPException(status_code=500, detail=f"Could not journal quotation generation: {exc}") from exc
    try:
        await dispatch_event(event["id"])
    except Exception:
        # The outbox row is already durable. Its worker will retry follow-up
        # automation; a transient dispatcher failure must not discard the PDF.
        logger.exception("Quotation PDF outbox dispatch deferred: quotation_id=%s", quotation_id)
    return StreamingResponse(
        iter([pdf_bytes]),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --- PDF (customer portal; intentionally read-only) ---
@router.get("/{quotation_id}/portal-pdf")
async def portal_pdf(quotation_id: str, cust: CustomerPublic = Depends(get_current_customer)):
    doc = await db.quotations.find_one({"id": quotation_id, "customer_id": cust.id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Quotation not found")
    pdf_doc = {**doc, "items": await _pdf_items(doc)}
    pdf_bytes = await _render_pdf(build_quotation_pdf, pdf_doc, cust.model_dump(), await _pdf_branding())
    filename = quotation_pdf_filename(doc.get("customer_name") or cust.name)
    return StreamingResponse(iter([pdf_bytes]), media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# --- PDF of a previous revision snapshot (customer portal; read-only) ---
@router.get("/{quotation_id}/portal-pdf/revision/{revision_no}")
async def portal_pdf_revision(
    quotation_id: str, revision_no: int, cust: CustomerPublic = Depends(get_current_customer),
):
    doc = await db.quotations.find_one({"id": quotation_id, "customer_id": cust.id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Quotation not found")
    rev = next((r for r in (doc.get("revisions") or []) if r.get("revision_no") == revision_no), None)
    if not rev:
        raise HTTPException(status_code=404, detail="Revision not found")
    snapshot = rev.get("snapshot") or {}
    # The snapshot only carries items/discounts/totals — NOT a timestamp —
    # so without this override every revision PDF silently showed the
    # CURRENT quotation's created_at (i.e. every revision looked dated the
    # same day the quote was first created, not the day that revision was
    # actually generated).
    merged = {**doc, **snapshot, "created_at": rev.get("created_at") or doc.get("created_at")}
    room_discs = {k: RoomDiscountCfg(**v) for k, v in (merged.get("room_discounts") or {}).items()}
    totals = _recalc(
        [QuotationLineItem(**i) for i in merged.get("items", [])],
        merged.get("project_discount_pct", 0),
        merged.get("category_discounts", {}) or {},
        room_discs,
    )
    pdf_doc = {**merged, **totals, "items": await _pdf_items(merged)}
    pdf_bytes = await _render_pdf(build_quotation_pdf, pdf_doc, cust.model_dump(), await _pdf_branding())
    filename = quotation_pdf_filename(doc.get("customer_name") or cust.name)
    return StreamingResponse(iter([pdf_bytes]), media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# --- Brand-filtered PDF (customer portal; read-only) ---
@router.get("/{quotation_id}/portal-pdf/brand/{brand_id}")
async def portal_pdf_brand(
    quotation_id: str, brand_id: str, cust: CustomerPublic = Depends(get_current_customer),
):
    doc = await db.quotations.find_one({"id": quotation_id, "customer_id": cust.id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Quotation not found")
    items = doc.get("items", [])
    product_ids = list({item["product_id"] for item in items})
    products = await db.products.find(
        {"id": {"$in": product_ids}}, {"_id": 0, "id": 1, "brand_id": 1},
    ).to_list(len(product_ids) + 5)
    brand_by_product = {p["id"]: p.get("brand_id") for p in products}
    is_unassigned = brand_id == "unassigned"
    filtered = [
        it for it in items
        if (
            brand_by_product.get(it["product_id"]) is None
            if is_unassigned
            else brand_by_product.get(it["product_id"]) == brand_id
        )
    ]
    if not filtered:
        raise HTTPException(status_code=404, detail="No items for this brand on this quotation")
    room_discs = {k: RoomDiscountCfg(**v) for k, v in (doc.get("room_discounts") or {}).items()}
    totals = _recalc(
        [QuotationLineItem(**i) for i in filtered],
        doc.get("project_discount_pct", 0),
        doc.get("category_discounts", {}) or {},
        room_discs,
    )
    filtered_doc = {**doc, "items": filtered}
    pdf_doc = {**filtered_doc, **totals, "items": await _pdf_items(filtered_doc)}
    pdf_bytes = await _render_pdf(build_quotation_pdf, pdf_doc, cust.model_dump(), await _pdf_branding())
    filename = quotation_pdf_filename(doc.get("customer_name") or cust.name)
    return StreamingResponse(iter([pdf_bytes]), media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# =============================================================================
# Place Order command — primary quotation state + EventOutbox; no side effects.
# =============================================================================
class PlaceOrderConfirmPayload(BaseModel):
    """Retained API shape; downstream defaults are selected by the OrderPlaced handler."""
    supplier_by_brand: dict[str, str] = {}
    notes_by_brand: dict[str, str] = {}
    expected_delivery_at: str | None = None
    project_name: str | None = None
    catalog_price_choice: Literal["keep", "latest"] | None = None
    catalog_price_token: str | None = None


async def _godown_matches(doc: dict) -> list[dict]:
    """Return reusable sanitary stock for otherwise-to-be-produced lines."""
    # Returned sanitary material is deliberately isolated from Ground Floor
    # tile documents (which have their own logistics godown workflow).
    if doc.get("floor_id") != "first-floor":
        return []
    wanted = [line for line in doc.get("items", []) if not line.get("godown_stock_id")]
    product_ids = list({line.get("product_id") for line in wanted if line.get("product_id")})
    if not product_ids:
        return []
    lots = await db.godown_stock.find(
        {"floor_id": doc.get("floor_id"), "product_id": {"$in": product_ids}, "available_qty": {"$gt": 0}},
        {"_id": 0, "id": 1, "product_id": 1, "available_qty": 1, "loaned_out_qty": 1, "source_customer_name": 1, "transferred_at": 1},
    ).sort("transferred_at", 1).to_list(500)
    available: dict[str, float] = {}
    sources: dict[str, list[dict]] = {}
    for lot in lots:
        product_id = str(lot["product_id"])
        free_qty = max(0.0, float(lot.get("available_qty") or 0) - float(lot.get("loaned_out_qty") or 0))
        available[product_id] = available.get(product_id, 0.0) + free_qty
        sources.setdefault(product_id, []).append(lot)
    return [{
        "line_id": line.get("id"), "product_id": line.get("product_id"), "sku": line.get("sku"), "name": line.get("name"),
        "requested_qty": float(line.get("qty") or 0), "available_qty": available.get(str(line.get("product_id")), 0.0),
        "replaceable_qty": min(float(line.get("qty") or 0), available.get(str(line.get("product_id")), 0.0)),
        "source_customers": list(dict.fromkeys(lot.get("source_customer_name") or "Unknown customer" for lot in sources.get(str(line.get("product_id")), []))),
    } for line in wanted if available.get(str(line.get("product_id")), 0.0) > 0]


async def _brand_grouped_preview(doc: dict) -> dict:
    items = doc.get("items", [])
    if not items:
        return {"quotation_id": doc["id"], "quotation_number": doc.get("number"), "brands": []}
    product_ids = list({item["product_id"] for item in items})
    products = await db.products.find({"id": {"$in": product_ids}}, {"_id": 0, "id": 1, "brand_id": 1}).to_list(len(product_ids) + 5)
    product_map = {product["id"]: product for product in products}
    brand_ids = list({product.get("brand_id") for product in products if product.get("brand_id")})
    brands = await db.brands.find({"id": {"$in": brand_ids}}, {"_id": 0}).to_list(len(brand_ids) + 5)
    brand_map = {brand["id"]: brand for brand in brands}
    # Resolve the SAME effective (post product/room/category/project
    # discount) per-line total that the OrderPlaced automation will use for
    # the real Purchase Order's unit_cost — so this review screen never
    # shows a different number than what actually gets created.
    net_by_line = per_line_net_amounts(doc)
    grouped: dict[str, dict] = {}
    for item in items:
        brand_id = product_map.get(item["product_id"], {}).get("brand_id") or "__unassigned__"
        group = grouped.setdefault(brand_id, {"brand_id": None if brand_id == "__unassigned__" else brand_id, "brand_name": brand_map.get(brand_id, {}).get("name", "Unassigned"), "items": [], "subtotal": 0.0})
        qty = float(item.get("qty") or 0)
        net_total = net_by_line.get(item.get("id"))
        unit_cost = round(net_total / qty, 2) if net_total is not None and qty else float(item.get("unit_price") or 0)
        group["items"].append({**item, "unit_cost": unit_cost})
        group["subtotal"] += qty * unit_cost
    cards = [{**group, "subtotal": round(group["subtotal"], 2), "item_count": len(group["items"])} for group in grouped.values()]
    # Purchase-order cards represent material subtotals, while the customer
    # quotation total also includes transport. The review screen must show
    # the same grand total that will be journaled as the payment/customer-order
    # amount; otherwise Place Order appears to change the price by freight.
    return {"quotation_id": doc["id"], "quotation_number": doc.get("number"), "doc_type": doc.get("doc_type", "standard"), "customer_id": doc.get("customer_id"), "customer_name": doc.get("customer_name"), "brands": sorted(cards, key=lambda card: card["brand_name"]), "total_value": round(float(doc.get("grand_total") or sum(card["subtotal"] for card in cards)), 2), "godown_matches": await _godown_matches(doc)}


@router.post("/{quotation_id}/use-godown-stock")
async def use_godown_stock(quotation_id: str, user: UserPublic = Depends(require_min_role("sales"))):
    """Replace matching open-quotation quantities with reserved godown lots.

    The customer-facing price and room stay unchanged; only fulfilment changes.
    A partial match splits the original line so the unmatched remainder still
    creates a supplier PO, while each reserved part becomes an In Box item.
    """
    doc = await get_floor_scoped_or_404(db.quotations, quotation_id, user, not_found="Quotation not found", projection={"_id": 0})
    if doc.get("floor_id") != "first-floor":
        raise HTTPException(status_code=404, detail="Godown stock replacement is only available for sanitary quotations")
    if doc.get("status") not in {"draft", "sent", "approved"}:
        raise HTTPException(status_code=409, detail="Godown stock can only replace products on an open quotation")
    output: list[dict] = []
    replacements = 0
    for raw in doc.get("items", []):
        remaining = float(raw.get("qty") or 0)
        if raw.get("godown_stock_id") or remaining <= 0:
            output.append(raw); continue
        lots = await db.godown_stock.find({"floor_id": doc.get("floor_id"), "product_id": raw.get("product_id"), "available_qty": {"$gt": 0}}, {"_id": 0}).sort("transferred_at", 1).to_list(100)
        for lot in lots:
            if remaining <= 1e-6: break
            qty = min(remaining, max(0.0, float(lot.get("available_qty") or 0) - float(lot.get("loaned_out_qty") or 0)))
            if qty <= 0:
                continue
            at = now_iso()
            allocation = {"id": str(uuid4()), "quotation_id": doc["id"], "quotation_number": doc.get("number"), "customer_id": doc.get("customer_id"), "customer_name": doc.get("customer_name"), "qty": qty, "allocated_at": at, "allocated_by": user.id, "allocated_by_name": user.full_name}
            claimed = await db.godown_stock.find_one_and_update({"id": lot["id"], "floor_id": doc.get("floor_id"), "$expr": {"$gte": [
                {"$subtract": [{"$ifNull": ["$available_qty", 0]}, {"$ifNull": ["$loaned_out_qty", 0]}]}, qty,
            ]}}, {"$inc": {"available_qty": -qty}, "$push": {"allocations": allocation}, "$set": {"updated_at": at}}, return_document=ReturnDocument.AFTER)
            if not claimed:
                continue
            replacement = {**raw, "id": str(uuid4()), "qty": qty, "godown_stock_id": lot["id"], "godown_allocation_id": allocation["id"], "godown_source_customer_name": lot.get("source_customer_name"), "godown_source_purchased_at": lot.get("source_purchased_at"), "godown_transferred_at": lot.get("transferred_at"), "godown_allocated_at": at}
            output.append(replacement)
            remaining = round(remaining - qty, 4); replacements += 1
        if remaining > 1e-6:
            output.append({**raw, "qty": remaining})
    if not replacements:
        raise HTTPException(status_code=409, detail="Matching godown stock is no longer available")
    # Splitting one quoted line into a godown line plus a supplier remainder
    # changes line ids and quantities. Re-stamp the denormalized analytics
    # values so their sum still equals the quotation total.
    output = stamp_net_amounts(
        output,
        doc.get("project_discount_pct", 0) or 0,
        doc.get("category_discounts", {}) or {},
        doc.get("room_discounts", {}) or {},
    )
    await db.quotations.update_one({"id": quotation_id}, {"$set": {"items": output, "updated_at": now_iso()}})
    await log_event(event_type="godown_stock.replaced_on_quotation", entity_type="quotation", entity_id=quotation_id, actor=user, floor_id=doc.get("floor_id"), customer_id=doc.get("customer_id"), quotation_id=quotation_id, summary=f"Reserved {replacements} godown stock lot(s) for {doc.get('customer_name')}", payload={"replacements": replacements})
    return {"replacements": replacements, "godown_matches": await _godown_matches({**doc, "items": output})}


@router.get("/{quotation_id}/place-order/preview")
async def place_order_preview(quotation_id: str, user: UserPublic = Depends(require_min_role("sales"))):
    doc = await get_floor_scoped_or_404(db.quotations, quotation_id, user, not_found="Quotation not found", projection={"_id": 0})
    if not can_place_order(doc.get("doc_type", "standard"), doc.get("status", "draft")):
        raise HTTPException(status_code=400, detail="Confirm the quotation before placing the order")
    if not doc.get("items"):
        raise HTTPException(status_code=400, detail="Cannot place order — quotation has no items")
    return {**await _brand_grouped_preview(doc), "price_review": await price_review(doc, db.products)}


@router.post("/{quotation_id}/place-order/confirm")
async def place_order_confirm(quotation_id: str, body: PlaceOrderConfirmPayload, user: UserPublic = Depends(require_min_role("sales"))):
    """Commit OrderPlaced once, then dispatch idempotent secondary automation."""
    # Authorize retries as well: an existing outbox row must not bypass floor access.
    await get_floor_scoped_or_404(db.quotations, quotation_id, user, not_found="Quotation not found", projection={"_id": 0, "id": 1, "floor_id": 1})
    key = f"order-placed:{quotation_id}"
    event = await db.event_outbox.find_one({"idempotency_key": key}, {"_id": 0})
    if not event:
        from db import client
        try:
            async with await client.start_session() as session:
                async with session.start_transaction():
                    doc = await get_floor_scoped_or_404(
                        db.quotations, quotation_id, user, not_found="Quotation not found",
                        projection={"_id": 0}, session=session,
                    )
                    if not can_place_order(doc.get("doc_type", "standard"), doc.get("status", "draft")):
                        raise HTTPException(status_code=400, detail="Confirm the quotation before placing the order")
                    if not doc.get("items"):
                        raise HTTPException(status_code=400, detail="Cannot place order — quotation has no items")
                    review = await price_review(doc, db.products, session=session)
                    items = apply_price_choice(doc, review, body.catalog_price_choice, body.catalog_price_token)
                    price_patch = {}
                    if review["changes"]:
                        if body.catalog_price_choice == "latest":
                            typed_items = _normalize_tile_items([QuotationLineItem(**raw) for raw in items], doc.get("doc_type", "standard"))
                            room_discounts = {key: RoomDiscountCfg(**value) for key, value in (doc.get("room_discounts") or {}).items()}
                            price_patch = _tile_totals(_recalc(typed_items, doc.get("project_discount_pct") or 0, doc.get("category_discounts") or {}, room_discounts), doc.get("transportation_fee") or 0, doc.get("doc_type", "standard"))
                            price_patch["items"] = stamp_net_amounts([item.model_dump() for item in typed_items], doc.get("project_discount_pct") or 0, doc.get("category_discounts") or {}, doc.get("room_discounts") or {})
                        price_patch["catalog_price_decision"] = {"choice": body.catalog_price_choice, "at": now_iso(), "by": user.id, "changes": review["changes"]}
                    await db.quotations.update_one(
                        {"id": quotation_id, "floor_id": doc.get("floor_id")},
                        {"$set": {**price_patch, "status": "ordered", "updated_at": now_iso(), **_ordered_at_patch(doc, "ordered")}},
                        session=session,
                    )
                    await _complete_order_notebook_followups(doc, session=session)
                    await _complete_pre_confirmation_followups(
                        quotation_id, doc.get("number"), session=session, floor_id=doc.get("floor_id"),
                    )
                    event = await enqueue_after_primary_commit(
                        event_type=EVENT_ORDER_PLACED,
                        idempotency_key=key,
                        payload={"quotation_id": quotation_id, "project_name": body.project_name, "expected_delivery_at": body.expected_delivery_at},
                        actor=user,
                        session=session,
                    )
        except HTTPException:
            raise
        except Exception as exc:
            event = await db.event_outbox.find_one({"idempotency_key": key}, {"_id": 0})
            if not event:
                raise HTTPException(status_code=500, detail=f"Could not journal order placement: {exc}") from exc
    try:
        result = await dispatch_event(event["id"])
    except Exception as exc:
        # The order itself is already journaled (event_outbox row committed
        # above) — a handler failure here is a retryable automation error,
        # not a failed order. Without this, an unhandled exception (e.g. the
        # DuplicateKeyError this exact endpoint hit in production) propagates
        # past FastAPI's normal error handling and can surface to the browser
        # as a raw connection failure instead of a JSON body the frontend's
        # `toast.error(e?.detail || ...)` can read — i.e. no visible message
        # at all, not even the "Could not place order" fallback.
        raise HTTPException(status_code=500, detail=f"Order was placed but automation failed: {exc}") from exc
    asyncio.create_task(reconcile_followups())
    return {"quotation_id": quotation_id, "idempotent": event.get("status") == "completed", **result}


@router.get("/{quotation_id}/workflow-status")
async def workflow_status(
    quotation_id: str,
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Read-only audit projection for the transactional quotation workflow."""
    quotation = await db.quotations.find_one(floor_query(user, {"id": quotation_id}), {"_id": 0})
    if not quotation:
        raise HTTPException(status_code=404, detail="Quotation not found")
    floor_id = quotation.get("floor_id")
    events = await db.event_outbox.find({"payload.quotation_id": quotation_id, "floor_id": floor_id}, {"_id": 0}).sort("created_at", 1).to_list(50)
    purchase_orders = await db.purchase_orders.find({"quotation_id": quotation_id, "floor_id": floor_id}, {"_id": 0}).sort("created_at", 1).to_list(100)
    payments = await db.payments.find({"quotation_id": quotation_id, "floor_id": floor_id}, {"_id": 0}).sort("created_at", 1).to_list(100)
    timeline = await db.activity_events.find({"quotation_id": quotation_id, "floor_id": floor_id, "automation_key": {"$exists": True}}, {"_id": 0}).sort("created_at", 1).to_list(100)
    followups = await db.followups.find({"quotation_id": quotation_id, "floor_id": floor_id, "automation_key": {"$exists": True}}, {"_id": 0}).sort("created_at", 1).to_list(100)
    return {"quotation_id": quotation_id, "quotation_total": round(float(quotation.get("grand_total") or 0), 2), "events": events, "purchase_orders": purchase_orders, "payments": payments, "timeline": timeline, "followups": followups}


# Customer sharing deliberately uses an opaque, expiring capability rather
# than a staff JWT or the authenticated download token (which is single-use).
@router.post("/{quotation_id}/whatsapp-draft")
async def quotation_whatsapp_draft(quotation_id: str, include_dimensions: bool = False,
                                   user: UserPublic = Depends(get_current_user)):
    from services.quotation_shares import create_share, whatsapp_phone
    doc = await get_floor_scoped_or_404(db.quotations, quotation_id, user,
                                      not_found="Quotation not found", projection={"_id": 0})
    customer = await db.customers.find_one(
        {"id": doc["customer_id"], "floor_id": doc.get("floor_id")}, {"_id": 0, "password_hash": 0},
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    phone = whatsapp_phone(customer.get("phone"))
    if not phone:
        raise HTTPException(status_code=422, detail="Add a valid WhatsApp phone number to the customer's contact details first")
    pdf_bytes, filename = await _build_quotation_file(doc, customer, include_dimensions)
    shared = await create_share(doc, pdf_bytes, filename, user.id)
    # Creating/opening a draft cannot prove delivery and never marks it sent.
    return {**shared, "phone": phone, "customer_name": customer.get("name") or doc.get("customer_name") or "Customer"}


@router.api_route("/shared-pdf/{token}", methods=["GET", "HEAD"])
async def shared_quotation_pdf(token: str):
    from services.quotation_shares import read_share
    pdf_bytes, filename = await read_share(token)
    return StreamingResponse(iter([pdf_bytes]), media_type="application/pdf", headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    })


@router.delete("/{quotation_id}/whatsapp-draft")
async def revoke_quotation_whatsapp_drafts(quotation_id: str, user: UserPublic = Depends(get_current_user)):
    from services.quotation_shares import revoke_shares
    doc = await get_floor_scoped_or_404(db.quotations, quotation_id, user, not_found="Quotation not found")
    await revoke_shares(doc["id"], doc.get("floor_id"))
    return {"revoked": True}
