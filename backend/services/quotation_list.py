"""Small list responses and literal search; full quotation reads stay unchanged."""
import re


SUMMARY_FIELDS = (
    "id", "number", "doc_number", "doc_date", "doc_type", "floor_id",
    "customer_id", "customer_name", "project_name", "status", "customer_outcome",
    "outcome_reason", "grand_total", "created_at", "updated_at",
    "purchase_completion_status",
)


def list_projection(summary: bool) -> dict:
    if not summary:
        return {"_id": 0}
    return {
        "_id": 0,
        **dict.fromkeys(SUMMARY_FIELDS, 1),
        "item_count": {"$size": {"$ifNull": ["$items", []]}},
    }


def list_search(query: dict, q: str | None) -> dict:
    term = (q or "").strip()[:120]
    if not term:
        return query
    return {"$and": [query, {"$or": [
        {field: {"$regex": re.escape(term), "$options": "i"}}
        for field in ("number", "doc_number", "customer_name", "project_name")
    ]}]}
