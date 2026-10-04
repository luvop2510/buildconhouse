"""Shared proof that a follow-up belongs to a placed customer order."""


async def has_placed_order(db, followup: dict, *, floor_id: str | None = None) -> bool:
    floor = floor_id or followup.get("floor_id")
    if not floor:
        return False
    query = {"floor_id": floor, "status": "ordered"}
    if followup.get("quotation_id"):
        query["id"] = followup["quotation_id"]
    elif followup.get("customer_id"):
        query["customer_id"] = followup["customer_id"]
    else:
        return False
    return bool(await db.quotations.find_one(query, {"_id": 0, "id": 1}))
