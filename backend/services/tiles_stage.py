"""Ground Floor workflow, mirrored in frontend tilesStage.ts.

Legacy approval statuses remain readable but require no approval action.
Selections move directly into quotations; an explicit Place Order commits a sale.
"""
from __future__ import annotations


EDITABLE_TILES_STATUSES = frozenset({"draft", "pending_approval", "approved", "sent", "won"})


def tiles_stage(doc_type: str, status: str) -> str:
    if doc_type == "tiles_selection":
        return "selection_draft"
    if doc_type == "tiles_quotation":
        return "ordered" if status == "ordered" else "quotation_draft"
    raise ValueError(f"tiles_stage() called with non-tiles doc_type {doc_type!r}")


TILES_STAGE_LABELS: dict[str, str] = {
    "selection_draft": "Selection — Draft",
    "quotation_draft": "Quotation — Draft",
    "ordered": "Order placed",
}


def tiles_stage_label(doc_type: str, status: str) -> str:
    return TILES_STAGE_LABELS[tiles_stage(doc_type, status)]


def can_move_to_quotation(doc_type: str, status: str) -> bool:
    return doc_type == "tiles_selection" and status in EDITABLE_TILES_STATUSES


def can_place_order(doc_type: str, status: str) -> bool:
    if doc_type == "tiles_selection":
        return False
    if doc_type != "tiles_quotation":
        return True
    return status in EDITABLE_TILES_STATUSES


def next_tiles_action(doc_type: str, status: str) -> dict | None:
    if can_move_to_quotation(doc_type, status):
        return {"label": "Move to Quotation", "kind": "move_to_quotation", "next_status": None}
    return None
