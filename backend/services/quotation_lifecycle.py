"""Keep an edited confirmed quotation and its operational projections aligned.

The quotation is the commercial source of truth.  Once it has been converted
to an order, purchase orders and the pending-balance row are projections of
that source.  Editing a quote used to change only its total, which left a
customer owing the revised amount while Purchasing still ordered the old
products.  This module makes that reconciliation explicit and deliberately
refuses changes after a line has entered fulfilment.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from db import db
from models import (
    PurchaseCancellationEvent,
    PurchaseOrder,
    PurchaseOrderItem,
    PurchaseStageEvent,
    PurchaseStatusEvent,
    UserPublic,
)
from services.pricing import per_line_net_amounts
from services.sequence import next_number


ORDER_STATUSES = {"ordered", "won"}
_EPSILON = 1e-6


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _collection_total(quotation: dict) -> float:
    history = quotation.get("payment_extra_history")
    extras = (
        sum(float(entry.get("amount") or 0) for entry in history)
        if isinstance(history, list)
        else float(quotation.get("payment_extra_amount") or 0)
    )
    return round(float(quotation.get("grand_total") or 0) + extras, 2)


def purchase_item_is_mutable(item: dict) -> bool:
    """True only while an item has not entered a real material workflow.

    A revised quote must never quietly erase a supplier order, goods already
    received, a godown move, or a tile release/dispatch.  Those situations
    need their dedicated Purchasing adjustment/refund workflow instead.
    """
    if item.get("cancelled"):
        return True
    return (
        item.get("stage", "order_in_company") == "order_in_company"
        and float(item.get("qty_received") or 0) <= _EPSILON
        and float(item.get("godown_transferred_qty") or 0) <= _EPSILON
        and float(item.get("boxes_ready") or 0) <= _EPSILON
        and float(item.get("boxes_godown") or 0) <= _EPSILON
        and float(item.get("boxes_dispatched") or 0) <= _EPSILON
        and not item.get("transferred_from_item_id")
        and not item.get("split_from_item_id")
    )


def _line_changed(old: dict, new: dict | None) -> bool:
    if new is None:
        return True
    # Purchase values and product identity must track these quotation fields.
    fields = ("product_id", "sku", "name", "image", "finish", "category_id", "room", "qty", "unit_price", "net_amount", "godown_stock_id", "godown_allocation_id")
    return any(old.get(field) != new.get(field) for field in fields)


async def _completed_paid(quotation_id: str) -> float:
    rows = await db.payments.aggregate([
        {"$match": {"quotation_id": quotation_id, "status": "completed"}},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]).to_list(1)
    return float(rows[0].get("total") or 0) if rows else 0.0


async def preflight_ordered_quotation_change(previous: dict, proposed: dict) -> None:
    """Reject an unsafe confirmed-order product/price change before writes."""
    if previous.get("status") not in ORDER_STATUSES:
        return
    if proposed.get("customer_id") != previous.get("customer_id"):
        raise HTTPException(
            status_code=409,
            detail="The customer cannot be changed after an order is placed. Create a transfer order instead.",
        )
    line_ids = [str(item.get("id") or "") for item in proposed.get("items") or []]
    if len(line_ids) != len(set(line_ids)) or not all(line_ids):
        raise HTTPException(status_code=422, detail="Every quotation line must have a unique id.")

    # A new line or a product swap must resolve to an active product before
    # the commercial document changes.  Without this guard the quotation
    # write could commit and the following purchase reconciliation could fail
    # while trying to create its replacement PO item.
    previous_lines = {item.get("id"): item for item in previous.get("items") or []}
    introduced_product_ids = {
        item.get("product_id")
        for item in proposed.get("items") or []
        if item.get("product_id")
        and (
            item.get("id") not in previous_lines
            or previous_lines[item.get("id")].get("product_id") != item.get("product_id")
        )
    }
    if introduced_product_ids:
        found = await db.products.find(
            {"id": {"$in": list(introduced_product_ids)}, "floor_id": previous.get("floor_id")},
            {"_id": 0, "id": 1},
        ).to_list(len(introduced_product_ids) + 1)
        if {row.get("id") for row in found} != introduced_product_ids:
            raise HTTPException(status_code=409, detail="One or more replacement products are no longer available.")

    paid = await _completed_paid(previous["id"])
    new_total = _collection_total(proposed)
    if new_total + 0.01 < paid:
        raise HTTPException(
            status_code=409,
            detail=(
                f"This change would reduce the order below its completed payments "
                f"(₹{paid:,.2f}). Record a refund/credit before reducing products."
            ),
        )

    desired = {item["id"]: item for item in proposed.get("items") or []}
    purchase_orders = await db.purchase_orders.find(
        {"quotation_id": previous["id"], "floor_id": previous.get("floor_id")}, {"_id": 0, "items": 1},
    ).to_list(500)
    blocked: list[str] = []
    for po in purchase_orders:
        for item in po.get("items") or []:
            line_id = item.get("quotation_line_id")
            if not line_id or item.get("cancelled"):
                continue
            if _line_changed(item, desired.get(line_id)) and not purchase_item_is_mutable(item):
                blocked.append(str(item.get("name") or item.get("sku") or line_id))
    if blocked:
        raise HTTPException(
            status_code=409,
            detail=(
                "This product has already entered Purchasing/fulfilment and cannot be changed from the quotation: "
                + ", ".join(blocked[:3])
                + ". Use the Purchasing adjustment workflow instead."
            ),
        )


def _cancel_purchase_item(item: dict, user: UserPublic, reason: str | None) -> dict:
    now = _now()
    history = list(item.get("cancellation_history") or [])
    history.append(PurchaseCancellationEvent(
        by_user_id=user.id, by_user_name=user.full_name, reason=reason,
    ).model_dump())
    return {
        **item,
        "cancelled": True,
        "cancelled_at": now,
        "cancelled_by": user.id,
        "cancelled_by_name": user.full_name,
        "cancellation_reason": reason,
        "cancellation_history": history,
    }


def _po_totals(items: list[dict]) -> float:
    return round(sum(
        float(item.get("qty") or 0) * float(item.get("unit_cost") or 0)
        for item in items if not item.get("cancelled")
    ), 2)


def _new_po_item(raw: dict, *, unit_cost: float, product: dict, user: UserPublic) -> dict:
    now = _now()
    stage = "in_box" if raw.get("godown_stock_id") else "order_in_company"
    return PurchaseOrderItem(
        product_id=raw["product_id"], sku=raw["sku"], name=raw["name"], image=raw.get("image"),
        finish=raw.get("finish"), category_id=raw.get("category_id"), room=raw.get("room"),
        qty=float(raw.get("qty") or 0), unit_cost=unit_cost, quotation_line_id=raw["id"],
        stage=stage, customer_id=raw.get("customer_id"), customer_name=raw.get("customer_name"),
        brand_id=product.get("brand_id"), brand_name=product.get("brand_name"),
        last_moved_at=now, last_moved_by=user.id, last_moved_by_name=user.full_name,
        stage_history=[PurchaseStageEvent(
            from_stage=None, to_stage=stage, by_user_id=user.id, by_user_name=user.full_name,
            note="Added by quotation revision", action="create",
        )],
        godown_stock_id=raw.get("godown_stock_id"), godown_allocation_id=raw.get("godown_allocation_id"),
        godown_source_customer_name=raw.get("godown_source_customer_name"),
        godown_source_purchased_at=raw.get("godown_source_purchased_at"),
        godown_transferred_at=raw.get("godown_transferred_at"),
        series=product.get("series"), size=raw.get("size"), pieces_per_box=raw.get("pcs_per_box"),
        quantity_unit=raw.get("quantity_unit") or "Box", boxes_pending=float(raw.get("qty") or 0),
    ).model_dump()


async def _next_purchase_number() -> str:
    year = datetime.now(timezone.utc).year
    return await next_number("purchase_order", f"FPO-{year}-", collection="purchase_orders")


async def reconcile_ordered_quotation(previous: dict, current: dict, user: UserPublic, *, reason: str | None = None) -> dict:
    """Rebuild mutable purchase projections after a confirmed quote edit.

    Existing PO items are retained and marked cancelled for audit; products
    are never deleted from a supplier-facing document.  New or swapped lines
    are added to a matching draft PO or to a new PO for their brand.
    """
    if previous.get("status") not in ORDER_STATUSES:
        return {"purchase_orders": 0, "cancelled_lines": 0, "added_lines": 0, "pending_balance": None}

    desired = {item["id"]: dict(item) for item in current.get("items") or []}
    net_by_line = per_line_net_amounts(current)
    product_ids = list({item.get("product_id") for item in desired.values() if item.get("product_id")})
    products = await db.products.find(
        {"id": {"$in": product_ids}, "floor_id": current.get("floor_id")},
        {"_id": 0, "id": 1, "brand_id": 1, "series": 1},
    ).to_list(len(product_ids) + 5)
    product_by_id = {product["id"]: product for product in products}
    brand_ids = list({product.get("brand_id") for product in products if product.get("brand_id")})
    brands = await db.brands.find({"id": {"$in": brand_ids}}, {"_id": 0, "id": 1, "name": 1}).to_list(len(brand_ids) + 5)
    brand_names = {brand["id"]: brand.get("name") or "Unassigned" for brand in brands}
    for product in products:
        product["brand_name"] = brand_names.get(product.get("brand_id"), "Unassigned")

    pos = await db.purchase_orders.find(
        {"quotation_id": current["id"], "floor_id": current.get("floor_id")}, {"_id": 0},
    ).to_list(500)
    by_id = {po["id"]: po for po in pos}
    handled_lines: set[str] = set()
    changed_pos: set[str] = set()
    cancelled_lines = 0

    # First retain/update like-for-like lines, or cancel removed/swapped ones.
    for po in pos:
        changed = False
        items_out: list[dict] = []
        for item in po.get("items") or []:
            line_id = item.get("quotation_line_id")
            target = desired.get(line_id) if line_id else None
            if item.get("cancelled") or not line_id:
                items_out.append(item)
                continue
            if target and target.get("product_id") == item.get("product_id"):
                unit_cost = round(net_by_line.get(line_id, 0) / float(target.get("qty") or 1), 2)
                product = product_by_id.get(target["product_id"], {})
                refreshed = {
                    **item, "sku": target.get("sku"), "name": target.get("name"), "image": target.get("image"),
                    "finish": target.get("finish"), "category_id": target.get("category_id"), "room": target.get("room"),
                    "qty": float(target.get("qty") or 0), "unit_cost": unit_cost,
                    "series": product.get("series"), "size": target.get("size"),
                    "pieces_per_box": target.get("pcs_per_box"), "quantity_unit": target.get("quantity_unit") or "Box",
                }
                if refreshed != item:
                    changed = True
                items_out.append(refreshed)
                handled_lines.add(line_id)
            else:
                items_out.append(_cancel_purchase_item(item, user, reason or "Removed or swapped in quotation"))
                changed = True
                cancelled_lines += 1
        if changed:
            po["items"] = items_out
            changed_pos.add(po["id"])

    # Add every genuinely new/swap-replacement line to a compatible draft PO.
    suppliers = await db.suppliers.find(
        {"brand_id": {"$in": brand_ids}, "floor_id": current.get("floor_id"), "active": True}, {"_id": 0},
    ).to_list(200)
    supplier_by_brand: dict[str, dict] = {}
    for supplier in suppliers:
        supplier_by_brand.setdefault(supplier.get("brand_id"), supplier)
    added_lines = 0
    for line_id, raw in desired.items():
        if line_id in handled_lines:
            continue
        product = product_by_id.get(raw.get("product_id"))
        if not product:
            # This should have been impossible after route-level validation;
            # keep the invariant explicit instead of producing an unassigned PO.
            raise HTTPException(status_code=409, detail="A revised quotation product is no longer available.")
        brand_id = product.get("brand_id")
        po = next((candidate for candidate in by_id.values()
                   if candidate.get("status") == "draft" and candidate.get("brand_id") == brand_id), None)
        if po is None:
            supplier = supplier_by_brand.get(brand_id, {})
            po_model = PurchaseOrder(
                number=await _next_purchase_number(), quotation_id=current["id"], quotation_number=current.get("number"),
                customer_id=current["customer_id"], customer_name=current.get("customer_name", ""), project_name=current.get("project_name"),
                brand_id=brand_id, brand_name=product.get("brand_name"), supplier_id=supplier.get("id"), supplier_name=supplier.get("name"),
                status="draft", items=[], created_by=user.id, created_by_name=user.full_name, floor_id=current.get("floor_id"),
                status_history=[PurchaseStatusEvent(from_status=None, to_status="draft", by_user_id=user.id, by_user_name=user.full_name, note="Created from quotation revision")],
            )
            po = po_model.model_dump()
            await db.purchase_orders.insert_one(po)
            by_id[po["id"]] = po
            changed_pos.add(po["id"])
        cost = round(net_by_line.get(line_id, 0) / float(raw.get("qty") or 1), 2)
        raw_with_customer = {**raw, "customer_id": current.get("customer_id"), "customer_name": current.get("customer_name")}
        po.setdefault("items", []).append(_new_po_item(raw_with_customer, unit_cost=cost, product=product, user=user))
        changed_pos.add(po["id"])
        added_lines += 1

    for po_id in changed_pos:
        po = by_id[po_id]
        total = _po_totals(po.get("items") or [])
        await db.purchase_orders.update_one(
            {"id": po_id, "floor_id": current.get("floor_id")},
            {"$set": {"items": po.get("items") or [], "subtotal": total, "grand_total": total, "updated_at": _now()}},
        )

    # The automatically-created pending payment is an informational pending
    # balance, never money received. Keep it aligned for payment history while
    # completed payments remain immutable.
    paid = await _completed_paid(current["id"])
    remaining = round(max(0.0, _collection_total(current) - paid), 2)
    payment_key = f"order-placed:{current['id']}:payment"
    if remaining > _EPSILON:
        await db.payments.update_one(
            {"automation_key": payment_key, "status": "pending"},
            {"$set": {"amount": remaining, "updated_at": _now(), "note": "Outstanding balance updated by quotation revision."}},
        )
    else:
        await db.payments.delete_many({"automation_key": payment_key, "status": "pending"})
    return {"purchase_orders": len(changed_pos), "cancelled_lines": cancelled_lines, "added_lines": added_lines, "pending_balance": remaining}
