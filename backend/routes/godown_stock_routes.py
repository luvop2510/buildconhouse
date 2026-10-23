from services.followup_engine import reconcile_followups_admitted
"""Sanitary godown stock — returned/declined material that can be reused.

Lots are intentionally separate from tile logistics.  Each lot preserves its
customer and original-purchase provenance and is consumed with a conditional
quantity update, so two staff members cannot allocate the same unit.
"""
import asyncio
import logging
import re
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator
from pymongo.errors import DuplicateKeyError, PyMongoError

from auth import floor_for_write, floor_query, get_current_user, get_floor_scoped_or_404, require_min_role
from db import client, db
from pymongo import ReturnDocument
from models import (
    CustomerPublic, Payment, PurchaseOrder, PurchaseOrderItem, PurchaseStageEvent,
    Quotation, QuotationLineItem, QuotationRevision, RoomDiscountCfg, UserPublic, now_iso,
)
from services.activity_log import log_event
from services.analytics import cache
from services.followup_engine import reconcile_followups
from services.notifications import notify
from services.sequence import next_number
from services.pricing import per_line_net_amounts, recalc_quotation_totals, stamp_net_amounts
from services import godown_media_service
from services.product_image_normalizer import ProductImageNormalizationError
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
    unit_price: float | None = Field(default=None, ge=0)
    price_variants: list[StockPriceVariant] = Field(default_factory=list, max_length=20)


class NewTransferCustomer(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    company: str | None = None
    email: str | None = None
    phone: str | None = None


class CustomerTransfer(BaseModel):
    qty: float = Field(gt=0)
    recipient_customer_id: str | None = None
    new_customer: NewTransferCustomer | None = None
    recipient_purchase_item_id: str | None = None
    reason: str | None = Field(default=None, max_length=280)
    unit_price: float | None = Field(default=None, ge=0)
    discount_pct: float = Field(default=0, ge=0, le=100)
    idempotency_key: str = Field(min_length=8, max_length=160)


class ReturnTransfer(BaseModel):
    note: str | None = Field(default=None, max_length=280)


def _stock_view(lot: dict) -> dict:
    row = {key: value for key, value in lot.items() if key not in {"_id", "source_provenance", "catalog_provenance", "image_local"}}
    row["stock_value"] = round(float(row.get("available_qty") or 0) * float(row["unit_price"]), 2) if row.get("unit_price") is not None and not row.get("quantity_missing") else None
    row["transferable_qty"] = 0 if row.get("quantity_missing") or row.get("archived") else max(0.0, round(float(row.get("available_qty") or 0) - float(row.get("loaned_out_qty") or 0), 4))
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
                    "$and": [
                        {"$or": [
                            {"godown_transferred_qty": {"$lte": received_qty - float(item.get("loan_replenishment_returned_qty") or 0) - float(item.get("loaned_qty") or 0) - qty}},
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
):
    query: dict = floor_query(user, {} if include_history else {"$or": [{"available_qty": {"$gt": 0}}, {"quantity_missing": True}]})
    query["archived"] = {"$ne": True}
    if brand_id:
        query["brand_id"] = brand_id
    if q and q.strip():
        literal = re.escape(q.strip())
        query["$or"] = [{field: {"$regex": literal, "$options": "i"}}
                        for field in ("name", "sku", "brand_name")]
    lots = await db.godown_stock.find(query, {"_id": 0, "source_provenance": 0, "catalog_provenance": 0, "image_local": 0}).sort("transferred_at", -1).to_list(2001)
    if len(lots) > 2000:
        raise HTTPException(status_code=409, detail="More than 2,000 stock lots match. Select a brand or search to narrow the list.")
    transfer_map: dict[str, list[dict]] = {}
    if include_history and lots:
        transfers = await db.godown_customer_transfers.find(
            floor_query(user, {"stock_id": {"$in": [lot["id"] for lot in lots]}}), {"_id": 0},
        ).sort("created_at", -1).to_list(2000)
        for transfer in transfers:
            transfer_map.setdefault(transfer["stock_id"], []).append(transfer)
    brands: dict[str, dict] = {}
    for lot in lots:
        key = lot.get("brand_id") or lot.get("brand_name") or "unbranded"
        row = brands.setdefault(key, {"id": lot.get("brand_id"), "name": lot.get("brand_name") or "Other", "lot_count": 0, "available_qty": 0})
        row["lot_count"] += 1
        if not lot.get("quantity_missing"):
            row["available_qty"] += float(lot.get("available_qty") or 0)
    return {"lots": [{**_stock_view(lot), "customer_transfers": transfer_map.get(lot["id"], [])} for lot in lots], "brands": sorted(brands.values(), key=lambda row: row["name"].lower()), "total_available_qty": sum(float(lot.get("available_qty") or 0) for lot in lots if not lot.get("quantity_missing")), "total_stock_value": round(sum(float(lot.get("available_qty") or 0) * float(lot["unit_price"]) for lot in lots if lot.get("unit_price") is not None and not lot.get("quantity_missing")), 2), "unpriced_lot_count": sum(1 for lot in lots if (float(lot.get("available_qty") or 0) > 0 or lot.get("quantity_missing")) and lot.get("unit_price") is None)}


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
    return {"transfers": rows}


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
            existing = await db.godown_customer_transfers.find_one(
                floor_query(user, {"idempotency_key": f"godown-transfer:{body.idempotency_key}"}), {"_id": 0},
            )
            if existing:
                return _replayed_transfer(existing, stock_id, body)
            raise
        except PyMongoError as exc:
            if attempt == 2 or not exc.has_error_label("TransientTransactionError"):
                raise
    raise RuntimeError("Unreachable transfer retry state")


def _replayed_transfer(existing: dict, stock_id: str, body: CustomerTransfer) -> dict:
    """A retry must not report success for a changed transfer form."""
    same_request = (
        existing.get("stock_id") == stock_id
        and float(existing.get("qty") or 0) == body.qty
        and existing.get("recipient_purchase_item_id") == body.recipient_purchase_item_id
        and (not body.recipient_customer_id or existing.get("recipient_customer_id") == body.recipient_customer_id)
        and (body.unit_price is None or float(existing.get("unit_price") or 0) == body.unit_price)
        and float(existing.get("discount_pct") or 0) == body.discount_pct
    )
    if not same_request:
        raise HTTPException(status_code=409, detail="This transfer was already recorded with different details. Refresh the stock and try again.")
    return {**existing, "idempotent": True}


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
    existing = await db.godown_customer_transfers.find_one(floor_query(user, {"idempotency_key": command_key}), {"_id": 0})
    if existing:
        return _replayed_transfer(existing, stock_id, body)

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

    await log_event(
        event_type="godown_stock.customer_transferred", entity_type="godown_stock", entity_id=stock_id,
        actor=user, floor_id=lot["floor_id"], customer_id=recipient["id"],
        quotation_id=transfer.get("recipient_quotation_id"), purchase_id=transfer.get("recipient_purchase_order_id"),
        summary=f"Transferred {body.qty:g} × {lot.get('name')} from GoDown stock to {recipient_name}",
        payload={"transfer_id": transfer["id"], "source_customer_id": lot.get("source_customer_id"),
                 "recipient_customer_id": recipient["id"], "qty": body.qty, "amount": transfer["total"]},
    )
    return {**transfer, "created_customer": created_customer}


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
                return transfer
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
    return {**transfer, "status": "returned", "returned_at": at, "returned_by": user.id, "return_note": body.note, "return_due": False}


@router.get("/{stock_id}")
async def get_stock(stock_id: str, user: UserPublic = Depends(get_current_user)):
    return _stock_view(await get_floor_scoped_or_404(db.godown_stock, stock_id, user, not_found="Godown stock lot not found", projection={"_id": 0}))


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
    return _stock_view(lot)


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
    return _stock_view(lot)


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
    if not product and body.unit_price is None:
        raise HTTPException(status_code=422, detail="Unit price is required for a product outside the catalog")
    at = now_iso()
    lot_id = str(uuid4())
    catalog_price = product.get("mrp") if product and (product.get("price_status") or (product.get("specs") or {}).get("price_status")) != "unspecified" else None
    # Catalog models retain a numeric zero placeholder for unknown prices.
    # Carry the explicit unknown status into stock instead of asserting a gift.
    stock_price = body.unit_price if body.unit_price is not None else catalog_price
    stock_mrp = catalog_price if catalog_price is not None else body.unit_price
    lot = {
        "id": lot_id, "floor_id": floor_id,
        # Stock-only lines use an opaque id tied to this lot. It is never
        # inserted into catalog/products, so manual entries stay private to
        # the godown while quotations can still identify their source.
        "product_id": (product or {}).get("id") or f"godown:{lot_id}",
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
    received_qty = float(item["qty_received"] if item.get("qty_received") is not None else item.get("qty") or 0)
    transferable = received_qty - float(item.get("godown_transferred_qty") or 0) - float(item.get("loan_replenishment_returned_qty") or 0) - float(item.get("loaned_qty") or 0)
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
    await notify(user.id, "Godown stock added", body=(f"{body.qty:g} × {item.get('name')} from {po.get('customer_name')} is available to reuse." + (f" Customer balance reduced by ₹{credit_amount:,.2f}." if credit_amount else "")), kind="success", link="/(admin)/godown-stock", floor_id=po["floor_id"])
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
