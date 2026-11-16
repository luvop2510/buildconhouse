"""Interest labels are metadata; operational fan-out retains its own grants.

Only active floor IDs/names may cross the intake boundary. A foreign interest
never authorizes reading customers, workers, notebooks or creating a sibling.
"""
from fastapi import HTTPException

from auth import accessible_floor_ids, profile_floor_ids, require_floor_access
from services.access_grants import grant_allows, grants_for_user


async def require_intake(database, user, source_floor):
    require_floor_access(source_floor, user)
    if user.custom_access and user.role != "owner":
        grants = await grants_for_user(database, user.id)
        if not any(grant_allows(grant, user_id=user.id, resource="walkins", action="create", floor_id=source_floor) for grant in grants):
            raise HTTPException(403, "Walk-in creation is not permitted on this floor")


async def floor_options(database):
    rows = await database.floors.find({"active": {"$ne": False}}, {"_id": 0, "id": 1, "name": 1}).sort([("name", 1), ("id", 1)]).limit(101).to_list(101)
    if len(rows) > 100:
        raise HTTPException(413, "Interested-floor options exceed their supported bound")
    return [{"id": row["id"], "name": row["name"]} for row in rows]


async def plan(database, user, floor_ids, source_floor, assignments=None):
    require_floor_access(source_floor, user)
    interests = list(dict.fromkeys(floor_ids))
    if not interests or len(interests) > 20:
        raise HTTPException(422, "Choose between one and twenty interested floors")
    existing = await database.floors.find({"id": {"$in": interests}, "active": {"$ne": False}}, {"_id": 0, "id": 1}).to_list(20)
    if set(interests) != {row["id"] for row in existing}:
        raise HTTPException(422, "A selected floor is unavailable")
    # Current source authorization is already enforced by the Walk-in route.
    # Foreign routing still needs the existing destination follow-up grant.
    if user.custom_access and user.role != "owner":
        permitted = profile_floor_ids(user.access_profile)
        permitted = permitted if permitted is not None else user.floor_ids
        grants = await grants_for_user(database, user.id)
    else:
        permitted = accessible_floor_ids(user)
        grants = []
    routed = [source_floor]
    for floor in interests:
        if floor == source_floor or permitted is not None and floor not in permitted:
            continue
        if user.custom_access and user.role != "owner":
            # Existing lead_scope revalidates the actual destination stage
            # before writing. Do not read foreign contacts to discover it here.
            resources = ("followups", "notebook_walkins") if floor in {"second-floor", "third-floor"} else ("followups",)
            if not any(all(any(grant_allows(grant, user_id=user.id, resource=resource, action=action, floor_id=floor)
                              for grant in grants) for action in ("view", "update")) for resource in resources):
                continue
        routed.append(floor)
    for item in assignments or []:
        floor = item.floor_id if hasattr(item, "floor_id") else item["floor_id"]
        if floor not in routed:
            raise HTTPException(403, "Team assignments require access to that floor; its interest can be recorded without an assignment")
    return interests, routed
