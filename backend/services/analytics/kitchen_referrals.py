"""Read current Kitchen commercial records without counting historical order versions."""
from fastapi import HTTPException


def kitchen_referral_pipeline(match, *, include_leads=False):
    # Kitchen has no product-line attribution. A product-filtered report must
    # not add unrelated Kitchen value to its selected product cohort.
    if any(key.startswith("items.") for key in match):
        return [{"$match": {"id": {"$in": []}}}]
    scope = {key: value for key, value in match.items()
             if key in {"floor_id", "referrer_id", "referrer_type", "customer_id", "created_by"}}
    scope.setdefault("referrer_id", {"$nin": [None, ""]})
    return [
        {"$match": {**scope, "is_deleted": {"$ne": True}}},
        {"$set": {"_order": {"$arrayElemAt": ["$orders", -1]},
                  "_quote": {"$arrayElemAt": ["$quotation_versions", -1]},
                  "_design": {"$arrayElemAt": ["$design_versions", -1]}}},
        {"$set": {"_confirmed": {"$and": [
            {"$eq": ["$_order.confirmed", True]}, {"$eq": ["$_order.status", "Confirmed"]},
            {"$not": [{"$ifNull": ["$_order.authorization_invalidated", False]}]},
            {"$not": [{"$ifNull": ["$commercial_basis_invalidated", False]}]},
            {"$not": [{"$ifNull": ["$design_revision_pending", False]}]},
            {"$not": [{"$in": ["$lifecycle_status", ["Cancelled", "On Hold"]]}]},
            {"$eq": ["$_quote.response", "Approved"]},
            {"$ne": [{"$ifNull": ["$_quote.shared_date", ""]}, ""]},
            {"$eq": ["$_design.response", "Approved"]},
            {"$eq": ["$_order.quotation_version_id", "$_quote.id"]},
            {"$eq": ["$_quote.design_version_id", "$_design.id"]},
            {"$eq": [{"$ifNull": ["$_design.workflow_cycle", 1]}, {"$ifNull": ["$workflow_cycle", 1]}]},
        ]}}},
        *([] if include_leads else [{"$match": {"_confirmed": True}}]),
        {"$set": {"number": {"$ifNull": ["$project_reference", "$reference"]},
                  "customer_name": "$customer.name", "ordered_at": "$_order.at",
                  "status": {"$switch": {"branches": [
                      {"case": "$_confirmed", "then": "ordered"},
                      {"case": {"$or": [
                          {"$in": ["$lifecycle_status", ["Cancelled", "On Hold"]]},
                          {"$ifNull": ["$commercial_basis_invalidated", False]},
                          {"$ifNull": ["$design_revision_pending", False]},
                          {"$ifNull": ["$_order.authorization_invalidated", False]},
                      ]}, "then": "inactive"},
                      {"case": {"$and": [
                          {"$ne": [{"$ifNull": ["$_quote.id", ""]}, ""]},
                          {"$eq": ["$_quote.design_version_id", "$_design.id"]},
                          {"$eq": [{"$ifNull": ["$_design.workflow_cycle", 1]}, {"$ifNull": ["$workflow_cycle", 1]}]},
                          {"$ne": ["$_quote.response", "Rejected"]},
                      ]}, "then": "draft"},
                  ], "default": {"$cond": [{"$ne": [{"$ifNull": ["$_quote.id", ""]}, ""]}, "inactive", "lead"]}}},
                  "grand_total": {"$convert": {"input": {"$cond": ["$_confirmed", "$_order.final_amount", "$_quote.amount"]}, "to": "double", "onError": 0, "onNull": 0}},
                  "kitchen_stage": "$stage",
                  "_kitchen_paid": {"$convert": {"input": {"$cond": ["$_order.advance.received", "$_order.advance.amount", "0"]}, "to": "double", "onError": 0, "onNull": 0}}}},
        {"$match": match},
    ]


async def kitchen_referral_records(db, match):
    rows = await db.kitchen_projects.aggregate([
        *kitchen_referral_pipeline(match, include_leads=True),
        {"$project": {"_id": 0, "id": 1, "number": 1, "customer_name": 1,
                      "status": 1, "kitchen_stage": 1, "grand_total": 1,
                      "ordered_at": 1, "created_at": 1, "referrer_name": 1, "referrer_type": 1}},
        {"$sort": {"created_at": -1, "id": 1}}, {"$limit": 1001},
    ]).to_list(1001)
    if len(rows) > 1000:
        raise HTTPException(422, "Narrow the date range to view at most 1,000 Kitchen referrals")
    return rows
