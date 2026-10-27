"""Count referred people before ordering, without exporting lead records.

Mongo groups across sources and floors before applying the display limit. Phone
identity follows the application's Indian local-number duplicate convention;
records without a phone retain their explicit customer/lead identity.
"""
from dataclasses import replace

from services.analytics.filters import AnalyticsFilter, build_match


def acquisition_pipeline(f: AnalyticsFilter, floors, window, kind=None, order_match=None, *, limit=100):
    def source(collection):
        match = build_match(replace(f, status="any", referrer_type=kind), floors, window)
        if collection == "customers" and "customer_id" in match:
            match["id"] = match.pop("customer_id")
        if collection == "kitchen_projects":
            phone_field = "$customer_phone_normalized"
        else:
            phone_field = "$phone_normalized"
        if collection == "walkins" and "created_by" in match:
            match["salesperson_id"] = match.pop("created_by")
        match.update({"referrer_id": match.get("referrer_id", {"$nin": [None, ""]}), "is_deleted": {"$ne": True}})
        # Brand filters have meaning on ordered product lines, not an unrelated
        # pre-order lead. In this scope use precisely the filtered order cohort.
        if f.brand_id:
            match = {**(order_match or {}), **{"referrer_id": match["referrer_id"], "is_deleted": {"$ne": True}}}
            if kind:
                match["referrer_type"] = kind
        phone = {"$ifNull": [phone_field, {"$ifNull": ["$customer_phone", {"$ifNull": ["$phone", ""]}]}]}
        for character in ("+", " ", "-", "(", ")", "."):
            phone = {"$replaceAll": {"input": phone, "find": character, "replacement": ""}}
        stages = [{"$match": match}]
        if collection == "quotations":
            stages.extend([
                {"$lookup": {"from": "customers", "localField": "customer_id", "foreignField": "id", "as": "customer_identity"}},
                {"$set": {"customer_phone": {"$arrayElemAt": ["$customer_identity.phone", 0]}}},
            ])
        return [
            *stages,
            {"$project": {"referrer_id": 1, "referrer_name": 1, "referrer_type": 1,
                          "phone_key": phone,
                          "identity": {"$ifNull": ["$customer_id", {"$ifNull": ["$lead_group_id", "$id"]}]}}},
            {"$set": {"person": {"$cond": [
                {"$gte": [{"$strLenCP": "$phone_key"}, 10]},
                {"$concat": ["phone:", {"$substrCP": ["$phone_key", {"$subtract": [{"$strLenCP": "$phone_key"}, 10]}, 10]}]},
                {"$concat": ["id:", "$identity"]},
            ]}}},
        ]

    first = "quotations" if f.brand_id else "customers"
    pipeline = source(first)
    if not f.brand_id:
        for collection in ("walkins", "followups", "quotations", "furniture_quotations", "kitchen_projects"):
            pipeline.append({"$unionWith": {"coll": collection, "pipeline": source(collection)}})
    pipeline.extend([
        {"$group": {"_id": {"referrer": "$referrer_id", "person": "$person"},
                    "name": {"$max": "$referrer_name"}, "type": {"$max": "$referrer_type"}}},
        {"$group": {"_id": "$_id.referrer", "name": {"$max": "$name"}, "type": {"$max": "$type"}, "customers_acquired": {"$sum": 1}}},
        {"$sort": {"customers_acquired": -1, "_id": 1}}, {"$limit": limit},
        {"$project": {"_id": 0, "id": "$_id", "name": 1, "type": 1, "customers_acquired": 1}},
        {"$lookup": {"from": "referrers", "localField": "id", "foreignField": "id", "as": "_directory", "pipeline": [
            *([{"$match": {"floor_id": {"$in": list(floors)}}}] if floors is not None else []),
            {"$project": {"_id": 0, "name": 1, "company": 1}},
        ]}},
        {"$set": {"name": {"$ifNull": [{"$arrayElemAt": ["$_directory.name", 0]}, "$name"]},
                  "company": {"$ifNull": [{"$arrayElemAt": ["$_directory.company", 0]}, None]}}},
        {"$unset": "_directory"},
    ])
    return first, pipeline


async def gather_acquired_customers(db, f, floors, window, kind=None, order_match=None, *, limit=100):
    collection, pipeline = acquisition_pipeline(f, floors, window, kind, order_match, limit=limit)
    return await db[collection].aggregate(pipeline).to_list(limit)


def merge_acquisitions(relationships, acquired):
    by_id = {row["id"]: {**row, "customers_acquired": row.get("customers", 0)} for row in relationships}
    for row in acquired:
        existing = by_id.setdefault(row["id"], {"id": row["id"], "name": row.get("name") or "Unknown interior",
                                              "type": row.get("type"), "revenue": 0, "orders": 0, "customers": 0, "last_order_at": None})
        existing["customers_acquired"] = int(row.get("customers_acquired") or 0)
        existing["company"] = row.get("company")
        if row.get("name"):
            existing["name"] = row["name"]
    return sorted(by_id.values(), key=lambda row: (-row.get("revenue", 0), -row.get("customers_acquired", 0), row["id"]))[:100]
