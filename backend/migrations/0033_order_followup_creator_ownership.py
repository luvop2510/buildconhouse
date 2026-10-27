"""Attribute historical won sales to their actual order's quotation creator.

Existing linked closed sales need a same-floor placed quotation. Unlinked
walk-in/showroom wins need exactly one placed order for that same customer
and floor; ambiguous customers are left intact. Operational/payment reminders,
drafts and lost leads never qualify. Preserve notes and completion times.
"""


async def up(db):
    query = {
        "status": "done", "auto_resolved": True,
        "completed_outcome": {"$in": ["won", "converted"]},
        "purchase_id": None, "rule_type": {"$ne": "order_confirmed_ops"},
        "category": {"$nin": ["payment", "purchase", "operations"]},
        "$or": [
            {"quotation_id": {"$type": "string", "$ne": ""}},
            {"category": "walk_in", "quotation_id": None},
            {"category": "walk_in", "quotation_id": ""},
        ],
    }
    async for row in db.followups.find(query, {
        "_id": 0, "id": 1, "floor_id": 1, "customer_id": 1, "quotation_id": 1,
    }):
        if not row.get("floor_id"):
            continue
        confirmed = {"floor_id": row["floor_id"], "status": {"$in": ["ordered", "won"]}}
        projection = {"_id": 0, "id": 1, "number": 1, "created_by": 1, "created_by_name": 1}
        linked = bool(row.get("quotation_id"))
        if linked:
            order = await db.quotations.find_one({**confirmed, "id": row["quotation_id"]}, projection)
        elif row.get("customer_id"):
            # Bound the read: a second candidate proves ambiguity. Even equal
            # creators on several orders do not identify this historical sale.
            orders = await db.quotations.find({**confirmed, "customer_id": row["customer_id"]}, projection).limit(2).to_list(2)
            order = orders[0] if len(orders) == 1 else None
        else:
            continue
        if not order or not order.get("created_by"):
            continue
        patch = {"assigned_to": order["created_by"], "assigned_to_name": order.get("created_by_name")}
        if not linked:
            patch.update({"quotation_id": order["id"], "quotation_number": order.get("number")})
        await db.followups.update_one({
            "id": row["id"], "floor_id": row["floor_id"],
            "quotation_id": row.get("quotation_id"), "status": "done", "auto_resolved": True,
            "completed_outcome": {"$in": ["won", "converted"]},
        }, {"$set": patch})
