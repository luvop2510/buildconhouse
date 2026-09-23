"""Sanitary godown stock — returned/declined material that can be reused.

Lots are intentionally separate from tile logistics.  Each lot preserves its
customer and original-purchase provenance and is consumed with a conditional
quantity update, so two staff members cannot allocate the same unit.
"""
import asyncio
import logging
import re
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth import floor_for_write, floor_query, get_current_user, get_floor_scoped_or_404, require_min_role
from db import client, db
from pymongo import ReturnDocument
from models import Payment, UserPublic, now_iso
from services.activity_log import log_event
from services.analytics import cache
from services.followup_engine import reconcile_followups
from services.notifications import notify

router = APIRouter(prefix="/godown-stock", tags=["godown-stock"])
logger = logging.getLogger(__name__)


async def ensure_godown_stock_indexes() -> None:
    """Indexes match the page's floor/status, product and brand access paths."""
    await db.godown_stock.create_index([("floor_id", 1), ("available_qty", 1), ("brand_id", 1), ("transferred_at", -1)])
    await db.godown_stock.create_index([("floor_id", 1), ("product_id", 1), ("available_qty", 1)])
    await db.godown_stock.create_index("id", unique=True)


class Intake(BaseModel):
    purchase_order_id: str
    purchase_item_id: str
    qty: float = Field(gt=0)
    reason: str = Field(min_length=2, max_length=280)


class Allocation(BaseModel):
    quotation_id: str
    qty: float = Field(gt=0)


class DirectIntake(BaseModel):
    product_id: str | None = None
    qty: float = Field(gt=0)
    reason: str = Field(default="Added to godown stock", min_length=2, max_length=280)
    sku: str | None = None
    name: str | None = None
    brand: str | None = None
    image: str | None = None
    size: str | None = None
    feature: str | None = None
    category: str | None = None


def _stock_view(lot: dict) -> dict:
    return {key: value for key, value in lot.items() if key != "_id"}


def _transaction_unsupported(exc: Exception) -> bool:
    """Whether a local standalone Mongo instance rejected transactions."""
    message = str(exc)
    return (
        "Transaction numbers" in message
        or "replica set" in message
        or "IllegalOperation" in message
    )


def _collection_total(quotation: dict) -> float:
    """Keep godown credits aligned with Payments' order-total semantics."""
    history = quotation.get("payment_extra_history")
    extras = (
        sum(float(entry.get("amount") or 0) for entry in history)
        if isinstance(history, list)
        else float(quotation.get("payment_extra_amount") or 0)
    )
    return round(float(quotation.get("grand_total") or 0) + extras, 2)


async def _persist_intake(
    *, po: dict, item: dict, qty: float, reason: str, user: UserPublic,
    lot: dict, at: str, session=None,
) -> tuple[dict, dict | None]:
    """Atomically reserve a source line, create the lot, and credit its order.

    A sanitary purchase item's ``unit_cost`` is the effective sold unit price
    copied from its quotation at order placement.  Moving a quantity into
    reusable stock therefore reduces the source customer's remaining balance
    by that exact effective value.  The resulting typed payment row is an
    auditable credit, not a cash collection.
    """
    received_qty = float(item.get("qty_received") or item.get("qty") or 0)
    source_updated = False
    lot_inserted = False
    payment: dict | None = None
    try:
        # Many existing purchase rows predate godown_transferred_qty. Mongo's
        # $lte does not match an absent field, which made valid legacy rows
        # fail with the misleading concurrent-change error.
        moved = await db.purchase_orders.update_one(
            {
                "id": po["id"], "floor_id": po["floor_id"],
                "items": {"$elemMatch": {
                    "id": item["id"],
                    "$or": [
                        {"godown_transferred_qty": {"$lte": received_qty - qty}},
                        {"godown_transferred_qty": {"$exists": False}},
                    ],
                }},
            },
            {"$inc": {"items.$.godown_transferred_qty": qty}, "$set": {"updated_at": at}, "$push": {
                "items.$.godown_transfer_history": {
                    "stock_id": lot["id"], "qty": qty, "reason": reason,
                    "transferred_at": at, "transferred_by": user.id,
                    "transferred_by_name": user.full_name,
                },
            }},
            session=session,
        )
        if not moved.modified_count:
            raise HTTPException(status_code=409, detail="This purchase item was changed while transferring it. Refresh and try again.")
        source_updated = True

        # Re-read and calculate inside the transaction so a simultaneous cash
        # collection cannot make this ledger credit over-settle the order.
        quotation_id = po.get("quotation_id")
        if quotation_id:
            quotation = await db.quotations.find_one(
                {"id": quotation_id, "floor_id": po["floor_id"]}, {"_id": 0}, session=session,
            )
            if quotation and quotation.get("status") in {"ordered", "won"}:
                paid_rows = await db.payments.aggregate([
                    {"$match": {
                        "quotation_id": quotation_id, "floor_id": po["floor_id"], "status": "completed",
                    }},
                    {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
                ], session=session).to_list(1)
                already_settled = float(paid_rows[0].get("total") or 0) if paid_rows else 0.0
                transferred_value = round(qty * float(item.get("unit_cost") or 0), 2)
                credit_amount = round(min(transferred_value, max(0.0, _collection_total(quotation) - already_settled)), 2)
                lot["transferred_value"] = transferred_value
                lot["payment_credit_amount"] = credit_amount
                if credit_amount > 0:
                    payment = Payment(
                        floor_id=po["floor_id"], quotation_id=quotation_id,
                        quotation_number=quotation.get("number"), customer_id=quotation["customer_id"],
                        customer_name=quotation.get("customer_name"), amount=credit_amount,
                        mode="bank", status="completed", entry_type="godown_stock_credit",
                        godown_stock_id=lot["id"],
                        reference=f"Godown stock {lot['id']}",
                        note=(
                            f"₹{credit_amount:,.2f} balance credit — {qty:g} × {item.get('name')} "
                            "moved to godown stock."
                        ),
                        paid_at=at, recorded_by=user.id, recorded_by_name=user.full_name,
                        idempotency_key=f"godown-stock-credit:{lot['id']}",
                    ).model_dump()
                    lot["payment_id"] = payment["id"]

        await db.godown_stock.insert_one(lot, session=session)
        lot_inserted = True
        if payment:
            await db.payments.insert_one(payment, session=session)
        return lot, payment
    except Exception:
        # Atlas rolls the complete write set back itself.  Only a standalone
        # local Mongo fallback needs explicit compensation; attempting it in
        # an already-aborted transaction can hide the original write error.
        if session is None:
            if payment:
                await db.payments.delete_one({"id": payment["id"]})
            if lot_inserted:
                await db.godown_stock.delete_one({"id": lot["id"]})
            if source_updated:
                await db.purchase_orders.update_one(
                    {"id": po["id"], "floor_id": po["floor_id"], "items.id": item["id"]},
                    {"$inc": {"items.$.godown_transferred_qty": -qty}, "$pull": {"items.$.godown_transfer_history": {"stock_id": lot["id"]}}, "$set": {"updated_at": now_iso()}},
                )
        raise


@router.get("")
async def list_stock(
    brand_id: str | None = None, q: str | None = None,
    user: UserPublic = Depends(get_current_user),
):
    query: dict = floor_query(user, {"available_qty": {"$gt": 0}})
    if brand_id:
        query["brand_id"] = brand_id
    if q and q.strip():
        query["$or"] = [{"name": {"$regex": q.strip(), "$options": "i"}}, {"sku": {"$regex": q.strip(), "$options": "i"}}, {"brand_name": {"$regex": q.strip(), "$options": "i"}}]
    lots = await db.godown_stock.find(query, {"_id": 0}).sort("transferred_at", -1).to_list(500)
    brands: dict[str, dict] = {}
    for lot in lots:
        key = lot.get("brand_id") or lot.get("brand_name") or "unbranded"
        row = brands.setdefault(key, {"id": lot.get("brand_id"), "name": lot.get("brand_name") or "Other", "lot_count": 0, "available_qty": 0})
        row["lot_count"] += 1
        row["available_qty"] += float(lot.get("available_qty") or 0)
    return {"lots": [_stock_view(lot) for lot in lots], "brands": sorted(brands.values(), key=lambda row: row["name"].lower()), "total_available_qty": sum(float(lot.get("available_qty") or 0) for lot in lots)}


@router.get("/sku-suggestions")
async def sku_suggestions(prefix: str = Query(min_length=1, max_length=80), user: UserPublic = Depends(get_current_user)):
    """Literal, floor-scoped SKU prefix lookup for direct stock intake."""
    rows = await db.products.find(
        floor_query(user, {"sku": {"$regex": f"^{re.escape(prefix.strip())}", "$options": "i"}, "active": {"$ne": False}}),
        {"_id": 0, "id": 1, "sku": 1, "name": 1, "brand_id": 1, "brand_name": 1, "hero_image_url": 1, "images": 1, "size": 1, "category_id": 1},
    ).sort("sku", 1).to_list(30)
    return [{"id": row["id"], "sku": row.get("sku"), "name": row.get("name"), "brand_name": row.get("brand_name"), "image": row.get("hero_image_url") or (row.get("images") or [None])[0], "size": row.get("size"), "category_id": row.get("category_id")} for row in rows]


@router.get("/{stock_id}")
async def get_stock(stock_id: str, user: UserPublic = Depends(get_current_user)):
    return _stock_view(await get_floor_scoped_or_404(db.godown_stock, stock_id, user, not_found="Godown stock lot not found", projection={"_id": 0}))


@router.post("/direct-intakes")
async def direct_intake(body: DirectIntake, user: UserPublic = Depends(require_min_role("warehouse"))):
    """Add catalog or independently described material without a customer source."""
    floor_id = floor_for_write(user)
    product = None
    if body.product_id:
        product = await db.products.find_one(floor_query(user, {"id": body.product_id}), {"_id": 0})
        if not product:
            raise HTTPException(status_code=404, detail="Product not found on this floor")
        # A multi-floor user may read another floor, but the intake must stay
        # on the actual product's floor rather than their default floor.
        floor_id = product["floor_id"]
    elif not (body.sku and body.sku.strip() and body.name and body.name.strip()):
        raise HTTPException(status_code=422, detail="SKU and product name are required")
    at = now_iso()
    lot_id = str(uuid4())
    lot = {
        "id": lot_id, "floor_id": floor_id,
        # Stock-only lines use an opaque id tied to this lot. It is never
        # inserted into catalog/products, so manual entries stay private to
        # the godown while quotations can still identify their source.
        "product_id": (product or {}).get("id") or f"godown:{lot_id}",
        "sku": (product or {}).get("sku") or (body.sku or "").strip(),
        "name": (product or {}).get("name") or (body.name or "").strip(),
        "image": (product or {}).get("hero_image_url") or ((product or {}).get("images") or [None])[0] or body.image,
        "size": (product or {}).get("size") or body.size,
        "feature": (product or {}).get("feature") or body.feature,
        "category": body.category,
        "category_id": (product or {}).get("category_id"),
        "brand_id": (product or {}).get("brand_id"),
        "brand_name": (product or {}).get("brand_name") or body.brand,
        "qty_received": body.qty, "available_qty": body.qty,
        "reason": body.reason.strip(), "source_type": "catalog" if product else "manual",
        "transferred_at": at, "transferred_by": user.id, "transferred_by_name": user.full_name,
        "allocations": [], "created_at": at, "updated_at": at,
    }
    await db.godown_stock.insert_one(lot)
    await log_event(event_type="godown_stock.intaken", entity_type="godown_stock", entity_id=lot["id"], actor=user, floor_id=floor_id, summary=f"Added {body.qty:g} × {lot['name']} to godown stock", payload={"source_type": lot["source_type"]})
    return _stock_view(lot)


@router.post("/intakes")
async def intake_stock(body: Intake, user: UserPublic = Depends(require_min_role("warehouse"))):
    po = await get_floor_scoped_or_404(db.purchase_orders, body.purchase_order_id, user, not_found="Purchase order not found", projection={"_id": 0})
    item = next((row for row in po.get("items", []) if row.get("id") == body.purchase_item_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="Purchase order item not found")
    if item.get("cancelled"):
        raise HTTPException(status_code=409, detail="A cancelled purchase item cannot be transferred to godown stock")
    received_qty = float(item.get("qty_received") or item.get("qty") or 0)
    transferable = received_qty - float(item.get("godown_transferred_qty") or 0)
    if body.qty > transferable:
        raise HTTPException(status_code=409, detail=f"Only {transferable:g} units are available to transfer")
    product = await db.products.find_one(floor_query(user, {"id": item["product_id"]}), {"_id": 0, "brand_id": 1, "floor_id": 1}) or {}
    source_quote = None
    if po.get("quotation_id"):
        source_quote = await db.quotations.find_one(floor_query(user, {"id": po["quotation_id"]}), {"_id": 0, "created_at": 1, "ordered_at": 1})
    at = now_iso()
    lot = {
        "id": str(uuid4()), "floor_id": po["floor_id"], "product_id": item["product_id"], "sku": item.get("sku"), "name": item.get("name"), "image": item.get("image"), "finish": item.get("finish"),
        "brand_id": item.get("brand_id") or product.get("brand_id"), "brand_name": item.get("brand_name") or po.get("brand_name"), "qty_received": body.qty, "available_qty": body.qty,
        "source_purchase_order_id": po["id"], "source_purchase_item_id": item["id"], "source_quotation_id": po.get("quotation_id"), "source_customer_id": po.get("customer_id"), "source_customer_name": po.get("customer_name"),
        "source_purchased_at": (source_quote or {}).get("ordered_at") or (source_quote or {}).get("created_at") or po.get("created_at"),
        "reason": body.reason.strip(), "transferred_at": at, "transferred_by": user.id, "transferred_by_name": user.full_name, "allocations": [], "created_at": at, "updated_at": at,
    }
    payment: dict | None = None
    try:
        async with await client.start_session() as session:
            async with session.start_transaction():
                lot, payment = await _persist_intake(
                    po=po, item=item, qty=body.qty, reason=lot["reason"], user=user,
                    lot=lot, at=at, session=session,
                )
    except Exception as exc:
        if not _transaction_unsupported(exc):
            raise
        # Local standalone Mongo has no transactions. _persist_intake has
        # explicit compensating writes for this development-only fallback.
        lot, payment = await _persist_intake(
            po=po, item=item, qty=body.qty, reason=lot["reason"], user=user,
            lot=lot, at=at,
        )
    credit_amount = float((payment or {}).get("amount") or 0)
    await log_event(event_type="godown_stock.intaken", entity_type="purchase", entity_id=po["id"], actor=user, floor_id=po["floor_id"], customer_id=po.get("customer_id"), purchase_id=po["id"], summary=f"Moved {body.qty:g} × {item.get('name')} to godown stock", payload={"stock_id": lot["id"], "reason": lot["reason"], "source_purchased_at": lot["source_purchased_at"], "payment_credit_amount": credit_amount, "payment_id": (payment or {}).get("id")})
    await notify(user.id, "Godown stock added", body=(f"{body.qty:g} × {item.get('name')} from {po.get('customer_name')} is available to reuse." + (f" Customer balance reduced by ₹{credit_amount:,.2f}." if credit_amount else "")), kind="success", link="/(admin)/godown-stock", floor_id=po["floor_id"])
    try:
        await cache.bump("payments")
    except Exception:
        logger.exception("cache bump failed after godown stock intake for %s", lot["id"])
    if payment:
        # Outstanding-balance follow-ups are derived from the same ledger.
        # Run reconciliation after the transaction commits, never inside it.
        asyncio.create_task(reconcile_followups())
    return _stock_view(lot)


@router.post("/{stock_id}/allocate")
async def allocate_stock(stock_id: str, body: Allocation, user: UserPublic = Depends(require_min_role("sales"))):
    quote = await get_floor_scoped_or_404(db.quotations, body.quotation_id, user, not_found="Quotation not found", projection={"_id": 0})
    if quote.get("status") not in {"draft", "sent", "approved"}:
        raise HTTPException(status_code=409, detail="Godown stock can only be added to an open quotation")
    at = now_iso()
    allocation = {"id": str(uuid4()), "quotation_id": quote["id"], "quotation_number": quote.get("number"), "customer_id": quote.get("customer_id"), "customer_name": quote.get("customer_name"), "qty": body.qty, "allocated_at": at, "allocated_by": user.id, "allocated_by_name": user.full_name}
    lot = await db.godown_stock.find_one_and_update(
        floor_query(user, {"id": stock_id, "available_qty": {"$gte": body.qty}}),
        {"$inc": {"available_qty": -body.qty}, "$push": {"allocations": allocation}, "$set": {"updated_at": at}},
        return_document=ReturnDocument.AFTER,
    )
    if not lot:
        raise HTTPException(status_code=409, detail="That stock is no longer available in the requested quantity")
    line = {"id": str(uuid4()), "product_id": lot["product_id"], "sku": lot["sku"], "name": lot["name"], "image": lot.get("image"), "finish": lot.get("finish"), "qty": body.qty, "unit_price": 0, "room": None, "godown_stock_id": stock_id, "godown_allocation_id": allocation["id"], "godown_source_customer_name": lot.get("source_customer_name"), "godown_source_purchased_at": lot.get("source_purchased_at"), "godown_transferred_at": lot.get("transferred_at"), "godown_allocated_at": at}
    await db.quotations.update_one({"id": quote["id"]}, {"$push": {"items": line}, "$set": {"updated_at": at}})
    await log_event(event_type="godown_stock.allocated", entity_type="quotation", entity_id=quote["id"], actor=user, floor_id=quote["floor_id"], customer_id=quote.get("customer_id"), quotation_id=quote["id"], summary=f"Added {body.qty:g} × {lot['name']} from godown stock", payload={"stock_id": stock_id, "allocation_id": allocation["id"], "source_customer": lot.get("source_customer_name"), "source_purchased_at": lot.get("source_purchased_at"), "allocated_at": at})
    await notify(user.id, "Godown stock allocated", body=f"{body.qty:g} × {lot['name']} was added to {quote.get('number')} for {quote.get('customer_name')}.", kind="info", link=f"/(admin)/quotations/{quote['id']}", floor_id=quote["floor_id"])
    return {"allocation": allocation, "line": line, "remaining_qty": float(lot.get("available_qty") or 0)}
