"""Referrer directory — architects & interior designers who refer business.
Minimal CRUD: list (used by the quotation builder's picker and the Sales
Data dashboard) and create (inline quick-add from that same picker). No
update/delete for v1 — see
docs/superpowers/specs/2026-07-27-sales-data-dashboard-design.md."""
from fastapi import APIRouter, Depends, HTTPException, Query

from auth import accessible_floor_ids, floor_for_write, floor_query, get_floor_scoped_or_404, require_min_role
from db import db
from models import Referrer, ReferrerCreate, ReferrerType, UserPublic

router = APIRouter(tags=["referrers"])


@router.get("/referrers", response_model=list[Referrer])
async def list_referrers(
    type: ReferrerType | None = Query(None),
    include_inactive: bool = Query(False),
    user: UserPublic = Depends(require_min_role("sales")),
    include_counts: bool = False,
):
    query: dict = floor_query(user)
    if type:
        query["type"] = type
    docs = await db.referrers.find(query, {"_id": 0}).sort("name", 1).to_list(2000)
    if include_counts:
        scope = query.get("floor_id")
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
        {"floor_id": floor_id, "type": body.type}, {"_id": 0},
    ).to_list(2000)
    for doc in existing:
        if doc.get("normalized_name") == normalized_name or doc.get("name", "").strip().casefold() == normalized_name:
            return Referrer(**doc)

    values = body.model_dump()
    values["name"] = body.name.strip()
    referrer = Referrer(**values, normalized_name=normalized_name, floor_id=floor_id, created_by=user.id)
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
    selector = {"id": referrer_id, "floor_id": referrer["floor_id"]}
    await db.referrers.update_one(selector, {"$set": {"active": active}})
    doc = await db.referrers.find_one(selector, {"_id": 0})
    return Referrer(**doc)
