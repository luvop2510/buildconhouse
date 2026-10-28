from services.money import format_indian_money
from services.followup_engine import reconcile_followups_admitted
"""Sanitary godown stock — returned/declined material that can be reused.

Lots are intentionally separate from tile logistics.  Each lot preserves its
customer and original-purchase provenance and is consumed with a conditional
quantity update, so two staff members cannot allocate the same unit.
"""
import asyncio
import hashlib
import json
import logging
import re
from datetime import date, datetime, timezone
from typing import Literal
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, ConfigDict, EmailStr, Field, HttpUrl, field_validator
from pymongo.errors import DuplicateKeyError, PyMongoError

from auth import floor_for_write, floor_query, get_current_user, get_floor_scoped_or_404, require_min_role
from db import client, db
from pymongo import ReturnDocument
from models import (
    CustomerPublic, Payment, PurchaseOrder, PurchaseOrderItem, PurchaseStageEvent,
    Product, Quotation, QuotationLineItem, QuotationRevision, RoomDiscountCfg, UserPublic, now_iso,
)
from services.activity_log import log_event
from services.analytics import cache
from services.followup_engine import reconcile_followups
from services.notifications import notify
from services.sequence import next_number
from services.pricing import per_line_net_amounts, recalc_quotation_totals, stamp_net_amounts
from services import catalog_service, godown_media_service
from services.multi_filters import filter_values
from services.product_image_normalizer import ProductImageNormalizationError
from services.godown_transfer_receipts import completion_receipt, receipt_id as transfer_receipt_id, removed_history_result
from routes.media_routes import _read_bounded_upload

router = APIRouter(prefix="/godown-stock", tags=["godown-stock"])
logger = logging.getLogger(__name__)


async def ensure_godown_stock_indexes() -> None:
    """Indexes match the page's floor/status, product and brand access paths."""
    await db.godown_stock.create_index([("floor_id", 1), ("available_qty", 1), ("brand_id", 1), ("transferred_at", -1)])
    await db.godown_stock.create_index([("floor_id", 1), ("product_id", 1), ("available_qty", 1)])
    await db.godown_stock.create_index("id", unique=True)
    await db.godown_customer_transfers.create_index("id", unique=True)
    await db.godown_customer_transfers.create_index("idempotency_key", unique=True, sparse=True)
    await db.godown_customer_transfers.create_index([("floor_id", 1), ("source_customer_id", 1), ("created_at", -1)])
    await db.godown_customer_transfers.create_index([("floor_id", 1), ("recipient_customer_id", 1), ("created_at", -1)])


class Intake(BaseModel):
    purchase_order_id: str
    purchase_item_id: str
    qty: float = Field(gt=0)
    reason: str = Field(min_length=2, max_length=280)


class Allocation(BaseModel):
    quotation_id: str
    qty: float = Field(gt=0)


class StockPriceVariant(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    price: float = Field(ge=0, allow_inf_nan=False)


class StockPricingUpdate(BaseModel):
    unit_price: float | None = Field(ge=0, allow_inf_nan=False)
    price_variants: list[StockPriceVariant] = Field(default_factory=list, max_length=20)


class StockDetailsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    unit_price: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    price_variants: list[StockPriceVariant] | None = Field(default=None, max_length=20)
    image: HttpUrl | None = None

    @field_validator("image")
    @classmethod
    def public_image_url(cls, value):
        if value is not None and (value.scheme != "https" or value.username or value.password):
            raise ValueError("Use a public HTTPS image URL without credentials")
        return value

    @field_validator("price_variants")
    @classmethod
    def non_null_variants(cls, value):
        if value is None:
            raise ValueError("Use an empty list to remove price variants")
        return value


class DirectIntake(BaseModel):
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=160)
    product_id: str | None = None
    qty: float = Field(gt=0, allow_inf_nan=False)
    reason: str = Field(default="Added to godown stock", min_length=2, max_length=280)
    sku: str | None = Field(default=None, max_length=80)
    name: str | None = Field(default=None, max_length=200)
    brand: str | None = Field(default=None, max_length=120)
    image: HttpUrl | None = None
    size: str | None = Field(default=None, max_length=120)
    feature: str | None = Field(default=None, max_length=280)
    category: str | None = Field(default=None, max_length=120)

    @field_validator("image", mode="before")
    @classmethod
    def blank_image(cls, value):
        return None if isinstance(value, str) and not value.strip() else value

    @field_validator("image")
    @classmethod
    def public_image_url(cls, value):
        return StockDetailsUpdate.public_image_url(value)
    unit_price: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    price_variants: list[StockPriceVariant] = Field(default_factory=list, max_length=20)


class MissingQuantityCount(BaseModel):
    model_config = ConfigDict(extra="forbid")
    qty: float = Field(ge=0, allow_inf_nan=False)
    counted_on: date
    reason: str = Field(min_length=3, max_length=280)
    expected_updated_at: str | None = None
    idempotency_key: str = Field(min_length=8, max_length=160)

    @field_validator("reason")
    @classmethod
    def meaningful_reason(cls, value):
        if len(value.strip()) < 3:
            raise ValueError("Explain the count source")
        return value.strip()


class StockMovement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["receipt", "adjustment_out"]
    qty: float = Field(gt=0, allow_inf_nan=False)
    occurred_on: date
    reason: str = Field(min_length=3, max_length=280)
    expected_updated_at: str | None = None
    idempotency_key: str = Field(min_length=8, max_length=160)

    @field_validator("reason")
    @classmethod
    def meaningful_reason(cls, value):
        if len(value.strip()) < 3:
            raise ValueError("Explain the stock movement")
        return value.strip()


class NewTransferCustomer(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    company: str | None = None
    email: EmailStr | None = None
    phone: str | None = None

    @field_validator("name", "email", mode="before")
    @classmethod
    def trim_customer_inputs(cls, value, info):
        if isinstance(value, str):
            value = value.strip()
            if info.field_name == "email" and not value:
                return None
        return value


class CustomerTransfer(BaseModel):
    qty: float = Field(gt=0, allow_inf_nan=False)
    recipient_customer_id: str | None = None
    new_customer: NewTransferCustomer | None = None
    recipient_purchase_item_id: str | None = None
    reason: str | None = Field(default=None, max_length=280)
    unit_price: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    discount_pct: float = Field(default=0, ge=0, le=100, allow_inf_nan=False)
    idempotency_key: str = Field(min_length=8, max_length=160)


class ReturnTransfer(BaseModel):
    note: str | None = Field(default=None, max_length=280)


def _stock_view(lot: dict) -> dict:
    row = {key: value for key, value in lot.items() if key not in {"_id", "intake_command", "source_provenance", "catalog_provenance", "image_local"}}
    if "quantity_counts" in row:
        row["quantity_counts"] = [{key: value for key, value in count.items() if key not in {"command_key", "payload_sha256"}} for count in row["quantity_counts"]]
    if "stock_movements" in row:
        row["stock_movements"] = [{key: value for key, value in movement.items() if key not in {"command_key", "payload_sha256"}} for movement in row["stock_movements"]]
    row["stock_value"] = round(float(row.get("available_qty") or 0) * float(row["unit_price"]), 2) if row.get("unit_price") is not None and not row.get("quantity_missing") else None
    row["transferable_qty"] = 0 if row.get("quantity_missing") or row.get("archived") else max(0.0, round(float(row.get("available_qty") or 0) - float(row.get("loaned_out_qty") or 0), 4))
    return row


async def _stock_response(lot: dict) -> dict:
    """Keep exact catalog fallback consistent after a detail read or write."""
    row = _stock_view(lot)
    await _hydrate_missing_stock_catalog_images([row])
    return row


def _same_product(lot: dict, item: dict) -> str | None:
    """Prefer catalog identity; allow the same SKU or a named manual product."""
    if lot.get("product_id") and not str(lot["product_id"]).startswith("godown:") and lot["product_id"] == item.get("product_id"):
        return "product_id"
    stock_sku = str(lot.get("sku") or "").strip().casefold()
    item_sku = str(item.get("sku") or "").strip().casefold()
    stock_brand_id = lot.get("brand_id")
    item_brand_id = item.get("brand_id")
    same_brand = not (stock_brand_id and item_brand_id and stock_brand_id != item_brand_id)
    if stock_sku and stock_sku == item_sku and same_brand:
        return "sku"
    stock_name = re.sub(r"\s+", " ", str(lot.get("name") or "").strip()).casefold()
    item_name = re.sub(r"\s+", " ", str(item.get("name") or "").strip()).casefold()
    stock_brand = str(lot.get("brand_name") or "").strip().casefold()
    item_brand = str(item.get("brand_name") or "").strip().casefold()
    if stock_name and stock_name == item_name and stock_brand and stock_brand == item_brand:
        return "name_and_brand"
    return None


async def _po_final_matches(lot: dict) -> dict:
    if lot.get("archived") or lot.get("quantity_missing"):
        return {"matches": [], "total_ordered_qty": 0, "transferable_qty": 0}
    rows = await db.purchase_orders.find(
        {"floor_id": lot["floor_id"], "items.stage": "po_final", "status": {"$ne": "cancelled"}},
        {"_id": 0, "id": 1, "number": 1, "customer_id": 1, "customer_name": 1, "items": 1},
    ).to_list(2000)
    matches = []
    for po in rows:
        for item in po.get("items") or []:
            if item.get("stage") != "po_final" or item.get("cancelled"):
                continue
            matched_by = _same_product(lot, item)
            if not matched_by:
                continue
            ordered_qty = float(item.get("qty") or 0)
            remaining_qty = max(0.0, ordered_qty - float(item.get("godown_borrowed_qty") or 0))
            if remaining_qty <= 0:
                continue
            matches.append({
                "purchase_order_id": po["id"], "purchase_order_number": po.get("number"),
                "purchase_item_id": item["id"], "customer_id": item.get("customer_id") or po.get("customer_id"),
                "customer_name": item.get("customer_name") or po.get("customer_name"),
                "product_id": item.get("product_id"), "sku": item.get("sku"), "name": item.get("name"),
                "ordered_qty": ordered_qty, "remaining_qty": remaining_qty, "matched_by": matched_by,
            })
    total = sum(row["ordered_qty"] for row in matches)
    waiting = sum(row["remaining_qty"] for row in matches)
    transferable = max(0.0, float(lot.get("available_qty") or 0) - float(lot.get("loaned_out_qty") or 0))
    return {"matches": matches, "total_ordered_qty": total, "transferable_qty": min(waiting, transferable)}


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

    Capture the current agreed selling value at movement time. PO unit_cost
    can be stale after a quotation revision; the captured value stays fixed
    when the quotation is edited again. A credit is settlement, not cash.
    """
    received_qty = float(item["qty_received"] if item.get("qty_received") is not None else item.get("qty") or 0)
    source_updated = False
    lot_inserted = False
    payment: dict | None = None
    try:
        quotation_id = po.get("quotation_id")
        quotation = await db.quotations.find_one(
            {"id": quotation_id, "floor_id": po["floor_id"]}, {"_id": 0}, session=session,
        ) if quotation_id else None
        sold_unit = float(item.get("unit_cost") or 0)
        line_id = item.get("quotation_line_id")
        if quotation and line_id:
            quote_line = next((line for line in quotation.get("items") or [] if line.get("id") == line_id), None)
            if quote_line and float(quote_line.get("qty") or 0) > 0:
                sold_unit = per_line_net_amounts(quotation).get(line_id, sold_unit * float(quote_line["qty"])) / float(quote_line["qty"])
        transferred_value = round(qty * sold_unit, 2)
        lot["transferred_value"] = transferred_value
        # Many existing purchase rows predate godown_transferred_qty. Mongo's
        # $lte does not match an absent field, which made valid legacy rows
        # fail with the misleading concurrent-change error.
        moved = await db.purchase_orders.update_one(
            {
                "id": po["id"], "floor_id": po["floor_id"],
                "items": {"$elemMatch": {
                    "id": item["id"],
                    "loan_replenishment_promised_qty": item.get("loan_replenishment_promised_qty"),
                    "loaned_qty": item.get("loaned_qty"),
                    "$and": [
                        {"$or": [
                            {"godown_transferred_qty": {"$lte": received_qty - float(item.get("loan_replenishment_returned_qty") or 0) - float(item.get("loaned_qty") or 0) - max(0.0, float(item.get("loan_replenishment_promised_qty") or 0) - float(item.get("loan_replenishment_returned_qty") or 0)) - qty}},
                            {"godown_transferred_qty": {"$exists": False}},
                        ]},
                        ({"loan_replenishment_returned_qty": float(item["loan_replenishment_returned_qty"])}
                         if item.get("loan_replenishment_returned_qty") else
                         {"$or": [{"loan_replenishment_returned_qty": 0}, {"loan_replenishment_returned_qty": {"$exists": False}}]}),
                    ],
                }},
            },
            {"$inc": {"items.$.godown_transferred_qty": qty,
                       "items.$.godown_valued_qty": qty,
                       "items.$.godown_transferred_value": transferred_value}, "$set": {"updated_at": at}, "$push": {
                "items.$.godown_transfer_history": {
                    "stock_id": lot["id"], "qty": qty, "reason": reason,
                    "transferred_value": transferred_value,
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
        if quotation_id:
            if quotation and quotation.get("status") in {"ordered", "won"}:
                paid_rows = await db.payments.aggregate([
                    {"$match": {
                        "quotation_id": quotation_id, "floor_id": po["floor_id"], "status": "completed",
                    }},
                    {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
                ], session=session).to_list(1)
                already_settled = float(paid_rows[0].get("total") or 0) if paid_rows else 0.0
                credit_amount = round(min(transferred_value, max(0.0, _collection_total(quotation) - already_settled)), 2)
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
                            f"₹{format_indian_money(credit_amount)} balance credit — {qty:g} × {item.get('name')} "
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
                    {"$inc": {"items.$.godown_transferred_qty": -qty,
                               "items.$.godown_valued_qty": -qty,
                               "items.$.godown_transferred_value": -transferred_value},
                     "$pull": {"items.$.godown_transfer_history": {"stock_id": lot["id"]}}, "$set": {"updated_at": now_iso()}},
                )
        raise


@router.get("")
async def list_stock(
    brand_id: str | None = None, q: str | None = None,
    include_history: bool = False,
    user: UserPublic = Depends(get_current_user),
    limit: int | None = None, offset: int = 0, brands: str | None = None, with_movements: bool = True,
):
    if limit is not None:
        if not 1 <= limit <= 100 or not 0 <= offset <= 100000:
            raise HTTPException(422, "Stock pages require limit 1–100 and a nonnegative offset up to 100000")
        return await _stock_page(user, include_history, q, brands or brand_id, limit, offset)
    query: dict = floor_query(user, {} if include_history else {"$or": [{"available_qty": {"$gt": 0}}, {"quantity_missing": True}]})
    query["archived"] = {"$ne": True}
    if brand_id:
        query["brand_id"] = brand_id
    if q and q.strip():
        literal = re.escape(q.strip())
        query["$or"] = [{field: {"$regex": literal, "$options": "i"}}
                        for field in ("name", "sku", "brand_name")]
    if brands:
        query = {"$and": [query, _stock_choices(brands)]}
    projection = {"_id": 0, "source_provenance": 0, "catalog_provenance": 0, "image_local": 0}
    if not with_movements:
        projection.update(allocations=0, stock_movements=0)
    lots = await db.godown_stock.find(query, projection).sort("transferred_at", -1).to_list(2001)
    if len(lots) > 2000:
        raise HTTPException(status_code=409, detail="More than 2,000 stock lots match. Select a brand or search to narrow the list.")
    await _hydrate_missing_stock_catalog_images(lots)
    transfer_map: dict[str, list[dict]] = {}
    if include_history and with_movements and lots:
        recorded_count = sum(len(lot.get("allocations") or []) + len(lot.get("stock_movements") or []) for lot in lots)
        if recorded_count > 2000:
            raise HTTPException(409, "More than 2,000 movements match. Narrow the stock selection before exporting movements.")
        transfers = await db.godown_customer_transfers.find(
            floor_query(user, {"stock_id": {"$in": [lot["id"] for lot in lots]}}), {"_id": 0},
        ).sort("created_at", -1).to_list(2001)
        if recorded_count + len(transfers) > 2000:
            raise HTTPException(409, "More than 2,000 movements match. Narrow the stock selection before exporting movements.")
        for transfer in transfers:
            transfer_map.setdefault(transfer["stock_id"], []).append(_transfer_view(transfer))
    brands: dict[str, dict] = {}
    for lot in lots:
        key = lot.get("brand_id") or lot.get("brand_name") or "unbranded"
        row = brands.setdefault(key, {"id": lot.get("brand_id"), "name": lot.get("brand_name") or "Other", "lot_count": 0, "available_qty": 0})
        row["lot_count"] += 1
        if not lot.get("quantity_missing"):
            row["available_qty"] += float(lot.get("available_qty") or 0)
    return {"lots": [{**_stock_view(lot), "customer_transfers": transfer_map.get(lot["id"], [])} for lot in lots], "brands": sorted(brands.values(), key=lambda row: row["name"].lower()), "total_available_qty": sum(float(lot.get("available_qty") or 0) for lot in lots if not lot.get("quantity_missing")), "total_stock_value": round(sum(float(lot.get("available_qty") or 0) * float(lot["unit_price"]) for lot in lots if lot.get("unit_price") is not None and not lot.get("quantity_missing")), 2), "unpriced_lot_count": sum(1 for lot in lots if (float(lot.get("available_qty") or 0) > 0 or lot.get("quantity_missing")) and lot.get("unit_price") is None)}


def _stock_choices(value):
    selected = filter_values(value)
    choices = [{"brand_id": {"$in": selected}}, {"brand_id": {"$in": [None, ""]}, "brand_name": {"$in": selected}}]
    if "unbranded" in selected:
        choices.append({"brand_id": {"$in": [None, ""]}, "brand_name": {"$in": [None, ""]}})
    return {"$or": choices} if selected else {}


async def _stock_page(user, include_history, q, brands, limit, offset):
    base = floor_query(user, {"archived": {"$ne": True}, **({} if include_history else {"$or": [{"available_qty": {"$gt": 0}}, {"quantity_missing": True}]})})
    filters = [_stock_choices(brands)]
    if q and q.strip():
        if len(q) > 200:
            raise HTTPException(422, "Use at most 200 search characters")
        filters.append({"$or": [{field: {"$regex": re.escape(q.strip()), "$options": "i"}} for field in ("name", "sku", "brand_name")]})
    filtered = {"$and": filters}
    missing = {"$eq": [{"$ifNull": ["$quantity_missing", False]}, True]}
    known_qty = {"$cond": [missing, 0, {"$ifNull": ["$available_qty", 0]}]}
    stats = {"_id": None, "total_lots": {"$sum": 1},
             "available_lot_count": {"$sum": {"$cond": [{"$gt": [known_qty, 0]}, 1, 0]}},
             "unknown_quantity_count": {"$sum": {"$cond": [missing, 1, 0]}},
             "zero_lot_count": {"$sum": {"$cond": [{"$and": [{"$not": [missing]}, {"$lte": [known_qty, 0]}]}, 1, 0]}}}
    totals = {"_id": None, "total_available_qty": {"$sum": known_qty},
              "total_stock_value": {"$sum": {"$multiply": [known_qty, {"$ifNull": ["$unit_price", 0]}]}},
              "unpriced_lot_count": {"$sum": {"$cond": [{"$and": [{"$or": [missing, {"$gt": [known_qty, 0]}]}, {"$eq": [{"$ifNull": ["$unit_price", None]}, None]}]}, 1, 0]}}}
    pipeline = [{"$match": base}, {"$project": {"name": 1, "sku": 1, "brand_id": 1, "brand_name": 1, "quantity_missing": 1, "available_qty": 1, "unit_price": 1}}, {"$facet": {
        "totals": [{"$group": totals}],
        "filtered": [{"$match": filtered}, {"$group": stats}],
        "brands": [{"$group": {"_id": {"$cond": [{"$and": [{"$ne": [{"$ifNull": ["$brand_id", ""]}, ""]}]}, "$brand_id", {"$ifNull": ["$brand_name", "unbranded"]}]},
                    "id": {"$first": "$brand_id"}, "name": {"$first": "$brand_name"}, "lot_count": {"$sum": 1}, "available_qty": {"$sum": known_qty}}}],
    }}]
    async def page():
        lots = await db.godown_stock.find({"$and": [base, filtered]}, {
            "_id": 0, "source_provenance": 0, "catalog_provenance": 0, "image_local": 0,
            "allocations": 0, "customer_transfers": 0, "stock_movements": 0, "intake_command": 0,
        }).sort([("transferred_at", -1), ("id", 1)]).skip(offset).to_list(limit)
        await _hydrate_missing_stock_catalog_images(lots)
        return [{**_stock_view(lot), "history_loaded": False} for lot in lots]
    lots, summaries = await asyncio.gather(page(), db.godown_stock.aggregate(pipeline).to_list(1))
    summary = summaries[0] if summaries else {}
    result = {key: value for key, value in (summary.get("totals") or [dict(total_available_qty=0, total_stock_value=0, unpriced_lot_count=0)])[0].items() if key != "_id"}
    result.update({key: value for key, value in (summary.get("filtered") or [dict(total_lots=0, available_lot_count=0, unknown_quantity_count=0, zero_lot_count=0)])[0].items() if key != "_id"})
    result["total_stock_value"] = round(result["total_stock_value"], 2)
    result["brands"] = sorted([{key: value for key, value in brand.items() if key != "_id"} | {"id": brand.get("id") or brand.get("name") or "unbranded", "name": brand.get("name") or "Other"} for brand in summary.get("brands", [])], key=lambda row: row["name"].lower())
    return {**result, "lots": lots, "next_offset": offset + len(lots) if lots and offset + len(lots) < result["total_lots"] else None}


@router.get("/{stock_id}/history")
async def stock_history(stock_id: str, offset: int = 0, limit: int = 60, user: UserPublic = Depends(get_current_user)):
    if not 1 <= limit <= 100 or not 0 <= offset <= 100000:
        raise HTTPException(422, "Invalid stock history page")
    lot = await db.godown_stock.find_one(floor_query(user, {"id": stock_id}), {"_id": 0, "allocations": 1, "stock_movements": 1})
    if not lot:
        raise HTTPException(404, "Godown stock lot not found on this floor")
    allocations = lot.get("allocations") or []
    transfers = await db.godown_customer_transfers.find(floor_query(user, {"stock_id": stock_id}), {"_id": 0}).sort([("created_at", -1), ("id", 1)]).skip(offset).to_list(limit + 1)
    movements = _stock_view(lot).get("stock_movements", [])
    more = offset + limit < max(len(allocations), len(movements)) or len(transfers) > limit
    return {"stock_movements": movements[offset:offset + limit], "allocations": allocations[offset:offset + limit], "customer_transfers": [_transfer_view(row) for row in transfers[:limit]], "next_offset": offset + limit if more else None}


@router.get("/sku-suggestions")
async def sku_suggestions(prefix: str = Query(min_length=1, max_length=80), user: UserPublic = Depends(get_current_user)):
    """Literal, floor-scoped SKU prefix lookup for direct stock intake."""
    rows = await db.products.find(
        floor_query(user, {"sku": {"$regex": f"^{re.escape(prefix.strip())}", "$options": "i"}, "active": {"$ne": False}}),
        {"_id": 0, "id": 1, "sku": 1, "name": 1, "brand_id": 1, "brand_name": 1, "hero_image_url": 1, "images": 1, "size": 1, "category_id": 1, "floor_id": 1},
    ).sort("sku", 1).to_list(30)
    images = await _catalog_images(rows)
    return [{"id": row["id"], "sku": row.get("sku"), "name": row.get("name"), "brand_name": row.get("brand_name"), "image": images.get(row["id"]), "size": row.get("size"), "category_id": row.get("category_id")} for row in rows]


async def _catalog_images(products: list[dict]) -> dict[str, str | None]:
    images = {row["id"]: row.get("hero_image_url") or (row.get("images") or [None])[0] for row in products}
    missing = [row for row in products if not images[row["id"]]]
    if not missing:
        return images
    # One bounded exact-product batch; never borrow a sibling finish or scan
    # the catalog for a similar-looking image.
    media = await db.product_media.find({"$or": [
        {"product_id": row["id"], "floor_id": row["floor_id"], "brand_id": row.get("brand_id")}
        for row in missing
    ], "role": {"$in": ["hero", "gallery"]}, "mime": {"$regex": "^image/"}}, {"_id": 0}).sort([
        ("is_primary", -1), ("sort_order", 1), ("id", 1),
    ]).to_list(600)
    owners = {row["id"]: row for row in missing}
    for photo in media:
        owner = owners.get(photo.get("product_id"))
        if owner and photo.get("floor_id") == owner["floor_id"] and photo.get("brand_id") == owner.get("brand_id") and photo.get("public_url"):
            images[owner["id"]] = images.get(owner["id"]) or photo["public_url"]
    return images


async def _hydrate_missing_stock_catalog_images(lots: list[dict]) -> None:
    """Fill absent lot images from the exact floor-scoped catalog product.

    A stock lot's own image is an intentional, lot-specific override, so it
    remains authoritative. Catalog-only product identity (never SKU/name
    similarity) is used for this read-time fallback; no stock rows are mutated.
    """
    linked = {
        (lot.get("floor_id"), lot.get("product_id"))
        for lot in lots
        if not lot.get("image")
        and lot.get("floor_id")
        and lot.get("product_id")
        and not str(lot["product_id"]).startswith("godown:")
    }
    if not linked:
        return

    products = await db.products.find(
        {"$or": [{"floor_id": floor_id, "id": product_id} for floor_id, product_id in linked]},
        {"_id": 0, "id": 1, "floor_id": 1, "brand_id": 1, "hero_image_url": 1, "images": 1},
    ).to_list(len(linked))
    by_identity: dict[tuple[str, str], dict] = {}
    for product in products:
        identity = (product.get("floor_id"), product.get("id"))
        by_identity[identity] = product

    images: dict[tuple[str, str], str | None] = {}
    # _catalog_images bounds its media fallback query to 600 rows. Chunking
    # keeps large stock inventories within that bound without losing matches.
    product_rows = list(by_identity.values())
    for offset in range(0, len(product_rows), 500):
        batch = product_rows[offset:offset + 500]
        resolved = await _catalog_images(batch)
        for product in batch:
            key = (product["floor_id"], product["id"])
            images[key] = resolved.get(product["id"])

    for lot in lots:
        key = (lot.get("floor_id"), lot.get("product_id"))
        if not lot.get("image") and key in images and images[key]:
            lot["image"] = images[key]


@router.get("/customer-transfers")
async def list_customer_transfers(customer_id: str, user: UserPublic = Depends(get_current_user)):
    customer = await db.customers.find_one(floor_query(user, {"id": customer_id}), {"_id": 0, "id": 1})
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    rows = await db.godown_customer_transfers.find(
        floor_query(user, {"$or": [{"source_customer_id": customer_id}, {"recipient_customer_id": customer_id}]}),
        {"_id": 0},
    ).sort("created_at", -1).to_list(500)
    for row in rows:
        row["return_due"] = await _return_due(row)
    return {"transfers": [_transfer_view(row) for row in rows]}


async def _return_due(row: dict) -> bool:
    if row.get("status") != "awaiting_return" or not row.get("recipient_purchase_item_id"):
        return False
    po = await db.purchase_orders.find_one(
        {"id": row.get("recipient_purchase_order_id"), "floor_id": row.get("floor_id")},
        {"_id": 0, "items": 1},
    )
    item = next((item for item in (po or {}).get("items", []) if item.get("id") == row["recipient_purchase_item_id"]), None)
    return bool(item and item.get("stage") not in {"po_final", "order_in_company", "company_billing"})


def _replacement_items(items: list[dict], source_id: str, replacement: dict, qty: float) -> list[dict]:
    """Replace only the fulfilled PO Final quantity and retain other lines."""
    result = []
    for item in items:
        if item.get("id") != source_id:
            result.append(item)
            continue
        remaining = round(float(item.get("qty") or 0) - qty, 4)
        if remaining > 0:
            result.append({**item, "qty": remaining})
    result.append(replacement)
    return result


def _stock_mrp(product: dict, quote_line: dict | None, purchase_item: dict) -> float:
    """Restore list price when a discounted customer line enters stock."""
    for value in (product.get("mrp"), (quote_line or {}).get("mrp"), purchase_item.get("unit_cost")):
        if value is not None:
            return float(value)
    return 0.0


@router.get("/{stock_id}/po-final-matches")
async def po_final_matches(stock_id: str, user: UserPublic = Depends(get_current_user)):
    lot = await get_floor_scoped_or_404(db.godown_stock, stock_id, user, not_found="Godown stock lot not found", projection={"_id": 0})
    return await _po_final_matches(lot)


@router.post("/{stock_id}/customer-transfers")
async def transfer_stock_to_customer(stock_id: str, body: CustomerTransfer, user: UserPublic = Depends(require_min_role("warehouse"))):
    for attempt in range(3):
        try:
            return await _transfer_stock_to_customer_once(stock_id, body, user)
        except DuplicateKeyError:
            # A repeated click may race the first request at the unique key.
            terminal = await db.settings.find_one(floor_query(user, {"_id": transfer_receipt_id(f"godown-transfer:{body.idempotency_key}")}), {"_id": 0})
            _validate_transfer_terminal(terminal, stock_id, user)
            existing = await db.godown_customer_transfers.find_one(
                floor_query(user, {"idempotency_key": f"godown-transfer:{body.idempotency_key}"}), {"_id": 0},
            )
            if existing:
                return _replayed_transfer(existing, stock_id, body, user)
            if terminal:
                raise removed_history_result(terminal)
            if await db.settings.find_one({"_id": transfer_receipt_id(f"godown-transfer:{body.idempotency_key}")}, {"_id": 1}):
                raise HTTPException(409, "This command was already used for another transfer.")
            raise
        except PyMongoError as exc:
            if attempt == 2 or not exc.has_error_label("TransientTransactionError"):
                raise
    raise RuntimeError("Unreachable transfer retry state")


def _transfer_view(row: dict) -> dict:
    return {key: value for key, value in row.items() if key not in {"_id", "request_sha256"}}


def _validate_transfer_terminal(receipt: dict | None, stock_id: str, user: UserPublic) -> None:
    if receipt and (receipt.get("kind") != "godown_transfer_completion" or receipt.get("stock_id") != stock_id
                    or (receipt.get("actor_id") and receipt["actor_id"] != user.id)):
        raise HTTPException(409, "This command was already used for another transfer.")


def _transfer_request_hash(stock_id: str, body: CustomerTransfer, user: UserPublic) -> str:
    return hashlib.sha256(json.dumps([user.id, stock_id, body.model_dump(mode="json", exclude={"idempotency_key"})], sort_keys=True).encode()).hexdigest()


def _replayed_transfer(existing: dict, stock_id: str, body: CustomerTransfer, user: UserPublic) -> dict:
    """A retry must not report success for a changed transfer form."""
    same_request = (
        existing.get("stock_id") == stock_id
        and float(existing.get("qty") or 0) == body.qty
        and existing.get("recipient_purchase_item_id") == body.recipient_purchase_item_id
        and (not body.recipient_customer_id or existing.get("recipient_customer_id") == body.recipient_customer_id)
        and (body.unit_price is None or float(existing.get("unit_price") or 0) == body.unit_price)
        and float(existing.get("discount_pct") or 0) == body.discount_pct
    )
    if existing.get("request_sha256"):
        same_request = same_request and existing["request_sha256"] == _transfer_request_hash(stock_id, body, user)
    if not same_request:
        raise HTTPException(status_code=409, detail={
            "code": "godown_transfer_already_recorded",
            "message": "This transfer was already recorded with different details. Review the recorded transfer before starting another.",
            "transfer": _transfer_view(existing),
        })
    return {**_transfer_view(existing), "idempotent": True}


def _transfer_quotation_line(lot: dict, body: CustomerTransfer, stock_id: str, at: str) -> QuotationLineItem:
    unit_price = float(body.unit_price if body.unit_price is not None else lot.get("unit_price") or 0)
    line = QuotationLineItem(
        product_id=lot.get("product_id") or f"godown:{stock_id}", sku=lot.get("sku") or "",
        name=lot.get("name") or "Godown stock", image=lot.get("image"),
        qty=body.qty, unit_price=unit_price,
        mrp=float(lot.get("mrp") if lot.get("mrp") is not None else lot.get("unit_price") or 0),
        discount_pct=body.discount_pct,
        godown_stock_id=stock_id, godown_source_customer_name=lot.get("source_customer_name"),
        godown_source_purchased_at=lot.get("source_purchased_at"), godown_transferred_at=at,
    )
    line.net_amount = recalc_quotation_totals([line])["grand_total"]
    return line


async def _new_transfer_quotation(lot: dict, recipient: dict, body: CustomerTransfer,
                                  stock_id: str, at: str, user: UserPublic, session) -> tuple[dict, QuotationLineItem]:
    year = datetime.now(timezone.utc).year
    number = await next_number("quotation", f"FQ-{year}-", collection="quotations", session=session)
    line = _transfer_quotation_line(lot, body, stock_id, at)
    quote = Quotation(
        number=number, customer_id=recipient["id"], customer_name=recipient.get("company") or recipient.get("name"),
        status="ordered", ordered_at=at, items=[line],
        **recalc_quotation_totals([line]),
        notes=f"Transferred from GoDown stock{f' — {body.reason}' if body.reason else ''}",
        created_by=user.id, created_by_name=user.full_name, source="transfer", floor_id=lot["floor_id"],
    ).model_dump()
    return quote, line


async def _customer_transfer_quotation(lot: dict, recipient: dict, body: CustomerTransfer,
                                       stock_id: str, at: str, user: UserPublic, session) -> tuple[dict, QuotationLineItem, bool]:
    """Append stock sales to the customer's transfer quote with an audit revision.

    Lock the customer inside the stock transaction before selecting the quote.
    Concurrent first transfers then conflict/retry rather than creating two
    commercial documents. Independent project quotations are never combined.
    Completed receipts stay attached when new goods reopen this balance.
    """
    await db.customers.update_one(
        {"id": recipient["id"], "floor_id": lot["floor_id"]},
        {"$inc": {"godown_transfer_revision": 1}}, session=session,
    )
    group_key = f"godown-customer:{lot['floor_id']}:{recipient['id']}"
    current = await db.quotations.find_one(
        {"floor_id": lot["floor_id"], "customer_id": recipient["id"],
         "status": {"$in": ["ordered", "won"]}, "transfer_group_key": group_key},
        {"_id": 0}, session=session,
    )
    if not current:
        # Adopt a previous stock-sale document without combining historical
        # orders. Provenance excludes project quotes and ordinary transfers.
        legacy = await db.quotations.find({
            "floor_id": lot["floor_id"], "customer_id": recipient["id"],
            "status": {"$in": ["ordered", "won"]}, "source": "transfer",
            "transfer_group_key": {"$exists": False},
            "source_purchase_order_id": {"$exists": True},
            "items.godown_stock_id": {"$exists": True},
            "project_name": {"$in": [None, ""]},
            "notes": {"$regex": "^Transferred from GoDown stock"},
        }, {"_id": 0}, session=session).sort("created_at", -1).to_list(1)
        current = legacy[0] if legacy else None
    if not current:
        quote, line = await _new_transfer_quotation(lot, recipient, body, stock_id, at, user, session)
        quote["transfer_group_key"] = group_key
        return quote, line, True
    line = _transfer_quotation_line(lot, body, stock_id, at)
    revision = QuotationRevision(
        revision_no=len(current.get("revisions") or []) + 1, created_at=at, created_by=user.id,
        reason=f"Added {body.qty:g} × {line.name} from GoDown stock" + (f" — {body.reason}" if body.reason else ""),
        snapshot={key: current.get(key) for key in (
            "items", "rooms", "notes", "status", "grand_total", "project_discount_pct",
            "category_discounts", "room_discounts", "customer_id", "customer_name", "transportation_fee",
        )},
    ).model_dump()
    items = [*(current.get("items") or []), line.model_dump()]
    project_discount = float(current.get("project_discount_pct") or 0)
    category_discounts = current.get("category_discounts") or {}
    room_discounts = {key: RoomDiscountCfg(**value) for key, value in (current.get("room_discounts") or {}).items()}
    totals = recalc_quotation_totals(
        [QuotationLineItem(**item) for item in items], project_discount, category_discounts, room_discounts,
    )
    totals["grand_total"] = round(totals["grand_total"] + float(current.get("transportation_fee") or 0), 2)
    update = {
        "items": stamp_net_amounts(items, project_discount, category_discounts, room_discounts),
        **totals,
        "revisions": [*(current.get("revisions") or []), revision], "updated_at": at,
        "transfer_group_key": group_key,
    }
    await db.quotations.update_one(
        {"id": current["id"], "floor_id": lot["floor_id"]}, {"$set": update}, session=session,
    )
    return {**current, **update}, line, False


async def _transfer_stock_to_customer_once(stock_id: str, body: CustomerTransfer, user: UserPublic):
    """Consume godown stock for a customer, optionally replacing PO Final demand."""
    if bool(body.recipient_customer_id) == bool(body.new_customer):
        raise HTTPException(status_code=422, detail="Choose one existing or new customer")
    command_key = f"godown-transfer:{body.idempotency_key}"
    terminal = await db.settings.find_one(floor_query(user, {"_id": transfer_receipt_id(command_key)}), {"_id": 0})
    _validate_transfer_terminal(terminal, stock_id, user)
    if terminal:
        if terminal.get("history_removed"):
            raise removed_history_result(terminal)
    existing = await db.godown_customer_transfers.find_one(floor_query(user, {"idempotency_key": command_key}), {"_id": 0})
    if existing:
        return _replayed_transfer(existing, stock_id, body, user)
    if terminal:
        raise removed_history_result(terminal)

    async with await client.start_session() as session:
        async with session.start_transaction():
            lot = await db.godown_stock.find_one(floor_query(user, {"id": stock_id}), {"_id": 0}, session=session)
            if not lot:
                raise HTTPException(status_code=404, detail="Godown stock lot not found")
            if lot.get("archived") or lot.get("quantity_missing"):
                raise HTTPException(status_code=409, detail="This stock lot has no confirmed available quantity")
            if body.unit_price is None and lot.get("unit_price") is None:
                raise HTTPException(status_code=422, detail="Record a unit price before transferring this stock")
            if float(lot.get("available_qty") or 0) - float(lot.get("loaned_out_qty") or 0) < body.qty:
                raise HTTPException(status_code=409, detail="Requested quantity exceeds stock available for customer transfer")
            recipient = None
            created_customer = False
            if body.recipient_customer_id:
                recipient = await db.customers.find_one({"id": body.recipient_customer_id, "floor_id": lot["floor_id"]}, {"_id": 0}, session=session)
                if not recipient:
                    raise HTTPException(status_code=404, detail="Recipient customer not found on this floor")
            else:
                data = body.new_customer
                assert data is not None
                email = (data.email or "").strip().lower()
                if email:
                    recipient = await db.customers.find_one({"email": email}, {"_id": 0}, session=session)
                    if recipient and recipient.get("floor_id") != lot["floor_id"]:
                        raise HTTPException(status_code=409, detail="Customer email belongs to another floor")
                if not recipient:
                    recipient = CustomerPublic(
                        name=data.name.strip(), company=(data.company or "").strip() or None,
                        email=email or None, phone=(data.phone or "").strip() or None,
                        floor_id=lot["floor_id"],
                    ).model_dump()
                    if not email:
                        recipient.pop("email", None)
                    await db.customers.insert_one(recipient, session=session)
                    created_customer = True
            matched_po = None
            matched_item = None
            replacement = None
            at = now_iso()
            transfer_id = str(uuid4())
            quote = None
            mrp = float(lot.get("mrp") if lot.get("mrp") is not None else lot.get("unit_price") or 0)
            unit_price = float(body.unit_price if body.unit_price is not None else lot.get("unit_price") or 0)
            net_unit_price = round(unit_price * (1 - body.discount_pct / 100), 2)
            if body.recipient_purchase_item_id:
                matched_po = await db.purchase_orders.find_one(
                    {"floor_id": lot["floor_id"], "customer_id": recipient["id"], "items.id": body.recipient_purchase_item_id},
                    {"_id": 0}, session=session,
                )
                matched_item = next((item for item in (matched_po or {}).get("items", []) if item.get("id") == body.recipient_purchase_item_id), None)
                if (not matched_po or matched_po.get("status") == "cancelled" or not matched_item
                        or matched_item.get("cancelled") or matched_item.get("stage") != "po_final"
                        or not _same_product(lot, matched_item)):
                    raise HTTPException(status_code=409, detail="Recipient purchase item is no longer a matching PO Final product")
                remaining_order_qty = float(matched_item.get("qty") or 0) - float(matched_item.get("godown_borrowed_qty") or 0)
                if body.qty > remaining_order_qty:
                    raise HTTPException(status_code=409, detail="Transfer quantity exceeds the recipient's ordered quantity")
                replacement = {
                    **matched_item, "id": str(uuid4()), "qty": body.qty, "qty_received": body.qty,
                    "stage": "in_box", "unit_cost": matched_item.get("unit_cost", 0),
                    "godown_stock_id": stock_id, "godown_allocation_id": None,
                    "godown_source_customer_name": lot.get("source_customer_name"),
                    "godown_source_purchased_at": lot.get("source_purchased_at"),
                    "godown_transferred_at": at, "godown_allocated_at": at,
                    "godown_customer_transfer_id": transfer_id,
                    "godown_transfer_mrp": mrp, "godown_transfer_unit_price": unit_price,
                    "godown_transfer_discount_pct": body.discount_pct,
                    "godown_transfer_net_unit_price": net_unit_price,
                    "last_moved_at": at, "last_moved_by": user.id,
                    "last_moved_by_name": user.full_name,
                    "stage_history": [{"from_stage": "po_final", "to_stage": "in_box", "by_user_id": user.id,
                                       "by_user_name": user.full_name, "note": "Transferred from GoDown stock",
                                       "action": "transfer_in", "at": at, "qty": body.qty}],
                }
                # Compare the complete current item so simultaneous fulfilment
                # of the same line cannot overwrite another staff member's work.
                demand_reserved = await db.purchase_orders.update_one(
                    {"id": matched_po["id"], "floor_id": lot["floor_id"], "items": matched_po["items"]},
                    {"$set": {"items": _replacement_items(matched_po["items"], matched_item["id"], replacement, body.qty), "updated_at": at}},
                    session=session,
                )
                if not demand_reserved.modified_count:
                    raise HTTPException(status_code=409, detail="Recipient PO Final quantity changed; refresh and try again")
                if not matched_po.get("quotation_id"):
                    # Older/manual POs have no confirmed customer order for
                    # Payments to display. Record this fulfilled quantity as
                    # an amount due, without inventing a cash collection.
                    quote, quote_line, new_quote = await _customer_transfer_quotation(lot, recipient, body, stock_id, at, user, session)
                    if new_quote:
                        quote["source_purchase_order_id"] = matched_po["id"]
                        quote["source_item_id"] = replacement["id"]
                        await db.quotations.insert_one(quote, session=session)
            else:
                # Payments reads confirmed quotations, while Purchases and the
                # customer workspace read PO items. A direct transfer needs
                # both records; a transfer-history row alone is invisible to
                # those screens. Keep all writes in the stock transaction.
                recipient_name = recipient.get("company") or recipient.get("name")
                year = datetime.now(timezone.utc).year
                po_number = await next_number("purchase_order", f"FPO-{year}-", collection="purchase_orders", session=session)
                quote, quote_line, new_quote = await _customer_transfer_quotation(lot, recipient, body, stock_id, at, user, session)
                replacement = PurchaseOrderItem(
                    product_id=quote_line.product_id, sku=quote_line.sku, name=quote_line.name,
                    image=lot.get("image"), qty=body.qty, qty_received=body.qty,
                    unit_cost=net_unit_price, quotation_line_id=quote_line.id,
                    stage="in_box", customer_id=recipient["id"], customer_name=recipient_name,
                    brand_id=lot.get("brand_id"), brand_name=lot.get("brand_name") or lot.get("brand"),
                    godown_stock_id=stock_id, godown_source_customer_name=lot.get("source_customer_name"),
                    godown_source_purchased_at=lot.get("source_purchased_at"), godown_transferred_at=at,
                    godown_allocated_at=at, godown_customer_transfer_id=transfer_id,
                    godown_transfer_mrp=mrp, godown_transfer_unit_price=unit_price,
                    godown_transfer_discount_pct=body.discount_pct,
                    godown_transfer_net_unit_price=net_unit_price,
                    last_moved_at=at, last_moved_by=user.id, last_moved_by_name=user.full_name,
                    stage_history=[PurchaseStageEvent(
                        from_stage=None, to_stage="in_box", by_user_id=user.id,
                        by_user_name=user.full_name, note="Transferred from GoDown stock", action="transfer_in",
                    )],
                ).model_dump()
                matched_po = PurchaseOrder(
                    number=po_number, quotation_id=quote["id"], quotation_number=quote["number"],
                    customer_id=recipient["id"], customer_name=recipient_name,
                    brand_id=lot.get("brand_id"), brand_name=lot.get("brand_name") or lot.get("brand"),
                    status="draft", items=[replacement],
                    subtotal=quote_line.net_amount, grand_total=quote_line.net_amount,
                    created_by=user.id, created_by_name=user.full_name, floor_id=lot["floor_id"],
                    internal_notes="Created from GoDown stock transfer",
                ).model_dump()
                if new_quote:
                    quote["source_purchase_order_id"] = matched_po["id"]
                    quote["source_item_id"] = replacement["id"]
                    await db.quotations.insert_one(quote, session=session)
                await db.purchase_orders.insert_one(matched_po, session=session)

            reserved = await db.godown_stock.update_one(
                {"id": stock_id, "floor_id": lot["floor_id"], "archived": {"$ne": True}, "quantity_missing": {"$ne": True}, "$expr": {"$gte": [
                    {"$subtract": [{"$ifNull": ["$available_qty", 0]}, {"$ifNull": ["$loaned_out_qty", 0]}]}, body.qty,
                ]}},
                {"$inc": {"available_qty": -body.qty}, "$set": {"updated_at": at}}, session=session,
            )
            if not reserved.modified_count:
                raise HTTPException(status_code=409, detail="Stock changed while transferring; refresh and try again")
            recipient_name = recipient.get("company") or recipient.get("name")
            transfer = {
                "id": transfer_id, "idempotency_key": command_key, "floor_id": lot["floor_id"],
                "request_sha256": _transfer_request_hash(stock_id, body, user),
                "stock_id": stock_id, "product_id": lot.get("product_id"), "sku": lot.get("sku"),
                "name": lot.get("name"), "image": lot.get("image"), "qty": body.qty,
                "source_customer_id": lot.get("source_customer_id"),
                "source_customer_name": lot.get("source_customer_name"),
                "recipient_customer_id": recipient["id"], "recipient_customer_name": recipient_name,
                "recipient_purchase_order_id": (matched_po or {}).get("id"),
                "recipient_purchase_item_id": body.recipient_purchase_item_id,
                "replacement_item_id": (replacement or {}).get("id"),
                "recipient_inbox_stage": "in_box" if replacement else None,
                "recipient_quotation_id": (quote or {}).get("id") or (matched_po or {}).get("quotation_id"),
                "transfer_type": "godown_stock", "status": "completed", "reason": body.reason,
                "mrp": mrp, "unit_price": unit_price, "discount_pct": body.discount_pct,
                "net_unit_price": net_unit_price, "total": quote_line.net_amount if quote else round(net_unit_price * body.qty, 2),
                "created_at": at, "created_by": user.id, "created_by_name": user.full_name,
            }
            await db.godown_customer_transfers.insert_one(transfer, session=session)
            await db.settings.insert_one(completion_receipt(transfer), session=session)

    await log_event(
        event_type="godown_stock.customer_transferred", entity_type="godown_stock", entity_id=stock_id,
        actor=user, floor_id=lot["floor_id"], customer_id=recipient["id"],
        quotation_id=transfer.get("recipient_quotation_id"), purchase_id=transfer.get("recipient_purchase_order_id"),
        summary=f"Transferred {body.qty:g} × {lot.get('name')} from GoDown stock to {recipient_name}",
        payload={"transfer_id": transfer["id"], "source_customer_id": lot.get("source_customer_id"),
                 "recipient_customer_id": recipient["id"], "qty": body.qty, "amount": transfer["total"]},
    )
    return {**_transfer_view(transfer), "created_customer": created_customer}


@router.post("/customer-transfers/{transfer_id}/return")
async def return_customer_transfer(transfer_id: str, body: ReturnTransfer, user: UserPublic = Depends(require_min_role("warehouse"))):
    async with await client.start_session() as session:
        async with session.start_transaction():
            transfer = await db.godown_customer_transfers.find_one(floor_query(user, {"id": transfer_id}), {"_id": 0}, session=session)
            if not transfer:
                raise HTTPException(status_code=404, detail="Customer transfer not found")
            if transfer.get("transfer_type") == "godown_stock" or transfer.get("status") == "completed":
                raise HTTPException(status_code=409, detail="A GoDown stock transfer is permanent and cannot be marked returned")
            if transfer["status"] == "returned":
                return _transfer_view(transfer)
            at = now_iso()
            result = await db.godown_customer_transfers.update_one(
                {"id": transfer_id, "floor_id": transfer["floor_id"], "status": "awaiting_return"},
                {"$set": {"status": "returned", "returned_at": at, "returned_by": user.id, "return_note": body.note}}, session=session,
            )
            if not result.modified_count:
                raise HTTPException(status_code=409, detail="Customer transfer changed; refresh and try again")
            await db.godown_stock.update_one(
                {"id": transfer["stock_id"], "floor_id": transfer["floor_id"]},
                {"$inc": {"loaned_out_qty": -float(transfer["qty"])}, "$set": {"updated_at": at}}, session=session,
            )
            if transfer.get("recipient_purchase_order_id") and transfer.get("recipient_purchase_item_id"):
                await db.purchase_orders.update_one(
                    {"id": transfer["recipient_purchase_order_id"], "floor_id": transfer["floor_id"], "items.id": transfer["recipient_purchase_item_id"]},
                    {"$inc": {"items.$.godown_borrowed_qty": -float(transfer["qty"])}, "$set": {"updated_at": at}}, session=session,
                )
    return {**_transfer_view(transfer), "status": "returned", "returned_at": at, "returned_by": user.id, "return_note": body.note, "return_due": False}




@router.get("/{stock_id}")
async def get_stock(stock_id: str, user: UserPublic = Depends(get_current_user)):
    return await _stock_response(await get_floor_scoped_or_404(db.godown_stock, stock_id, user, not_found="Godown stock lot not found", projection={"_id": 0}))


@router.patch("/{stock_id}/pricing")
async def update_stock_pricing(stock_id: str, body: StockPricingUpdate, user: UserPublic = Depends(require_min_role("warehouse"))):
    at = now_iso()
    lot = await db.godown_stock.find_one_and_update(
        floor_query(user, {"id": stock_id, "archived": {"$ne": True}}),
        {"$set": {"unit_price": body.unit_price, "price_variants": [variant.model_dump() for variant in body.price_variants], "updated_at": at}},
        return_document=ReturnDocument.AFTER,
    )
    if not lot:
        raise HTTPException(status_code=404, detail="Godown stock lot not found")
    await log_event(event_type="godown_stock.pricing_updated", entity_type="godown_stock", entity_id=stock_id, actor=user, floor_id=lot["floor_id"], summary=f"Updated pricing for {lot['name']}", payload={"unit_price": body.unit_price, "variant_count": len(body.price_variants)})
    return await _stock_response(lot)


@router.post("/{stock_id}/quantity-count")
async def record_missing_quantity(stock_id: str, body: MissingQuantityCount, user: UserPublic = Depends(require_min_role("warehouse"))):
    lot = await get_floor_scoped_or_404(db.godown_stock, stock_id, user, not_found="Godown stock lot not found", projection={"_id": 0})
    fingerprint = hashlib.sha256(json.dumps([user.id, body.model_dump(mode="json", exclude={"idempotency_key"})], sort_keys=True).encode()).hexdigest()
    def replay(row):
        for count in row.get("quantity_counts", []):
            if count.get("command_key") == body.idempotency_key and count.get("actor_id") == user.id:
                if count.get("payload_sha256") != fingerprint:
                    raise HTTPException(409, "This count was already recorded with different details. Review current stock.")
                return {**_stock_view(row), "idempotent": True}
        return None
    previous = replay(lot)
    if previous:
        return await _stock_response(previous)
    if lot.get("archived") or not lot.get("quantity_missing"):
        raise HTTPException(409, "This lot is no longer awaiting a quantity count. Reload and review current stock.")
    if lot.get("allocations") or lot.get("customer_transfers") or any(float(lot.get(field) or 0) != 0 for field in ("qty_received", "available_qty", "loaned_out_qty")):
        raise HTTPException(409, "This lot has recorded quantities or movements. Reconcile its history before recording a count.")
    if await db.godown_customer_transfers.find_one(floor_query(user, {"stock_id": stock_id}), {"_id": 1}):
        raise HTTPException(409, "This lot has transfer history. Reconcile its history before recording a count.")
    if lot.get("updated_at") != body.expected_updated_at:
        raise HTTPException(409, "Stock details changed. Reload and review this lot before recording the count.")
    at = now_iso()
    count = {"id": str(uuid4()), "qty": body.qty, "unit": "product_stock_unit", "counted_on": body.counted_on.isoformat(),
             "reason": body.reason, "actor_id": user.id, "actor_name": user.full_name, "recorded_at": at,
             "command_key": body.idempotency_key, "payload_sha256": fingerprint}
    guard = {"id": stock_id, "archived": {"$ne": True}, "quantity_missing": True, "updated_at": body.expected_updated_at,
             **{field: lot.get(field) for field in ("qty_received", "available_qty", "loaned_out_qty", "allocations", "customer_transfers", "quantity_counts")}}
    updated = await db.godown_stock.find_one_and_update(floor_query(user, guard), {
        "$set": {"qty_received": body.qty, "available_qty": body.qty, "quantity_missing": False, "updated_at": at},
        "$push": {"quantity_counts": count},
    }, return_document=ReturnDocument.AFTER)
    if not updated:
        current = await get_floor_scoped_or_404(db.godown_stock, stock_id, user, not_found="Godown stock lot not found", projection={"_id": 0})
        previous = replay(current)
        if previous:
            return await _stock_response(previous)
        raise HTTPException(409, "Stock changed while this count was being saved. Reload and review current stock.")
    return await _stock_response(updated)


@router.post("/{stock_id}/movements")
async def record_stock_movement(stock_id: str, body: StockMovement, user: UserPublic = Depends(require_min_role("warehouse"))):
    lot = await get_floor_scoped_or_404(db.godown_stock, stock_id, user, not_found="Godown stock lot not found", projection={"_id": 0})
    fingerprint = hashlib.sha256(json.dumps([user.id, body.model_dump(mode="json", exclude={"idempotency_key"})], sort_keys=True).encode()).hexdigest()
    def replay(row):
        for movement in row.get("stock_movements", []):
            if movement.get("command_key") == body.idempotency_key and movement.get("actor_id") == user.id:
                if movement.get("payload_sha256") != fingerprint:
                    raise HTTPException(409, "This movement was recorded with different details. Review current stock.")
                return {**_stock_view(row), "idempotent": True}
        return None
    previous = replay(lot)
    if previous:
        return await _stock_response(previous)
    if lot.get("archived") or lot.get("quantity_missing"):
        raise HTTPException(409, "Record a confirmed opening quantity before moving this stock.")
    if len(lot.get("stock_movements", [])) >= 1000:
        raise HTTPException(409, "This lot has reached its movement limit. Add a new intake lot.")
    if lot.get("updated_at") != body.expected_updated_at:
        raise HTTPException(409, "Stock changed. Refresh this lot and review the movement.")
    if body.kind == "adjustment_out" and body.qty > float(lot.get("available_qty") or 0) - float(lot.get("loaned_out_qty") or 0):
        raise HTTPException(409, "The movement exceeds stock available after reserved transfers.")
    changes = {"updated_at": now_iso()}
    if body.kind == "receipt" and not lot.get("catalog_product_id") and (not lot.get("product_id") or str(lot["product_id"]).startswith("godown:")):
        # Preserve legacy lot identity used by saved quotations while making its SKU reusable.
        product = await _intake_catalog_product(DirectIntake(
            qty=body.qty, sku=lot.get("sku"), name=lot.get("name"), brand=lot.get("brand_name"),
            category=lot.get("category"), unit_price=lot.get("unit_price"),
        ), lot["floor_id"])
        changes["catalog_product_id"] = product["id"]
        catalog_service.schedule_catalog_refresh()
    at = changes["updated_at"]
    movement = {"id": str(uuid4()), "kind": body.kind, "qty": body.qty, "occurred_on": body.occurred_on.isoformat(),
                "reason": body.reason, "actor_id": user.id, "actor_name": user.full_name, "recorded_at": at,
                "command_key": body.idempotency_key, "payload_sha256": fingerprint}
    increments = {"available_qty": body.qty if body.kind == "receipt" else -body.qty}
    if body.kind == "receipt":
        increments["qty_received"] = body.qty
    guard = {"id": stock_id, "archived": {"$ne": True}, "quantity_missing": {"$ne": True},
             "updated_at": body.expected_updated_at, "stock_movements": lot.get("stock_movements"),
             "available_qty": lot.get("available_qty"), "loaned_out_qty": lot.get("loaned_out_qty")}
    updated = await db.godown_stock.find_one_and_update({**guard, "floor_id": lot["floor_id"]}, {
        "$inc": increments, "$set": changes, "$push": {"stock_movements": movement},
    }, return_document=ReturnDocument.AFTER)
    if not updated:
        current = await get_floor_scoped_or_404(db.godown_stock, stock_id, user, not_found="Godown stock lot not found", projection={"_id": 0})
        previous = replay(current)
        if previous:
            return await _stock_response(previous)
        raise HTTPException(409, "Stock changed while saving. Refresh and review current stock.")
    return await _stock_response(updated)


@router.patch("/{stock_id}/details")
async def update_stock_details(stock_id: str, body: StockDetailsUpdate, user: UserPublic = Depends(require_min_role("warehouse"))):
    changes = body.model_dump(mode="json", exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422, detail="Provide a price, image or price variants to update")
    # A stock image override affects this lot only; previously issued quotes
    # and the manufacturer's catalog photo retain their original snapshots.
    if "image" in changes:
        changes["image_media_id"] = None
    lot = await db.godown_stock.find_one_and_update(
        floor_query(user, {"id": stock_id, "archived": {"$ne": True}}),
        {"$set": {**changes, "updated_at": now_iso()}}, return_document=ReturnDocument.AFTER,
    )
    if not lot:
        raise HTTPException(status_code=404, detail="Godown stock lot not found")
    await log_event(event_type="godown_stock.details_updated", entity_type="godown_stock", entity_id=stock_id,
                    actor=user, floor_id=lot["floor_id"], summary=f"Updated stock details for {lot['name']}",
                    payload={"fields": sorted(body.model_fields_set)})
    return await _stock_response(lot)


@router.post("/{stock_id}/image")
async def upload_stock_image(stock_id: str, file: UploadFile = File(...), user: UserPublic = Depends(require_min_role("warehouse"))):
    lot = await db.godown_stock.find_one(floor_query(user, {"id": stock_id, "archived": {"$ne": True}}), {"_id": 0})
    if not lot:
        raise HTTPException(status_code=404, detail="Godown stock lot not found")
    if not (file.content_type or "").startswith("image/"):
        raise HTTPException(status_code=400, detail="Choose a JPG, PNG, WebP or GIF photo")
    data = await _read_bounded_upload(file)
    try:
        media = await godown_media_service.upload_stock_photo(data=data, mime=file.content_type,
                                                              lot=lot, actor_id=user.id)
    except ProductImageNormalizationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    updated = await db.godown_stock.find_one_and_update(
        {"id": stock_id, "floor_id": lot["floor_id"], "archived": {"$ne": True}},
        {"$set": {"image": media["public_url"], "image_media_id": media["id"], "updated_at": now_iso()}},
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        # The registered photo remains attributed to the archived lot. Keep
        # historical bytes and metadata together rather than deleting a URL
        # that may already be present in an issued quotation.
        raise HTTPException(status_code=409, detail="Stock changed while saving the photo; refresh and try again")
    await log_event(event_type="godown_stock.image_updated", entity_type="godown_stock", entity_id=stock_id,
                    actor=user, floor_id=lot["floor_id"], summary=f"Updated photo for {lot['name']}",
                    payload={"media_id": media["id"]})
    return _stock_view(updated)


async def _intake_catalog_product(body: DirectIntake, floor_id: str) -> dict:
    """Persist reusable catalog identity before inventory; retries reuse its SKU."""
    if not body.sku or not body.sku.strip() or not body.name or not body.name.strip():
        raise HTTPException(422, "SKU and product name are required to register reusable stock. Add a labelled intake for unlabelled material.")
    async def relation(collection, name, kind):
        existing = await collection.find_one({"floor_id": floor_id, "name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}, {"_id": 0})
        if existing:
            return existing
        identity = str(uuid5(NAMESPACE_URL, f"godown:{kind}:{floor_id}:{name.casefold()}"))
        row = {"id": identity, "floor_id": floor_id, "name": name, "slug": f"godown-{identity}", "created_at": now_iso(), "updated_at": now_iso()}
        await collection.update_one({"_id": f"godown-{kind}:{identity}"}, {"$setOnInsert": row}, upsert=True)
        return row
    brand = await relation(db.brands, (body.brand or "").strip() or "Unbranded", "brand")
    category = await relation(db.categories, (body.category or "").strip() or "Godown stock", "category")
    lookup = {"floor_id": floor_id, "brand_id": brand["id"], "sku": body.sku.strip()}
    product = await db.products.find_one(lookup, {"_id": 0})
    if product:
        if not product.get("active", True):
            raise HTTPException(409, "This SKU is inactive in the catalog. Restore it before adding stock.")
        return product
    identity = str(uuid5(NAMESPACE_URL, f"godown-product:{floor_id}:{brand['id']}:{body.sku.strip()}"))
    product = Product(id=identity, floor_id=floor_id, sku=body.sku.strip(), name=body.name.strip(),
                      brand_id=brand["id"], category_id=category["id"], mrp=body.unit_price or 0, price=body.unit_price or 0,
                      price_status="known" if body.unit_price is not None else "unspecified",
                      size=body.size, description=body.feature, images=[str(body.image)] if body.image else [],
                      is_custom=True, catalog_source="godown_intake").model_dump()
    try:
        await db.products.insert_one({**product, "_id": f"godown-product:{identity}"})
    except DuplicateKeyError:
        product = await db.products.find_one(lookup, {"_id": 0})
        if not product or not product.get("active", True):
            raise HTTPException(409, "Catalog changed while adding stock. Review the SKU and retry.") from None
    return {**product, "brand_name": brand["name"]}


@router.post("/direct-intakes")
async def direct_intake(body: DirectIntake, user: UserPublic = Depends(require_min_role("warehouse"))):
    """Add catalog or independently described material without a customer source."""
    floor_id = floor_for_write(user)
    # The built-in unique _id makes the command and stock insertion one atomic
    # document write. Keep the receipt on archived lots so an old replay cannot
    # recreate inventory after reconciliation. Legacy clients may omit the key.
    command_id = None
    command_hash = None
    if body.idempotency_key:
        command_id = "godown-intake:" + hashlib.sha256(json.dumps(
            [user.id, floor_id, body.idempotency_key], separators=(",", ":"),
        ).encode()).hexdigest()
        command_hash = hashlib.sha256(json.dumps(
            body.model_dump(mode="json", exclude={"idempotency_key"}), sort_keys=True,
            separators=(",", ":"), allow_nan=False,
        ).encode()).hexdigest()

        def replay(existing):
            if existing.get("intake_command", {}).get("payload_sha256") != command_hash:
                raise HTTPException(status_code=409, detail="This stock intake was already recorded with different details. Review the recorded lot before adding more stock.")
            return {**_stock_view(existing), "idempotent": True}

        existing = await db.godown_stock.find_one(floor_query(user, {"_id": command_id}))
        if existing:
            return replay(existing)
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
    if not product and body.unit_price is None:
        raise HTTPException(status_code=422, detail="Unit price is required for a product outside the catalog")
    manual = product is None
    if manual:
        product = await _intake_catalog_product(body, floor_id)
        catalog_service.schedule_catalog_refresh()
    at = now_iso()
    lot_id = str(uuid4())
    catalog_price = product.get("mrp") if product and (product.get("price_status") or (product.get("specs") or {}).get("price_status")) != "unspecified" else None
    # Catalog models retain a numeric zero placeholder for unknown prices.
    # Carry the explicit unknown status into stock instead of asserting a gift.
    stock_price = body.unit_price if body.unit_price is not None else catalog_price
    stock_mrp = catalog_price if catalog_price is not None else body.unit_price
    lot = {
        "id": lot_id, "floor_id": floor_id,
        "product_id": product["id"],
        "sku": (product or {}).get("sku") or (body.sku or "").strip(),
        "name": (product or {}).get("name") or (body.name or "").strip(),
        "image": (await _catalog_images([product])).get(product["id"]) if product else body.image,
        "size": (product or {}).get("size") or body.size,
        "feature": (product or {}).get("feature") or body.feature,
        "category": body.category,
        "category_id": (product or {}).get("category_id"),
        "brand_id": (product or {}).get("brand_id"),
        "brand_name": (product or {}).get("brand_name") or body.brand,
        "mrp": float(stock_mrp) if stock_mrp is not None else None,
        "unit_price": float(stock_price) if stock_price is not None else None,
        "discount_pct": 0,
        "price_variants": [variant.model_dump() for variant in body.price_variants],
        "qty_received": body.qty, "available_qty": body.qty,
        "reason": body.reason.strip(), "source_type": "manual" if manual else "catalog",
        "transferred_at": at, "transferred_by": user.id, "transferred_by_name": user.full_name,
        "allocations": [], "created_at": at, "updated_at": at,
    }
    if command_id:
        lot["_id"] = command_id
        lot["intake_command"] = {"payload_sha256": command_hash, "actor_id": user.id}
    try:
        await db.godown_stock.insert_one(lot)
    except DuplicateKeyError:
        if not command_id:
            raise
        existing = await db.godown_stock.find_one(floor_query(user, {"_id": command_id}))
        if not existing:
            raise
        return replay(existing)
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
    received_qty = float(item["qty_received"] if item.get("qty_received") is not None else item.get("qty") or 0)
    promised = max(0.0, float(item.get("loan_replenishment_promised_qty") or 0) - float(item.get("loan_replenishment_returned_qty") or 0))
    transferable = received_qty - float(item.get("godown_transferred_qty") or 0) - float(item.get("loan_replenishment_returned_qty") or 0) - float(item.get("loaned_qty") or 0) - promised
    if body.qty > transferable:
        raise HTTPException(status_code=409, detail=f"Only {transferable:g} units are available to transfer")
    product = await db.products.find_one(floor_query(user, {"id": item["product_id"]}), {"_id": 0, "brand_id": 1, "floor_id": 1, "mrp": 1}) or {}
    source_quote = None
    if po.get("quotation_id"):
        source_quote = await db.quotations.find_one(floor_query(user, {"id": po["quotation_id"]}), {"_id": 0, "created_at": 1, "ordered_at": 1, "items": 1})
    quote_line = next((line for line in (source_quote or {}).get("items", []) if line.get("id") == item.get("quotation_line_id")), None)
    mrp = _stock_mrp(product, quote_line, item)
    at = now_iso()
    lot = {
        "id": str(uuid4()), "floor_id": po["floor_id"], "product_id": item["product_id"], "sku": item.get("sku"), "name": item.get("name"), "image": item.get("image"), "finish": item.get("finish"),
        "brand_id": item.get("brand_id") or product.get("brand_id"), "brand_name": item.get("brand_name") or po.get("brand_name"), "qty_received": body.qty, "available_qty": body.qty,
        "mrp": mrp, "unit_price": mrp,
        "discount_pct": 0, "price_variants": [],
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
    await notify(user.id, "Godown stock added", body=(f"{body.qty:g} × {item.get('name')} from {po.get('customer_name')} is available to reuse." + (f" Customer balance reduced by ₹{format_indian_money(credit_amount)}." if credit_amount else "")), kind="success", link="/(admin)/godown-stock", floor_id=po["floor_id"])
    try:
        await cache.bump("payments")
    except Exception:
        logger.exception("cache bump failed after godown stock intake for %s", lot["id"])
    if payment:
        # Outstanding-balance follow-ups are derived from the same ledger.
        # Run reconciliation after the transaction commits, never inside it.
        asyncio.create_task(reconcile_followups_admitted())
    return _stock_view(lot)


@router.post("/{stock_id}/allocate")
async def allocate_stock(stock_id: str, body: Allocation, user: UserPublic = Depends(require_min_role("sales"))):
    quote = await get_floor_scoped_or_404(db.quotations, body.quotation_id, user, not_found="Quotation not found", projection={"_id": 0})
    if quote.get("status") not in {"draft", "sent", "approved"}:
        raise HTTPException(status_code=409, detail="Godown stock can only be added to an open quotation")
    at = now_iso()
    allocation = {"id": str(uuid4()), "quotation_id": quote["id"], "quotation_number": quote.get("number"), "customer_id": quote.get("customer_id"), "customer_name": quote.get("customer_name"), "qty": body.qty, "allocated_at": at, "allocated_by": user.id, "allocated_by_name": user.full_name}
    lot = await db.godown_stock.find_one_and_update(
        floor_query(user, {"id": stock_id, "archived": {"$ne": True}, "quantity_missing": {"$ne": True}, "unit_price": {"$ne": None}, "$expr": {"$gte": [
            {"$subtract": [{"$ifNull": ["$available_qty", 0]}, {"$ifNull": ["$loaned_out_qty", 0]}]}, body.qty,
        ]}}),
        {"$inc": {"available_qty": -body.qty}, "$push": {"allocations": allocation}, "$set": {"updated_at": at}},
        return_document=ReturnDocument.AFTER,
    )
    if not lot:
        raise HTTPException(status_code=409, detail="That stock is no longer available in the requested quantity")
    line = {"id": str(uuid4()), "product_id": lot["product_id"], "sku": lot["sku"], "name": lot["name"], "image": lot.get("image"), "finish": lot.get("finish"), "qty": body.qty, "unit_price": float(lot.get("unit_price") or 0), "room": None, "godown_stock_id": stock_id, "godown_allocation_id": allocation["id"], "godown_source_customer_name": lot.get("source_customer_name"), "godown_source_purchased_at": lot.get("source_purchased_at"), "godown_transferred_at": lot.get("transferred_at"), "godown_allocated_at": at}
    await db.quotations.update_one({"id": quote["id"]}, {"$push": {"items": line}, "$set": {"updated_at": at}})
    await log_event(event_type="godown_stock.allocated", entity_type="quotation", entity_id=quote["id"], actor=user, floor_id=quote["floor_id"], customer_id=quote.get("customer_id"), quotation_id=quote["id"], summary=f"Added {body.qty:g} × {lot['name']} from godown stock", payload={"stock_id": stock_id, "allocation_id": allocation["id"], "source_customer": lot.get("source_customer_name"), "source_purchased_at": lot.get("source_purchased_at"), "allocated_at": at})
    await notify(user.id, "Godown stock allocated", body=f"{body.qty:g} × {lot['name']} was added to {quote.get('number')} for {quote.get('customer_name')}.", kind="info", link=f"/(admin)/quotations/{quote['id']}", floor_id=quote["floor_id"])
    return {"allocation": allocation, "line": line, "remaining_qty": float(lot.get("available_qty") or 0)}
