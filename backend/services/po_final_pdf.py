"""Render the current PO Final snapshot with the official quotation templates."""
from __future__ import annotations

from pdf_generator import build_quotation_pdf
from pdf_tiles import build_tiles_quotation_pdf


def _final_quotation(data: dict, quotation: dict, payments: list[dict]) -> dict:
    """Keep quotation artwork and product metadata, replacing commercial values."""
    current = {str(item.get("id")): item for item in data.get("items") or []}
    items = []
    for original in quotation.get("items") or []:
        final = current.get(str(original.get("id")))
        if not final or float(final.get("qty") or 0) <= 0:
            continue
        qty = float(final["qty"])
        total = float(final.get("total") or 0)
        rate = total / qty
        original_unit = float(original.get("unit_price") or 0)
        ratio = rate / original_unit if original_unit else 1
        items.append({
            **original,
            "qty": qty,
            "unit_price": rate,
            "discount_pct": 0,
            "net_amount": total,
            "offer_rate": float(original.get("offer_rate") or original.get("rate_sqft") or rate) * ratio,
            "rate_sqft": float(original.get("rate_sqft") or 0) * ratio if original.get("rate_sqft") is not None else None,
            "rate_box": rate,
        })
    return {
        **quotation,
        "items": items,
        "rooms": list(dict.fromkeys(item.get("room") or "General" for item in items)),
        "subtotal": float(data.get("items_total") or 0),
        "grand_total": float(data.get("total") or 0),
        "discount_total": 0,
        "transportation_fee": float(data.get("transportation_fee") or 0),
        "_po_final": {
            "payments": payments,
            "additional_costs": quotation.get("payment_extra_history") or [],
            "payable_total": float(data.get("payable_total") or 0),
            "total": float(data.get("total") or 0),
        },
    }


def build_po_final_pdf(data: dict, branding: dict | None = None,
                       quotation: dict | None = None, payments: list[dict] | None = None) -> bytes:
    """Use the same product quotation renderer as the quotation download."""
    quotation = quotation or {
        "number": data.get("quotation_number"),
        "customer_name": (data.get("customer") or {}).get("name"),
        "doc_type": data.get("doc_type") or "standard",
        "items": data.get("items") or [],
    }
    document = _final_quotation(data, quotation, payments or [])
    renderer = build_tiles_quotation_pdf if document.get("doc_type") in {"tiles_selection", "tiles_quotation"} else build_quotation_pdf
    return renderer(document, data.get("customer") or {}, branding)
