"""Kitchen capabilities plus project scope; no role grants approval authority."""
from __future__ import annotations

from fastapi import HTTPException

from auth import accessible_floor_ids
from services.access_grants import KITCHEN_STAGE_RESOURCES, grant_allows, grants_for_user

KITCHEN_FLOOR = "second-floor"
RESOURCE = "kitchen_projects"


def owner(user):
    return user.role == "owner"


def hydrate_stage_actions(user, grants):
    stage_actions = {operation: [name for name, resource in KITCHEN_STAGE_RESOURCES.items()
        if any(grant_allows(grant, user_id=user.id, resource=candidate, action=operation, floor_id=KITCHEN_FLOOR)
               for grant in grants for candidate in (RESOURCE, resource))]
        for operation in ("view", "create", "update", "export")}
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
        if stage not in allowed_stages(user, "update"):
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


def scoped(user):
    return user.custom_access and len(allowed_stages(user)) < len(KITCHEN_STAGE_RESOURCES)


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
    for key in ("design_versions", "quotation_versions", "orders", "installation"):
        collect(result.get(key))
    ids.update(row["id"] for row in project.get("attachments", []) if row.get("stage") in allowed_stages(user))
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
        return result
    from models_kitchen import LeadFields, VisitFields, CadFields
    stages = allowed_stages(user)
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

