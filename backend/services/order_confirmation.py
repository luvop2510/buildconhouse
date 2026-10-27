"""Shared proof that a follow-up belongs to a placed customer order."""


async def placed_order(db, followup: dict, *, floor_id: str | None = None) -> dict | None:
    floor = floor_id or followup.get("floor_id")
    if not floor:
        return None
    query = {"floor_id": floor, "status": "ordered"}
    if followup.get("quotation_id"):
        query["id"] = followup["quotation_id"]
    elif followup.get("customer_id"):
        query["customer_id"] = followup["customer_id"]
    else:
        return None
    return await db.quotations.find_one(query, {"_id": 0, "id": 1, "created_by": 1, "created_by_name": 1})


async def has_placed_order(db, followup: dict, *, floor_id: str | None = None) -> bool:
    return bool(await placed_order(db, followup, floor_id=floor_id))
