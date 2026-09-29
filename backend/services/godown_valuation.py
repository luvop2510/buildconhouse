"""The fixed customer selling value removed by a permanent godown intake."""

from __future__ import annotations


def transferred_sold_value(item: dict) -> float:
    """Use the value captured when stock moved; support older PO rows."""
    moved = max(0.0, float(item.get("godown_transferred_qty") or 0))
    valued = max(0.0, float(item.get("godown_valued_qty") or 0))
    captured = max(0.0, float(item.get("godown_transferred_value") or 0))
    return round(captured + max(0.0, moved - valued) * float(item.get("unit_cost") or 0), 2)
