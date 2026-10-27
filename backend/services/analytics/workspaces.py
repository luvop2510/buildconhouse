"""Bounded read models for owner workspaces; raw orders never cross this boundary."""
from __future__ import annotations

from services.analytics.metrics import outstanding_pipeline
from services.analytics.kitchen_referrals import kitchen_referral_pipeline

ORDER_FIELDS = {
    "_id": 0, "id": 1, "number": 1, "customer_id": 1, "customer_name": 1,
    "floor_id": 1, "created_by_name": 1, "ordered_at": 1, "grand_total": 1,
}


def merge_reference_currencies(relationships: list[dict], acquired: list[dict], furniture: list[dict]) -> list[dict]:
    """Keep INR and RNB separate; acquisition identity remains the shared source."""
    by_id = {row["id"]: {**row, "revenue_rnb": 0.0, "orders_rnb": 0} for row in relationships}
    for row in furniture:
        existing = by_id.setdefault(row["id"], {"id": row["id"], "name": row.get("name") or "Unknown reference",
            "company": row.get("company"), "type": row.get("type"), "revenue": 0.0, "orders": 0, "customers": 0})
        existing.update(revenue_rnb=row["revenue_rnb"], orders_rnb=row["orders_rnb"])
        existing["last_order_at"] = max(existing.get("last_order_at") or "", row.get("last_order_at") or "") or None
    for row in acquired:
        existing = by_id.setdefault(row["id"], {"id": row["id"], "name": row.get("name") or "Unknown reference",
            "company": row.get("company"), "type": row.get("type"), "revenue": 0.0, "orders": 0, "customers": 0})
        existing["customers_acquired"] = int(row.get("customers_acquired") or 0)
        if row.get("name"):
            existing["name"] = row["name"]
        if row.get("company"):
            existing["company"] = row["company"]
    merged = list(by_id.values())
    for row in merged:
        row.setdefault("revenue_rnb", 0.0)
        row.setdefault("orders_rnb", 0)
    return sorted(merged, key=lambda row: (-row.get("customers_acquired", 0), row.get("name", "").casefold(), row["id"]))


def workspace_pipeline(match: dict, relationship_kind: str | None = None, *, include_kitchen=False, reference_limit=100) -> list[dict]:
    # Share the canonical completed-payment lookup. Clamp each order separately:
    # an overpayment on A must never cancel the outstanding balance on B.
    payment_stages = outstanding_pipeline(match)[1:3]
    relationships = {"referrer_id": {"$nin": [None, ""]}, "referrer_name": {"$nin": [None, ""]}}
    if relationship_kind:
        relationships["referrer_type"] = relationship_kind
    return [
        {"$match": match},
        *([{"$match": {"floor_id": {"$in": ["ground-floor", "first-floor"]}}}] if include_kitchen else []),
        *([{"$unionWith": {"coll": "kitchen_projects", "pipeline": kitchen_referral_pipeline(match)}}] if include_kitchen else []),
        {"$project": {**ORDER_FIELDS, "referrer_id": 1, "referrer_name": 1, "referrer_type": 1, "_kitchen_paid": 1}},
        {"$facet": {
            "totals": [
                *payment_stages,
                *([{ "$set": {"paid": {"$ifNull": ["$_kitchen_paid", "$paid"]}}}] if include_kitchen else []),
                {"$group": {
                    "_id": None, "revenue": {"$sum": "$grand_total"}, "orders": {"$sum": 1},
                    "outstanding": {"$sum": {"$max": [0, {"$subtract": [{"$ifNull": ["$grand_total", 0]}, "$paid"]}]}},
                }},
                {"$project": {"_id": 0, "revenue": 1, "orders": 1, "outstanding": 1}},
            ],
            "customers": [
                {"$group": {
                    "_id": {"$ifNull": ["$customer_id", ""]},
                    "name": {"$first": {"$ifNull": ["$customer_name", "Unknown customer"]}},
                    "revenue": {"$sum": "$grand_total"}, "orders": {"$sum": 1},
                    "last_order_at": {"$max": "$ordered_at"},
                }},
                {"$sort": {"revenue": -1, "_id": 1}}, {"$limit": 100},
                {"$project": {"_id": 0, "customer_id": "$_id", "name": 1, "revenue": 1,
                              "orders": 1, "last_order_at": 1, "aov": {"$divide": ["$revenue", "$orders"]}}},
            ],
            "floors": [
                {"$group": {"_id": {"$ifNull": ["$floor_id", "unassigned"]},
                            "revenue": {"$sum": "$grand_total"}, "orders": {"$sum": 1}}},
                {"$sort": {"revenue": -1, "_id": 1}},
                {"$project": {"_id": 0, "floor_id": "$_id", "revenue": 1, "orders": 1}},
            ],
            "relationships": [
                {"$match": relationships},
                {"$group": {
                    "_id": "$referrer_id", "name": {"$max": "$referrer_name"},
                    "type": {"$first": "$referrer_type"}, "revenue": {"$sum": "$grand_total"},
                    "orders": {"$sum": 1}, "customers": {"$addToSet": "$customer_id"},
                    "last_order_at": {"$max": "$ordered_at"},
                }},
                {"$sort": {"revenue": -1, "_id": 1}}, {"$limit": reference_limit},
                {"$project": {"_id": 0, "id": "$_id", "name": 1, "type": 1,
                              "revenue": 1, "orders": 1, "customers": {"$size": "$customers"}, "last_order_at": 1}},
            ],
        }},
    ]


async def gather_workspace(db, match: dict, relationship_kind: str | None = None, *, include_kitchen=False, reference_limit=100) -> dict:
    rows = await db.quotations.aggregate(workspace_pipeline(match, relationship_kind, include_kitchen=include_kitchen, reference_limit=reference_limit)).to_list(1)
    data = rows[0] if rows else {}
    totals = (data.get("totals") or [{}])[0]
    data["kpis"] = {
        "revenue": round(float(totals.get("revenue") or 0), 2),
        "orders": int(totals.get("orders") or 0),
        "outstanding": round(float(totals.get("outstanding") or 0), 2),
    }
    for key in ("customers", "floors", "relationships"):
        for row in data.setdefault(key, []):
            for field in ("revenue", "aov"):
                if field in row:
                    row[field] = round(float(row[field] or 0), 2)
    return data


async def gather_workspace_labels(db, match: dict, product_ids: list[str]) -> tuple[dict, dict]:
    """Read labels for the displayed top products without hydrating order items."""
    if not product_ids:
        return {}, {}
    rows = await db.quotations.aggregate([
        {"$match": match},
        {"$sort": {"ordered_at": 1, "id": 1}},
        {"$unwind": "$items"},
        {"$match": {"items.product_id": {"$in": product_ids}}},
        {"$group": {"_id": "$items.product_id", "name": {"$last": "$items.name"}, "sku": {"$last": "$items.sku"}}},
    ]).to_list(len(product_ids))
    return ({r["_id"]: r["name"] for r in rows if r.get("name")},
            {r["_id"]: r["sku"] for r in rows if r.get("sku")})
