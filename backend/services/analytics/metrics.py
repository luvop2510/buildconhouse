"""Canonical KPI definitions — spec §4.3.

Each KPI is defined here exactly once. A workspace that needs Revenue calls
revenue_pipeline; it does not write its own $group. This is the structural
guarantee behind "one source of truth per KPI".
"""
from __future__ import annotations

import hashlib
from dataclasses import asdict

from services.analytics.filters import AnalyticsFilter

# Which collections each metric reads — consumed by cache.cached so a write
# to any of them invalidates the metric automatically.
METRIC_SOURCES: dict[str, list[str]] = {
    "revenue": ["quotations"],
    "orders": ["quotations"],
    "aov": ["quotations"],
    "outstanding": ["quotations", "payments"],
    "conversion": ["quotations", "walkins"],
    "referral_revenue": ["quotations"],
    "brand_revenue": ["quotations", "products"],
    "product_revenue": ["quotations"],
    "customer_ltv": ["quotations"],
    "money_blocked": ["quotations", "payments", "customer_orders", "dispatches", "ready_batches", "purchase_orders"],
}


def filter_signature(f: AnalyticsFilter) -> str:
    """Short stable hash of a filter, for cache keys."""
    raw = "|".join(f"{k}={v}" for k, v in sorted(asdict(f).items()))
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def revenue_pipeline(match: dict) -> list[dict]:
    """Revenue, Orders, AOV and distinct customers in one pass.

    Revenue is the sum of grand_total over confirmed orders only, dated by
    ordered_at (enforced upstream by filters.date_field_for).
    """
    return [
        {"$match": match},
        {"$group": {
            "_id": None,
            "revenue": {"$sum": "$grand_total"},
            "orders": {"$sum": 1},
            "customers": {"$addToSet": "$customer_id"},
        }},
        {"$project": {
            "_id": 0,
            "revenue": {"$round": ["$revenue", 2]},
            "orders": 1,
            "customers": {"$size": "$customers"},
            "aov": {"$cond": [{"$gt": ["$orders", 0]}, {"$round": [{"$divide": ["$revenue", "$orders"]}, 2]}, 0]},
        }},
    ]


def line_revenue_pipeline(match: dict, group_by: str, limit: int | None = 50) -> list[dict]:
    """Revenue grouped by a line-level field.

    Sums items.net_amount — the denormalized post-discount total — so brand,
    product and category revenue reconcile to grand_total. Never
    qty x unit_price: that ignores the discount cascade.
    """
    return [
        {"$match": match},
        {"$unwind": "$items"},
        {"$group": {
            "_id": f"${group_by}",
            "revenue": {"$sum": "$items.net_amount"},
            "quantity": {"$sum": "$items.qty"},
            "orders": {"$addToSet": "$id"},
            "customers": {"$addToSet": "$customer_id"},
        }},
        {"$project": {
            "_id": 0,
            "key": "$_id",
            "revenue": {"$round": ["$revenue", 2]},
            "quantity": 1,
            "orders": {"$size": "$orders"},
            "customers": {"$size": "$customers"},
        }},
        {"$sort": {"revenue": -1}},
    ] + ([{"$limit": limit}] if limit is not None else [])


def outstanding_pipeline(match: dict) -> list[dict]:
    """Ordered value minus payments actually received.

    Only status="completed" payments count as collected. A "pending" payment
    is recorded, not received — treating it as collected would understate
    what the business is owed.
    """
    return [
        {"$match": match},
        {"$lookup": {
            "from": "payments",
            "let": {"qid": "$id"},
            "pipeline": [
                {"$match": {"$expr": {"$and": [
                    {"$eq": ["$quotation_id", "$$qid"]},
                    {"$eq": ["$status", "completed"]},
                ]}}},
                {"$group": {"_id": None, "paid": {"$sum": "$amount"}}},
            ],
            "as": "collected",
        }},
        {"$addFields": {"paid": {"$ifNull": [{"$first": "$collected.paid"}, 0]}}},
        {"$group": {
            "_id": None,
            "ordered": {"$sum": "$grand_total"},
            "collected": {"$sum": "$paid"},
        }},
        {"$project": {
            "_id": 0,
            "ordered": {"$round": ["$ordered", 2]},
            "collected": {"$round": ["$collected", 2]},
            "outstanding": {"$round": [{"$subtract": ["$ordered", "$collected"]}, 2]},
        }},
    ]
