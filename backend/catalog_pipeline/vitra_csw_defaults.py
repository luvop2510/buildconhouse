"""CSW catalogue relationships that are explicit in VitrA's price table.

The supplier lists a WC and its seat cover as separate sellable SKUs.  A
quotation, however, must always include the matching cover whenever a WC is
selected.  This module derives only the unambiguous same-series/same-finish
pairs; it deliberately does not guess a cover for Smart WCs where the sheet
does not list a separate cover.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def _key(value: object) -> str:
    return " ".join(str(value or "").upper().split())


def build_seat_cover_pairs(rows: Iterable[dict[str, Any]]) -> tuple[list[tuple[str, str]], list[str]]:
    """Return ``(wc_sku, cover_sku)`` pairs and WCs with no supplied cover.

    The CSW adapter emits one row per finish.  Pairing by series and finish is
    therefore materially safer than relying on adjacent spreadsheet rows or
    attempting to transform article numbers.
    """
    accepted = [row for row in rows if row.get("status") == "accepted"]
    covers: dict[tuple[str, str], str] = {}
    for row in accepted:
        name = _key(row.get("name"))
        if "SEAT COVER" in name and "WITH SEAT COVER" not in name:
            sku = str(row.get("sku") or "").strip()
            if sku:
                covers[(_key(row.get("series")), _key(row.get("finish")))] = sku

    pairs: list[tuple[str, str]] = []
    unmatched: list[str] = []
    for row in accepted:
        name = _key(row.get("name"))
        if row.get("category") != "Water Closets" or "WC" not in name or "SEAT COVER" in name:
            continue
        sku = str(row.get("sku") or "").strip()
        cover_sku = covers.get((_key(row.get("series")), _key(row.get("finish"))))
        if sku and cover_sku:
            pairs.append((sku, cover_sku))
        elif sku:
            unmatched.append(sku)
    return pairs, unmatched


async def apply_seat_cover_defaults(
    db: Any, *, brand_id: str, floor_id: str, pairs: list[tuple[str, str]],
) -> dict[str, Any]:
    """Attach validated seat-cover defaults to CSW WC product documents.

    All referenced products are read and validated before the first update.
    That prevents a partially configured catalogue if a source SKU failed to
    import.  Only the targeted product ``specs`` field is patched; quotations,
    orders, unrelated products and media are never touched.
    """
    skus = sorted({sku for pair in pairs for sku in pair})
    docs = await db.products.find(
        {"brand_id": brand_id, "floor_id": floor_id, "sku": {"$in": skus}}, {"_id": 0}
    ).to_list(len(skus) + 10)
    by_sku = {str(doc.get("sku")): doc for doc in docs}
    missing = sorted(sku for sku in skus if sku not in by_sku)
    if missing:
        raise RuntimeError("Cannot configure CSW seat covers; imported SKU(s) are missing: " + ", ".join(missing))

    planned: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for wc_sku, cover_sku in pairs:
        wc = by_sku[wc_sku]
        cover = by_sku[cover_sku]
        unit_price = cover.get("price")
        if not isinstance(unit_price, (int, float)) or unit_price <= 0:
            raise RuntimeError(f"Cannot configure seat cover {cover_sku}; it has no valid imported price.")
        planned.append((wc, {
            "role": "seat_cover",
            "sku": cover_sku,
            "product_id": cover["id"],
            "name": cover.get("name") or f"Seat cover · {cover_sku}",
            "unit_price": float(unit_price),
            "mrp": float(cover.get("mrp") or unit_price),
            "qty": 1,
        }))

    changed = 0
    for wc, part in planned:
        current = ((wc.get("specs") or {}).get("default_included_parts"))
        desired = [part]
        if current == desired:
            continue
        result = await db.products.update_one(
            {"id": wc["id"], "brand_id": brand_id, "floor_id": floor_id},
            {"$set": {"specs.default_included_parts": desired}},
        )
        changed += result.modified_count
    return {"seat_cover_pairs": len(pairs), "seat_cover_defaults_changed": changed}
