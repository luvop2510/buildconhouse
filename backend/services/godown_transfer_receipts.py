"""Minimal completion evidence survives removal of customer transfer history.

No customer identity, submitted form, contact details or image is retained here.
The deterministic Mongo _id provides command uniqueness without a new index.
"""
import hashlib
import math

from fastapi import HTTPException


def receipt_id(command_key: str) -> str:
    return "godown-transfer-completion:" + hashlib.sha256(command_key.encode()).hexdigest()


def completion_receipt(transfer: dict) -> dict | None:
    key = transfer.get("idempotency_key")
    if not key:
        return None
    if isinstance(key, str) and not key.startswith("godown-transfer:") and transfer.get("transfer_type") != "godown_stock":
        return None  # Unrelated legacy transfer namespaces have other lifecycles.
    if not isinstance(key, str) or not key.startswith("godown-transfer:") or not all(transfer.get(k) for k in ("id", "floor_id", "stock_id")):
        raise HTTPException(409, "Transfer completion evidence is incomplete; review it before deleting customer history.")
    qty = transfer.get("qty")
    if isinstance(qty, bool) or not isinstance(qty, (int, float)) or not math.isfinite(qty) or qty <= 0:
        raise HTTPException(409, "Transfer completion quantity is invalid; review it before deleting customer history.")
    identity = receipt_id(key)
    return {"_id": identity, "id": identity, "kind": "godown_transfer_completion",
            "floor_id": transfer["floor_id"], "stock_id": transfer["stock_id"],
            "actor_id": transfer.get("created_by"), "transfer_id": transfer["id"],
            "qty": qty, "request_sha256": transfer.get("request_sha256"),
            "completed_at": transfer.get("created_at")}


async def preserve_removed_history(database, transfer: dict, session) -> None:
    receipt = completion_receipt(transfer)
    if receipt:
        existing = await database.settings.find_one({"_id": receipt["_id"]}, session=session)
        immutable = {key: value for key, value in receipt.items() if key != "_id"}
        if existing and any(existing.get(key) != value for key, value in immutable.items()):
            raise HTTPException(409, "Transfer completion evidence conflicts; review it before deleting customer history.")
        await database.settings.update_one({"_id": receipt["_id"], **immutable},
            {"$setOnInsert": receipt, "$set": {"history_removed": True}}, upsert=True, session=session)


def removed_history_result(receipt: dict) -> HTTPException:
    return HTTPException(410, detail={
        "code": "godown_transfer_record_removed",
        "message": "This transfer was completed, but its customer history has been removed. Review the completion receipt; do not transfer the same stock again.",
        "transfer": {"id": receipt["transfer_id"], "floor_id": receipt["floor_id"],
                     "stock_id": receipt["stock_id"], "qty": receipt["qty"],
                     "recipient_customer_name": "Customer record removed", "created_at": receipt.get("completed_at"),
                     "status": "completed", "transfer_type": "godown_stock", "history_removed": True},
    })
