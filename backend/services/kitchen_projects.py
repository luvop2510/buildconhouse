"""Kitchen aggregate persistence. Every successful command is one CAS write."""
from __future__ import annotations

import copy
import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import re
from decimal import Decimal
from datetime import date, datetime, timedelta, timezone
from uuid import NAMESPACE_URL, uuid4, uuid5

from bson import BSON, Decimal128
from fastapi import HTTPException
from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError, ExecutionTimeout

from models_kitchen import (AdvancePayload, CadFields, ConfigurePolicy,
                            LeadCustomer, LeadFields, MetadataPayload, PolicyFields, STAGES, VisitFields, AssignmentPayload)
from services import kitchen_access as access
from services import kitchen_workflow as workflow
from services.referrer_identity import referrer_query

MAX_AGGREGATE_BYTES = 12 * 1024 * 1024
POLICY_ID = "kitchen-policy"
READ_MAX_TIME_MS = 5000
CUSTOMER_SEARCH_FIELDS = ("name", "phone", "alternate_phone", "email", "company", "property_name",
    "address", "city", "state", "pincode", "gstin", "notes", "referrer_name", "referrer_company")
CUSTOMER_PROJECTION = {"_id": 0, **{field: 1 for field in ("id", "name", "phone", "address", "email", "company", "property_name", "city", "state", "pincode", "gstin", "alternate_phone", "notes", "referrer_id", "referrer_name", "referrer_type", "referrer_company")}}
HISTORY_FIELDS = ("activity", "command_receipts", "design_versions", "quotation_versions", "orders",
                  "revision_events", "site_visits", "approvals", "attachments", "work_history")


DECISION_CONTRACT = "2026-10-20"


@asynccontextmanager
async def bounded_read():
    try:
        async with asyncio.timeout(8):
            yield
    except (ExecutionTimeout, TimeoutError) as exc:
        raise HTTPException(503, "Kitchen data is taking longer than expected; retry this read") from exc


def order_basis_expression(expression, *, fallback_quotation=False):
    """Resolve the latest order's explicit references without loading history."""
    def referenced(field, reference):
        return {"$ifNull": [{"$arrayElemAt": [{"$filter": {"input": {"$ifNull": ["$" + field, []]},
            "as": "version", "cond": {"$eq": ["$$version.id", reference]}}}, 0]}, {}]}
    quotation = referenced("quotation_versions", "$$order.quotation_version_id")
    if fallback_quotation:
        quotation = {"$cond": [{"$and": [{"$ne": ["$$order", {}]},
            {"$not": [{"$ifNull": ["$commercial_basis_invalidated", False]}]},
            {"$not": [{"$ifNull": ["$$order.authorization_invalidated", False]}]}]}, quotation,
            {"$ifNull": [{"$arrayElemAt": [{"$ifNull": ["$quotation_versions", []]}, -1]}, {}]}]}
    return {"$let": {"vars": {"order": {"$ifNull": [{"$arrayElemAt": [{"$ifNull": ["$orders", []]}, -1]}, {}]}},
        "in": {"$let": {"vars": {"quote": quotation},
        "in": {"$let": {"vars": {"design": referenced("design_versions", "$$quote.design_version_id")}, "in": expression}}}}}}


def attention_expressions(policy, now=None):
    """One server definition for dashboard metrics and their list drilldowns.

    Completion targets use the business date in India. Retired next-action
    deadlines remain in history but never become overdue. No client page count is used.
    """
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(timezone(timedelta(hours=5, minutes=30))).date().isoformat()
    active = {"$and": [{"$ne": ["$stage", "completed"]},
        {"$not": [{"$in": [{"$ifNull": ["$status", None]}, ["Lost", "Cancelled", "On Hold"]]}]}]}
    pending = []
    for scope, stage in (("production", "order"), ("closure", "installation")):
        subject = {"$ifNull": [f"$approval_subjects.{scope}", None]}
        decision = f"$approval_decisions.{scope}"
        pending.append({"$and": [{"$eq": ["$stage", stage]}, {"$ne": [subject, None]},
            {"$ne": [subject, ""]}, {"$or": [
                {"$ne": [{"$ifNull": [decision + ".policy_version", None]}, policy["version"]]},
                {"$ne": [{"$ifNull": [decision + ".subject_id", None]}, subject]},
                {"$ne": [{"$ifNull": [decision + ".decision", None]}, "Approved"]}]}]})
    valid_order = order_basis_expression({"$and": [
        active,
        {"$not": [{"$ifNull": ["$commercial_basis_invalidated", False]}]},
        {"$not": [{"$ifNull": ["$design_revision_pending", False]}]},
        {"$not": [{"$ifNull": ["$$order.authorization_invalidated", False]}]},
        {"$eq": ["$$order.confirmed", True]}, {"$eq": ["$$order.status", "Confirmed"]},
        {"$eq": ["$$quote.response", "Approved"]},
        {"$ne": [{"$ifNull": ["$$quote.shared_date", None]}, None]},
        {"$ne": [{"$ifNull": ["$$quote.shared_date", ""]}, ""]},
        {"$eq": ["$$design.response", "Approved"]},
        {"$eq": ["$$order.quotation_version_id", "$$quote.id"]},
        {"$eq": ["$$quote.design_version_id", "$$design.id"]},
        {"$eq": [{"$ifNull": ["$$design.workflow_cycle", 1]}, {"$ifNull": ["$workflow_cycle", 1]}]},
    ]})
    return {"active": active, "on_hold": {"$eq": ["$status", "On Hold"]},
        "pending_approval": {"$and": [active, {"$or": pending}]},
        "next_action_overdue": {"$literal": False},
        "completion_overdue": {"$and": [active,
            {"$ne": [{"$ifNull": ["$target_completion_date", None]}, None]},
            {"$ne": [{"$ifNull": ["$target_completion_date", ""]}, ""]},
            {"$lt": ["$target_completion_date", today]}]},
        "active_order": valid_order}


def resolved_policy(policy):
    """Resolved business rules cannot be relaxed by a pre-decision policy.

    Adoption remains explicit and audited; only adopted manager identities may
    authorize department actions. Reading stale configuration never writes it.
    """
    from services.kitchen_attachments import FILE_EXTENSIONS, MAX_FILE_BYTES, MAX_TRANSFER_BYTES
    result = copy.deepcopy(policy)
    managers = result.get("department_manager_user_ids", []) if result.get("decision_contract") == DECISION_CONTRACT else []
    result.update(identity_timing="creation", cad_require_received=True, cad_require_progress_100=True,
        assignment_user_ids=[], unassigned_visibility="all_authorized",
        department_manager_user_ids=managers,
        production={"require_advance": True, "minimum_advance_amount": None, "minimum_advance_percent": None,
                    "require_confirmation_document": False, "require_manager_approval": True, "manager_user_ids": managers},
        closure={"require_manager_approval": True, "manager_user_ids": managers},
        exceptions={"allow_hold": True, "allow_cancel": True, "allow_reopen": True,
                    "allow_return_to_design": True, "manager_user_ids": []},
        metrics={"hold_is_active": False, "overdue_date": "target_completion", "confirmed_value_include_completed": False,
                 "confirmed_value_include_cancelled": False},
        required_fields=None, history_corrections=None,
        files={"allowed_types": list(FILE_EXTENSIONS), "max_bytes": MAX_TRANSFER_BYTES, "single_request_max_bytes": MAX_FILE_BYTES, "chunk_bytes": 512 * 1024})
    return result


def duplicate_selector(customer_id, phone, name, exclude=None):
    candidates = [{"customer_id": customer_id}]
    if phone:
        candidates.append({"customer_phone_normalized": phone})
    if name:
        candidates.append({"customer_name_normalized": name})
    return {"floor_id": access.KITCHEN_FLOOR, "$or": candidates, "id": {"$ne": exclude}}


def lead_error(project):
    customer = project.get("customer", {})
    if not str(customer.get("name") or "").strip() or not re.sub(r"\D", "", str(customer.get("phone") or "")) or not str(project.get("lead", {}).get("site_location") or "").strip():
        return "Customer Name, Phone Number and Site Location are required"
    return None

def timestamp():
    return datetime.now(timezone.utc).isoformat()


def fingerprint(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def validate(model, payload):
    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        raise HTTPException(422, exc.errors(include_context=False, include_url=False)) from exc


def bounded(document):
    if len(BSON.encode(document)) > MAX_AGGREGATE_BYTES:
        raise HTTPException(413, "Kitchen project history reached its supported size; no changes were saved")


def event(user, kind, payload):
    return {"id": str(uuid4()), "type": kind, "actor_id": user.id, "actor_name": user.full_name,
            "at": timestamp(), "payload": payload}


def current_status(project):
    stage = project["stage"]
    if project.get("lifecycle_status") in {"On Hold", "Cancelled"}:
        return project["lifecycle_status"]
    if stage == "completed":
        return "Completed"
    if stage == "order":
        if project.get("commercial_basis_invalidated") or (project.get("orders") and project["orders"][-1].get("authorization_invalidated")):
            return "Pending"
        if project.get("orders") and not project["orders"][-1].get("confirmed"):
            return "Pending"
        return project["orders"][-1]["status"] if project["orders"] else "Pending"
    if stage in {"design", "quotation"}:
        designs = project.get("design_versions", [])
        rows = project["design_versions" if stage == "design" else "quotation_versions"]
        design = (next((row for row in designs if rows and row["id"] == rows[-1].get("design_version_id")), None)
            if stage == "quotation" else next((row for row in designs if row["id"] == project.get("final_design_version_id")), designs[-1] if designs else None))
        if project.get("design_revision_pending") or not design or design.get("workflow_cycle", 1) != project.get("workflow_cycle", 1):
            return "Pending"
        return design["response"] if stage == "design" else rows[-1]["response"] if rows else "Pending"
    return project.get(stage, {}).get("status", "Pending")


def required_fields_error(project, stage, policy):
    """Configured fields apply to creation and leaving a stage, allowing drafts."""
    fields = (policy.get("required_fields") or {}).get(stage, [])
    # Retired visit/design controls must not keep legacy policies blocking progress.
    retired = {"lead": {"lead_source", "budget"}, "visit": {"requirements", "budget_discussion", "interested"}, "design": {"requirements", "budget_discussion"}, "quotation": {"amount", "received_date"}}
    fields = [name for name in fields if name not in retired.get(stage, set())]
    source = project.get(stage, {})
    key = {"design": "design_versions", "quotation": "quotation_versions", "order": "orders"}.get(stage)
    if key:
        source = project.get(key, [])[-1] if project.get(key) else {}
    if stage == "design" and project.get("final_design_version_id"):
        source = next((row for row in project.get("design_versions", []) if row["id"] == project["final_design_version_id"]), {})
    missing = []
    for name in fields:
        value = source.get(name)
        if value is None or isinstance(value, str) and not value.strip():
            missing.append(name)
    return "Configured required fields are missing: " + ", ".join(missing) if missing else None


def transition_error(project, target, policy):
    current = project["stage"]
    if project.get("lifecycle_status") in {"On Hold", "Cancelled"}:
        return "The owner must resume this held or cancelled project before moving stages"
    required = required_fields_error(project, current, policy)
    if required:
        return required
    if current == "completed" or STAGES.index(target) != STAGES.index(current) + 1:
        return "Only the next lifecycle stage can be requested"
    if current == "lead":
        if lead_error(project):
            return lead_error(project)
        if project.get("duplicate_review", {}).get("status") == "pending":
            return "Owner duplicate review is required before conversion"
        if project["lead"]["status"] == "Lost":
            return "A lost lead cannot be converted; owner review is required"
        return None
    if current == "visit":
        visit = project["visit"]
        if visit["status"] != "Visited":
            return "Mark the showroom visit as Visited first"
        return None
    if current == "cad":
        cad = project["cad"]
        if not cad["received"]:
            return "CAD file receipt is required before Design"
        if cad["progress"] != 100 or cad["status"] != "Completed":
            return "Design Status must be Completed and Design Progress must be 100%"
        return None
    return workflow.transition(project, target, policy)


class KitchenProjectService:
    def __init__(self, database):
        self.db = database

    async def policy(self, *, ensure=False):
        found = await self.db.kitchen_configuration.find_one({"_id": POLICY_ID})
        if found:
            return resolved_policy({key: value for key, value in found.items() if key not in {"_id", "active_command_count", "command_admissions", "active_create_token"}})
        policy = resolved_policy({"id": POLICY_ID, "version": 1, **PolicyFields().model_dump(), "activity": []})
        if ensure:
            try:
                await self.db.kitchen_configuration.insert_one({"_id": POLICY_ID, **policy,
                    "active_command_count": 0, "command_admissions": {}})
            except DuplicateKeyError:
                pass
        return policy

    @asynccontextmanager
    async def admission(self, user, action):
        """Pin one policy revision while an admitted command can commit.

        Configuration and admission write the same document atomically. No
        lease expiry can release a live writer. A crashed process leaves a
        conservative configuration block for maintenance reconciliation.
        """
        await access.require_capability(self.db, user, action)
        policy = await self.policy(ensure=True)
        token = str(uuid4())
        field = "command_admissions." + token
        selector = {"_id": POLICY_ID, "version": policy["version"], "$or": [
            {"active_command_count": {"$exists": False}}, {"active_command_count": {"$lt": 64}}]}
        updates = {"$inc": {"active_command_count": 1}, "$set": {field: timestamp()}}
        if action == "create":
            selector["active_create_token"] = {"$exists": False}
            updates["$set"]["active_create_token"] = token
        admitted = await self.db.kitchen_configuration.update_one(selector, updates)
        if not admitted.matched_count:
            raise HTTPException(409, "Kitchen policy changed or command capacity is occupied; refresh and retry")
        try:
            yield policy
        finally:
            # Finish exact-token release even if the request is cancelled.
            release = {"$inc": {"active_command_count": -1}, "$unset": {field: ""}}
            if action == "create":
                release["$unset"]["active_create_token"] = ""
            cleanup = asyncio.ensure_future(self.db.kitchen_configuration.update_one(
                {"_id": POLICY_ID, field: {"$exists": True}}, release))
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                await cleanup
                raise

    async def public_policy(self, user):
        await access.require_capability(self.db, user, "view")
        policy = await self.policy()
        return {**policy, "unconfigured": (["decision_contract"] if policy.get("decision_contract") != DECISION_CONTRACT else []) +
                ([] if policy.get("department_manager_user_ids") else ["department_manager_user_ids"])}

    async def configure(self, user, body: ConfigurePolicy):
        from models import UserPublic

        await access.require_capability(self.db, user, "update")
        if not access.owner(user):
            raise HTTPException(403, "Only the owner can configure Kitchen policy")
        policy = await self.policy()
        if policy["version"] != body.expected_version:
            raise HTTPException(409, "Kitchen policy changed; refresh before saving")
        patch = body.model_dump(exclude_unset=True, exclude={"expected_version"})
        merged_fields = {**{k: policy.get(k) for k in PolicyFields.model_fields}, **patch}
        if merged_fields.get("decision_contract") != DECISION_CONTRACT:
            raise HTTPException(422, "Explicitly adopt the resolved 2026-10-20 decisions")
        # Validate only declared fields before applying immutable resolved rules.
        # Existing nested v2 settings are never reused as authority.
        merged_fields.update(production=None, closure=None, exceptions=None)
        merged = resolved_policy(validate(PolicyFields, merged_fields).model_dump())
        if len(set(merged["department_manager_user_ids"])) != len(merged["department_manager_user_ids"]):
            raise HTTPException(422, "Department manager selection must not contain duplicates")
        for authority in merged["department_manager_user_ids"]:
            staff = await self.db.users.find_one({"id": authority, "active": True}, {"_id": 0})
            if not staff or staff.get("is_deleted") or staff.get("deleted_at"):
                raise HTTPException(422, "Department managers must be active existing staff")
            principal = UserPublic(**{**staff, "active_floor_id": None})
            if not await access.capability(self.db, principal, "view") or not await access.capability(self.db, principal, "update"):
                raise HTTPException(422, "Department managers need current Kitchen view/update access")
        updated = {"_id": POLICY_ID, "id": POLICY_ID, "version": policy["version"] + 1,
                   **merged, "updated_at": timestamp(), "updated_by": user.id,
                   "activity": [*policy.get("activity", []), event(user, "configuration.updated", {"fields": sorted(patch)})]}
        bounded(updated)
        existing = await self.db.kitchen_configuration.find_one({"_id": POLICY_ID}, {"_id": 1})
        if existing:
            result = await self.db.kitchen_configuration.replace_one({"_id": POLICY_ID, "version": body.expected_version,
                "$or": [{"active_command_count": 0}, {"active_command_count": {"$exists": False}}]}, updated)
            if not result.matched_count:
                raise HTTPException(409, "Kitchen policy changed or an active command is using it; retry after commands finish")
        else:
            try:
                await self.db.kitchen_configuration.insert_one(updated)
            except DuplicateKeyError as exc:
                raise HTTPException(409, "Kitchen policy changed; refresh before saving") from exc
        return {k: v for k, v in updated.items() if k != "_id"}

    async def public(self, project, user, policy, *, summary=False, replayed=False, can_update=None):
        result = {k: copy.deepcopy(v) for k, v in project.items() if k not in {"_id", "command_receipts", "creation_fingerprint", "customer_phone_normalized", "customer_name_normalized"}}
        if not summary:
            customers = await self._current_customers([project["customer_id"]])
            result["customer"] = customers.get(project["customer_id"], result["customer"])
        if summary:
            version_fields = {"id", "number", "response", "approval_date", "shared_date", "handoff_date", "handoff_status", "presentation_date", "received_date",
                              "received_status", "sent_status", "amount", "design_version_id", "workflow_cycle", "attachment_id", "url", "requirements", "budget_discussion", "attachment_ids", "final_attachment_id", "pdf_options", "kitchen_type", "upload_date"}
            order_fields = {"id", "confirmed", "status", "order_date", "final_amount", "original_amount", "quotation_version_id",
                            "confirmation_document_id", "authorization_invalidated", "advance"}
            order = project.get("orders", [])[-1] if project.get("orders") else None
            bound_order = order if order and not project.get("commercial_basis_invalidated") and not order.get("authorization_invalidated") else None
            quote = next((row for row in project.get("quotation_versions", []) if bound_order and row["id"] == bound_order["quotation_version_id"]), None)
            if not bound_order and project.get("quotation_versions"):
                quote = project["quotation_versions"][-1]
            quotation_context = bool(quote and (bound_order or project["stage"] in {"quotation", "order"}))
            design = next((row for row in project.get("design_versions", []) if row["id"] == (quote["design_version_id"] if quotation_context else project.get("final_design_version_id"))), None)
            for source, target, fields in (("design_versions", "current_design", version_fields),
                                           ("quotation_versions", "current_quotation", version_fields),
                                           ("orders", "current_order", order_fields)):
                rows = project.get(source, [])
                selected = design if source == "design_versions" else (quote if source == "quotation_versions" else order) if bound_order else rows[-1] if rows else None
                result[target] = {key: copy.deepcopy(value) for key, value in selected.items() if key in fields} if selected else None
            for key in HISTORY_FIELDS:
                result.pop(key, None)
        result["project_reference"] = project.get("project_reference") or project["reference"]
        for total, events in (("design_revision_count", "known_design_revision_count"), ("site_visit_count", "known_site_visit_count")):
            result[events] = project.get(events, 0 if project.get("is_legacy") else project.get(total, 0))
            if project.get("is_legacy") and project.get(total) is None:
                result[total] = None
        if not access.owner(user):
            # Candidate identities may also occur in review audit snapshots.
            # Remove them recursively, not only from the current review card.
            def redact_candidates(value):
                if isinstance(value, dict):
                    return {k: redact_candidates(v) for k, v in value.items() if k != "candidate_ids"}
                if isinstance(value, list):
                    return [redact_candidates(v) for v in value]
                return value
            result = redact_candidates(result)
        assigned = project.get("assignments", {}).get(project["stage"])
        result["assigned_to"] = assigned
        result["assigned_to_name"] = project.get("assignment_names", {}).get(project["stage"])
        result.pop("assignment_names", None)
        if "attachments" in result:
            result["attachments"] = [{k: v for k, v in attachment.items() if k not in {"storage_key", "bucket"}}
                                     for attachment in result["attachments"]]
        result["permissions"] = {"can_update": await access.capability(self.db, user, "update") if can_update is None else can_update,
                                 "can_assign": access.owner(user), "can_configure": access.owner(user)}
        result["permissions"]["can_review_duplicate"] = access.owner(user)
        for scope in ("production", "closure"):
            result["permissions"][f"can_approve_{scope}"] = access.department_manager(user, policy) and result["permissions"]["can_update"]
        result["permissions"]["can_approve_exceptions"] = access.owner(user)
        index = STAGES.index(project["stage"])
        blocked = []
        if not summary and index < len(STAGES) - 1:
            target = STAGES[index + 1]
            reason = transition_error(project, target, policy)
            if reason:
                blocked.append({"target_stage": target, "reason": reason})
        result["blocked_transitions"] = blocked
        if replayed:
            result["replayed"] = True
        return result

    async def _current_customers(self, customer_ids):
        ids = list(set(customer_ids))
        if not ids:
            return {}
        rows = await self.db.customers.find({"id": {"$in": ids}, "floor_id": access.KITCHEN_FLOOR},
            CUSTOMER_PROJECTION).max_time_ms(READ_MAX_TIME_MS).to_list(len(ids))
        return {row["id"]: {key: value for key, value in row.items() if key in CUSTOMER_PROJECTION and key != "_id"}
                for row in rows}

    async def get(self, user, project_id):
        async with bounded_read():
            policy, project = await asyncio.gather(self.policy(),
                self.db.kitchen_projects.find_one({"id": project_id, "floor_id": access.KITCHEN_FLOOR}))
            await access.require_project(self.db, user, project, policy)
            result, duplicates = await asyncio.gather(self.public(project, user, policy),
                self._duplicates(user, project["customer_id"], policy, exclude=project_id))
            result["duplicate_candidates"] = duplicates
            return result

    async def duplicates(self, user, customer_id, *, exclude=None):
        await access.require_capability(self.db, user, "view")
        policy = await self.policy()
        return await self._duplicates(user, customer_id, policy, exclude=exclude)

    async def _duplicates(self, user, customer_id, policy, *, exclude=None):
        customer = await self.db.customers.find_one({"id": customer_id, "floor_id": access.KITCHEN_FLOOR},
                                                   {"_id": 0, "name": 1, "phone": 1})
        if not customer:
            raise HTTPException(404, "Kitchen customer not found")
        candidates = [{"customer_id": customer_id}]
        phone = re.sub(r"\D", "", customer.get("phone") or "")[-10:]
        name = " ".join((customer.get("name") or "").casefold().split())
        if phone:
            candidates.append({"customer_phone_normalized": phone})
        if name:
            candidates.append({"customer_name_normalized": name})
        selector = {"$and": [access.scope_query(user, policy), {"$or": candidates}, {"id": {"$ne": exclude}}]}
        return await self.db.kitchen_projects.find(selector, {"_id": 0, "id": 1, "reference": 1, "stage": 1}).limit(10).to_list(10)

    async def attach(self, user, project_id, **kwargs):
        async with self.admission(user, "update"):
            return await self._attach(user, project_id, **kwargs)

    async def _attach(self, user, project_id, *, expected_version, key, filename, content_type, data, storage, bucket, max_file_bytes=768 * 1024):
        from services.kitchen_attachments import canonical_type, prepare_private_upload, validate_file
        policy = await self.policy()
        project = await self.db.kitchen_projects.find_one({"id": project_id, "floor_id": access.KITCHEN_FLOOR})
        await access.require_project(self.db, user, project, policy, "update")
        content_type = canonical_type(content_type, filename)
        digest = hashlib.sha256(data).hexdigest()
        signature = fingerprint({"command": "attachment", "sha256": digest, "filename": filename, "content_type": content_type})
        def prior(row):
            return next((r for r in row["command_receipts"] if r["actor_id"] == user.id and r["key"] == key), None)
        replay = prior(project)
        if replay:
            if replay["fingerprint"] != signature:
                raise HTTPException(409, "This command key was already used with different fields")
            return await self.public(project, user, policy, replayed=True)
        await access.require_current_task(self.db, user, project, policy)
        if project["version"] != expected_version:
            raise HTTPException(409, "Kitchen project changed; reload before uploading")
        await asyncio.to_thread(validate_file, data, content_type, filename, policy, max_file_bytes)
        if project.get("lifecycle_status") in {"On Hold", "Cancelled"}:
            raise HTTPException(422, "The owner must resume the project before adding files")
        metadata = await prepare_private_upload(self.db, storage, user=user, project=project, policy=policy,
            data=data, content_type=content_type, filename=filename, bucket=bucket, max_file_bytes=max_file_bytes)
        updated = copy.deepcopy(project)
        if not any(a["id"] == metadata["id"] for a in updated["attachments"]):
            metadata["uploaded_at"] = timestamp()
            updated["attachments"].append(metadata)
        updated["version"] += 1
        updated["updated_at"], updated["updated_by"] = timestamp(), user.id
        updated["activity"].append(event(user, "attachment.added", {"attachment_id": metadata["id"], "filename": filename}))
        updated["command_receipts"].append({"actor_id": user.id, "key": key, "fingerprint": signature,
                                           "version": updated["version"], "command": "attachment"})
        bounded(updated)
        # Re-read the project and access after provider I/O before the CAS write.
        # Orphan bytes on a CAS loss remain private and unreferenced.
        latest_task = await self.db.kitchen_projects.find_one({"id": project_id, "floor_id": access.KITCHEN_FLOOR})
        await access.require_project(self.db, user, latest_task, policy, "update")
        saved_upload = prior(latest_task)
        if saved_upload:
            if saved_upload["fingerprint"] != signature:
                raise HTTPException(409, "This command key was already used with different fields")
            return await self.public(latest_task, user, policy, replayed=True)
        await access.require_current_task(self.db, user, latest_task, policy)
        result = await self.db.kitchen_projects.replace_one(
            {"id": project_id, "floor_id": access.KITCHEN_FLOOR, "version": expected_version}, updated)
        if not result.matched_count:
            latest = await self.db.kitchen_projects.find_one({"id": project_id, "floor_id": access.KITCHEN_FLOOR})
            await access.require_project(self.db, user, latest, policy, "update")
            replay = prior(latest)
            if replay and replay["fingerprint"] == signature:
                return await self.public(latest, user, policy, replayed=True)
            await access.require_current_task(self.db, user, latest, policy)
            raise HTTPException(409, "Kitchen project changed; reload before uploading")
        return await self.public(updated, user, policy)

    async def attachment(self, user, project_id, attachment_id, storage):
        policy = await self.policy()
        project = await self.db.kitchen_projects.find_one({"id": project_id, "floor_id": access.KITCHEN_FLOOR})
        await access.require_project(self.db, user, project, policy)
        metadata = next((a for a in project["attachments"] if a["id"] == attachment_id), None)
        if not metadata:
            raise HTTPException(404, "Kitchen attachment not found")
        await storage.require_private_bucket(metadata["bucket"])
        data = await storage.download(bucket=metadata["bucket"], key=metadata["storage_key"])
        if hashlib.sha256(data).hexdigest() != metadata["sha256"]:
            raise HTTPException(409, "Attachment content failed integrity verification")
        return data, metadata

    async def create(self, user, body):
        async with self.admission(user, "create"):
            return await self._create(user, body)

    async def resolve_assignee(self, user, user_id):
        if not access.owner(user):
            raise HTTPException(403, "Only the owner can select Kitchen assignments")
        if not user_id:
            return None
        employee = next((row for row in await access.eligible_staff(self.db) if row["id"] == user_id), None)
        if not employee:
            raise HTTPException(422, "Select an active employee with Kitchen access")
        return employee

    async def referrer_fields(self, referrer_id):
        if not referrer_id:
            return {"referrer_id": None, "referrer_name": None, "referrer_type": None, "referrer_company": None}
        referrer = await self.db.referrers.find_one(referrer_query({"floor_id": access.KITCHEN_FLOOR}, {"id": referrer_id, "active": {"$ne": False}}), {"_id": 0})
        if not referrer or referrer.get("type") not in {"architect", "interior_designer"}:
            raise HTTPException(422, "Select an active Kitchen architect or interior designer")
        return {"referrer_id": referrer["id"], "referrer_name": referrer["name"], "referrer_type": referrer["type"], "referrer_company": referrer.get("company")}

    async def lead_customer(self, details):
        """Resolve inline intake once without overwriting an existing contact.

        Creation admission serializes Kitchen intake. The deterministic Mongo
        identity also makes retry after a failed project write reuse the contact.
        Older contacts may contain spacing or an Indian country-code prefix.
        Ambiguous matches require explicit selection instead of guessing.
        """
        from models import CustomerPublic
        digits = re.sub(r"\D", "", details.phone)
        normalized = digits[2:] if len(digits) == 12 and digits.startswith("91") else digits
        prefix = r"(?:9\D*1\D*)?" if len(normalized) == 10 else ""
        pattern = r"^\D*" + prefix + r"\D*".join(normalized) + r"\D*$"
        query = {"floor_id": access.KITCHEN_FLOOR, "kitchen_delete_token": {"$exists": False},
                 "phone": {"$regex": pattern}}
        projection = CUSTOMER_PROJECTION
        matches = await self.db.customers.find(query, projection).limit(2).to_list(2)
        if len(matches) > 1:
            raise HTTPException(409, "Several existing customers use this phone number; select the correct customer")
        if matches:
            return {key: value for key, value in matches[0].items() if key in projection and key != "_id"}
        customer_id = str(uuid5(NAMESPACE_URL, f"kitchen-customer:{access.KITCHEN_FLOOR}:{normalized}"))
        contact = CustomerPublic(id=customer_id, floor_id=access.KITCHEN_FLOOR, **details.model_dump()).model_dump()
        if not contact.get("email"):
            contact.pop("email", None)  # The sparse unique email index excludes absent fields.
        contact.update(_id=customer_id, created_by_source="kitchen_lead")
        try:
            await self.db.customers.insert_one(contact)
        except DuplicateKeyError:
            existing = await self.db.customers.find_one({"id": customer_id, **query}, projection)
            if not existing:
                raise HTTPException(409, "Customer details changed during intake; select the existing customer and retry")
            contact = existing
        return {key: value for key, value in contact.items() if key in projection and key != "_id"}

    async def _create(self, user, body):
        await access.require_capability(self.db, user, "create")
        policy = await self.policy()
        project_id = str(uuid5(NAMESPACE_URL, f"kitchen:{user.id}:{access.KITCHEN_FLOOR}:{body.idempotency_key}"))
        request_fields = body.model_dump(exclude={"idempotency_key"})
        # Optional additions must not change receipts for pre-existing requests.
        for field in ("referrer_id", "referrer_name", "referrer_type", "referrer_company"):
            if request_fields["lead"].get(field) is None:
                request_fields["lead"].pop(field, None)
        if request_fields.get("customer"):
            for field in set(LeadCustomer.model_fields) - {"name", "phone", "address"}:
                if request_fields["customer"].get(field) is None:
                    request_fields["customer"].pop(field, None)
        if body.customer is None:
            request_fields.pop("customer")  # Preserve receipts created before inline intake existed.
        if body.assigned_to is None:
            request_fields.pop("assigned_to", None)
        digest = fingerprint(request_fields)
        previous = await self.db.kitchen_projects.find_one({"id": project_id, "floor_id": access.KITCHEN_FLOOR})
        if previous:
            await access.require_project(self.db, user, previous, policy, "create")
            if previous.get("creation_fingerprint") != digest:
                raise HTTPException(409, "This creation key was already used with different fields")
            return await self.public(previous, user, policy, replayed=True)
        assignee = await self.resolve_assignee(user, body.assigned_to) if body.assigned_to else None
        lead = body.lead.model_dump()
        if lead["status"] == "Lost" and not lead.get("lost_reason"):
            raise HTTPException(422, "A lost reason is required")
        if not str(lead.get("site_location") or "").strip():
            raise HTTPException(422, "Customer Name, Phone Number and Site Location are required")
        if body.customer is not None and not str(body.customer.address or "").strip():
            raise HTTPException(422, "Customer address is required before creating a lead")
        reference_fields = await self.referrer_fields(lead.get("referrer_id"))
        customer = (await self.lead_customer(body.customer) if body.customer is not None else
                    await self.db.customers.find_one({"id": body.customer_id, "floor_id": access.KITCHEN_FLOOR},
                                                    CUSTOMER_PROJECTION))
        if not customer:
            raise HTTPException(404, "Kitchen customer not found; select an existing customer")
        if not str(customer.get("address") or "").strip():
            raise HTTPException(422, "Customer address is required; update the existing customer before creating a lead")
        customer_id = customer["id"]
        lead.update(reference_fields)
        if not lead.get("lead_date"):
            lead["lead_date"] = datetime.now(timezone(timedelta(hours=5, minutes=30))).date().isoformat()
        now = timestamp()
        reference = "KIT-" + project_id.replace("-", "").upper()[:16]
        project = {"_id": project_id, "id": project_id, "reference": reference,
                   "project_reference": reference,
                   "floor_id": access.KITCHEN_FLOOR, "customer_id": customer_id, "customer": customer,
                   "customer_phone_normalized": re.sub(r"\D", "", customer.get("phone") or "")[-10:],
                   "customer_name_normalized": " ".join((customer.get("name") or "").casefold().split()),
                   "version": 1, "stage": "lead", "status": lead["status"], "lead": lead,
                   **reference_fields,
                   "visit": VisitFields().model_dump(), "cad": CadFields().model_dump(),
                   "assignments": {"lead": assignee["id"]} if assignee else {},
                   "assignment_names": {"lead": assignee["full_name"]} if assignee else {},
                   "assigned_to": assignee["id"] if assignee else None,
                   "assigned_to_name": assignee["full_name"] if assignee else None,
                   "next_action": None, "deadline": None, "target_completion_date": None,
                   "design_revision_count": 0, "site_visit_count": 0, "known_design_revision_count": 0, "known_site_visit_count": 0, "order_amount": None,
                   "workflow_cycle": 1, "commercial_basis_invalidated": False, "work_history": [],
                   "created_at": now, "updated_at": now, "created_by": user.id, "updated_by": user.id,
                   "creation_fingerprint": digest,
                   **{key: [] for key in HISTORY_FIELDS}}
        if lead_error(project):
            raise HTTPException(422, lead_error(project))
        selector = duplicate_selector(customer_id, project["customer_phone_normalized"], project["customer_name_normalized"], project_id)
        candidates = await self.db.kitchen_projects.find(selector, {"_id": 0, "id": 1}).limit(100).to_list(100)
        project["duplicate_review"] = {"status": "pending" if candidates else "cleared", "candidate_ids": [row["id"] for row in candidates]}
        project["activity"] = [event(user, "project.created", {"customer_id": customer_id})]
        project["command_receipts"] = [{"actor_id": user.id, "key": body.idempotency_key,
                                         "fingerprint": digest, "version": 1, "command": "create"}]
        required = required_fields_error(project, "lead", policy)
        if required:
            raise HTTPException(422, required)
        bounded(project)
        # This permanent, idempotent pin and customer deletion's tombstone
        # compete on the SAME Mongo document. Whichever wins excludes the
        # other before an aggregate can commit; a prior lookup alone cannot.
        # Never clear a pin after an uncertain insert: another retry may have
        # committed. An interrupted create can retry its deterministic ID;
        # an unused pin needs explicit isolated reconciliation to release.
        reservation = await self.db.customers.update_one(
            {"id": customer_id, "floor_id": access.KITCHEN_FLOOR,
             "kitchen_delete_token": {"$exists": False}},
            {"$set": {"kitchen_reference_reserved": True}})
        if not reservation.matched_count:
            raise HTTPException(409, "Customer is being removed; select an existing customer again")
        try:
            await self.db.kitchen_projects.insert_one(project)
        except DuplicateKeyError:
            previous = await self.db.kitchen_projects.find_one({"id": project_id, "floor_id": access.KITCHEN_FLOOR})
            if not previous:
                raise HTTPException(409, "Project reference collision; retry with another creation key")
            await access.require_project(self.db, user, previous, policy, "create")
            if previous.get("creation_fingerprint") != digest:
                raise HTTPException(409, "This creation key was already used with different fields")
            return await self.public(previous, user, policy, replayed=True)
        result = await self.public(project, user, policy)
        candidates = [{"customer_id": customer_id}]
        if project["customer_phone_normalized"]:
            candidates.append({"customer_phone_normalized": project["customer_phone_normalized"]})
        if project["customer_name_normalized"]:
            candidates.append({"customer_name_normalized": project["customer_name_normalized"]})
        duplicate_query = {"$and": [access.scope_query(user, policy), {"$or": candidates}, {"id": {"$ne": project_id}}]}
        result["duplicate_candidates"] = await self.db.kitchen_projects.find(duplicate_query, {"_id": 0, "id": 1, "reference": 1, "stage": 1}).limit(10).to_list(10)
        return result

    async def command(self, user, project_id, body):
        # Project lookup is independent of policy admission; overlap its network round trip.
        project_read = asyncio.ensure_future(self.db.kitchen_projects.find_one(
            {"id": project_id, "floor_id": access.KITCHEN_FLOOR}))
        try:
            async with self.admission(user, "update") as policy:
                return await self._command(user, project_id, body, policy, await project_read)
        finally:
            if not project_read.done():
                project_read.cancel()
            await asyncio.gather(project_read, return_exceptions=True)

    async def _command(self, user, project_id, body, policy, project):
        await access.require_project(self.db, user, project, policy, "update")
        digest = fingerprint({"command": body.command, "payload": body.payload})
        receipt = next((r for r in project["command_receipts"] if r["actor_id"] == user.id and r["key"] == body.idempotency_key), None)
        if receipt:
            if receipt["fingerprint"] != digest:
                raise HTTPException(409, "This command key was already used with different fields")
            return await self.public(project, user, policy, replayed=True)
        # Replays above are read-only acknowledgments of committed work. New
        # routine writes must respect an owner hold/cancellation in every stage,
        # including early-stage/plan commands outside workflow.apply. Duplicate
        # review retains its explicit authority checks below.
        if project.get("lifecycle_status") in {"On Hold", "Cancelled"} and body.command not in {"order_status", "exception", "review_duplicate", "move_stage"}:
            raise HTTPException(422, "The owner must resume this held or cancelled project before routine changes")
        await access.require_current_task(self.db, user, project, policy)
        if body.expected_version != project["version"]:
            raise HTTPException(409, {"message": "Kitchen project changed; reload before saving", "current_version": project["version"]})
        updated = copy.deepcopy(project)
        payload = body.payload
        command = body.command
        if command == "assign":
            assignment = validate(AssignmentPayload, payload)
            employee = await self.resolve_assignee(user, assignment.user_id)
            updated["assignments"][assignment.stage] = employee["id"] if employee else None
            updated["assignment_names"][assignment.stage] = employee["full_name"] if employee else None
        elif command in {"edit_lead", "save_visit", "save_cad"}:
            stage, model = {"edit_lead": ("lead", LeadFields), "save_visit": ("visit", VisitFields), "save_cad": ("cad", CadFields)}[command]
            if project["stage"] != stage:
                raise HTTPException(422, f"This command is available only in the {stage} stage")
            saved_fields = {key: value for key, value in project[stage].items() if key != "next_action"}
            updated[stage] = {**project[stage], **validate(model, {**saved_fields, **payload}).model_dump()}
            if stage == "lead":
                if updated[stage].get("referrer_id") == project[stage].get("referrer_id"):
                    reference_fields = {field: project[stage].get(field) for field in ("referrer_id", "referrer_name", "referrer_type", "referrer_company")}
                else:
                    reference_fields = await self.referrer_fields(updated[stage].get("referrer_id"))
                updated[stage].update(reference_fields)
                updated.update(reference_fields)
            if stage == "cad":
                updated["cad"]["ready"] = updated["cad"]["received"] and updated["cad"]["progress"] == 100 and updated["cad"]["status"] == "Completed"
            if stage == "lead" and lead_error(updated):
                raise HTTPException(422, lead_error(updated))
            if stage == "lead" and project[stage]["status"] == "Lost" and updated[stage]["status"] != "Lost":
                raise HTTPException(422, "Lost leads cannot be reopened through ordinary editing")
            if stage == "lead" and updated[stage]["status"] == "Lost" and not updated[stage].get("lost_reason"):
                raise HTTPException(422, "A lost reason is required")
        elif command == "move_stage":
            target = validate(AdvancePayload, payload).target_stage
            if abs(STAGES.index(target) - STAGES.index(project["stage"])) != 1:
                raise HTTPException(422, "Choose the previous or next Kitchen stage")
            # Navigation records the user's position without inventing business
            # evidence or changing saved approvals, work, or held status.
            if target == "quotation" and STAGES.index(project["stage"]) < STAGES.index(target):
                workflow.finalized_design(project)
            if target == "order" and project["stage"] == "quotation":
                quote = workflow.finalized_quotation(project, workflow.current(project, "quotation_versions"))
                workflow.finalized_design(project, quote.get("design_version_id"))
                if quote.get("response") != "Approved" or not quote.get("shared_date"):
                    raise HTTPException(422, "Confirm the selected quotation with customer approval first")
            updated["stage"] = target
            updated["manual_stage_navigation"] = True
            updated["closure_pending_reason"] = None
            if target == "completed" and not updated.get("completion_date"):
                updated["completion_date"] = datetime.now(timezone(timedelta(hours=5, minutes=30))).date().isoformat()
        elif command in {"convert", "advance_stage"}:
            if command == "convert":
                if payload:
                    raise HTTPException(422, "Convert accepts no fields")
                if project["stage"] != "lead":
                    raise HTTPException(422, "Only a lead can be converted")
                target = "visit"
            else:
                target = validate(AdvancePayload, payload).target_stage
            error = transition_error(project, target, policy)
            if error:
                raise HTTPException(422, error)
            updated["stage"] = target
        elif command == "review_duplicate":
            from models_kitchen import DuplicateReview
            if not access.owner(user):
                raise HTTPException(403, "Only the owner can review possible duplicates")
            if project["stage"] != "lead":
                raise HTTPException(422, "Duplicate review is available only before conversion")
            review = validate(DuplicateReview, payload)
            updated["duplicate_review"] = {**project.get("duplicate_review", {}),
                "status": "cleared" if review.decision == "distinct_project" else "duplicate",
                "reason": review.reason, "reviewed_by": user.id, "reviewed_at": timestamp()}
            if review.decision == "duplicate":
                updated["lead"].update(status="Lost", lost_reason=review.reason)
        elif command == "metadata":
            updated.update(validate(MetadataPayload, payload).model_dump(exclude_unset=True))
        elif command in workflow.COMMANDS:
            selected_design = next((row for row in project.get("design_versions", []) if row["id"] == payload.get("version_id")), {})
            if command in {"design_revision", "design_update"} and selected_design.get("response") == "Approved" and not access.owner(user):
                raise HTTPException(403, "Only the owner can authorize changing an approved design")
            if command == "approval":
                from models_kitchen import InternalApproval
                validate(InternalApproval, payload)
                if not access.department_manager(user, policy):
                    raise HTTPException(403, "Only an explicitly selected department manager can approve")
                staff = await self.db.users.find_one({"id": user.id, "active": True}, {"_id": 0, "id": 1, "is_deleted": 1, "deleted_at": 1})
                if not staff or staff.get("is_deleted") or staff.get("deleted_at"):
                    raise HTTPException(403, "The selected department manager is no longer active")
            if command == "order_confirm" and payload.get("final_amount") is not None:
                from models_kitchen import OrderConfirmation
                confirmation = validate(OrderConfirmation, payload)
                current_quote = next((row for row in project.get("quotation_versions", []) if row["id"] == confirmation.quotation_version_id), {})
                if current_quote.get("amount") is not None and Decimal(confirmation.final_amount) != Decimal(current_quote["amount"]) and not access.owner(user):
                    raise HTTPException(403, "Only the owner can authorize changed order terms")
            if command == "order_update" and payload.get("quotation_version_id") and project.get("orders"):
                quote = next((row for row in project.get("quotation_versions", []) if row["id"] == payload["quotation_version_id"]), {})
                order = project["orders"][-1]
                if payload["quotation_version_id"] != order["quotation_version_id"] and quote.get("amount") is not None and Decimal(order["final_amount"]) != Decimal(quote["amount"]) and not access.owner(user):
                    raise HTTPException(403, "Only the owner can authorize changed order terms")
            if command in {"order_status", "exception", "order_amend"} and not access.owner(user):
                raise HTTPException(403, "Only the owner can authorize exceptions or restricted changes")
            workflow.apply(updated, command, payload, policy, user, timestamp(), validate)
        else:
            raise HTTPException(422, "Unsupported Kitchen command")
        if project["stage"] == "completed" and command not in {"exception", "move_stage"}:
            raise HTTPException(422, "The owner must explicitly reopen a completed project before editing it")
        if updated["stage"] != project["stage"] and command not in {"exception", "move_stage"}:
            required = required_fields_error(updated, project["stage"], policy)
            if required:
                raise HTTPException(422, required)
        updated["version"] += 1
        updated["updated_at"], updated["updated_by"] = timestamp(), user.id
        updated["status"] = current_status(updated)
        updated["order_amount_paise"] = int(Decimal(updated.get("order_amount") or "0") * 100)
        updated["approval_subjects"] = {scope: workflow.subject(updated, scope) for scope in ("production", "closure") if updated.get("orders")}
        updated["approval_decisions"] = {scope: next((a for a in reversed(updated["approvals"]) if a["scope"] == scope), None)
                                         for scope in ("production", "closure")}
        updated["assigned_to"] = updated["assignments"].get(updated["stage"])
        updated["assigned_to_name"] = updated["assignment_names"].get(updated["stage"])
        record = {"fields": sorted(payload), "from_stage": project["stage"], "to_stage": updated["stage"], "changes": {}}
        for field in ("lead", "visit", "cad", "production", "installation", "assignments", "next_action", "deadline", "target_completion_date", "duplicate_review", "lifecycle_status", "workflow_cycle", "commercial_basis_invalidated", "manual_stage_navigation", "completion_date", "closure_pending_reason", "customer_order_confirmation", "final_design_version_id"):
            if project.get(field) != updated.get(field):
                record["changes"][field] = {"before": project.get(field), "after": updated.get(field)}
        if command in workflow.COMMANDS:
            record["subject_id"] = payload.get("version_id") or payload.get("quotation_version_id") or payload.get("design_version_id")
            for key in ("design_versions", "quotation_versions", "orders", "revision_events", "site_visits", "approvals"):
                old_rows, new_rows = project.get(key, []), updated.get(key, [])
                if len(new_rows) > len(old_rows):
                    record.setdefault("created_subjects", {})[key] = [row["id"] for row in new_rows[len(old_rows):]]
            for key in ("status", "order_amount", "design_revision_count", "site_visit_count", "completion_date"):
                if project.get(key) != updated.get(key):
                    record["changes"][key] = {"before": project.get(key), "after": updated.get(key)}
            if command == "design_update":
                record["reason"] = payload["reason"]
                record["changes"]["design"] = {"before": selected_design,
                    "after": next(row for row in updated["design_versions"] if row["id"] == payload["version_id"])}
            if command == "quotation_update":
                record["changes"]["quotation"] = {
                    "before": next(row for row in project["quotation_versions"] if row["id"] == payload["version_id"]),
                    "after": next(row for row in updated["quotation_versions"] if row["id"] == payload["version_id"])}
            if command in {"order_update", "order_confirmation"} and project.get("orders"):
                record["changes"]["order"] = {"before": project["orders"][-1], "after": updated["orders"][-1]}
            if command == "order_document":
                record["changes"]["confirmation_document_id"] = {
                    "before": project["orders"][-1].get("confirmation_document_id"),
                    "after": updated["orders"][-1].get("confirmation_document_id")}
            if command == "order_advance":
                record["changes"]["advance"] = {
                    "before": project["orders"][-1].get("advance"),
                    "after": updated["orders"][-1].get("advance")}
        updated["activity"].append(event(user, command, record))
        updated["command_receipts"].append({"actor_id": user.id, "key": body.idempotency_key, "fingerprint": digest,
                                              "version": updated["version"], "command": command})
        bounded(updated)
        # Resolve authoritative response reads before committing; an outage must
        # not turn a durable stage move into an apparently failed Next action.
        async with bounded_read():
            response = await self.public(updated, user, policy)
        result = await self.db.kitchen_projects.replace_one(
            {"id": project_id, "floor_id": access.KITCHEN_FLOOR, "version": body.expected_version}, updated)
        if not result.matched_count:
            latest = await self.db.kitchen_projects.find_one({"id": project_id, "floor_id": access.KITCHEN_FLOOR})
            await access.require_project(self.db, user, latest, policy, "update")
            saved = next((r for r in latest["command_receipts"] if r["actor_id"] == user.id and r["key"] == body.idempotency_key), None)
            if saved and saved["fingerprint"] == digest:
                return await self.public(latest, user, policy, replayed=True)
            await access.require_current_task(self.db, user, latest, policy)
            raise HTTPException(409, "Kitchen project changed; reload before saving")
        return response

    async def customers(self, user, *, search="", page=1, limit=50):
        await access.require_capability(self.db, user, "create")
        query = {"floor_id": access.KITCHEN_FLOOR, "kitchen_delete_token": {"$exists": False}}
        if search.strip():
            term = {"$regex": re.escape(search.strip()), "$options": "i"}
            query["$or"] = [{field: term} for field in ("name", "phone", "address")]
        total = await self.db.customers.count_documents(query)
        rows = await self.db.customers.find(query, CUSTOMER_PROJECTION).sort([("name", 1), ("id", 1)]).skip((page - 1) * limit).limit(limit).to_list(limit)
        return {"rows": rows, "total": total, "page": page, "limit": limit}

    async def assignees(self, user):
        await access.require_capability(self.db, user, "view")
        # The owner still selects approval managers through this legacy endpoint.
        return {"rows": await access.eligible_staff(self.db) if access.owner(user) else []}

    async def dashboard(self, user):
        async with bounded_read():
            await access.require_capability(self.db, user, "view")
            policy = await self.policy()
            expressions = attention_expressions(policy)
            totals = {key: {"$sum": {"$cond": ["$attention." + key, 1, 0]}} for key in expressions}
            totals["value"] = {"$sum": {"$cond": ["$attention.active_order",
                {"$convert": {"input": "$order.final_amount", "to": "decimal", "onError": 0, "onNull": 0}}, 0]}}
            # Aggregate in Mongo; no project histories or per-customer arrays cross the wire.
            pipeline = [{"$match": access.scope_query(user, policy)}, {"$project": {
                "stage": 1, "customer_id": {"$ifNull": ["$customer_id", "$id"]},
                "assigned_to": 1, "assigned_to_name": 1, "attention": expressions,
                "order": {"$arrayElemAt": [{"$ifNull": ["$orders", []]}, -1]}}},
                {"$facet": {
                    "totals": [{"$group": {"_id": None, **totals, "projects": {"$sum": 1}}}],
                    "customers": [{"$group": {"_id": "$customer_id"}}, {"$count": "count"}],
                    "stages": [{"$group": {"_id": {"stage": "$stage", "customer": "$customer_id"}, "projects": {"$sum": 1}}},
                        {"$group": {"_id": "$_id.stage", "projects": {"$sum": "$projects"}, "customers": {"$sum": 1}}}],
                    "workload": [{"$match": {"attention.active": True}}, {"$group": {
                        "_id": "$assigned_to", "assignee_name": {"$first": "$assigned_to_name"}, "project_count": {"$sum": 1}}}],
                }}]
            rows = await self.db.kitchen_projects.aggregate(pipeline, maxTimeMS=READ_MAX_TIME_MS).to_list(1)
            data = rows[0]
            values = data["totals"][0] if data["totals"] else {}
            stages = {stage: 0 for stage in STAGES}
            customers = dict(stages)
            for row in data["stages"]:
                if row["_id"] in stages:
                    stages[row["_id"]] = row["projects"]
                    customers[row["_id"]] = row["customers"]
            value = values.get("value", 0)
            amount = format(value.to_decimal() if isinstance(value, Decimal128) else Decimal(str(value)), ".2f")
            workload = [{"assignee_id": row["_id"], "assignee_name": row.get("assignee_name"),
                         "project_count": row["project_count"]} for row in data["workload"]]
            return {"configured": True, "active_projects": values.get("active", 0), "on_hold_projects": values.get("on_hold", 0),
                    "next_action_overdue_projects": values.get("next_action_overdue", 0),
                    "completion_overdue_projects": values.get("completion_overdue", 0),
                    "active_order_value": amount, "overdue_projects": values.get("completion_overdue", 0),
                    "confirmed_order_value": amount, "pending_approvals": values.get("pending_approval", 0),
                    "stage_counts": stages, "stage_customer_counts": customers,
                    "total_projects": values.get("projects", 0),
                    "total_customers": data["customers"][0]["count"] if data["customers"] else 0,
                    "workload": sorted(workload, key=lambda item: (item["assignee_name"] or "", item["assignee_id"] or "")),
                    "definitions": policy["metrics"]}

    async def export_completed(self, user, **filters):
        await access.require_capability(self.db, user, "export")
        # The full selected scope is exported page by page. Explicitly fail if
        # it exceeds this download bound; never silently export the first page.
        rows, page = [], 1
        while True:
            result = await self.list(user, **filters, completed=True, page=page, limit=100)
            if result["total"] > 10000:
                raise HTTPException(413, "Export exceeds 10,000 projects; narrow the selected filters")
            rows.extend(result["rows"])
            if len(rows) >= result["total"] or not result["rows"]:
                break
            page += 1
        from services.export import rows_to_csv
        return rows_to_csv([{"reference": row["reference"], "customer": row["customer"]["name"],
                             "order_amount": row.get("order_amount"), "completion_date": row.get("completion_date"),
                             "design_revisions": row["design_revision_count"] if row["design_revision_count"] is not None else "Historical count unavailable", "site_visits": row["site_visit_count"] if row["site_visit_count"] is not None else "Historical count unavailable"}
                            for row in rows], [("reference", "Project ID"), ("customer", "Customer"),
                            ("order_amount", "Order amount INR"), ("completion_date", "Completion date"),
                            ("design_revisions", "Design revisions"), ("site_visits", "Actual site visits")])

    async def list(self, user, *, search="", stage=None, status=None, assignee=None, date_from=None,
                   date_to=None, date_field="created_at", sort="updated_at", direction="desc", page=1, limit=50, completed=None, duplicate_review=None, attention=None):
        async with bounded_read():
            await access.require_capability(self.db, user, "view")
            policy = await self.policy()
            query = access.scope_query(user, policy)
            filters = [query]
            if attention:
                expressions = attention_expressions(policy)
                if attention not in expressions:
                    raise HTTPException(422, "Unsupported Kitchen attention filter")
                filters.append({"$expr": expressions[attention]})
            if duplicate_review:
                filters.append({"duplicate_review.status": duplicate_review})
            if stage:
                filters.append({"stage": stage})
            if completed is not None:
                filters.append({"stage": "completed" if completed else {"$ne": "completed"}})
            if status:
                filters.append({"status": status})
            if assignee:
                filters.append({"assigned_to": None if assignee == "unassigned" else assignee})
            if search.strip():
                term = {"$regex": re.escape(search.strip()), "$options": "i"}
                matches = await self.db.customers.find({"floor_id": access.KITCHEN_FLOOR,
                    "$or": [{field: term} for field in CUSTOMER_SEARCH_FIELDS]}, {"_id": 0, "id": 1}).limit(1001).max_time_ms(READ_MAX_TIME_MS).to_list(1001)
                if len(matches) > 1000:
                    raise HTTPException(413, "Search matches over 1,000 Kitchen customers; enter a more specific name or contact detail")
                # Contact edits must stop matching stale project snapshots.
                fields = ("reference", "project_reference", "customer_id", "lead.site_location")
                filters.append({"$or": [{field: term} for field in fields] + [{"customer_id": {"$in": [row["id"] for row in matches]}}]})
            if date_from or date_to:
                bounds = {}
                if date_from:
                    bounds["$gte"] = date_from if date_field.endswith("_date") else datetime.combine(date.fromisoformat(date_from), datetime.min.time(), tzinfo=timezone(timedelta(hours=5, minutes=30))).astimezone(timezone.utc).isoformat()
                if date_to:
                    end = date.fromisoformat(date_to) + timedelta(days=1)
                    bounds["$lt"] = end.isoformat() if date_field.endswith("_date") else datetime.combine(end, datetime.min.time(), tzinfo=timezone(timedelta(hours=5, minutes=30))).astimezone(timezone.utc).isoformat()
                filters.append({date_field: bounds})
            compiled = {"$and": filters}
            # Current-stage assignment is persisted as a query projection field.
            sort_field = {"customer": "customer.name", "assignee": "assigned_to_name", "order_amount": "order_amount_paise"}.get(sort, sort)
            projection = {key: 0 for key in HISTORY_FIELDS if key not in {"design_versions", "quotation_versions", "orders"}}
            versions = {}
            # Stage tables need the current commercial fields, never the full
            # version ledger. Keep the explicit order basis even when it references
            # an older design/quotation, returning at most one row per ledger.
            for key, variable in (("design_versions", "design"), ("quotation_versions", "quote")):
                versions[key] = order_basis_expression({"$cond": [{"$or": [
                    {"$and": [
                    {"$ne": ["$$order", {}]}, {"$not": [{"$ifNull": ["$commercial_basis_invalidated", False]}]},
                    {"$not": [{"$ifNull": ["$$order.authorization_invalidated", False]}]}]},
                    {"$in": ["$stage", ["quotation", "order"]]}]},
                    {"$cond": [{"$ne": ["$$" + variable, {}]}, ["$$" + variable], []]},
                    {"$slice": [{"$ifNull": ["$" + key, []]}, -1]}]}, fallback_quotation=True)
            versions["orders"] = {"$slice": [{"$ifNull": ["$orders", []]}, -1]}
            pipeline = [{"$match": compiled},
                {"$sort": {sort_field: 1 if direction == "asc" else -1, "id": 1}},
                {"$skip": (page - 1) * limit}, {"$limit": limit},
                {"$set": versions}, {"$project": projection}]
            total, rows = await asyncio.gather(
                self.db.kitchen_projects.count_documents(compiled, maxTimeMS=READ_MAX_TIME_MS),
                self.db.kitchen_projects.aggregate(pipeline, maxTimeMS=READ_MAX_TIME_MS).to_list(limit))
            can_update, customers = await asyncio.gather(access.capability(self.db, user, "update"),
                self._current_customers([row["customer_id"] for row in rows]))
            for row in rows:
                row["customer"] = customers.get(row["customer_id"], row["customer"])
            return {"rows": [await self.public(row, user, policy, summary=True, can_update=can_update) for row in rows], "total": total, "page": page, "limit": limit}
