"""Sanitary godown stock — returned/declined material that can be reused.

Lots are intentionally separate from tile logistics.  Each lot preserves its
customer and original-purchase provenance and is consumed with a conditional
quantity update, so two staff members cannot allocate the same unit.
"""
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth import floor_query, get_current_user, get_floor_scoped_or_404, require_min_role
from db import db
from pymongo import ReturnDocument
from models import UserPublic, now_iso
from services.activity_log import log_event
from services.notifications import notify

router = APIRouter(prefix="/godown-stock", tags=["godown-stock"])


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


def _stock_view(lot: dict) -> dict:
    return {key: value for key, value in lot.items() if key != "_id"}


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


@router.get("/{stock_id}")
async def get_stock(stock_id: str, user: UserPublic = Depends(get_current_user)):
    return _stock_view(await get_floor_scoped_or_404(db.godown_stock, stock_id, user, not_found="Godown stock lot not found", projection={"_id": 0}))


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
    # Guard the source line as well as the lot. The conditional update is the
    # concurrency boundary for repeated/partial intakes of one purchase line.
    moved = await db.purchase_orders.update_one(
        floor_query(user, {
            "id": po["id"],
            "items": {"$elemMatch": {
                "id": item["id"],
                "godown_transferred_qty": {"$lte": received_qty - body.qty},
            }},
        }),
        {"$inc": {"items.$.godown_transferred_qty": body.qty}, "$set": {"updated_at": at}},
    )
    if not moved.modified_count:
        raise HTTPException(status_code=409, detail="This purchase item was changed while transferring it. Refresh and try again.")
    try:
        await db.godown_stock.insert_one(lot)
    except Exception:
        # Do not leave source quantity consumed if the lot write is rejected.
        await db.purchase_orders.update_one(
            floor_query(user, {"id": po["id"], "items.id": item["id"]}),
            {"$inc": {"items.$.godown_transferred_qty": -body.qty}, "$set": {"updated_at": now_iso()}},
        )
        raise
    await log_event(event_type="godown_stock.intaken", entity_type="purchase", entity_id=po["id"], actor=user, floor_id=po["floor_id"], customer_id=po.get("customer_id"), purchase_id=po["id"], summary=f"Moved {body.qty:g} × {item.get('name')} to godown stock", payload={"stock_id": lot["id"], "reason": lot["reason"], "source_purchased_at": lot["source_purchased_at"]})
    await notify(user.id, "Godown stock added", body=f"{body.qty:g} × {item.get('name')} from {po.get('customer_name')} is available to reuse.", kind="success", link="/(admin)/godown-stock", floor_id=po["floor_id"])
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
