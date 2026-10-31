"""Customer PO Final read model and downloadable final quotation."""
from __future__ import annotations

import asyncio

from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from auth import get_current_user, get_floor_scoped_or_404
from db import db
from models import UserPublic
from services.po_final import build_po_final
from services.po_final_pdf import build_po_final_pdf
from services.po_final_pdf import _final_quotation

router = APIRouter(prefix="/customers", tags=["customers"])


def _linked_loan_items(source_orders: list[dict], selected_orders: list[dict]) -> dict[str, str]:
    """Map recipient loan transfer IDs to the selected quotation's line IDs.

    A borrower can have several orders for the same product. The immutable
    source loan history names the exact replenishment PO and item, so matching
    by SKU or customer alone would attach loans to the wrong quotation.
    """
    replenishment_lines = {
        (po.get("id"), item.get("id")): item.get("quotation_line_id")
        for po in selected_orders for item in po.get("items") or []
        if item.get("id") and item.get("quotation_line_id")
    }
    links: dict[str, str] = {}
    for po in source_orders:
        for item in po.get("items") or []:
            for entry in item.get("customer_loan_history") or []:
                line_id = replenishment_lines.get((entry.get("replenishment_po_id"), entry.get("replenishment_item_id")))
                if line_id and entry.get("transfer_id"):
                    links[str(entry["transfer_id"])] = str(line_id)
    return links


async def _po_final(customer_id: str, quotation_id: str | None, user: UserPublic) -> dict:
    customer = await get_floor_scoped_or_404(
        db.customers, customer_id, user, not_found="Customer not found",
        projection={"_id": 0, "password_hash": 0},
    )
    floor_id = customer.get("floor_id")
    quotations = await db.quotations.find(
        {"customer_id": customer_id, "floor_id": floor_id},
        {"_id": 0, "id": 1, "number": 1, "status": 1, "updated_at": 1, "grand_total": 1},
    ).sort("updated_at", -1).to_list(1000)
    if not quotations:
        if quotation_id:
            raise HTTPException(status_code=404, detail="Quotation not found for this customer")
        return {"customer": {key: customer.get(key) for key in ("id", "name", "company", "phone", "email", "address", "city", "state", "pincode", "floor_id")},
                "quotations": [], "quotation_id": None, "quotation_number": None, "status": None,
                "doc_type": None, "items": [], "changes": [], "total": 0.0,
                "original_total": 0.0, "godown_credit_amount": 0.0,
                "transportation_fee": 0.0, "items_total": 0.0,
                "payment_extra_amount": 0.0, "payable_total": 0.0, "generated_at": None}
    if quotation_id:
        selected = next((q for q in quotations if q.get("id") == quotation_id), None)
        if selected is None:
            raise HTTPException(status_code=404, detail="Quotation not found for this customer")
    else:
        selected = next((q for q in quotations if q.get("status") in {"ordered", "won"}), quotations[0])
    # Choices need no item/revision histories; load only the selected body.
    selected, purchase_orders = await asyncio.gather(
        db.quotations.find_one(
            {"id": selected["id"], "customer_id": customer_id, "floor_id": floor_id}, {"_id": 0},
        ),
        db.purchase_orders.find(
            {"customer_id": customer_id, "floor_id": floor_id, "quotation_id": selected["id"]}, {"_id": 0},
        ).to_list(1000),
    )
    if selected is None:
        raise HTTPException(status_code=404, detail="Quotation not found for this customer")
    selected_po_ids = [po["id"] for po in purchase_orders if po.get("id")]
    if selected_po_ids:
        source_orders = await db.purchase_orders.find(
            {"floor_id": floor_id, "items.customer_loan_history.replenishment_po_id": {"$in": selected_po_ids}},
            {"_id": 0, "id": 1, "items": 1},
        ).to_list(1000)
        loan_links = _linked_loan_items(source_orders, purchase_orders)
        if loan_links:
            loan_orders = await db.purchase_orders.find(
                {"floor_id": floor_id, "customer_id": customer_id,
                 "quotation_id": {"$in": [None, ""]},
                 "items.loan_transfer_id": {"$in": list(loan_links)}}, {"_id": 0},
            ).to_list(1000)
            for loan_po in loan_orders:
                linked_items = []
                for item in loan_po.get("items") or []:
                    line_id = loan_links.get(str(item.get("loan_transfer_id") or ""))
                    if line_id:
                        linked_items.append({**item, "quotation_line_id": line_id})
                if linked_items:
                    purchase_orders.append({**loan_po, "items": linked_items})
    po_ids = [po["id"] for po in purchase_orders if po.get("id")]
    event_match = [{"quotation_id": selected["id"]},
                   {"entity_type": "quotation", "entity_id": selected["id"]}]
    if po_ids:
        event_match.extend([{"purchase_id": {"$in": po_ids}},
                            {"entity_type": "purchase", "entity_id": {"$in": po_ids}}])
    events, stock_transfers = await asyncio.gather(
        db.activity_events.find(
            {"floor_id": floor_id, "$or": event_match}, {"_id": 0},
        ).sort("created_at", 1).to_list(5000),
        db.godown_customer_transfers.find(
            {"floor_id": floor_id, "recipient_customer_id": customer_id,
             "recipient_quotation_id": selected["id"], "transfer_type": "godown_stock"},
            {"_id": 0},
        ).sort("created_at", 1).to_list(1000),
    )
    events.extend({
        "id": f"godown-transfer:{transfer['id']}",
        "event_type": "godown_stock.customer_transferred",
        "created_at": transfer.get("created_at"),
        "summary": f"Transferred {float(transfer.get('qty') or 0):g} × {transfer.get('name') or 'product'} from GoDown stock",
        "payload": {"qty": transfer.get("qty"), "transfer_id": transfer.get("id")},
    } for transfer in stock_transfers)
    return build_po_final(customer, selected, quotations, purchase_orders, events)


@router.get("/{customer_id}/po-final")
async def get_po_final(customer_id: str, quotation_id: str | None = Query(None),
                       user: UserPublic = Depends(get_current_user)):
    return await _po_final(customer_id, quotation_id, user)


@router.get("/{customer_id}/po-final/pdf")
async def get_po_final_pdf(customer_id: str, quotation_id: str | None = Query(None),
                           user: UserPublic = Depends(get_current_user)):
    data = await _po_final(customer_id, quotation_id, user)
    if not data["quotation_id"]:
        raise HTTPException(status_code=404, detail="No quotation exists for this customer")
    from routes.quotation_routes import _canonicalize_item_images, _diagram_items, _pdf_branding

    quotation = await get_floor_scoped_or_404(
        db.quotations, data["quotation_id"], user, not_found="Quotation not found", projection={"_id": 0},
    )
    items = await _canonicalize_item_images(quotation.get("items") or [], quotation.get("floor_id"))
    if data.get("doc_type") not in {"tiles_selection", "tiles_quotation"}:
        items = await _diagram_items(items, quotation.get("floor_id"))
    quotation = {**quotation, "items": items}
    payments = await db.payments.find(
        {"customer_id": customer_id, "quotation_id": data["quotation_id"], "floor_id": quotation.get("floor_id")},
        {"_id": 0},
    ).sort("created_at", 1).to_list(1000)
    pdf = await run_in_threadpool(build_po_final_pdf, data, await _pdf_branding(), quotation, payments)
    filename = f"PO-Final-{data['quotation_number'] or customer_id}.pdf"
    return StreamingResponse(iter([pdf]), media_type="application/pdf",
                             headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}", "Cache-Control": "private, no-store"})


@router.get("/{customer_id}/po-final/xlsx")
async def get_po_final_xlsx(customer_id: str, quotation_id: str | None = Query(None),
                            user: UserPublic = Depends(get_current_user)):
    data = await _po_final(customer_id, quotation_id, user)
    if not data["quotation_id"]:
        raise HTTPException(status_code=404, detail="No quotation exists for this customer")
    from routes.quotation_routes import _build_quotation_excel_file

    quotation = await get_floor_scoped_or_404(
        db.quotations, data["quotation_id"], user, not_found="Quotation not found", projection={"_id": 0},
    )
    if quotation.get("doc_type") in {"tiles_selection", "tiles_quotation"}:
        raise HTTPException(status_code=400, detail="Quotation Excel is available for Sanitary Bathroom quotations")
    document = _final_quotation(data, quotation, [])
    # Final item rates already include every discount and stock credit.
    document.update(project_discount_pct=0, category_discounts={}, room_discounts={})
    content, _ = await _build_quotation_excel_file(document, data["customer"])
    filename = f"PO-Final-{data['quotation_number'] or customer_id}.xlsx"
    return StreamingResponse(iter([content]),
                             media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}", "Cache-Control": "private, no-store"})
