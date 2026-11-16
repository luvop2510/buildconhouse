"""Home customer discovery with independently authorized source records.

Identity is the stored customer link, never a matching name/phone: relatives and
separate projects can legitimately share a contact number.
"""
from __future__ import annotations

import asyncio
import os
import re
from typing import get_args, get_origin
from fastapi import HTTPException
from pydantic import BaseModel
from auth import accessible_floor_ids, authorize_staff_resource
from models import CustomerPublic, Followup, Quotation
from models_walkins import WalkIn
from models_tile_orders import TileCustomerOrder
from services import kitchen_access
from services.lead_scope import POST_ORDER_CATEGORIES, POST_ORDER_RULES
from services.kitchen_projects import KitchenProjectService
from services.kitchen_stage_followups import public_followup

SOURCES = {
    "customer": ("customers", "/api/customers", ("name",), ("phone",)),
    "kitchen": ("kitchen_projects", "/api/kitchen-projects", ("customer.name", "reference", "project_reference"), ("customer.phone", "customer_phone_normalized")),
    "walkin": ("walkins", "/api/walkins", ("customer_name",), ("customer_phone",)),
    "followup": ("followups", "/api/followups", ("customer_name",), ("customer_phone",)),
    "quotation": ("quotations", "/api/quotations", ("customer_name", "customer_name_snapshot", "number", "project_name"), ("customer_phone", "phone_snapshot")),
    "furniture": ("furniture_quotations", "/api/furniture-quotations", ("customer_name", "number"), ("customer_phone",)),
    "order": ("customer_orders", "/api/tile-orders/customer-orders", ("customer_name", "number"), ("customer_phone",)),
}
# Public stored business fields only. Credentials, receipts, bucket/object keys,
# command fingerprints and admission tokens never enter this read model.
PUBLIC_FIELDS = frozenset("id floor_id customer_id name customer_name customer_name_snapshot phone customer_phone phone_snapshot address email property_name city reference project_reference number project_name status stage created_at updated_at completion_date completed_at target_completion_date assigned_to assigned_to_name salesperson_name notes history activity items lines products total subtotal grand_total amount currency order_date delivery_date selection_date quotation_date design_date installation_date attachments document_ids pdf_url referrer_name referrer_company company lead_temperature preferred_contact_method preferred_contact_time followup_date next_followup_at due_at type interaction_type contact_history deposits charges balance delivery_status dispatch_status quantity delivered_qty ordered_qty doc_type doc_date doc_number attended_by prepared_by address_snapshot ordered_at customer_outcome outcome_reason revision revisions revision_history rooms site_visits design_versions quotation_versions payments documents events contact_attempts last_contacted_at latest_response next_action completed_outcome lost_reason notebook_status is_converted quotation_price quotation_number quotation_date source_status line_items totals order_status installation production deadline".split())
PRIVATE_FIELDS = frozenset("_id storage_key bucket password_hash password password_encrypted token secret command_receipts creation_fingerprint idempotency_key fingerprint client_draft_id".split())
MAX_ROWS = 1000
SOURCE_MODELS = {"quotation": Quotation, "walkin": WalkIn, "followup": Followup, "order": TileCustomerOrder}
FURNITURE_FIELDS = frozenset("id floor_id customer_id customer_name customer_phone number status created_at updated_at finalized_at referrer_id referrer_name referrer_type referrer_company charges deposits total_payable_rmb total_received_rmb balance_rmb created_by created_by_name".split())
SNAPSHOT_FIELDS = PUBLIC_FIELDS | frozenset("description amount_rmb rate product_id sku brand_id brand_name category_id category_name name_snapshot unit unit_price mrp qty quantity discount_pct net_price line_total floor_id created_by created_by_name changed_by changed_by_name recorded_by recorded_by_name actor_id actor_name at date type action summary payload changes from_stage to_stage before after snapshot revision_id reason note source channel outcome amount_paise event_type label value status response timestamp".split())


def account_scope(user, floor=None):
    account = user.model_copy(deep=True)
    account.active_floor_id = floor
    for field in ("_custom_grant_floor_ids", "_module_floor_ids", "_kitchen_stage_actions", "_kitchen_semantic_actions", "_kitchen_restricted", "_kitchen_pdf_actions"):
        account.__dict__.pop(field, None)
    return account


def search_clause(term, names, phones):
    parts = [{field: {"$regex": re.escape(term), "$options": "i"}} for field in names]
    parts.extend({field: {"$regex": re.escape(term), "$options": "i"}} for field in phones)
    digits = re.sub(r"\D", "", term)
    if digits and re.fullmatch(r"[\d\s+().-]+", term):
        pattern = r"\D*".join(re.escape(digit) for digit in digits)
        parts.extend({field: {"$regex": pattern}} for field in phones)
    return {"$or": parts}


def public_fields(row):
    def clean(value):
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items() if key not in PRIVATE_FIELDS and not key.startswith("_") and not any(word in key.lower() for word in ("password", "token", "secret", "fingerprint", "receipt"))}
        if isinstance(value, list):
            return [clean(item) for item in value]
        return value
    return {key: clean(value) for key, value in row.items() if key in PUBLIC_FIELDS}


def public_source(kind, row):
    """Reuse response field contracts without inventing defaults for legacy rows.

    Nested typed lines are projected through their own models. Unstructured
    historical snapshots have a bounded business-field vocabulary, rather than
    copying arbitrary keys from raw Mongo documents into a new endpoint.
    """
    def clean(value, annotation=None):
        if isinstance(annotation, type) and issubclass(annotation, BaseModel) and isinstance(value, dict):
            return {key: clean(item, Quotation if kind == "quotation" and key == "snapshot" else annotation.model_fields[key].annotation) for key, item in value.items()
                    if key in annotation.model_fields and key != "ui_state"}
        args = get_args(annotation)
        if args and type(None) in args:
            return clean(value, next((arg for arg in args if arg is not type(None)), None))
        if isinstance(value, list):
            child = args[0] if get_origin(annotation) in {list, tuple} and args else None
            return [clean(item, child) for item in value]
        if isinstance(value, dict):
            if get_origin(annotation) is dict and len(args) == 2:
                return {key: clean(item, args[1]) for key, item in value.items() if key not in PRIVATE_FIELDS}
            return {key: clean(item) for key, item in value.items() if key in SNAPSHOT_FIELDS and key not in PRIVATE_FIELDS}
        return value
    if kind in SOURCE_MODELS:
        return clean(row, SOURCE_MODELS[kind])
    if kind == "furniture":
        return {key: clean(value) for key, value in row.items() if key in FURNITURE_FIELDS}
    return public_fields(row)


def summary(kind, row):
    contact = row.get("customer") or {}
    return {"kind": kind, "id": row["id"], "floor_id": row["floor_id"],
            "customer_id": row.get("customer_id") or (row["id"] if kind == "customer" else None),
            "name": contact.get("name") or row.get("name") or row.get("customer_name") or row.get("customer_name_snapshot") or "Customer",
            "phone": contact.get("phone") or row.get("phone") or row.get("customer_phone") or row.get("phone_snapshot"),
            "reference": row.get("project_reference") or row.get("reference") or row.get("number") or row["id"],
            "stage": row.get("stage"), "status": row.get("status"), "doc_type": row.get("doc_type"), "updated_at": row.get("updated_at")}


class CustomerSearchService:
    def __init__(self, database):
        self.db = database

    async def linked_customer_ids(self, customer_id, scopes):
        # Explicit imports form the only cross-floor identity edge. A matching
        # name or phone never merges unrelated customer profiles.
        allowed_floors = sorted({floor for _, floor, _ in scopes})
        found, pending = {customer_id}, {customer_id}
        for _ in range(100):
            rows = await self.db.customers.find({"floor_id": {"$in": allowed_floors},
                "is_deleted": {"$ne": True}, "deleted_at": {"$in": [None, ""]},
                "$or": [{"id": {"$in": list(pending)}}, {"imported_from_customer_id": {"$in": list(pending)}}]},
                {"_id": 0, "id": 1, "imported_from_customer_id": 1}).max_time_ms(5000).limit(101).to_list(101)
            identities = {value for row in rows for value in (row.get("id"), row.get("imported_from_customer_id")) if value}
            pending = identities - found
            found.update(identities)
            if len(found) > 100 or len(rows) > 100:
                raise HTTPException(422, "Linked customer history exceeds its supported bound")
            if not pending:
                return sorted(found)
        raise HTTPException(422, "Linked customer history exceeds its supported bound")

    async def scopes(self, user):
        account = account_scope(user)
        floors = accessible_floor_ids(account)
        if floors is None:
            floors = [row["id"] for row in await self.db.floors.find({"active": {"$ne": False}}, {"_id": 0, "id": 1}).limit(100).to_list(100)]
        deleted_ids = []
        if kitchen_access.KITCHEN_FLOOR in floors:
            deleted = await self.db.customers.find({"floor_id": kitchen_access.KITCHEN_FLOOR,
                "$or": [{"deleted_at": {"$exists": True, "$nin": [None, ""]}}, {"is_deleted": True}]}, {"_id": 0, "id": 1}).limit(10001).to_list(10001)
            if len(deleted) > 10000:
                raise HTTPException(422, "Archived customer scope exceeds the search bound")
            deleted_ids = [row["id"] for row in deleted]
        async def permit(kind, floor):
            if (kind == "kitchen" and floor != kitchen_access.KITCHEN_FLOOR
                    or kind == "furniture" and floor != "third-floor"
                    or kind == "order" and floor != "ground-floor"):
                return None
            actor = account_scope(account, floor)
            object.__setattr__(actor, "_customer_search_deleted_ids", deleted_ids if floor == kitchen_access.KITCHEN_FLOOR else [])
            try:
                await authorize_staff_resource(actor, method="GET", path=SOURCES[kind][1], floor_id=floor)
                if kind == "kitchen":
                    if os.environ.get("FORGE_KITCHEN_OWNER_ONLY", "false").lower() == "true" and actor.role != "owner" and not actor.custom_access:
                        return None
                    await kitchen_access.require_capability(self.db, actor, "view")
            except HTTPException as exc:
                if exc.status_code in (403, 404):
                    return None
                raise
            return kind, floor, actor
        result = await asyncio.gather(*(permit(kind, floor) for floor in floors for kind in SOURCES))
        return [scope for scope in result if scope is not None]

    async def rows(self, kind, floor, actor, extra, cap=MAX_ROWS, *, summary_only=False):
        collection = SOURCES[kind][0]
        query = {"floor_id": floor, "is_deleted": {"$ne": True}, "deleted_at": {"$in": [None, ""]}, **extra}
        if kind == "followup":
            query = {"$and": [query, {"category": {"$nin": sorted(POST_ORDER_CATEGORIES)},
                "rule_type": {"$nin": sorted(POST_ORDER_RULES)}, "purchase_id": {"$in": [None, ""]}}]}
        deleted_ids = getattr(actor, "_customer_search_deleted_ids", [])
        if deleted_ids and kind != "customer":
            query = {"$and": [query, {"customer_id": {"$nin": deleted_ids}}]}
        if kind == "kitchen":
            query = {"$and": [query, kitchen_access.scope_query(actor, {})]}
        projection = {"_id": 0, **{field: 1 for field in ("id", "floor_id", "customer_id", "customer", "name", "customer_name", "customer_name_snapshot", "phone", "customer_phone", "phone_snapshot", "project_reference", "reference", "number", "stage", "status", "updated_at", "doc_type")}} if summary_only else {"_id": 0}
        result = await getattr(self.db, collection).find(query, projection).max_time_ms(5000).sort([("updated_at", -1), ("id", 1)]).limit(cap + 1).to_list(cap + 1)
        if len(result) > cap:
            raise HTTPException(422, "Too many matching records. Refine the customer search.")
        return result

    async def search(self, user, term, page=1, limit=20):
        term = term.strip()
        if not term:
            return {"rows": [], "total": 0, "page": page, "limit": limit}
        scopes = await self.scopes(user)
        async def matching_rows(kind, floor, actor):
            clause = search_clause(term, SOURCES[kind][2], SOURCES[kind][3])
            if kind == "kitchen":
                # Kitchen's customer contact snapshot can predate an explicit
                # customer edit. Search/hydrate the canonical contact while the
                # project query still enforces its current-stage grant.
                contacts = await self.rows("customer", floor, actor,
                    search_clause(term, ("name",), ("phone",)), summary_only=True)
                if contacts:
                    clause = {"$or": [clause, {"customer_id": {"$in": [row["id"] for row in contacts]}}]}
            found = await self.rows(kind, floor, actor, clause, summary_only=True)
            if kind == "kitchen" and found:
                contacts = await self.rows("customer", floor, actor,
                    {"id": {"$in": list({row["customer_id"] for row in found})}}, summary_only=True)
                by_id = {row["id"]: row for row in contacts}
                found = [{**row, "customer": by_id.get(row["customer_id"], row.get("customer", {}))} for row in found]
            return found
        batches = await asyncio.gather(*(matching_rows(kind, floor, actor) for kind, floor, actor in scopes))
        rows = [summary(kind, row) for (kind, _, _), batch in zip(scopes, batches) for row in batch]
        rows.sort(key=lambda row: (row["name"].casefold(), row["floor_id"], row["kind"], row["id"]))
        return {"rows": rows[(page - 1) * limit:page * limit], "total": len(rows), "page": page, "limit": limit}

    async def profile(self, user, kind, identity, floor):
        scopes = await self.scopes(user)
        actor = next((actor for candidate, scope, actor in scopes if candidate == kind and scope == floor), None)
        if actor is None:
            raise HTTPException(404, "Customer record is unavailable")
        rows = await self.rows(kind, floor, actor, {"id": identity}, cap=1)
        if not rows:
            raise HTTPException(404, "Customer record is unavailable")
        source = rows[0]
        customer_id = source.get("customer_id") or (identity if kind == "customer" else None)
        async def record(source_kind, row, source_actor):
            if source_kind == "kitchen":
                value = await KitchenProjectService(self.db).get(source_actor, row["id"])
                value.pop("duplicate_candidates", None)
                # A customer's persisted stage follow-ups have independent rows.
                permitted = kitchen_access.semantic_stages(source_actor)
                followups = await self.db.kitchen_stage_followups.find({"project_id": row["id"], "stage": {"$in": permitted}}, {"_id": 0, "fingerprint": 0, "idempotency_key": 0}).sort([("created_at", 1), ("id", 1)]).limit(10001).to_list(10001)
                if len(followups) > 10000:
                    raise HTTPException(422, "This history is too large for one profile. Open the project follow-up history.")
                value["follow_ups"] = [public_followup(followup, source_actor) for followup in followups]
            elif source_kind == "customer":
                value = CustomerPublic(**row).model_dump()
            else:
                value = public_source(source_kind, row)
            contact_row = {**row, "customer": value.get("customer", row.get("customer", {}))} if source_kind == "kitchen" else row
            return {"kind": source_kind, "summary": summary(source_kind, contact_row), "data": value}
        linked = [(kind, source, actor)]
        if customer_id:
            identities = await self.linked_customer_ids(customer_id, scopes)
            batches = await asyncio.gather(*(self.rows(candidate, scope, source_actor,
                {"id": {"$in": identities}} if candidate == "customer" else {"customer_id": {"$in": identities}})
                for candidate, scope, source_actor in scopes))
            for (candidate, _, source_actor), batch in zip(scopes, batches):
                linked.extend((candidate, row, source_actor) for row in batch if candidate != kind or row["id"] != identity)
        records = await asyncio.gather(*(record(*entry) for entry in linked))
        return {"customer": records[0]["summary"], "records": records}
