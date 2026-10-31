"""Contact-only discovery and explicit Ground profile reuse for tile builders."""
import asyncio
import re
from uuid import NAMESPACE_URL, uuid5
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Literal
from auth import accessible_floor_ids, authorize_staff_resource, get_current_user, require_floor_access
from db import db
from models import CustomerPublic, UserPublic

router = APIRouter(prefix="/quotations/customer-sources", tags=["quotations"])
SOURCES = {"customer": ("customers", "name", "phone"), "walkin": ("walkins", "customer_name", "customer_phone"), "followup": ("followups", "customer_name", "customer_phone")}
PROFILE_FIELDS = ("name", "phone", "address", "referrer_id", "referrer_name", "referrer_type", "referrer_company")
FIELDS = {"_id": 0, **{k: 1 for k in ("id", "floor_id", "customer_id", "name", "customer_name", "phone", "customer_phone", "address", "referrer_id", "referrer_name", "referrer_type", "referrer_company")}}

async def scopes(user):
    require_floor_access("ground-floor", user)
    account = user.model_copy(deep=True)
    # Re-evaluate source grants rather than inheriting the tile request grant.
    account.__dict__.pop("_custom_grant_floor_ids", None)
    floors = accessible_floor_ids(account)
    if floors is None:
        floors = [r["id"] for r in await db.floors.find({}, {"_id": 0, "id": 1}).to_list(100)]
    allowed = []
    for floor in floors:
        for kind, (collection, _, _) in SOURCES.items():
            try:
                await authorize_staff_resource(account, method="GET", path=f"/api/{collection}", floor_id=floor)
            except HTTPException as exc:
                if exc.status_code == 403: continue
                raise
            allowed.append((kind, floor))
    return allowed

def contact(kind, row):
    _, name, phone = SOURCES[kind]
    return {"source_kind": kind, "source_id": row["id"], "floor_id": row["floor_id"],
            **{k: row.get(k) for k in ("customer_id", "address", "referrer_id", "referrer_name", "referrer_type", "referrer_company")},
            "name": row.get(name) or "", "phone": row.get(phone) or ""}

@router.get("")
async def search_sources(search: str = Query("", max_length=200), skip: int = Query(0, ge=0, le=10000), limit: int = Query(20, ge=1, le=50), user: UserPublic = Depends(get_current_user)):
    allowed = await scopes(user)
    async def read(kind):
        collection, name, phone = SOURCES[kind]
        floors = [floor for k, floor in allowed if k == kind]
        if not floors: return []
        query = {"floor_id": {"$in": floors}, "is_deleted": {"$ne": True}}
        if search.strip(): query["$or"] = [{field: {"$regex": re.escape(search.strip()), "$options": "i"}} for field in (name, phone)]
        rows = await getattr(db, collection).find(query, FIELDS).sort("id", 1).limit(skip + limit + 1).to_list(skip + limit + 1)
        return [contact(kind, row) for row in rows if row.get("id") and row.get(name)]
    groups = await asyncio.gather(*(read(kind) for kind in SOURCES))
    rows = sorted([r for group in groups for r in group], key=lambda r: (r["source_kind"], r["source_id"]))
    page = rows[skip:skip + limit]
    return {"items": page, "has_more": len(rows) > skip + limit, "next_skip": skip + len(page)}

class Reuse(BaseModel):
    source_kind: Literal["customer", "walkin", "followup"]
    source_id: str

@router.post("/reuse")
async def reuse_source(body: Reuse, user: UserPublic = Depends(get_current_user)):
    await authorize_staff_resource(user, method="POST", path="/api/quotations", floor_id="ground-floor")
    allowed = await scopes(user)
    collection, _, _ = SOURCES[body.source_kind]
    source = await getattr(db, collection).find_one({"id": body.source_id, "floor_id": {"$in": [f for k, f in allowed if k == body.source_kind]}, "is_deleted": {"$ne": True}}, FIELDS)
    if not source: raise HTTPException(404, "Selected person is unavailable")
    value = contact(body.source_kind, source)
    linked = source.get("id") if body.source_kind == "customer" else source.get("customer_id")
    target = await db.customers.find_one({"id": linked, "floor_id": "ground-floor"}, {"_id": 0, "password_hash": 0}) if linked else None
    if linked and source.get("floor_id") != "ground-floor":
        try:
            await authorize_staff_resource(user, method="GET", path="/api/customers", floor_id=source["floor_id"])
            profile = await db.customers.find_one({"id": linked, "floor_id": source["floor_id"]}, FIELDS)
            if profile:
                value = {**value, **{k: profile[k] for k in PROFILE_FIELDS if profile.get(k)}}
        except HTTPException as exc:
            if exc.status_code != 403: raise
    digits = re.sub(r"\D", "", value["phone"])
    if len(digits) == 12 and digits.startswith("91"): digits = digits[2:]
    if target is None and len(digits) == 10:
        phone_pattern = r"\D*".join(map(re.escape, digits))
        target = await db.customers.find_one({"floor_id": "ground-floor", "phone": {"$regex": r"^(?:\+?91\D*)?" + phone_pattern + r"\D*$"}}, {"_id": 0, "password_hash": 0})
    created = target is None
    if target is None:
        identity = digits if len(digits) == 10 else f"{body.source_kind}:{body.source_id}"
        cid = str(uuid5(NAMESPACE_URL, "tile-reuse:" + identity))
        profile = CustomerPublic(id=cid, floor_id="ground-floor", **{k: value.get(k) for k in PROFILE_FIELDS})
        record = profile.model_dump(exclude={"email"})
        await db.customers.update_one({"id": cid, "floor_id": "ground-floor"}, {"$setOnInsert": record}, upsert=True)
        target = await db.customers.find_one({"id": cid, "floor_id": "ground-floor"}, {"_id": 0, "password_hash": 0})
    return {"customer": CustomerPublic(**target), "created": created}
