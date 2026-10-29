"""Floor-local Today work plus the owner-only legacy sales snapshot."""
import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from pymongo.errors import ExecutionTimeout

from auth import floor_query, floor_scope_ids, get_current_user
from db import db
from models import UserPublic
from services.analytics import cache

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/today/overview")
async def today_overview(response: Response, user: UserPublic = Depends(get_current_user)):
    from services.today_dashboard import today_overview as load_overview
    response.headers["Cache-Control"] = "no-store"
    try:
        async with asyncio.timeout(8):
            return await load_overview(db, user)
    except (TimeoutError, ExecutionTimeout) as exc:
        raise HTTPException(503, "The floor overview is taking too long. Try again.") from exc


@router.get("/today")
async def today(response: Response, user: UserPublic = Depends(get_current_user)):
    from services.today_dashboard import today_dashboard
    response.headers["Cache-Control"] = "no-store"
    try:
        async with asyncio.timeout(12):
            return await today_dashboard(db, user)
    except (TimeoutError, ExecutionTimeout) as exc:
        raise HTTPException(503, "Today's work is taking too long. Try again.") from exc


@router.get("/stats")
async def dashboard_stats(user: UserPublic = Depends(get_current_user)):
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    today_end = (now + timedelta(days=1)).isoformat()

    async def load() -> dict:
        # One database-side facet replaces downloading (and Python-processing)
        # every quotation. Each facet returns only the small slice the home
        # screen needs, so the cost stays bounded as the ERP grows.
        quotation_pipeline = [
            {"$match": floor_query(user, {})},
            {"$facet": {
                "revenue_month": [
                    {"$match": {"$or": [
                        {"status": "ordered", "ordered_at": {"$gte": month_start}},
                        # Historic records may still carry the legacy won
                        # state and no ordered_at; preserve their reporting
                        # history until a dedicated backfill is run.
                        {"status": "won", "updated_at": {"$gte": month_start}},
                    ]}},
                    {"$group": {"_id": None, "value": {"$sum": "$grand_total"}}},
                ],
                "pipeline": [
                    {"$match": {"status": {"$in": ["draft", "pending_approval", "sent"]}}},
                    {"$group": {
                        "_id": None,
                        "value": {"$sum": "$grand_total"},
                        "pending": {"$sum": {"$cond": [{"$eq": ["$status", "pending_approval"]}, 1, 0]}},
                    }},
                ],
                "quotes_this_month": [
                    {"$match": {"created_at": {"$gte": month_start}}},
                    {"$count": "value"},
                ],
                "recent": [
                    {"$sort": {"updated_at": -1}}, {"$limit": 8},
                    {"$project": {"_id": 0, "id": 1, "number": 1, "customer_name": 1, "status": 1, "grand_total": 1, "updated_at": 1}},
                ],
                "top_products": [
                    # Product rankings are revenue, not quote popularity:
                    # never let draft/rejected/lost documents influence them.
                    {"$match": {"status": {"$in": ["ordered", "won"]}}},
                    {"$unwind": "$items"},
                    {"$group": {
                        "_id": "$items.product_id", "name": {"$first": "$items.name"}, "sku": {"$first": "$items.sku"},
                        "image": {"$first": "$items.image"}, "qty": {"$sum": "$items.qty"},
                        # Quotation writes stamp net_amount per line after
                        # product/room/category/project discounts. Historic
                        # rows without that field retain their gross fallback.
                        "revenue": {"$sum": {"$ifNull": ["$items.net_amount", {"$multiply": ["$items.qty", "$items.unit_price"]}]}},
                    }},
                    {"$sort": {"revenue": -1}}, {"$limit": 5},
                    {"$project": {"_id": 0, "product_id": "$_id", "name": 1, "sku": 1, "image": 1, "qty": 1, "revenue": 1}},
                ],
            }},
        ]
        (quotation_result,), customers, products, followups_due = await asyncio.gather(
            db.quotations.aggregate(quotation_pipeline).to_list(1),
            db.customers.count_documents(floor_query(user, {})),
            db.products.count_documents(floor_query(user, {"active": True})),
            db.followups.count_documents(floor_query(user, {"status": "open", "due_at": {"$lte": today_end}, "assigned_to": user.id}))
            if user.role != "owner" else asyncio.sleep(0, result=0),
        )
        revenue = quotation_result.get("revenue_month", [])
        pipeline = quotation_result.get("pipeline", [])
        month_count = quotation_result.get("quotes_this_month", [])
        pipeline_row = pipeline[0] if pipeline else {}
        return {
            "revenue_month": round((revenue[0].get("value", 0) if revenue else 0), 2),
            "open_pipeline": round(pipeline_row.get("value", 0), 2),
            "pending_approval": pipeline_row.get("pending", 0),
            "quotes_this_month": month_count[0].get("value", 0) if month_count else 0,
            "customers": customers, "products": products, "followups_due": followups_due,
            "recent_activity": [
                {"id": q["id"], "kind": "quotation", "title": f"{q['number']} · {q['customer_name']}", "status": q["status"], "amount": q.get("grand_total", 0), "at": q.get("updated_at")}
                for q in quotation_result.get("recent", [])
            ],
            "top_products": quotation_result.get("top_products", []),
        }

    # A very short cache makes route revisits instantaneous without making the
    # dashboard materially stale. Version keys invalidate immediately for
    # write paths that already publish analytics changes.
    # followups_due is assigned to this person, so same-floor staff must not
    # share one another's cached count.
    return await cache.cached("dashboard_stats", ["quotations", "customers", "products", "followups"], f"{month_start[:10]}:{user.id}", floor_scope_ids(user), load, ttl=15)
