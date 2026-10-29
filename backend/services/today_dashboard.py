"""One current-floor operational read model, with no sales-report payloads."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi import HTTPException

from access_profiles import PROFILE_MODULES
from auth import accessible_floor_ids
from services.access_grants import RESOURCE_REGISTRY, grant_allows, grants_for_user
from services.lead_scope import POST_ORDER_CATEGORIES, POST_ORDER_RULES

INDIA = timezone(timedelta(hours=5, minutes=30))
TASK_LIMIT = 24
logger = logging.getLogger(__name__)
FLOOR_NAMES = {"ground-floor": "Ground Floor", "first-floor": "The Sanitary Bathroom",
               "second-floor": "Kitchen", "third-floor": "Furniture"}
LEGACY_RESOURCES = {"sales": {"quotations", "tiles", "walkins", "followups", "customers", "catalog", "furniture_quotations"},
                    "accounts": {"payments"}, "purchase": {"purchases", "catalog"},
                    "warehouse": {"orders", "godown_stock"}, "worker": set()}


def floor_resources(floor):
    return {key for key, metadata in RESOURCE_REGISTRY.items()
            if key not in {"dashboard", "reports", "sales_data"} and not metadata.get("retired")
            and (not metadata.get("floor_ids") or floor in metadata["floor_ids"])
            and (floor != "second-floor" or key == "kitchen_projects")}


async def access_for(database, user, floor):
    allowed = accessible_floor_ids(user)
    if allowed is not None and floor not in allowed:
        raise HTTPException(403, "You do not have access to this floor")
    resources = floor_resources(floor)
    if user.role == "owner":
        return resources, True
    if user.custom_access:
        grants = await grants_for_user(database, user.id)
        enabled = {resource for resource in resources if any(grant_allows(grant, user_id=user.id,
                   resource=resource, action="view", floor_id=floor) for grant in grants)}
        if user.access_profile:
            enabled &= PROFILE_MODULES.get(user.access_profile, set())
        return enabled, not user.access_profile and resources <= enabled
    if user.access_profile:
        return resources & PROFILE_MODULES.get(user.access_profile, set()), False
    if user.role in {"admin", "manager"}:
        return resources, True
    enabled = resources & LEGACY_RESOURCES.get(user.role, set())
    if floor == "second-floor":
        enabled.add("kitchen_projects")
    return enabled, False


def selected_floor(user):
    allowed = accessible_floor_ids(user)
    floor = user.active_floor_id or (allowed[0] if allowed is not None and len(allowed) == 1 else None)
    if not floor:
        raise HTTPException(422, "Choose a floor to see today's work")
    if floor not in FLOOR_NAMES:
        raise HTTPException(422, "Choose an active operational floor")
    if allowed is not None and floor not in allowed:
        raise HTTPException(403, "You do not have access to this floor")
    return floor


def task(row, resource, href, *, title=None, due=None, progress=None):
    # Whitelisted output deliberately excludes amounts, contacts and histories.
    return {"id": row["id"], "resource": resource, "title": title or row.get("customer_name") or row.get("number") or "Scheduled work",
            "status": row.get("status") or "open", "due_at": (due if due.tzinfo else due.replace(tzinfo=timezone.utc)).isoformat() if isinstance(due, datetime) else due, "updated_at": row.get("updated_at"),
            "assignee_name": row.get("assigned_to_name") or row.get("salesperson_name"),
            "href": href, "progress": progress}


async def followup_tasks(database, user, floor, full, start, end, now):
    match = {"floor_id": floor, "category": {"$nin": sorted(POST_ORDER_CATEGORIES)},
             "rule_type": {"$nin": sorted(POST_ORDER_RULES)}, "purchase_id": {"$in": [None, ""]},
             "consolidated_order_id": {"$in": [None, ""]}}
    effective_due = {"$cond": [{"$and": [{"$eq": ["$status", "snoozed"]},
                                          {"$gt": [{"$convert": {"input": "$snoozed_until", "to": "date", "onError": None, "onNull": None}}, now]}]}, "$snoozed_until", "$due_at"]}
    active = {"status": {"$in": ["open", "snoozed"]}}
    projection = {"_id": 0, **{key: 1 for key in ("id", "customer_name", "status", "due_at", "updated_at", "assigned_to_name", "completed_at")}}
    rows = await database.followups.aggregate([
        {"$match": match}, {"$set": {"due_at": {"$convert": {"input": effective_due, "to": "date", "onError": None, "onNull": None}}, "completed_at": {"$convert": {"input": "$completed_at", "to": "date", "onError": None, "onNull": None}}}}, {"$facet": {
            "open": [{"$match": active}, {"$count": "count"}],
            "overdue": [{"$match": {**active, "due_at": {"$ne": None, "$lt": start}}}, {"$count": "count"}],
            "due_today": [{"$match": {**active, "due_at": {"$gte": start, "$lt": end}}}, {"$count": "count"}],
            "completed_today": [{"$match": {"status": "done", "completed_at": {"$gte": start, "$lt": end}}}, {"$count": "count"}],
            "tasks": [{"$match": active}, {"$set": {"sort_due": {"$ifNull": ["$due_at", datetime.max.replace(tzinfo=timezone.utc)]}}}, {"$sort": {"sort_due": 1, "id": 1}}, {"$limit": TASK_LIMIT + 1}, {"$project": projection}],
        }}], maxTimeMS=5000).to_list(1)
    result = rows[0] if rows else {}
    summary = {key: (result.get(key) or [{}])[0].get("count", 0) for key in ("open", "overdue", "due_today", "completed_today")}
    items = result.get("tasks", [])
    return summary, [task(row, "followups", "/followups", due=row.get("due_at")) for row in items[:TASK_LIMIT]], len(items) > TASK_LIMIT


async def scheduled_tasks(database, user, floor, resources, full, start, end):
    specs = []
    fields = {"_id": 0, **{key: 1 for key in ("id", "number", "customer_name", "status", "updated_at", "assigned_to_name", "due_at", "progress", "source_customer_name", "name", "doc_type")}}
    if "walkins" in resources:
        specs.append(("walkins", "walkins", {"showroom_transferred_at": None},
                      {"status": {"$in": ["new", "contacted", "selection_scheduled"]}}, "$next_followup_at", fields,
                      {"status": {"$in": ["converted", "quotation_created", "selection_completed"]}, "converted_at": {"$gte": start.isoformat(), "$lt": end.isoformat()}}))
    if "quotations" in resources or "tiles" in resources:
        resource = "quotations" if "quotations" in resources else "tiles"
        specs.append((resource, "quotations", {}, {"status": {"$in": ["draft", "pending_approval", "sent"]}},
                      "$valid_until", fields, {"status": "ordered", "ordered_at": {"$gte": start.isoformat(), "$lt": end.isoformat()}}))
    if "purchases" in resources or "orders" in resources:
        resource = "purchases" if "purchases" in resources else "orders"
        specs.append((resource, "purchase_orders", {}, {"status": {"$nin": ["delivered", "cancelled", "completed"]}},
                      "$expected_delivery_at", fields, {"status": "delivered", "delivered_at": {"$gte": start.isoformat(), "$lt": end.isoformat()}}))
    if "payments" in resources and floor in {"ground-floor", "first-floor"}:
        specs.append(("payments", "quotations", {"status": {"$in": ["ordered", "won"]}},
                      {"$expr": {"$gt": [{"$subtract": ["$collection_total", "$collection_paid"]}, 0.000001]}}, None, fields, None))
    if "purchases" in resources:
        specs.append(("purchases", "purchase_shortages", {}, {"status": "awaiting_reorder"}, None, fields,
                      {"status": {"$in": ["resolved", "reordered"]}, "resolved_at": {"$gte": start.isoformat(), "$lt": end.isoformat()}}))
    if "godown_stock" in resources:
        specs.append(("godown_stock", "purchase_transfers", {"type": "loan"}, {"status": "return_due"}, None, fields,
                      {"status": "returned", "returned_at": {"$gte": start.isoformat(), "$lt": end.isoformat()}}))
    if "kitchen_projects" in resources:
        due = {"$cond": [{"$eq": ["$stage", "visit"]}, "$visit.visit_date", "$target_completion_date"]}
        specs.append(("kitchen_projects", "kitchen_projects", {},
                      {"stage": {"$ne": "completed"}, "status": {"$nin": ["Lost", "Cancelled", "On Hold"]}, "lifecycle_status": {"$nin": ["Cancelled", "On Hold"]}}, due,
                      {**fields, "stage": 1, "customer.name": 1, "cad.progress": 1, "production.progress": 1, "installation.progress": 1},
                      {"stage": "completed", "completion_date": start.astimezone(INDIA).date().isoformat()}))
    if "furniture_quotations" in resources:
        specs.append(("furniture_quotations", "furniture_quotations", {}, {"status": "draft"}, None, fields, None))

    async def read(spec):
        resource, collection, extra, active, due, projection, completed = spec
        due_expression = {"$convert": {"input": due, "to": "date", "onError": None, "onNull": None}} if due else None
        # Kitchen's date-only work dates represent an India calendar day.
        if resource == "kitchen_projects":
            due_expression = {"$dateFromString": {"dateString": due, "timezone": "Asia/Kolkata", "onError": None, "onNull": None}}
        facets = {"open": [{"$match": active}, {"$count": "count"}],
                  "overdue": [{"$match": {**active, "due_at": {"$ne": None, "$lt": start}}}, {"$count": "count"}],
                  "due_today": [{"$match": {**active, "due_at": {"$gte": start, "$lt": end}}}, {"$count": "count"}],
                  "tasks": [{"$match": active}, {"$set": {"sort_due": {"$ifNull": ["$due_at", datetime.max.replace(tzinfo=timezone.utc)]}}}, {"$sort": {"sort_due": 1, "id": 1}}, {"$limit": TASK_LIMIT + 1}, {"$project": projection}]}
        if completed:
            facets["completed_today"] = [{"$match": completed}, {"$count": "count"}]
        pipeline = [{"$match": {"floor_id": floor, "is_deleted": {"$ne": True}, **extra}}]
        if resource == "payments":
            # The same receivable as Payments: immutable extra costs add to
            # the order; completed receipts and stock credits settle it.
            pipeline.extend([
                {"$lookup": {"from": "payments", "let": {"quotation": "$id", "floor": "$floor_id"},
                    "pipeline": [{"$match": {"status": "completed", "$expr": {"$and": [
                        {"$eq": ["$quotation_id", "$$quotation"]}, {"$eq": ["$floor_id", "$$floor"]}]}}},
                        {"$group": {"_id": None, "paid": {"$sum": "$amount"}}}], "as": "receipts"}},
                {"$set": {"collection_total": {"$round": [{"$add": [{"$ifNull": ["$grand_total", 0]},
                    {"$cond": [{"$isArray": "$payment_extra_history"}, {"$sum": "$payment_extra_history.amount"},
                               {"$ifNull": ["$payment_extra_amount", 0]}]}]}, 2]},
                          "collection_paid": {"$ifNull": [{"$arrayElemAt": ["$receipts.paid", 0]}, 0]}}},
                {"$set": {"status": {"$cond": [{"$gt": ["$collection_paid", 0]}, "partial", "due"]},
                          "progress": {"$cond": [{"$gt": ["$collection_total", 0]},
                              {"$min": [100, {"$round": [{"$multiply": [{"$divide": ["$collection_paid", "$collection_total"]}, 100]}, 0]}]}, 0]}}}])
        rows = await database[collection].aggregate([*pipeline,
            {"$set": {"due_at": due_expression}}, {"$facet": facets}], maxTimeMS=5000).to_list(1)
        result = rows[0] if rows else {}
        summary = {key: (result.get(key) or [{}])[0].get("count", 0) for key in ("open", "overdue", "due_today", "completed_today")}
        tasks = []
        for row in result.get("tasks", [])[:TASK_LIMIT]:
            href = {"walkins": "/walkins/" + quote(row["id"], safe=""), "purchases": "/purchases",
                    "orders": "/tiles/orders", "payments": "/payments", "godown_stock": "/godown-stock", "quotations": "/quotations/" + quote(row["id"], safe=""), "tiles": ("/tiles/selection?id=" if row.get("doc_type") == "tiles_selection" else "/tiles/quotation?id=" if row.get("doc_type") == "tiles_quotation" else "/tiles?quotation=") + quote(row["id"], safe=""), "furniture_quotations": "/notebook/furniture-quotations"}.get(resource, "")
            if resource == "kitchen_projects":
                stage = row.get("stage", "lead")
                item = task(row, resource, "/kitchen/" + quote(row["id"], safe="") + "/stages/" + stage,
                            title=(row.get("customer") or {}).get("name"), due=row.get("due_at"), progress=(row.get(stage) or {}).get("progress"))
                item["status"] = stage
            else:
                item = task(row, resource, href, due=row.get("due_at"), progress=row.get("progress"),
                            title=("Return stock · " + (row.get("source_customer_name") or row.get("name") or "Recorded loan")) if resource == "godown_stock" else
                                  ("Reorder · " + (row.get("customer_name") or row.get("name") or "Recorded shortage")) if collection == "purchase_shortages" else None)
            tasks.append(item)
        return summary, tasks, len(result.get("tasks", [])) > TASK_LIMIT

    results = await asyncio.gather(*(read(spec) for spec in specs))
    summary = {key: sum(result[0][key] for result in results) for key in ("open", "overdue", "due_today", "completed_today")}
    return summary, [task for _, tasks, _ in results for task in tasks], any(result[2] for result in results)


async def workflow_counts(database, floor, resources):
    specs = [("walkins", "Walk-ins", "walkins", "status"), ("quotations", "Quotations", "quotations", "status"),
             ("tiles", "Selections and quotations", "quotations", "status"), ("purchases", "Purchases", "purchase_orders", "status"),
             ("orders", "Orders and dispatches", "customer_orders", "overall_status"),
             ("kitchen_projects", "Kitchen projects", "kitchen_projects", "stage"),
             ("furniture_quotations", "Furniture quotations", "furniture_quotations", "status")]
    specs = [spec for spec in specs if spec[0] in resources]
    rows = await asyncio.gather(*(database[collection].aggregate([
        {"$match": {"floor_id": floor, "is_deleted": {"$ne": True}}},
        {"$group": {"_id": "$" + field, "count": {"$sum": 1}}}], maxTimeMS=5000).to_list(50)
        for _, _, collection, field in specs))
    return [{"resource": resource, "label": label, "total": sum(row["count"] for row in statuses),
             "statuses": [{"status": row["_id"] or "unknown", "count": row["count"]} for row in statuses]}
            for (resource, label, _, _), statuses in zip(specs, rows)]


async def receipt_totals(database, floor, start, end):
    rows = await database.payments.aggregate([
        {"$match": {"floor_id": floor, "status": "completed", "entry_type": {"$ne": "godown_stock_credit"}}},
        {"$set": {"receipt_at": {"$convert": {"input": {"$ifNull": ["$paid_at", "$created_at"]}, "to": "date", "onError": None, "onNull": None}}}},
        {"$match": {"receipt_at": {"$gte": start, "$lt": end}}},
        {"$group": {"_id": None, "received": {"$sum": "$amount"}, "count": {"$sum": 1}}}], maxTimeMS=5000).to_list(1)
    value = rows[0] if rows else {}
    return {"currency": "INR", "received_today": round(value.get("received", 0), 2), "receipt_count": value.get("count", 0)}


async def today_dashboard(database, user, now=None):
    now = now or datetime.now(timezone.utc)
    floor = selected_floor(user)
    resources, full = await access_for(database, user, floor)
    local_start = now.astimezone(INDIA).replace(hour=0, minute=0, second=0, microsecond=0)
    start = local_start.astimezone(timezone.utc)
    end = (local_start + timedelta(days=1)).astimezone(timezone.utc)
    empty = ({"open": 0, "overdue": 0, "due_today": 0, "completed_today": 0}, [], False)
    followups, scheduled = await asyncio.gather(
        followup_tasks(database, user, floor, full, start, end, now) if "followups" in resources else asyncio.sleep(0, result=empty),
        scheduled_tasks(database, user, floor, resources, full, start, end))
    summary, tasks, truncated = followups
    schedule_summary, scheduled_rows, schedule_truncated = scheduled
    summary = {key: value + schedule_summary[key] for key, value in summary.items()}
    tasks.extend(scheduled_rows)
    tasks.sort(key=lambda row: (row["due_at"] is None, row["due_at"] or "", row["resource"], row["id"]))
    # Complete database counts remain independent of the bounded preview.
    return {"floor_id": floor, "floor_name": FLOOR_NAMES[floor], "generated_at": now.isoformat(),
            "full_floor_access": full, "resources": sorted(resources), "task_summary": summary,
            "tasks": tasks[:TASK_LIMIT], "workflows": [], "payments": None,
            "truncated": truncated or schedule_truncated or len(tasks) > TASK_LIMIT, "unavailable_sections": []}


async def today_overview(database, user, now=None):
    floor = selected_floor(user)
    resources, full = await access_for(database, user, floor)
    if not full:
        raise HTTPException(403, "The floor overview requires access to every department on this floor")
    now = now or datetime.now(timezone.utc)
    start = now.astimezone(INDIA).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    end = start + timedelta(days=1)
    unavailable = []
    async def optional(section, operation, fallback):
        try:
            async with asyncio.timeout(3):
                return await operation
        except Exception:
            logger.warning("Today %s unavailable on %s", section, floor, exc_info=True)
            unavailable.append(section)
            return fallback

    workflows, payments = await asyncio.gather(
        optional("workflows", workflow_counts(database, floor, resources), []),
        optional("payments", receipt_totals(database, floor, start, end), None) if "payments" in resources and floor in {"ground-floor", "first-floor"} else asyncio.sleep(0, result=None))
    return {"floor_id": floor, "workflows": workflows, "payments": payments, "unavailable_sections": unavailable}
