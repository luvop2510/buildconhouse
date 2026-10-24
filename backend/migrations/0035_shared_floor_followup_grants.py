"""Preserve shared Follow-ups access when both department notebooks retire.

Only active custom staff with BOTH same-floor notebook view grants and existing
Customer view access qualify. A single-stage allocation remains fail-closed.
Update requires both notebook updates; create additionally requires the old
notebook AND regular Walk-ins create permissions. Never add export/delete,
another floor, or replace/extend any existing Follow-ups allocation. The new
grant expires at the earliest contributing grant expiry. Existing grants and
business data remain intact. Deterministic identities and user-snapshot CAS
make a retry additive and prevent concurrent Team changes from being overwritten.
Legacy separate-collection grants are reported for manual review and are never
promoted automatically: they cannot share the user's atomic snapshot guard.
"""
from collections import Counter
from datetime import datetime, timezone
from uuid import NAMESPACE_URL, uuid5

from auth import profile_floor_ids
from services.access_grants import grant_allows, grant_is_valid, is_expired, resource_supports


MIGRATION = "0035_shared_floor_followup_grants"
FLOORS = ("second-floor", "third-floor")
USER_QUERY = {"custom_access": True, "active": {"$ne": False}, "role": {"$ne": "owner"},
              "is_deleted": {"$ne": True}, "deleted_at": None}
USER_PROJECTION = {"_id": 0, "id": 1, "role": 1, "floor_ids": 1, "access_profile": 1,
                   "custom_access": 1, "active": 1, "is_deleted": 1, "deleted_at": 1, "delegation_grants": 1}


def derive_grants(user, source_grants, *, now):
    """Build an additive least-capability plan without database writes."""
    if not user.get("custom_access") or user.get("role") == "owner" or not user.get("active", True) or user.get("is_deleted") or user.get("deleted_at"):
        return []
    profile = user.get("access_profile")
    floors = profile_floor_ids(profile) if profile is not None else user.get("floor_ids", [])
    if not isinstance(source_grants, list) or not isinstance(floors, list):
        return []
    snapshot = "delegation_grants" in user
    valid = [g for g in source_grants if isinstance(g, dict) and grant_is_valid(g) and not is_expired(g.get("expires_at"), now=now)
             and g["user_id"] == user["id"] and (g.get("floor_id") in floors or not snapshot and g.get("floor_id") is None)
             and (not snapshot or "view" in g["actions"])
             and (g.get("floor_id") is None or resource_supports(g["resource"], g["floor_id"], g["actions"]))]
    additions = []
    for floor in FLOORS:
        if floor not in floors:
            continue
        # Existing (even expired) allocations represent an explicit owner
        # decision. Do not overwrite them or silently restore removed actions.
        if any(isinstance(g, dict) and g.get("resource") == "followups" and g.get("floor_id") in (floor, None) for g in source_grants):
            continue
        def permitted(resource, action):
            return any(grant_allows(g, user_id=user["id"], resource=resource, action=action, floor_id=floor, now=now)
                       and (resource not in {"notebook_walkins", "notebook_quotations"} or g.get("floor_id") == floor) for g in valid)
        if not all(permitted(resource, "view") for resource in ("notebook_walkins", "notebook_quotations", "customers")):
            continue
        actions = ["view"]
        if all(permitted(resource, "update") for resource in ("notebook_walkins", "notebook_quotations")):
            actions.append("update")
        if all(permitted(resource, "create") for resource in ("notebook_walkins", "walkins")):
            actions.append("create")
        resources = {"notebook_walkins", "notebook_quotations", "customers"} | ({"walkins"} if "create" in actions else set())
        contributors = [g for g in valid if g["resource"] in resources and g.get("floor_id") in (floor, None)]
        expiries = [datetime.fromisoformat(g["expires_at"].replace("Z", "+00:00")) for g in contributors if g.get("expires_at")]
        timestamp = now.isoformat()
        additions.append({
            "id": str(uuid5(NAMESPACE_URL, f"{MIGRATION}:{user['id']}:{floor}")), "user_id": user["id"],
            "resource": "followups", "floor_id": floor, "actions": actions,
            "expires_at": min(expiries).isoformat() if expiries else None,
            "created_at": timestamp, "updated_at": timestamp,
            "created_by": f"migration:{MIGRATION}", "updated_by": f"migration:{MIGRATION}",
            "created_by_name": "Shared floor follow-ups migration", "updated_by_name": "Shared floor follow-ups migration",
            "migration": MIGRATION,
        })
    return additions


async def _plans(db):
    now = datetime.now(timezone.utc)
    active_floors = {row["id"] async for row in db.floors.find({"id": {"$in": list(FLOORS)}, "active": {"$ne": False}}, {"_id": 0, "id": 1})}
    async for user in db.users.find(USER_QUERY, USER_PROJECTION):
        grants = user.get("delegation_grants") if "delegation_grants" in user else await db.access_grants.find({"user_id": user["id"]}, {"_id": 0}).to_list(500)
        additions = [g for g in derive_grants(user, grants, now=now) if g["floor_id"] in active_floors]
        yield user, grants, additions


async def audit(db):
    """Read-only preflight; output only aggregate floors/actions and counts."""
    counts = Counter()
    single_stage = Counter()
    legacy_storage = Counter()
    async for user, grants, additions in _plans(db):
        for grant in additions:
            if "delegation_grants" in user:
                counts[(grant["floor_id"], tuple(grant["actions"]))] += 1
            else:
                legacy_storage[grant["floor_id"]] += 1
        for floor in FLOORS:
            resources = {g.get("resource") for g in grants or [] if isinstance(g, dict) and grant_is_valid(g)
                         and g.get("user_id") == user["id"] and g.get("floor_id") == floor
                         and "view" in g["actions"] and not is_expired(g.get("expires_at"))}
            if len(resources & {"notebook_walkins", "notebook_quotations"}) == 1:
                single_stage[floor] += 1
    return {"planned_grants": [{"floor_id": floor, "actions": list(actions), "count": count} for (floor, actions), count in sorted(counts.items())],
            "single_stage_allocations_unchanged": dict(single_stage),
            "legacy_collection_allocations_unchanged": dict(legacy_storage)}


async def up(db):
    async for user, _grants, additions in _plans(db):
        if not additions or "delegation_grants" not in user:
            continue
        result = await db.users.update_one({**USER_QUERY, "id": user["id"], "floor_ids": user.get("floor_ids", []),
                                            "access_profile": user.get("access_profile"), "delegation_grants": user["delegation_grants"]},
                                           {"$push": {"delegation_grants": {"$each": additions}}})
        if not result.matched_count:
            raise RuntimeError("Team permissions changed during the shared Follow-ups migration; rerun the controlled job")
