"""Five-stage purchase lifecycle, including backward-compatible legacy reads."""
from __future__ import annotations

LEGACY_DISPATCH_STAGES = ("dispatched", "in_transit", "delivered")


def dispatched_chalan_quantity(po: dict, item: dict) -> float:
    return sum(float(line.get("qty") or 0) for chalan in po.get("chalans") or []
               if chalan.get("stage") == "dispatched" for line in chalan.get("items") or []
               if line.get("po_item_id") == item.get("id"))


def delivery_timestamp(po: dict, item: dict) -> str | None:
    dates = [c.get("dispatched_at") for c in po.get("chalans") or []
             if c.get("stage") == "dispatched" and any(line.get("po_item_id") == item.get("id") for line in c.get("items") or [])]
    return item.get("delivered_at") or item.get("dispatched_at") or max([d for d in dates if d], default=None) or item.get("last_moved_at")


def normalized_stage(item: dict, po: dict | None = None) -> str:
    if po and active_quantity(item) > 0 and dispatched_chalan_quantity(po, item) >= active_quantity(item) - 1e-6:
        return "dispatched"
    stage = item.get("stage") or "order_in_company"
    if stage == "delivered":
        history = item.get("stage_history") or []
        # Old receiving code mislabeled arrival from the supplier as delivery.
        if history and history[-1].get("note") == "Auto-synced from PO receiving":
            return "in_box"
    return "dispatched" if stage in LEGACY_DISPATCH_STAGES else stage


def stage_expression(prefix: str = "$items", *, with_chalans: bool = True) -> dict:
    stage = {"$ifNull": [f"{prefix}.stage", "order_in_company"]}
    received = {"$and": [
        {"$eq": [stage, "delivered"]},
        {"$eq": [{"$arrayElemAt": [{"$ifNull": [f"{prefix}.stage_history.note", []]}, -1]}, "Auto-synced from PO receiving"]},
    ]}
    normalized = {"$cond": [received, "in_box", {"$cond": [
        {"$in": [stage, list(LEGACY_DISPATCH_STAGES)]}, "dispatched", stage,
    ]}]}
    if not with_chalans:
        return normalized
    return {"$cond": [{"$and": [
        {"$gt": [active_quantity_expression(prefix), 0]},
        {"$gte": [dispatched_quantity_expression(prefix), active_quantity_expression(prefix)]},
    ]}, "dispatched", normalized]}


def dispatched_quantity_expression(prefix: str = "$items") -> dict:
    return {"$reduce": {"input": {"$ifNull": ["$chalans", []]}, "initialValue": 0, "in": {
        "$add": ["$$value", {"$cond": [{"$eq": ["$$this.stage", "dispatched"]},
            {"$sum": {"$map": {"input": {"$ifNull": ["$$this.items", []]}, "as": "line", "in": {
                "$cond": [{"$eq": ["$$line.po_item_id", f"{prefix}.id"]}, {"$ifNull": ["$$line.qty", 0]}, 0],
            }}}}, 0]}],
    }}}


def delivery_timestamp_expression(prefix: str = "$items") -> dict:
    chalan_date = {"$max": {"$map": {"input": {"$ifNull": ["$chalans", []]}, "as": "chalan", "in": {
        "$cond": [{"$and": [{"$eq": ["$$chalan.stage", "dispatched"]}, {"$in": [f"{prefix}.id", {"$ifNull": ["$$chalan.items.po_item_id", []]}]}]}, "$$chalan.dispatched_at", None],
    }}}}
    return {"$ifNull": [f"{prefix}.delivered_at", {"$ifNull": [f"{prefix}.dispatched_at", {"$ifNull": [chalan_date, f"{prefix}.last_moved_at"]}]}]}


def active_quantity(item: dict) -> float:
    return max(0.0, float(item.get("qty") or 0) - float(item.get("godown_transferred_qty") or 0) - float(item.get("loan_replenishment_returned_qty") or 0))


def active_quantity_expression(prefix: str = "$items") -> dict:
    return {"$max": [0, {"$subtract": [
        {"$ifNull": [f"{prefix}.qty", 0]},
        {"$add": [{"$ifNull": [f"{prefix}.godown_transferred_qty", 0]}, {"$ifNull": [f"{prefix}.loan_replenishment_returned_qty", 0]}]},
    ]}]}
