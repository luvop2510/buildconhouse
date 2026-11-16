"""Fresh, owner-configured customer deletion permission using Team & Roles."""
from fastapi import HTTPException

from services.access_grants import grant_allows, grants_for_user

RESOURCE = "customer_delete"
ROLE_PERMISSION = "delete-customers"
FLOORS = {"ground-floor", "first-floor", "second-floor", "third-floor"}


async def require_customer_delete(database, user, floor_id):
    from auth import accessible_floor_ids
    if floor_id not in FLOORS:
        raise HTTPException(403, "Select a department before deleting a customer")
    principal = await database.users.find_one({"id": user.id},
        {"id": 1, "role": 1, "floor_ids": 1, "access_profile": 1, "custom_access": 1,
         "active": 1, "deleted_at": 1, "is_deleted": 1})
    if not principal or principal.get("active") is False or principal.get("deleted_at") or principal.get("is_deleted"):
        raise HTTPException(403, "This account is no longer permitted to delete customers")
    # UserPublic is request-local, while its authentication snapshot may have
    # been cached. Keep subsequent stage/graph checks on this same fresh identity.
    # Preserve the selected floor and private request restrictions: fresh floor
    # assignments are intersected with those restrictions by accessible_floor_ids.
    for key, default in (("role", "worker"), ("floor_ids", []), ("access_profile", None), ("custom_access", False)):
        setattr(user, key, principal.get(key, default))
    floors = accessible_floor_ids(user)
    if floors is not None and floor_id not in floors:
        raise HTTPException(403, "Customer deletion requires access to this department")
    if user.role == "owner":
        return
    grants = await grants_for_user(database, user.id)
    resources = [RESOURCE, *(["kitchen_customer_delete"] if floor_id == "second-floor" else [])]
    if any(grant_allows(grant, user_id=user.id, resource=resource, action="delete", floor_id=floor_id)
           for grant in grants for resource in resources):
        return
    # Custom accounts have explicit capabilities; a role cannot silently widen them.
    if not user.custom_access:
        policy = await database.settings.find_one({"key": "permission_matrix"}, {"_id": 0})
        if (policy or {}).get("overrides", {}).get(user.role, {}).get(ROLE_PERMISSION) is True:
            return
    raise HTTPException(403, "The owner must enable Delete Customers for your account or role")
