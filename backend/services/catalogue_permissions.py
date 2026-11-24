"""Department-scoped capabilities for the Catalogue Management workspace."""
from fastapi import HTTPException

from auth import accessible_floor_ids
from services.access_grants import CATALOGUE_CAPABILITIES as CAPABILITIES, CATALOGUE_FLOORS as FLOORS, grant_allows, grants_for_user

OPERATION_PERMISSIONS = {
    "add": ("catalogue_bulk", "catalogue_products_add"),
    "update": ("catalogue_bulk", "catalogue_products_edit"),
    "sync": ("catalogue_bulk", "catalogue_products_add", "catalogue_products_edit"),
    "prices": ("catalogue_prices",),
    "images": ("catalogue_images",),
}


async def capabilities(database, actor_id: str, floor_id: str) -> set[str]:
    from models import UserPublic

    principal = await database.users.find_one({"id": actor_id}, {"_id": 0, **dict.fromkeys(
        ("id", "email", "full_name", "role", "floor_ids", "access_profile", "custom_access", "active", "deleted_at", "is_deleted"), 1,
    )})
    if not principal or principal.get("active") is False or principal.get("deleted_at") or principal.get("is_deleted"):
        return set()
    user = UserPublic(**principal)
    permitted = accessible_floor_ids(user)
    if floor_id not in FLOORS or (permitted is not None and floor_id not in permitted):
        return set()
    if user.role == "owner":
        return set(CAPABILITIES)
    grants = await grants_for_user(database, actor_id)
    return {
        resource for resource, (_, action) in CAPABILITIES.items()
        if any(grant.get("floor_id") == floor_id and grant_allows(
            grant, user_id=actor_id, resource=resource, action=action, floor_id=floor_id,
        ) for grant in grants)
    }


async def require_capabilities(database, actor_id: str, floor_id: str, *required: str) -> set[str]:
    granted = await capabilities(database, actor_id, floor_id)
    if not set(required) <= granted:
        raise HTTPException(403, "Catalogue Management permission is required for this department.")
    return granted
