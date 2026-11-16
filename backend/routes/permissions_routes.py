"""Existing Team & Roles matrix for module visibility and Delete Customers.

Ordinary module rows remain a visibility layer; business routes retain their
existing authorization. The explicit `delete-customers` row additionally grants
customer deletion to a role through services.customer_delete_access. It defaults
off for every non-owner and never widens department assignments or a custom
account's explicit capabilities. Only the owner can change this matrix.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response

from auth import ROLE_HIERARCHY, ROLE_LABELS, get_current_user, require_min_role
from db import db
from models import UserPublic, now_iso
from services.access_grants import KITCHEN_STAGE_RESOURCES, RESOURCE_REGISTRY

router = APIRouter(prefix="/settings/permission-matrix", tags=["settings"])

SETTINGS_KEY = "permission_matrix"

MODULES: list[dict[str, str]] = [
    {"key": "dashboard", "label": "Dashboard"},
    {"key": "quotations", "label": "Quotations"},
    {"key": "catalog", "label": "Catalog"},
    {"key": "customers", "label": "Customers"},
    {"key": "kitchen-projects", "label": "Kitchen · Overview, Projects, Workflow and Completed"},
    {"key": "purchases", "label": "Purchases"},
    {"key": "payments", "label": "Payments"},
    {"key": "followups", "label": "Follow-ups"},
    {"key": "notifications", "label": "Notifications"},
    {"key": "team", "label": "Team"},
    {"key": "settings", "label": "Settings"},
    {"key": "sales-data", "label": "Sales Data"},
]
MODULES.extend({"key": f"kitchen-{stage}", "label": f"Kitchen · {RESOURCE_REGISTRY[resource]['label']}"}
               for stage, resource in KITCHEN_STAGE_RESOURCES.items())
MODULES.append({"key": "delete-customers", "label": "Delete Customers"})
MODULE_KEYS = {m["key"] for m in MODULES}

# Mirrors the nav `roles` restriction that existed before this feature —
# ordinary modules default to worker visibility; destructive deletion and
# owner reporting require explicit owner configuration.
DEFAULT_MIN_ROLE: dict[str, str] = {"team": "owner", "sales-data": "owner", "delete-customers": "owner"}


def _default_matrix() -> dict[str, dict[str, bool]]:
    matrix: dict[str, dict[str, bool]] = {}
    for role, level in ROLE_HIERARCHY.items():
        row: dict[str, bool] = {}
        for m in MODULES:
            floor = ROLE_HIERARCHY.get(DEFAULT_MIN_ROLE.get(m["key"], "worker"), 10)
            row[m["key"]] = level >= floor
        matrix[role] = row
    return matrix


def _roles_payload() -> list[dict[str, object]]:
    return [
        {"role": r, "label": ROLE_LABELS.get(r, r.title()), "level": lvl}
        for r, lvl in sorted(ROLE_HIERARCHY.items(), key=lambda kv: -kv[1])
    ]


@router.get("")
async def get_permission_matrix(_: UserPublic = Depends(get_current_user)):
    """Any authenticated staff member can read the effective matrix — the
    frontend nav consults this to decide what to render for the current
    user's own role; only the owner can change it (PUT below)."""
    doc = await db.settings.find_one({"key": SETTINGS_KEY}, {"_id": 0})
    overrides = (doc or {}).get("overrides", {})
    matrix = _default_matrix()
    for role, row in overrides.items():
        if role not in matrix or not isinstance(row, dict):
            continue
        for mod_key, allowed in row.items():
            if mod_key in MODULE_KEYS:
                matrix[role][mod_key] = bool(allowed)
    for role, row in matrix.items():
        row["sales-data"] = role == "owner"
        row["delete-customers"] = role == "owner" or overrides.get(role, {}).get("delete-customers") is True
        for stage in KITCHEN_STAGE_RESOURCES:
            key = f"kitchen-{stage}"
            if role == "owner":
                row[key] = True
            elif key not in overrides.get(role, {}):
                row[key] = row["kitchen-projects"]
    return {
        "modules": MODULES,
        "roles": _roles_payload(),
        "matrix": matrix,
        "updated_at": (doc or {}).get("updated_at"),
        "updated_by_name": (doc or {}).get("updated_by_name"),
    }


@router.get("/customer-deletion-access")
async def customer_deletion_access(response: Response, user: UserPublic = Depends(get_current_user)):
    from services.customer_delete_access import require_customer_delete
    response.headers["Cache-Control"] = "no-store"
    try:
        await require_customer_delete(db, user, user.active_floor_id)
    except HTTPException as error:
        if error.status_code != 403:
            raise
        return {"allowed": False}
    return {"allowed": True}


@router.put("")
async def update_permission_matrix(body: dict, user: UserPublic = Depends(require_min_role("owner"))):
    overrides = body.get("overrides")
    if not isinstance(overrides, dict):
        raise HTTPException(status_code=400, detail="Body must include an 'overrides' object")

    clean: dict[str, dict[str, bool]] = {}
    for role, row in overrides.items():
        if role not in ROLE_HIERARCHY:
            raise HTTPException(status_code=400, detail=f"Unknown role '{role}'")
        if not isinstance(row, dict):
            raise HTTPException(status_code=400, detail=f"Row for role '{role}' must be an object")
        clean_row: dict[str, bool] = {}
        for mod_key, allowed in row.items():
            if mod_key not in MODULE_KEYS:
                raise HTTPException(status_code=400, detail=f"Unknown module '{mod_key}'")
            if mod_key == "delete-customers" and not isinstance(allowed, bool):
                raise HTTPException(400, "Delete Customers must be enabled or disabled explicitly")
            clean_row[mod_key] = bool(allowed)
        clean[role] = clean_row

    # Guard rail — owner can never lock themselves out of Settings/Team by
    # a fat-fingered save; every other combination is fair game.
    owner_row = clean.get("owner", {})
    owner_row["delete-customers"] = True
    clean["owner"] = owner_row
    if owner_row.get("settings") is False or owner_row.get("team") is False:
        raise HTTPException(status_code=400, detail="Owner must always keep Settings and Team visible")

    await db.settings.update_one(
        {"key": SETTINGS_KEY},
        {"$set": {
            "key": SETTINGS_KEY, "overrides": clean, "updated_at": now_iso(),
            "updated_by": user.id, "updated_by_name": user.full_name,
        }},
        upsert=True,
    )
    return await get_permission_matrix(user)
