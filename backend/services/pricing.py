"""Shared quotation discount-resolution logic.

Moved out of routes/quotation_routes.py so it can also be used by
services/domain_outbox.py (the OrderPlaced handler that turns a quotation
into supplier Purchase Orders) WITHOUT a circular import — quotation_routes
already imports from domain_outbox, so domain_outbox can never import back
from quotation_routes.

Mirrors frontend/src/components/quotation/helpers/pricing.ts effectivePct
EXACTLY — these implementations must never drift, or the builder's live
totals would disagree with what the server persists / what a Purchase
Order is generated at.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any
from models import QuotationLineItem, RoomDiscountCfg


def normalize_tile_line_item(item: QuotationLineItem) -> QuotationLineItem:
    """Normalize tile-only display/pricing fields at the pricing boundary.

    `unit_price` is the persisted per-unit amount used by the existing
    quotation pricing engine. When a tile row supplies both a per-square-foot
    price and the square-foot coverage of a box, the conversion is performed
    here—not in a presentation component. The offer rate is the actual
    selling price: if it is absent, the rate per SQ.FT is used instead.
    """
    # Individual tiles are priced per *piece*, not per square foot or box.
    # A Pieces line can still carry old box fields after an editor toggle, so
    # resolve its unit price before the box-rate conversion below.  Prefer an
    # explicit rate_box (the legacy persisted unit-rate field), then the
    # offered rate, and finally the submitted unit_price.  In particular,
    # treat 0 as an unset fallback here: the editor used to submit rate_box=0
    # alongside a valid ₹/piece offer rate, producing a zero-value order.
    if item.quantity_unit == "Pieces" or item.price_basis == "box":
        per_piece_rate = next(
            (value for value in (item.rate_box, item.offer_rate, item.unit_price) if value is not None and float(value) > 0),
            0.0,
        )
        item.rate_box = round(float(per_piece_rate), 2)
        item.unit_price = item.rate_box
        # Preserve rate_sqft / box_sqft as historical display metadata only;
        # they must never affect a per-piece line's arithmetic.
        return item

    if item.rate_sqft is None and item.offer_rate is not None:
        item.rate_sqft = item.offer_rate
    if item.offer_rate is None:
        item.offer_rate = item.rate_sqft if item.rate_sqft is not None else item.unit_price
    # A supplied offer must always drive the box and line totals. Do not
    # retain a stale rate_box calculated before the offer was edited.
    effective_rate = item.offer_rate if item.offer_rate is not None else item.rate_sqft
    rate_box = item.rate_box
    if effective_rate is not None and item.box_sqft is not None:
        rate_box = round(float(effective_rate) * float(item.box_sqft), 2)
    if rate_box is None:
        rate_box = item.unit_price
    item.rate_box = round(max(0.0, float(rate_box)), 2)
    # The quantity unit records how the material is fulfilled. It must not
    # mutate the agreed quotation rate: a Box → Piece toggle previously
    # divided the price by pcs_per_box and changed the saved quotation total.
    item.unit_price = item.rate_box
    return item


def effective_discount_pct(
    line: QuotationLineItem,
    room_discounts: dict[str, RoomDiscountCfg],
    category_discounts: dict[str, float],
    project_discount_pct: float,
) -> tuple[float, str]:
    """Return (pct, source) — Product override > Room > Category > Project.
    A room with an "amount" (flat ₹) discount has no single per-line pct —
    it's resolved by recalc_quotation_totals's second pass — so we return
    pct=0 with source "room_amount" here to signal "blocked from
    category/project, pending room-level allocation".
    """
    if line.discount_pct is not None:
        return float(line.discount_pct), "product"
    rd = room_discounts.get(line.room) if line.room else None
    if rd and rd.value > 0:
        if rd.type == "percent":
            return float(rd.value), "room"
        return 0.0, "room_amount"
    if line.category_id and line.category_id in category_discounts:
        return float(category_discounts[line.category_id]), "category"
    if project_discount_pct:
        return float(project_discount_pct), "project"
    return 0.0, "none"


def _resolve_line_rows(
    items: list[QuotationLineItem],
    project_discount_pct: float,
    category_discounts: dict[str, float],
    room_discounts: dict[str, RoomDiscountCfg],
) -> list[dict]:
    """The one implementation of the discount cascade and the room "amount"
    pro-rata allocation.

    This loop used to exist four times — recalc_quotation_totals,
    per_line_net_amounts, the /breakdown route, and the PDF item enricher —
    which was a standing invitation for per-line revenue to drift from
    grand_total, and did leave the last two disagreeing on rounding. All four
    now build on this.

    "pct" is the effective discount percent, UNROUNDED — including the value
    back-derived for a room "amount" line once its flat rupee discount has
    been allocated. Rounding is a display concern and belongs to the caller;
    doing it here is what let the breakdown (4dp) and the PDF (2dp) drift.
    """
    rows = []
    for it in items:
        gross = it.qty * it.unit_price
        pct, source = effective_discount_pct(it, room_discounts, category_discounts, project_discount_pct)
        rows.append({"line_id": it.id, "gross": gross, "source": source, "room": it.room, "pct": pct, "disc": gross * pct / 100})

    by_room: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        if row["source"] == "room_amount":
            by_room[row["room"] or ""].append(row)
    for room, room_rows in by_room.items():
        cfg = room_discounts.get(room)
        if not cfg or cfg.type != "amount" or cfg.value <= 0:
            continue
        room_gross = sum(r["gross"] for r in room_rows)
        flat = min(cfg.value, room_gross)
        if room_gross <= 0 or flat <= 0:
            continue
        for row in room_rows:
            row["disc"] = flat * (row["gross"] / room_gross)
            row["pct"] = (row["disc"] / row["gross"]) * 100 if row["gross"] else 0
    return rows


def recalc_quotation_totals(
    items: list[QuotationLineItem],
    project_discount_pct: float = 0.0,
    category_discounts: dict[str, float] | None = None,
    room_discounts: dict[str, RoomDiscountCfg] | None = None,
) -> dict:
    rows = _resolve_line_rows(items, project_discount_pct, category_discounts or {}, room_discounts or {})
    # Explicit fold, NOT sum(): CPython >= 3.12 gives sum() a Neumaier
    # compensated-summation fast path, which shifts grand_total by ₹0.01 on
    # roughly 1 in 60 to 1 in 160 real quotations, depending on line count,
    # versus the accumulator this code has always used. grand_total values are
    # already persisted and are re-written on every quotation edit, so they
    # must not move.
    subtotal = 0.0
    discount_total = 0.0
    for row in rows:
        subtotal += row["gross"]
        discount_total += row["disc"]
    return {
        "subtotal": round(subtotal, 2),
        "discount_total": round(discount_total, 2),
        "grand_total": round(subtotal - discount_total, 2),
    }


def net_amounts(
    items: list[QuotationLineItem],
    project_discount_pct: float = 0.0,
    category_discounts: dict[str, float] | None = None,
    room_discounts: dict[str, RoomDiscountCfg] | None = None,
) -> dict[str, float]:
    """Return {line_id: post-discount line total}.

    Sums to grand_total to within per-line rounding. Each line is rounded to
    paise independently, so the tight bound is 0.005 * (N + 1) for N lines —
    half a paisa per line plus half a paisa on the total. Assert with that
    bound, not equality, and not N * 0.01: the looser figure would let a
    systematic one-paisa-per-line error pass at every N.
    """
    rows = _resolve_line_rows(items, project_discount_pct, category_discounts or {}, room_discounts or {})
    return {row["line_id"]: round(row["gross"] - row["disc"], 2) for row in rows}


def per_line_net_amounts(doc: dict[str, Any]) -> dict[str, float]:
    """Doc-shaped wrapper over net_amounts().

    Used by the OrderPlaced automation so a Purchase Order's unit_cost keeps
    whatever discount was actually applied, and by the place-order preview so
    the review screen shows the same number the PO is created at.
    """
    return net_amounts(
        [QuotationLineItem(**raw) for raw in doc.get("items", [])],
        doc.get("project_discount_pct", 0) or 0,
        doc.get("category_discounts", {}) or {},
        {k: RoomDiscountCfg(**v) for k, v in (doc.get("room_discounts") or {}).items()},
    )


def net_amount_list(
    items: list[QuotationLineItem],
    project_discount_pct: float = 0.0,
    category_discounts: dict[str, float] | None = None,
    room_discounts: dict[str, RoomDiscountCfg] | None = None,
) -> list[float]:
    """Per-line post-discount totals in INPUT ORDER.

    Order-preserving rather than id-keyed: line ids are client-supplied and
    nothing enforces uniqueness, so a dict keyed by id silently collapses
    duplicates onto one value. Every stamping path uses this.
    """
    rows = _resolve_line_rows(items, project_discount_pct, category_discounts or {}, room_discounts or {})
    return [round(row["gross"] - row["disc"], 2) for row in rows]


def stamp_net_amounts(
    item_dicts: list[dict[str, Any]],
    project_discount_pct: float = 0.0,
    category_discounts: dict[str, float] | None = None,
    room_discounts: dict[str, RoomDiscountCfg] | None = None,
) -> list[dict[str, Any]]:
    """Write each line's post-discount total onto its dict as net_amount.

    Mutates in place and returns the same list, so it can be dropped into a
    persistence path without re-binding. Always overwrites: a discount change
    re-prices every line even when no line itself was edited.

    Matches rows to dicts POSITIONALLY rather than by line id. Matching by id
    silently stamped 0.0 on any dict without an "id" (the model fills one from
    a default_factory, so the resolved key never matched), and collapsed two
    lines sharing an id onto one value.
    """
    nets = net_amount_list(
        [QuotationLineItem(**raw) for raw in item_dicts],
        project_discount_pct, category_discounts, room_discounts,
    )
    for raw, net in zip(item_dicts, nets, strict=True):
        raw["net_amount"] = net
    return item_dicts
