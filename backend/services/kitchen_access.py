"""Kitchen capabilities plus project scope; no role grants approval authority."""
from __future__ import annotations

from fastapi import HTTPException

from auth import accessible_floor_ids
from services.access_grants import grant_allows, grants_for_user

KITCHEN_FLOOR = "second-floor"
RESOURCE = "kitchen_projects"


def owner(user):
    return user.role == "owner"


async def capability(database, user, action):
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
        return any(grant_allows(g, user_id=user.id, resource=RESOURCE, action=action, floor_id=KITCHEN_FLOOR)
                   for g in await grants_for_user(database, user.id))
    if action == "view":
        return True
    return user.role in {"admin", "manager", "sales", "purchase", "warehouse", "accounts"}


async def require_capability(database, user, action):
    if not await capability(database, user, action):
        raise HTTPException(403, "Kitchen project access is not permitted")


def scope_query(user, policy):
    if owner(user) or department_manager(user, policy):
        return {"floor_id": KITCHEN_FLOOR}
    assigned = [{f"assignments.{stage}": user.id} for stage in
                ("lead", "visit", "cad", "design", "quotation", "order", "production", "installation", "completed")]
    return {"floor_id": KITCHEN_FLOOR, "$or": assigned}


def project_visible(project, user, policy):
    if project.get("floor_id") != KITCHEN_FLOOR:
        return False
    return owner(user) or department_manager(user, policy) or user.id in project.get("assignments", {}).values()


def department_manager(user, policy):
    return policy.get("decision_contract") == "2026-10-20" and user.id in policy.get("department_manager_user_ids", [])


def can_assign(user, policy):
    return owner(user) or department_manager(user, policy)


def current_task_assigned(project, user, policy):
    """History visibility does not delegate another employee's current task."""
    return owner(user) or department_manager(user, policy) or project.get("assignments", {}).get(project["stage"]) == user.id


async def require_current_task(database, user, project, policy):
    await require_capability(database, user, "update")
    if not current_task_assigned(project, user, policy):
        raise HTTPException(403, "Only the employee assigned to the current stage may update this task")


async def require_project(database, user, project, policy, action="view"):
    await require_capability(database, user, action)
    if not project or not project_visible(project, user, policy):
        raise HTTPException(404, "Kitchen project not found")


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


async def validate_assignee(database, user_id):
    if user_id is None:
        return None
    selected = next((row for row in await eligible_staff(database) if row["id"] == user_id), None)
    if not selected:
        raise HTTPException(422, "Assignee must be active and have Kitchen project view/update access")
    return selected

