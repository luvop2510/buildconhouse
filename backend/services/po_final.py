"""Read-only final customer quotation assembled from the live sales snapshot.

Purchase-order unit_cost starts as a copy of discounted selling price, but
transfers and later edits can leave it stale. The quotation is authoritative.
"""
from __future__ import annotations

from datetime import datetime, timezone

from services.pricing import per_line_net_amounts
from services.godown_valuation import transferred_sold_value


def _money(value) -> float:
    try:
        return round(float(value or 0), 2)
    except (TypeError, ValueError):
        return 0.0


def _line_changes(previous: dict, current: dict, at: str, revision_id: str) -> list[dict]:
    """Describe saved line and amount edits, including post-order revisions."""
    old = {str(i.get("id")): i for i in previous.get("items") or [] if i.get("id")}
    new = {str(i.get("id")): i for i in current.get("items") or [] if i.get("id")}
    changes = []
    for line_id in sorted(old.keys() | new.keys()):
        before, after = old.get(line_id), new.get(line_id)
        if before is None:
            kind, label, qty = "product_added", "Added", after.get("qty")
        elif after is None:
            kind, label, qty = "product_removed", "Removed", before.get("qty")
        elif before.get("product_id") != after.get("product_id"):
            kind, label, qty = "product_replaced", "Replaced", after.get("qty")
        elif any(before.get(key) != after.get(key) for key in ("qty", "unit_price", "discount_pct", "room", "godown_stock_id")):
            kind, label, qty = "product_adjusted", "Adjusted", after.get("qty")
        else:
            continue
        name = (after or before).get("name") or "Product"
        if kind == "product_replaced":
            description = f"Replaced {before.get('name') or 'product'} with {name}"
        else:
            description = f"{label} {name}"
        changes.append({"id": f"{revision_id}:{line_id}", "at": at, "type": kind,
                        "description": description, "qty": qty,
                        "amount": _money((after or before).get("net_amount")), "quotation_id": None})
    old_total, new_total = _money(previous.get("grand_total")), _money(current.get("grand_total"))
    if old_total != new_total:
        changes.append({"id": f"{revision_id}:total", "at": at, "type": "amount_adjusted",
                        "description": f"Quotation total changed from ₹{old_total:,.2f} to ₹{new_total:,.2f}",
                        "qty": None, "amount": round(new_total - old_total, 2), "quotation_id": None})
    return changes


def build_po_final(customer: dict, quotation: dict, quotations: list[dict],
                   purchase_orders: list[dict], events: list[dict]) -> dict:
    """Project a final, customer-priced view without mutating source records."""
    po_lines = {}
    godown_value = 0.0
    for order in purchase_orders:
        for line in order.get("items") or []:
            po_lines.setdefault(str(line.get("quotation_line_id") or ""), []).append(line)
            if not line.get("cancelled"):
                godown_value += transferred_sold_value(line)
    godown_value = _money(godown_value)
    net_by_id = per_line_net_amounts(quotation)
    items = []
    for line in quotation.get("items") or []:
        line_id = str(line.get("id") or "")
        linked = po_lines.get(line_id) or []
        moved_lines = [i for i in linked if not i.get("cancelled") and float(i.get("godown_transferred_qty") or 0) > 0]
        moved_qty = sum(float(i.get("godown_transferred_qty") or 0) for i in moved_lines)
        moved_value = _money(sum(transferred_sold_value(i) for i in moved_lines))
        original_qty = max(0.0, float(line.get("qty") or 0))
        original_total = _money(net_by_id.get(line_id, line.get("net_amount")))
        final_qty = max(0.0, original_qty - moved_qty)
        final_total = _money(max(0.0, original_total - moved_value))
        source = "godown" if line.get("godown_stock_id") or any(i.get("godown_stock_id") for i in linked) else "purchase"
        if any(i.get("borrowed_from_customer_id") for i in linked):
            source = "customer_loan"
        if any(i.get("transferred_from_customer_id") for i in linked):
            source = "customer_transfer"
        stages = sorted({str(i.get("stage")) for i in linked if i.get("stage")})
        items.append({
            "id": line_id, "product_id": line.get("product_id"), "sku": line.get("sku"),
            "name": line.get("name"), "qty": final_qty,
            "original_qty": original_qty, "godown_transferred_qty": moved_qty,
            "unit_price": _money(final_total / final_qty) if final_qty else 0.0,
            "list_unit_price": _money(line.get("unit_price")),
            "total": final_total,
            "original_total": original_total, "godown_credit_amount": moved_value,
            "source": source, "stage": ", ".join(stages) if stages else None,
            "room": line.get("room"), "brand_name": next((i.get("brand_name") for i in linked if i.get("brand_name")), None),
            "godown_source_customer_name": line.get("godown_source_customer_name") or next((i.get("godown_source_customer_name") for i in linked if i.get("godown_source_customer_name")), None),
        })

    revisions = quotation.get("revisions") or []
    changes = []
    for item in items:
        if item["godown_transferred_qty"] > 0:
            source_lines = [i for i in po_lines.get(item["id"], []) if not i.get("cancelled") and float(i.get("godown_transferred_qty") or 0) > 0]
            dates = [entry.get("at") or entry.get("transferred_at") for line in source_lines
                     for entry in (line.get("godown_transfer_history") or [])]
            changes.append({"id": f"godown-final:{item['id']}",
                            "at": max((str(at) for at in dates if at), default=quotation.get("updated_at")),
                            "type": "godown_stock.final_adjustment",
                            "description": f"Moved {item['godown_transferred_qty']:g} × {item.get('name') or 'product'} to godown; original line {_money(item['original_total'])}, final line {_money(item['total'])}",
                            "qty": item["godown_transferred_qty"], "amount": -item["godown_credit_amount"],
                            "quotation_id": quotation.get("id")})
    for index, revision in enumerate(revisions):
        before = revision.get("snapshot") or {}
        after = (revisions[index + 1].get("snapshot") or {}) if index + 1 < len(revisions) else quotation
        changes.extend(_line_changes(before, after, revision.get("created_at") or quotation.get("updated_at"),
                                     str(revision.get("id") or index)))
        if revision.get("reason"):
            changes.append({"id": f"{revision.get('id') or index}:reason", "at": revision.get("created_at"),
                            "type": "revision", "description": str(revision["reason"]), "qty": None,
                            "amount": None, "quotation_id": quotation.get("id")})
    changes.extend(dict(change) for change in quotation.get("po_final_changes") or [])
    for event in events:
        kind = str(event.get("event_type") or "")
        # Saved revisions already describe ordinary product edits. Operational
        # events add the material movement history that quotations cannot hold.
        if kind in {"quotation.product_added", "quotation.product_removed", "quotation.product_reordered",
                    "quotation.discount_changed", "quotation.revision_created"} and (event.get("payload") or {}).get("source") != "product_command":
            continue
        if not (kind.startswith(("quotation.", "purchase.", "godown_stock.", "customer_loan.", "transfer.")) or "transfer" in kind or "loan" in kind):
            continue
        changes.append({"id": event.get("id"), "at": event.get("created_at"), "type": kind,
                        "description": event.get("summary") or kind.replace(".", " ").replace("_", " ").title(),
                        "qty": (event.get("payload") or {}).get("qty"), "amount": None,
                        "quotation_id": quotation.get("id")})
    for cost in quotation.get("payment_extra_history") or []:
        changes.append({"id": cost.get("id"), "at": cost.get("created_at"), "type": "additional_cost",
                        "description": cost.get("name") or "Additional cost", "qty": None,
                        "amount": _money(cost.get("amount")), "quotation_id": quotation.get("id")})
    for change in changes:
        change["quotation_id"] = quotation.get("id")
    changes.sort(key=lambda row: (str(row.get("at") or ""), str(row.get("id") or "")))
    original_total = _money(quotation.get("grand_total"))
    transportation_fee = _money(quotation.get("transportation_fee")) if quotation.get("doc_type") in {"tiles_selection", "tiles_quotation"} else 0.0
    total = _money(max(0.0, original_total - godown_value))
    history = quotation.get("payment_extra_history")
    extra = _money(sum(float(entry.get("amount") or 0) for entry in history) if isinstance(history, list)
                   else quotation.get("payment_extra_amount"))
    return {
        "customer": {key: customer.get(key) for key in ("id", "name", "company", "phone", "email", "address", "city", "state", "pincode", "floor_id")},
        "quotations": [{"id": q.get("id"), "number": q.get("number"), "status": q.get("status"),
                        "updated_at": q.get("updated_at"), "grand_total": _money(q.get("grand_total"))} for q in quotations],
        "quotation_id": quotation.get("id"), "quotation_number": quotation.get("number"),
        "status": quotation.get("status"), "doc_type": quotation.get("doc_type") or "standard",
        "items": items, "changes": changes, "total": total,
        "original_total": original_total, "godown_credit_amount": godown_value,
        "transportation_fee": transportation_fee,
        "items_total": _money(sum(item["total"] for item in items)),
        "payment_extra_amount": extra,
        "payable_total": _money(max(0.0, original_total + extra - godown_value)),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
