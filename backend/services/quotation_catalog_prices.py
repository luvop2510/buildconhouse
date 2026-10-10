"""Explicit catalog repricing at PO creation; stored quotations are snapshots."""
from __future__ import annotations
import hashlib
import json
import math
from fastapi import HTTPException

FINAL_STATUSES = {"sent", "approved", "ordered", "won", "lost", "cancelled"}


def line_catalog_snapshot(product: dict) -> dict:
    return {"catalog_price": product.get("price"), "catalog_mrp": product.get("mrp"), "catalog_version": product.get("catalog_version")}


async def price_review(doc: dict, products_collection, *, session=None) -> dict:
    if doc.get("status") in FINAL_STATUSES or doc.get("ordered_at"):
        return {"changes": [], "token": None}
    ids = list({line.get("product_id") for line in doc.get("items", []) if line.get("product_id") and not line.get("godown_stock_id")})
    if not ids:
        return {"changes": [], "token": None}
    options = {"session": session} if session is not None else {}
    products = await products_collection.find({"id": {"$in": ids}, "floor_id": doc.get("floor_id"), "active": {"$ne": False}}, {"_id": 0, "id": 1, "price": 1, "mrp": 1, "catalog_version": 1, "updated_at": 1, "price_status": 1, "price_unknown": 1}, **options).to_list(len(ids))
    by_id = {product["id"]: product for product in products}
    changes = []
    tiles = doc.get("doc_type") in {"tiles_selection", "tiles_quotation"}
    for position, line in enumerate(doc.get("items", [])):
        product = by_id.get(line.get("product_id"))
        if not product or line.get("godown_stock_id"):
            continue
        # Unspecified source prices must never turn a negotiated offer into
        # a zero/invalid-value PO. They require a supplier rate first.
        if product.get("price_status") in {"unspecified", "unknown"} or product.get("price_unknown"):
            continue
        try:
            catalog_price = float(product["price"])
            catalog_mrp = float(product["mrp"]) if product.get("mrp") is not None else None
        except (ValueError, TypeError, KeyError):
            continue
        if not math.isfinite(catalog_price) or catalog_price < 0 or (catalog_mrp is not None and (not math.isfinite(catalog_mrp) or catalog_mrp < 0)):
            continue
        old_price = line.get("catalog_price")
        old_mrp = line.get("catalog_mrp") if line.get("catalog_mrp") is not None else line.get("mrp")
        # Legacy tile documents already snapshot their source rate. Standard
        # legacy quotations may lack their original trade-price snapshot.
        if old_price is None and tiles:
            old_price = line.get("rate_sqft") if line.get("quantity_unit") != "Pieces" else line.get("unit_price")
        changed = (old_price is not None and float(old_price) != catalog_price) or (old_mrp is not None and catalog_mrp is not None and float(old_mrp) != catalog_mrp)
        unit_price = catalog_price
        if tiles and line.get("quantity_unit") != "Pieces" and line.get("box_sqft") is not None:
            unit_price = round(unit_price * float(line["box_sqft"]), 2)
        unverified = old_price is None and float(line.get("unit_price") or 0) != unit_price
        if not changed and not unverified:
            continue
        changes.append({"position": position, "line_id": line.get("id"), "product_id": line.get("product_id"), "sku": line.get("sku"), "name": line.get("name"), "old_unit_price": line.get("unit_price"), "new_unit_price": unit_price, "new_catalog_price": product.get("price"), "old_mrp": old_mrp, "new_mrp": product.get("mrp"), "catalog_version": product.get("catalog_version"), "changed_at": product.get("updated_at"), "reason": "catalog_price_changed" if changed else "source_price_unverified"})
    token = hashlib.sha256(json.dumps({"quotation_id": doc["id"], "updated_at": doc.get("updated_at"), "changes": changes}, sort_keys=True).encode()).hexdigest() if changes else None
    return {"changes": changes, "token": token}


def apply_price_choice(doc: dict, review: dict, choice: str | None, token: str | None) -> list[dict]:
    if not review["changes"]:
        return list(doc.get("items") or [])
    if choice not in {"keep", "latest"} or token != review["token"]:
        raise HTTPException(status_code=409, detail={"code": "catalog_price_review_required", "message": "Catalog prices changed. Review and choose original or latest prices before creating the purchase order.", "price_review": review})
    if choice == "keep":
        return list(doc.get("items") or [])
    # Legacy/client-supplied IDs can repeat across products; prices belong
    # to the physical row reviewed, never whichever duplicate ID came last.
    by_position = {change["position"]: change for change in review["changes"]}
    output = []
    tiles = doc.get("doc_type") in {"tiles_selection", "tiles_quotation"}
    for position, raw in enumerate(doc.get("items", [])):
        change = by_position.get(position)
        if not change:
            output.append(dict(raw)); continue
        line = {**raw, "unit_price": change["new_unit_price"], "mrp": change["new_mrp"], "catalog_price": change["new_catalog_price"], "catalog_mrp": change["new_mrp"], "catalog_version": change["catalog_version"]}
        if tiles:
            line.update({"rate_box": change["new_unit_price"], "offer_rate": change["new_catalog_price"]})
            if raw.get("quantity_unit") != "Pieces":
                line["rate_sqft"] = change["new_catalog_price"]
        output.append(line)
    return output
