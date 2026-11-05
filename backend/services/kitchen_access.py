"""Kitchen capabilities plus project scope; no role grants approval authority."""
from __future__ import annotations

from fastapi import HTTPException

from auth import accessible_floor_ids
from services.access_grants import KITCHEN_STAGE_RESOURCES, grant_allows, grants_for_user

KITCHEN_FLOOR = "second-floor"
RESOURCE = "kitchen_projects"


def owner(user):
    return getattr(user, "role", None) == "owner"


def hydrate_stage_actions(user, grants):
    restricted = any(grant_allows(g, user_id=user.id, resource="kitchen_restricted", action="view", floor_id=KITCHEN_FLOOR) for g in grants)
    object.__setattr__(user, "_kitchen_restricted", restricted)
    pdf_actions = {stage: {action: any(grant_allows(g, user_id=user.id, resource=KITCHEN_STAGE_RESOURCES[stage], action="pdf_" + action, floor_id=KITCHEN_FLOOR) for g in grants)
                           for action in ("choose", "open", "download")} for stage in ("design", "quotation")}
    object.__setattr__(user, "_kitchen_pdf_actions", pdf_actions)
    stage_actions = {operation: [name for name, resource in KITCHEN_STAGE_RESOURCES.items()
        if any(grant_allows(grant, user_id=user.id, resource=candidate, action=operation, floor_id=KITCHEN_FLOOR)
               for grant in grants for candidate in (RESOURCE, resource))]
        for operation in ("view", "create", "update", "export")}
    object.__setattr__(user, "_kitchen_semantic_actions", {action: list(stages) for action, stages in stage_actions.items()})
    # Either section grant allows reaching the merged workspace; commands retain their own grants.
    for stages in stage_actions.values():
        if "order" in stages or "production" in stages:
            for stage in ("order", "production"):
                if stage not in stages:
                    stages.append(stage)
    object.__setattr__(user, "_kitchen_stage_actions", stage_actions)
    return stage_actions


async def capability(database, user, action, *, stage=None):
    if not user.active or getattr(user, "access_profile", None):
        return False
    allowed = accessible_floor_ids(user)
    if allowed is not None and KITCHEN_FLOOR not in allowed:
        return False
    if user.active_floor_id and user.active_floor_id != KITCHEN_FLOOR:
        return False
    if owner(user):
        return True
    if user.custom_access:
        grants = await grants_for_user(database, user.id)
        stage_actions = hydrate_stage_actions(user, grants)
        stages = stage_actions.get(action, [])
        return (stage or "lead") in stages if stage or action == "create" else bool(stages)
    if action == "view":
        return True
    return user.role in {"admin", "manager", "sales", "purchase", "warehouse", "accounts"}


async def require_capability(database, user, action, *, stage=None):
    if not await capability(database, user, action, stage=stage):
        raise HTTPException(403, "Kitchen project access is not permitted")


def allowed_stages(user, action="view"):
    if owner(user) or not user.custom_access:
        return list(KITCHEN_STAGE_RESOURCES)
    return getattr(user, "_kitchen_stage_actions", {}).get(action, [])


def restricted(user):
    return not owner(user) and bool(getattr(user, "_kitchen_restricted", False))


def pdf_allowed(user, stage, action):
    if not restricted(user):
        return True
    return bool(getattr(user, "_kitchen_pdf_actions", {}).get(stage, {}).get(action))


def is_pdf(metadata):
    return metadata.get("content_type", "").split(";", 1)[0].strip().lower() == "application/pdf" or metadata.get("filename", "").lower().endswith(".pdf")


def require_upload(user, project, content_type):
    if not restricted(user):
        return
    stage = project.get("stage")
    if stage not in {"design", "quotation", "order", "production", "completed"}:
        return
    if content_type != "application/pdf" or stage not in {"design", "quotation"} or not pdf_allowed(user, stage, "choose"):
        raise HTTPException(403, "File upload is not permitted")


def final_pdf_ids(project, stage):
    if stage == "design":
        identity = project.get("final_design_version_id")
        row = next((v for v in project.get("design_versions", []) if v.get("id") == identity), None)
    else:
        rows = project.get("quotation_versions", [])
        row = rows[-1] if rows else None
    return {row["final_attachment_id"]} if row and row.get("final_attachment_id") else set()


def require_attachment(user, project, metadata, purpose):
    if not restricted(user):
        return
    stage = project.get("stage")
    if stage in {"lead", "visit", "cad"}:
        return
    if stage == "installation" and (not is_pdf(metadata) or metadata.get("stage") == "installation"):
        return
    if stage not in {"design", "quotation"} or not is_pdf(metadata) or not pdf_allowed(user, stage, purpose):
        raise HTTPException(403, "File access is not permitted")
    if metadata["id"] not in final_pdf_ids(project, stage):
        raise HTTPException(404, "Finalized PDF not found")


def scope_query(user, policy):
    # Kitchen capabilities grant the workspace; historical staff assignments do not.
    stages = allowed_stages(user)
    return {"floor_id": KITCHEN_FLOOR, **({"stage": {"$in": stages}} if len(stages) < len(KITCHEN_STAGE_RESOURCES) else {})}


def project_visible(project, user, policy):
    return project.get("floor_id") == KITCHEN_FLOOR and project.get("stage") in allowed_stages(user)


def department_manager(user, policy):
    return policy.get("decision_contract") == "2026-10-20" and user.id in policy.get("department_manager_user_ids", [])


async def require_current_task(database, user, project, policy):
    await require_project(database, user, project, policy, "update")


async def require_project(database, user, project, policy, action="view"):
    await require_capability(database, user, action)
    if not project or not project_visible(project, user, policy):
        raise HTTPException(404, "Kitchen project not found")
    if project.get("stage") not in allowed_stages(user, action):
        raise HTTPException(403, "Kitchen stage action is not permitted")


async def require_command(database, user, project, command):
    stage = ({"edit_lead": "lead", "save_visit": "visit", "save_cad": "cad", "site_visit": "installation"}.get(command)
        or next((name for name in ("design", "quotation", "order", "production", "installation") if command.startswith(name + "_")), None))
    if stage:
        semantic = getattr(user, "_kitchen_semantic_actions", {}).get("update", []) if user.custom_access and not owner(user) else allowed_stages(user, "update")
        if stage not in semantic:
            raise HTTPException(403, "Kitchen stage action is not permitted")


async def require_customer(database, user, customer, action="view"):
    if customer.get("floor_id") != KITCHEN_FLOOR or not user.custom_access:
        return
    grants = await grants_for_user(database, user.id)
    if any(grant_allows(grant, user_id=user.id, resource="customers", action=action, floor_id=KITCHEN_FLOOR) for grant in grants):
        return
    await require_capability(database, user, action)
    stages = set(allowed_stages(user)) & set(allowed_stages(user, action))
    if not await database.kitchen_projects.find_one({"customer_id": customer["id"], "floor_id": KITCHEN_FLOOR,
            "stage": {"$in": list(stages)}}, {"_id": 0, "id": 1}):
        raise HTTPException(404, "Kitchen customer not found in your assigned stages")


def semantic_stages(user, action="view"):
    return getattr(user, "_kitchen_semantic_actions", {}).get(action, []) if user.custom_access and not owner(user) else allowed_stages(user, action)


def scoped(user):
    return user.custom_access and len(semantic_stages(user)) < len(KITCHEN_STAGE_RESOURCES)


def visible_attachment_ids(project, user):
    if not scoped(user):
        return None
    result = redact_project(dict(project), project, user, attachments=False)
    ids = set()
    def collect(value):
        if isinstance(value, list):
            for row in value:
                collect(row)
        elif isinstance(value, dict):
            for key, item in value.items():
                if key.endswith("attachment_id") or key in {"document_id", "confirmation_document_id"}:
                    if isinstance(item, str):
                        ids.add(item)
                elif key == "attachment_ids" and isinstance(item, list):
                    ids.update(item)
                else:
                    collect(item)
    for key in ("design_versions", "quotation_versions", "orders", "production", "installation"):
        collect(result.get(key))
    ids.update(row["id"] for row in project.get("attachments", []) if row.get("stage") in semantic_stages(user))
    return ids


def redact_project(result, project, user, *, attachments=True):
    # A quotation-stage worker may not see orders, but needs to know whether
    # editing a quotation would alter recorded order evidence. This flag is
    # derived from the authoritative aggregate, including historical orders.
    if "quotation" in allowed_stages(user):
        bound_ids = {order.get("quotation_version_id") for order in project.get("orders", [])}
        if "quotation_versions" in result:
            result["quotation_versions"] = [{**quote, "order_bound": quote.get("id") in bound_ids}
                                            for quote in result["quotation_versions"]]
        if result.get("current_quotation"):
            quote = result["current_quotation"]
            result["current_quotation"] = {**quote, "order_bound": quote.get("id") in bound_ids}
    if not scoped(user):
        return redact_restricted(result, project, user)
    from models_kitchen import LeadFields, VisitFields, CadFields
    stages = semantic_stages(user)
    for stage, model in (("lead", LeadFields), ("visit", VisitFields), ("cad", CadFields)):
        if stage not in stages:
            result[stage] = model().model_dump()
    for key in ("activity", "work_history", "approvals", "revision_events", "site_visits"):
        result[key] = []
    scopes = {"design": "customer_design", "quotation": "customer_quotation", "installation": "closure"}
    result["approvals"] = [{key: value for key, value in row.items() if key in {"id", "scope", "subject_id", "decision", "at", "approval_date"}}
        for row in project.get("approvals", []) if row.get("scope") in {scopes[stage] for stage in stages if stage in scopes}]
    for stage in ("production", "installation"):
        if stage not in stages:
            result[stage] = {"status": "Not Started"}
    dependencies = {
        "design_versions": ({"quotation", "order", "production", "installation"}, "design", {"id", "number", "response", "shared_date", "approval_date", "handoff_status", "handoff_date", "attachment_ids", "final_attachment_id", "workflow_cycle"}),
        "quotation_versions": ({"order", "production", "installation"}, "quotation", {"id", "number", "response", "shared_date", "sent_status", "design_version_id", "workflow_cycle", "final_attachment_id", "pdf_options"}),
        "orders": ({"production", "installation"}, "order", {"id", "confirmed", "status", "quotation_version_id", "authorization_invalidated"}),
    }
    if "order" in stages:
        dependencies["quotation_versions"][2].add("amount")
    order = (project.get("orders") or [{}])[-1]
    quote = next((row for row in project.get("quotation_versions", []) if row["id"] == order.get("quotation_version_id")), {})
    for key, (required_by, stage, fields) in dependencies.items():
        if stage in stages:
            continue
        rows = project.get(key, [])
        selected = rows[-1:] if set(stages) & required_by else []
        identity = (quote.get("design_version_id") if project.get("stage") in {"production", "installation"} else project.get("final_design_version_id")) if key == "design_versions" else order.get("quotation_version_id") if key == "quotation_versions" else None
        if identity and selected:
            selected = [row for row in rows if row["id"] == identity]
        result[key] = [{name: value for name, value in row.items() if name in fields} for row in selected]
        current = {"design_versions": "current_design", "quotation_versions": "current_quotation", "orders": "current_order"}[key]
        if current in result:
            result[current] = result[key][-1] if result[key] else None
    if "order" not in stages:
        for key in ("order_amount", "order_amount_paise", "customer_order_confirmation"):
            result[key] = None
    if attachments:
        permitted = visible_attachment_ids(project, user)
        result["attachments"] = [row for row in result.get("attachments", []) if row["id"] in permitted]
    result["access_scoped"] = True
    from services.kitchen_workflow import production_has_started
    result["production_started"] = production_has_started(project)
    return redact_restricted(result, project, user)


def redact_restricted(result, project, user):
    if not restricted(user):
        return result
    import re
    sensitive = re.compile(r"(^|_)(amount|price|cost|budget|installments?|advance|payment|paid|balance|total|value)(_|$)")
    def clean(value, path=()):
        if isinstance(value, list):
            return [clean(item, path) for item in value]
        if isinstance(value, dict):
            hidden_lists = {"activity", "work_history", "revision_events", "blocked_transitions"}
            hidden_text = {"notes", "response_notes", "reason", "requirements"}
            def hide(key):
                if key == "notes" and path == ("installation",) and project.get("stage") == "installation":
                    return False
                return bool(sensitive.search(key) or key in hidden_lists or key in hidden_text)
            return {key: ([] if isinstance(item, list) else None) if hide(key) else clean(item, (*path, key)) for key, item in value.items()}
        return value
    result = clean(result)
    stage = project.get("stage")
    permitted = set()
    if stage in {"design", "quotation"} and (pdf_allowed(user, stage, "open") or pdf_allowed(user, stage, "download") or pdf_allowed(user, stage, "choose")):
        permitted = final_pdf_ids(project, stage)
        if pdf_allowed(user, stage, "choose"):
            permitted.update(row["id"] for row in project.get("attachments", []) if row.get("stage") == stage and row.get("content_type") == "application/pdf")
    if stage == "installation":
        permitted.update(row["id"] for row in project.get("attachments", []) if row.get("stage") == "installation")
    if stage in {"lead", "visit", "cad"}:
        return result
    result["attachments"] = [row for row in result.get("attachments", []) if row.get("id") in permitted or (stage == "installation" and not is_pdf(row))]
    def strip_refs(value):
        if isinstance(value, list):
            return [strip_refs(v) for v in value]
        if isinstance(value, dict):
            output = {}
            for k, v in value.items():
                if k in {"attachment_id", "final_attachment_id", "confirmation_document_id", "document_id"} and v not in permitted:
                    output[k] = None
                elif k == "attachment_ids" and isinstance(v, list):
                    output[k] = [x for x in v if x in permitted]
                elif k == "pdf_options" and isinstance(v, list):
                    output[k] = [strip_refs(x) for x in v if x.get("attachment_id") in permitted]
                elif k == "url":
                    output[k] = None
                else:
                    output[k] = strip_refs(v)
            return output
        return value
    result = strip_refs(result)
    return result


async def eligible_staff(database):
    """Return only current Kitchen-capable staff, never credentials or grants."""
    from models import UserPublic
    fields = {"_id": 0, "id": 1, "full_name": 1, "role": 1, "active": 1, "floor_ids": 1,
              "access_profile": 1, "custom_access": 1, "is_deleted": 1, "deleted_at": 1}
    rows = await database.users.find({"active": True}, fields).sort([("full_name", 1), ("id", 1)]).limit(1001).to_list(1001)
    if len(rows) > 1000:
        raise HTTPException(413, "Staff selection exceeds its supported bound")
    result = []
    for row in rows:
        if row.get("role") == "owner" or row.get("is_deleted") or row.get("deleted_at"):
            continue
        staff = UserPublic(**row)
        if await capability(database, staff, "view") and await capability(database, staff, "update"):
            result.append({"id": staff.id, "full_name": staff.full_name, "role": staff.role})
    return result

