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
FIELDS = {"_id": 0, **{k: 1 for k in ("id", "floor_id", "customer_id", "name", "customer_name", "phone", "customer_phone", "address", "referrer_id", "referrer_name", "referrer_type", "referrer_company", "reference_source", "assigned_to_name")}}

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
            **{k: row.get(k) for k in ("customer_id", "address", "referrer_id", "referrer_name", "referrer_type", "referrer_company", "reference_source")},
            "name": row.get(name) or "", "phone": row.get(phone) or ""}

def _phone_digits(row):
    digits = re.sub(r"\D", "", row.get("phone") or "")
    return digits[2:] if len(digits) == 12 and digits.startswith("91") else digits

def _address_key(row):
    return re.sub(r"\s+", " ", str(row.get("address") or "").strip().casefold())

def identity_keys(row, conflicting_phone_addresses=None):
    """Match the same person across source records without merging namesakes."""
    digits = _phone_digits(row)
    keys = set()
    if len(digits) == 10:
        address = _address_key(row)
        if digits in (conflicting_phone_addresses or set()):
            if address:
                keys.add(("phone_address", digits, address))
        else:
            keys.add(("phone", digits))
    linked = row["source_id"] if row["source_kind"] == "customer" else row.get("customer_id")
    if linked:
        keys.add(("customer", linked))
    return keys

async def placed_customer_ids(candidates, allowed):
    ids = list({row.get("source_id") if row["source_kind"] == "customer" else row.get("customer_id") for row in candidates} - {None, ""})
    if not ids:
        return set()
    scope = {"floor_id": {"$in": list({floor for _, floor in allowed})}, "customer_id": {"$in": ids}}
    quotes, orders = await asyncio.gather(
        db.quotations.distinct("customer_id", {**scope, "status": "ordered"}),
        db.customer_orders.distinct("customer_id", {**scope, "is_deleted": {"$ne": True}}),
    )
    return set(quotes + orders)

@router.get("")
async def search_sources(search: str = Query("", max_length=200), skip: int = Query(0, ge=0, le=10000), limit: int = Query(20, ge=1, le=50), user: UserPublic = Depends(get_current_user)):
    allowed = await scopes(user)
    excluded = await db.customers.distinct("id", {"floor_id": {"$in": list({floor for _, floor in allowed})}, "exclude_from_tile_customer_lookup": True})
    # Read the complete bounded result set before grouping. A later follow-up
    # can bridge two earlier records by customer ID and phone, so paginating
    # before resolving those links would show the same person on multiple pages.
    async def read(kind):
        collection, name, phone = SOURCES[kind]
        floors = [floor for k, floor in allowed if k == kind]
        if not floors:
            return []
        query = {"floor_id": {"$in": floors}, "is_deleted": {"$ne": True}, "exclude_from_tile_customer_lookup": {"$ne": True}}
        if excluded:
            query["id" if kind == "customer" else "customer_id"] = {"$nin": excluded}
        if search.strip():
            query["$or"] = [{field: {"$regex": re.escape(search.strip()), "$options": "i"}} for field in (name, phone)]
        # A sentinel prevents silently returning incomplete identity groups.
        batch = await getattr(db, collection).find(query, FIELDS).sort("id", 1).limit(1001).to_list(1001)
        if len(batch) > 1000:
            raise HTTPException(422, "Too many matching records. Refine the customer search.")
        return [contact(kind, raw) for raw in batch if raw.get("id") and raw.get(name)]

    groups = await asyncio.gather(*(read(kind) for kind in sorted(SOURCES)))
    candidates = [row for group in groups for row in group]
    ordered_ids = await placed_customer_ids(candidates, allowed)

    phone_addresses = {}
    for row in candidates:
        digits, address = _phone_digits(row), _address_key(row)
        if len(digits) == 10 and address:
            phone_addresses.setdefault(digits, set()).add(address)
    conflicting = {digits for digits, addresses in phone_addresses.items() if len(addresses) > 1}

    # Keep the most useful authorized source: Ground customer first, then
    # other customers, followed by follow-ups and walk-ins. No profile is merged.
    candidates.sort(key=lambda row: (row["source_kind"] != "customer", row["floor_id"] != "ground-floor", (row["source_id"] if row["source_kind"] == "customer" else row.get("customer_id")) not in ordered_ids, row["source_kind"], row["source_id"]))
    parent = list(range(len(candidates)))
    key_owner = {}
    def root(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index
    for index, row in enumerate(candidates):
        for key in identity_keys(row, conflicting):
            previous = key_owner.get(key)
            if previous is not None:
                first, second = root(index), root(previous)
                parent[max(first, second)] = min(first, second)
            else:
                key_owner[key] = index
    rows = [row for index, row in enumerate(candidates) if root(index) == index]

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
    source = await getattr(db, collection).find_one({"id": body.source_id, "floor_id": {"$in": [f for k, f in allowed if k == body.source_kind]}, "is_deleted": {"$ne": True}, "exclude_from_tile_customer_lookup": {"$ne": True}}, FIELDS)
    if not source: raise HTTPException(404, "Selected person is unavailable")
    source_value = contact(body.source_kind, source)
    if body.source_kind == "followup" and source.get("floor_id") == "ground-floor":
        source_value["assigned_to_name"] = source.get("assigned_to_name")
    value = source_value
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
    return {"customer": CustomerPublic(**target), "source": source_value, "created": created}
