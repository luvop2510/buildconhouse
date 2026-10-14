"""Manage atomic, default-deny floor/page assignments for team members."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import get_current_user, invalidate_principal_cache, require_owner, revoke_all_sessions
from db import db
from models import UserPublic
from services.access_grants import (
    ACTIONS, ACTION_DESCRIPTIONS, RESOURCE_REGISTRY, build_delegation_snapshot,
    build_grant, grants_for_user, is_expired,
    is_valid_resource, normalized_actions, resource_supports, utc_now_iso,
)

router = APIRouter(prefix="/settings/access-grants", tags=["settings", "access grants"])


class AccessGrantInput(BaseModel):
    resource: str
    actions: list[Literal["view", "create", "update", "delete", "export"]] = Field(min_length=1)
    floor_id: str | None = None
    expires_at: str | None = None


class DelegationInput(BaseModel):
    floor_ids: list[str] = Field(max_length=50)
    grants: list[AccessGrantInput] = Field(max_length=500)


def _validate_input(body: AccessGrantInput) -> list[str]:
    actions = normalized_actions(body.actions)
    if not is_valid_resource(body.resource) or actions is None:
        raise HTTPException(status_code=422, detail="Invalid access-grant resource or actions")
    if body.floor_id is not None and not body.floor_id.strip():
        raise HTTPException(status_code=422, detail="floor_id must be a non-empty string or null")
    if body.expires_at is not None and is_expired(body.expires_at):
        raise HTTPException(status_code=422, detail="expires_at must be a valid future ISO-8601 timestamp")
    return actions


async def _target_user_or_404(user_id: str) -> dict:
    target = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not target or target.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Team member not found")
    return target


async def _assert_can_manage_target(actor: UserPublic, target: dict, *, mutation: bool = False) -> None:
    require_owner(actor)
    if mutation and target.get("role") == "owner":
        raise HTTPException(status_code=422, detail="Owners have full access; delegate pages to staff accounts")


async def _validate_floor(floor_id: str | None) -> None:
    if floor_id is None:
        return
    if not await db.floors.find_one({"id": floor_id, "active": {"$ne": False}}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=422, detail="floor_id must refer to an active floor")


async def _revoke_grant_subject(user_id: str) -> None:
    # Grant state is authorization state. Revoke every active device so stale
    # sessions cannot continue after an owner removes or narrows a grant.
    invalidate_principal_cache("staff", user_id)
    await revoke_all_sessions("staff", user_id)


@router.get("/resources")
async def list_grant_resources(actor: UserPublic = Depends(require_owner)):
    require_owner(actor)
    floors = await db.floors.find({"active": {"$ne": False}}, {"_id": 0, "id": 1}).to_list(50)
    floor_ids = [floor["id"] for floor in floors]
    return {
        "resources": [
            {"key": key, "label": value["label"], "retired": value.get("retired", False), "actions": value.get("actions", sorted(ACTIONS)),
             "floor_ids": [floor for floor in floor_ids if not value.get("floor_ids") or floor in value["floor_ids"]],
             "description": value.get("description", f"Manage {value['label'].lower()} records on this floor.")}
            for key, value in RESOURCE_REGISTRY.items() if key != "reports"
        ],
        "action_descriptions": ACTION_DESCRIPTIONS,
    }


@router.get("/me")
async def my_access_grants(user: UserPublic = Depends(get_current_user)):
    """The caller's grants, for an honest client shell; API enforcement remains server-side."""
    return {"user_id": user.id, "grants": await grants_for_user(db, user.id)}


@router.get("/{user_id}")
async def list_access_grants(user_id: str, actor: UserPublic = Depends(require_owner)):
    require_owner(actor)
    target = await _target_user_or_404(user_id)
    await _assert_can_manage_target(actor, target)
    return {"user_id": user_id, "floor_ids": target.get("floor_ids", []),
            "custom_access": bool(target.get("custom_access")), "grants": await grants_for_user(db, user_id)}


@router.put("/{user_id}")
async def replace_access_grants(user_id: str, body: DelegationInput, actor: UserPublic = Depends(require_owner)):
    require_owner(actor)
    target = await _target_user_or_404(user_id)
    await _assert_can_manage_target(actor, target, mutation=True)
    if any(grant.expires_at is not None for grant in body.grants):
        raise HTTPException(status_code=422, detail="Floor/page toggles use ongoing access; assign expiries individually")
    snapshot = await build_delegation_snapshot(
        db, user_id=user_id, floor_ids=body.floor_ids,
        grants=[grant.model_dump() for grant in body.grants], actor_id=actor.id, actor_name=actor.full_name,
    )
    # One Mongo document write commits the enabled floors and every page at
    # once. Empty snapshots retain custom mode and therefore deny everything.
    await db.users.update_one({"id": user_id}, {"$set": {
        "floor_ids": body.floor_ids, "delegation_grants": snapshot, "custom_access": True,
        "access_profile": None, "updated_at": utc_now_iso(),
    }})
    await _revoke_grant_subject(user_id)
    return {"user_id": user_id, "floor_ids": body.floor_ids, "custom_access": True, "grants": snapshot}


@router.post("/{user_id}", status_code=201)
async def create_access_grant(
    user_id: str, body: AccessGrantInput, actor: UserPublic = Depends(require_owner),
):
    require_owner(actor)
    target = await _target_user_or_404(user_id)
    await _assert_can_manage_target(actor, target, mutation=True)
    actions = _validate_input(body)
    await _validate_floor(body.floor_id)
    if body.floor_id not in target.get("floor_ids", []) or not resource_supports(body.resource, body.floor_id, actions) or "view" not in actions:
        raise HTTPException(status_code=422, detail="Enable a supported floor/page before assigning its actions, including view")
    current = await grants_for_user(db, user_id)
    existing = next((grant for grant in current if grant["resource"] == body.resource and grant.get("floor_id") == body.floor_id), None)
    grant = build_grant(
        user_id=user_id, resource=body.resource, actions=actions, floor_id=body.floor_id,
        expires_at=body.expires_at, actor_id=actor.id, actor_name=actor.full_name,
        grant_id=(existing or {}).get("id"), created_at=(existing or {}).get("created_at"),
    )
    if existing:
        for key in ("created_by", "created_by_name"):
            if key in existing:
                grant[key] = existing[key]
    snapshot = [row for row in current if row.get("id") != grant["id"]] + [grant]
    # A user with one or more grants is deliberately in custom-access mode.
    # Their next sign-in token carries this state and the server middleware
    # applies the grants as a default-deny allow-list.
    await db.users.update_one({"id": user_id}, {"$set": {"custom_access": True, "access_profile": None,
        "delegation_grants": snapshot, "updated_at": utc_now_iso()}})
    await _revoke_grant_subject(user_id)
    grant.pop("_id", None)
    return grant


@router.delete("/{user_id}/{grant_id}")
async def delete_access_grant(
    user_id: str, grant_id: str, actor: UserPublic = Depends(require_owner),
):
    require_owner(actor)
    target = await _target_user_or_404(user_id)
    await _assert_can_manage_target(actor, target, mutation=True)
    current = await grants_for_user(db, user_id)
    snapshot = [row for row in current if row.get("id") != grant_id]
    if len(snapshot) == len(current):
        raise HTTPException(status_code=404, detail="Access grant not found")
    await db.users.update_one({"id": user_id}, {"$set": {"custom_access": True, "delegation_grants": snapshot,
        "access_profile": None, "updated_at": utc_now_iso()}})
    await _revoke_grant_subject(user_id)
    return {"deleted": True, "id": grant_id}
