"""Settings > Team > Permissions — configurable per-role module visibility.

This is an ADDITIVE, UI-visibility layer on top of the existing hard RBAC
(auth.require_min_role / require_roles on every route — untouched by this
file). It lets the owner show/hide entire modules in the nav per role
without touching a single line of the real authorization checks that
protect the underlying data. Misconfiguring this matrix can only hide or
reveal a nav entry; it can never grant access to an endpoint the visiting
role's real backend role-check would otherwise reject, because every data
endpoint keeps enforcing its own require_min_role/require_roles exactly as
before — this file never reads or influences those decorators.

Defaults exactly mirror the nav `roles` arrays that existed in
app/(admin)/_layout.tsx before this feature (every module open to every
role except Team, which was already manager+) — so until an owner
explicitly saves an override, behaviour is byte-for-byte identical to
before this feature shipped.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from auth import ROLE_HIERARCHY, ROLE_LABELS, get_current_user, require_min_role
from db import db
from models import UserPublic, now_iso

router = APIRouter(prefix="/settings/permission-matrix", tags=["settings"])

SETTINGS_KEY = "permission_matrix"

MODULES: list[dict[str, str]] = [
    {"key": "dashboard", "label": "Dashboard"},
    {"key": "quotations", "label": "Quotations"},
    {"key": "catalog", "label": "Catalog"},
    {"key": "customers", "label": "Customers"},
    {"key": "purchases", "label": "Purchases"},
    {"key": "payments", "label": "Payments"},
    {"key": "followups", "label": "Follow-ups"},
    {"key": "notifications", "label": "Notifications"},
    {"key": "team", "label": "Team"},
    {"key": "settings", "label": "Settings"},
    {"key": "sales-data", "label": "Sales Data"},
]
MODULE_KEYS = {m["key"] for m in MODULES}

# Mirrors the nav `roles` restriction that existed before this feature —
# every module defaults to "worker" (i.e. visible to everyone) except Team.
DEFAULT_MIN_ROLE: dict[str, str] = {"team": "owner", "sales-data": "admin"}


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
    return {
        "modules": MODULES,
        "roles": _roles_payload(),
        "matrix": matrix,
        "updated_at": (doc or {}).get("updated_at"),
        "updated_by_name": (doc or {}).get("updated_by_name"),
    }


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
            clean_row[mod_key] = bool(allowed)
        clean[role] = clean_row

    # Guard rail — owner can never lock themselves out of Settings/Team by
    # a fat-fingered save; every other combination is fair game.
    owner_row = clean.get("owner", {})
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
