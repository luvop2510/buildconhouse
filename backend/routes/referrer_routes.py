import asyncio
import re

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import accessible_floor_ids, floor_for_write, floor_query, get_floor_scoped_or_404, require_min_role
from db import db
from models import Referrer, ReferrerCreate, ReferrerUpdate, ReferrerType, UserPublic, now_iso
from services.referrer_identity import referrer_query
from services.analytics.filters import AnalyticsFilter, FloorAccessError, build_match

router = APIRouter(tags=["referrers"])


@router.get("/referrers/page")
async def referrers_page(
    floor_id: str | None = None,
    type: ReferrerType | None = None,
    search: str = Query("", max_length=200),
    offset: int = Query(0, ge=0),
    limit: int = Query(25, ge=1, le=50),
    user: UserPublic = Depends(require_min_role("sales")),
):
    floor_for_write(user)
    try:
        scope = (build_match(AnalyticsFilter(floor_id=floor_id, status="any"), accessible_floor_ids(user), (None, None))
                 if floor_id else floor_query(user))
    except FloorAccessError as exc:
        raise HTTPException(403, "You do not have access to this floor") from exc
    query = referrer_query(scope, {"active": {"$ne": False}, **({"type": type} if type else {})})
    if search.strip():
        term = re.escape(search.strip())
        query = {"$and": [query, {"$or": [
            *[{field: {"$regex": term, "$options": "i"}} for field in ("name", "company", "phone")],
            {"$expr": {"$regexMatch": {"input": {"$concat": [
                {"$cond": [{"$eq": ["$type", "architect"]}, "ARC-", "INT-"]}, {"$toUpper": "$id"},
            ]}, "regex": term, "options": "i"}}},
        ]}]}
    docs, total = await asyncio.gather(
        db.referrers.find(query, {"_id": 0}).sort([("name", 1), ("id", 1)]).skip(offset).limit(limit).to_list(limit),
        db.referrers.count_documents(query),
    )
    return {"rows": [Referrer(**doc) for doc in docs], "total": total, "offset": offset, "limit": limit}


@router.get("/referrers", response_model=list[Referrer])
async def list_referrers(
    type: ReferrerType | None = Query(None),
    include_inactive: bool = Query(False),
    user: UserPublic = Depends(require_min_role("sales")),
    include_counts: bool = False,
):
    floor_for_write(user)
    scope_query = floor_query(user)
    query = referrer_query(scope_query)
    if type:
        query["type"] = type
    docs = await db.referrers.find(query, {"_id": 0}).sort("name", 1).to_list(2000)
    if include_counts:
        scope = scope_query.get("floor_id")
        floors = [scope] if isinstance(scope, str) else (scope.get("$in") if isinstance(scope, dict) else accessible_floor_ids(user))
        from services.referrer_identity import acquired_counts
        counts = await acquired_counts(db, [d["id"] for d in docs], floors)
        docs = [{**d, "customers_acquired": counts.get(d["id"], 0)} for d in docs]
    return [Referrer(**d) for d in docs if include_inactive or d.get("active") is not False]


@router.post("/referrers", response_model=Referrer)
async def create_referrer(
    body: ReferrerCreate,
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Case-insensitive existing-name check (same type) before inserting.
    Two sales reps could otherwise create "Rakesh Sharma" and "rakesh
    sharma" as separate people, permanently splitting that person's revenue
    on the Sales Data dashboard with no way to merge (v1 has no
    update/delete). Rather than rejecting the duplicate, return the
    pre-existing record — the picker's "+ Add new" flow expects a
    successful create-or-select response, so this lets the frontend proceed
    exactly as if it had created one. Same name but a different type (e.g.
    an architect and an interior designer sharing a name) still creates a
    separate record."""
    normalized_name = body.name.strip().casefold()
    if not normalized_name:
        raise HTTPException(status_code=400, detail="Referrer name is required")
    floor_id = floor_for_write(user)
    existing = await db.referrers.find(
        referrer_query({"floor_id": floor_id}, {"type": body.type}), {"_id": 0},
    ).to_list(2000)
    for doc in existing:
        if doc.get("normalized_name") == normalized_name or doc.get("name", "").strip().casefold() == normalized_name:
            return Referrer(**doc)

    values = body.model_dump()
    values["name"] = body.name.strip()
    referrer = Referrer(**values, normalized_name=normalized_name, floor_id=floor_id, shared_across_floors=True, created_by=user.id)
    await db.referrers.insert_one(referrer.model_dump())
    return referrer


@router.patch("/referrers/{referrer_id}", response_model=Referrer)
async def archive_referrer(
    referrer_id: str,
    active: bool,
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Archive instead of deleting a directory entry with historical quotes."""
    referrer = await get_floor_scoped_or_404(
        db.referrers, referrer_id, user, not_found="Referrer not found", projection={"_id": 0},
    )
    if referrer.get("shared_across_floors") and user.role != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can archive a shared reference")
    selector = {"id": referrer_id, "floor_id": referrer["floor_id"]}
    await db.referrers.update_one(selector, {"$set": {"active": active}})
    doc = await db.referrers.find_one(selector, {"_id": 0})
    return Referrer(**doc)


@router.put('/referrers/{referrer_id}', response_model=Referrer)
async def update_referrer(referrer_id: str, body: ReferrerUpdate, user: UserPublic = Depends(require_min_role('sales'))):
    if user.role != 'owner':
        raise HTTPException(status_code=403, detail='Only the owner can edit shared reference details')
    referrer = await db.referrers.find_one(referrer_query(floor_query(user), {"id": referrer_id}), {"_id": 0})
    if not referrer:
        raise HTTPException(status_code=404, detail="Referrer not found")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail='Referrer name is required')
    if body.type != referrer['type']:
        raise HTTPException(status_code=400, detail='The reference type cannot change after creation')
    values = body.model_dump(exclude={'updated_at'})
    values.update(name=name, normalized_name=name.casefold(), updated_at=now_iso(), updated_by=user.id)
    result = await db.referrers.update_one({'id': referrer_id, 'floor_id': referrer['floor_id'], 'updated_at': body.updated_at}, {'$set': values})
    if result.matched_count != 1:
        raise HTTPException(status_code=409, detail='This reference changed. Reload it before saving your edits.')
    return Referrer(**{**referrer, **values})
