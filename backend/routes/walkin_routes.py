"""Walk-ins — Phase 4 (2026-07-30). Entry point of the BuildCon ERP pipeline.

Department-agnostic by design: `floor_id` ("Interested Department") is the
existing, admin-configurable Floor entity — Tiles/Sanitary today, any future
department tomorrow, with zero schema change.

Reuses (no duplicate logic):
  - services/walkin_service.py     — duplicate-safe customer lookup/create
  - services/followup_engine.py    — reconcile_followups() / score_followup()
  - services/messaging_service.py  — WhatsApp deep-link + templates
  - services/email_service.py      — mailto deep-link + templates
  - services/activity_log.py       — timeline_for() (customer timeline)
  - services/sequence.py           — next_number()
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from pymongo.errors import DuplicateKeyError

from auth import floor_query, floor_scope_ids, get_current_user, profile_floor_ids, require_floor_access, require_min_role
from db import db
from models import Followup, UserPublic, now_iso
from models_walkins import WalkIn, WalkInCreate, WalkInUpdate, ReassignWalkInBody, WALKIN_OPEN_STATUSES
from services.access_grants import grants_for_user, grant_allows
from services.activity_log import log_event, timeline_for
from services.followup_engine import parse_iso, reconcile_followups
from services.multi_filters import predicate, scoped_query, values
from services.sequence import next_number as _next_number_seq
from services.walkin_service import find_or_create_customer

router = APIRouter(prefix="/walkins", tags=["walkins"])

LEAD_SOURCES_KEY = "lead_sources"


async def _next_walkin_number() -> str:
    year = datetime.now(timezone.utc).year
    return await _next_number_seq("walkin", f"WI-{year}-", collection="walkins")


async def _can_own_walkin(staff: dict, floor_id: str) -> bool:
    """A delegated page owner can do sales work regardless of their base role."""
    if not staff.get("active", True):
        return False
    if staff.get("role") == "owner":
        return True
    profile_floors = profile_floor_ids(staff.get("access_profile"))
    assigned_floors = profile_floors if profile_floors is not None else staff.get("floor_ids") or []
    if staff.get("custom_access"):
        if floor_id not in assigned_floors:
            return False
        grants = await grants_for_user(db, staff["id"])
        return any(grant_allows(grant, user_id=staff["id"], resource="walkins", action=action, floor_id=floor_id)
                   for grant in grants for action in ("create", "update"))
    return staff.get("role") in {"admin", "manager", "sales"} and (
        staff.get("role") == "manager" or floor_id in assigned_floors)


async def _salesperson_for_floor(salesperson_id: str, floor_id: str) -> dict:
    staff = await db.users.find_one(
        {"id": salesperson_id},
        {"_id": 0, "id": 1, "full_name": 1, "role": 1, "active": 1, "floor_ids": 1, "access_profile": 1, "custom_access": 1},
    )
    if not staff:
        raise HTTPException(status_code=404, detail="Salesperson not found")
    if not await _can_own_walkin(staff, floor_id):
        if not staff.get("custom_access") and (not staff.get("active", True) or staff.get("role") not in {"owner", "admin", "manager", "sales"}):
            raise HTTPException(status_code=400, detail="Selected staff member cannot own sales follow-ups")
        raise HTTPException(status_code=400, detail="Selected salesperson does not have access to this floor")
    return staff


@router.get("/config/assignees")
async def walkin_assignees(user: UserPublic = Depends(get_current_user)):
    """The intake picker belongs to Walk-ins, without granting Team or Follow-ups."""
    floor_ids = floor_scope_ids(user)
    rows = await db.users.find(
        {"active": True}, {"_id": 0, "id": 1, "full_name": 1, "role": 1, "active": 1,
                           "floor_ids": 1, "access_profile": 1, "custom_access": 1},
    ).sort("full_name", 1).to_list(1000)
    result = []
    for staff in rows:
        if any([await _can_own_walkin(staff, floor_id) for floor_id in floor_ids or []]):
            result.append({key: staff[key] for key in ("id", "full_name", "role")})
    return result


class LeadSourcesSettingsBody(BaseModel):
    sources: list[str]


# ---------- Lead sources config (Settings-style, db.settings pattern) ----------
@router.get("/config/sources")
async def get_lead_sources(_: UserPublic = Depends(get_current_user)):
    from models_walkins import LeadSourcesSettings
    doc = await db.settings.find_one({"key": LEAD_SOURCES_KEY}, {"_id": 0})
    if not doc:
        return LeadSourcesSettings()
    return LeadSourcesSettings(sources=doc.get("sources") or LeadSourcesSettings().sources)


@router.put("/config/sources")
async def update_lead_sources(body: LeadSourcesSettingsBody, user: UserPublic = Depends(require_min_role("manager"))):
    sources = [s.strip() for s in body.sources if s.strip()]
    await db.settings.update_one(
        {"key": LEAD_SOURCES_KEY},
        {"$set": {"key": LEAD_SOURCES_KEY, "sources": sources, "updated_at": now_iso(), "updated_by": user.id}},
        upsert=True,
    )
    return {"sources": sources}


# ---------- Duplicate check (frontend calls before submit, per spec) ----------
@router.get("/check-duplicate")
async def check_duplicate(
    phone: Optional[str] = None, alternate_phone: Optional[str] = None,
    email: Optional[str] = None, name: Optional[str] = None, city: Optional[str] = None,
    address: Optional[str] = None,
    user: UserPublic = Depends(get_current_user),
):
    """Confidence-tiered duplicate detection (see services/duplicate_detection.py):
    high (phone/alt-phone) auto-links, medium (email / name+city / name+address)
    requires an explicit staff decision, low (name only) is a soft suggestion
    that never blocks creation."""
    from services.duplicate_detection import find_customer_matches

    # Scoped to the caller's business unit. Unscoped, this endpoint returned
    # the other unit's customer name, company, both phone numbers, email and
    # address to anyone who could type a name into the walk-in form.
    return await find_customer_matches(
        phone=phone, alternate_phone=alternate_phone, email=email, name=name, city=city, address=address,
        floor_ids=floor_scope_ids(user),
    )


# ---------- Create ----------
@router.post("", response_model=WalkIn)
async def create_walkin(body: WalkInCreate, user: UserPublic = Depends(require_min_role("sales"))):
    if body.notes is not None:
        raise HTTPException(status_code=422, detail="Notes can only be written when marking a client as lost")
    if not await db.floors.find_one({"id": body.floor_id}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=404, detail="Department (floor) not found")
    # `body.floor_id` was only checked for EXISTENCE above — a caller could
    # still name a real floor they have no access to. Without this, every
    # downstream decision (customer lookup, duplicate-match scope, the
    # inserted WalkIn/customer's floor_id) anchors on an attacker-controlled
    # value: a first-floor-only user could write into ground-floor's book,
    # or — worse — trigger the 409 duplicate-match response below and read
    # the other unit's customer PII back in the response body.
    require_floor_access(body.floor_id, user)

    salesperson_id = body.salesperson_id or user.id
    salesperson_doc = await _salesperson_for_floor(salesperson_id, body.floor_id)

    if body.use_existing_customer_id:
        # Floor-checked against `body.floor_id`, which by this point has
        # itself been verified above to be a floor the caller may access —
        # not merely "exists": an id from the other business unit would
        # otherwise attach this walk-in — and every quotation/order that
        # follows — to a customer record that unit owns.
        customer = await db.customers.find_one(
            {"id": body.use_existing_customer_id, "floor_id": body.floor_id}, {"_id": 0},
        )
        if not customer:
            raise HTTPException(status_code=404, detail="Selected existing customer not found")
    else:
        from services.duplicate_detection import find_customer_matches

        matches = await find_customer_matches(
            phone=body.customer_phone, alternate_phone=body.alternate_phone,
            email=body.email, name=body.customer_name,
            city=body.city, address=body.address,
            floor_ids=[body.floor_id],
        )
        if matches["high"]:
            customer = matches["high"][0]
        elif matches["medium"] and not body.force_new_customer:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "A similar customer may already exist — resolve before creating a new one.",
                    "matches": matches,
                },
            )
        else:
            try:
                customer = await find_or_create_customer(
                    name=body.customer_name, phone=body.customer_phone, alternate_phone=body.alternate_phone,
                    email=body.email, floor_id=body.floor_id, user=user,
                    address=body.address, city=body.city, state=body.state, pincode=body.pincode,
                )
            except DuplicateKeyError:
                raise HTTPException(status_code=409, detail="That email is already used by another customer.")
    walkin = WalkIn(
        number=await _next_walkin_number(),
        customer_id=customer["id"], customer_name=customer.get("name"),
        customer_phone=body.customer_phone, alternate_phone=body.alternate_phone,
        visited_at=body.visited_at or now_iso(),
        salesperson_id=salesperson_id,
        salesperson_name=salesperson_doc["full_name"],
        source=body.source, reference_contact=body.reference_contact, architect=body.architect, builder=body.builder,
        floor_id=body.floor_id, interested_products=body.interested_products,
        budget=body.budget, manual_priority_override=body.priority,
        next_followup_at=body.next_followup_at,
        created_by=user.id, created_by_name=user.full_name,
    )
    await db.walkins.insert_one(walkin.dict())
    await log_event(
        event_type="walkin.created", entity_type="walkin", entity_id=walkin.id,
        customer_id=customer["id"], actor=user,
        summary=f"{walkin.number} · {customer.get('name')} · {body.source}",
    )
    asyncio.create_task(reconcile_followups())
    return walkin


# ---------- List ----------
@router.get("", response_model=list[WalkIn])
async def list_walkins(
    status: Optional[str] = None, priority: Optional[str] = None, salesperson_id: Optional[str] = None,
    source: Optional[str] = None, floor_id: Optional[str] = None, floor_ids: Optional[str] = None,
    date_from: Optional[str] = None, date_to: Optional[str] = None, search: Optional[str] = None,
    user: UserPublic = Depends(get_current_user),
):
    filters: dict = {"is_deleted": False, "showroom_followup_id": None, "showroom_transferred_at": None}
    if status:
        filters["status"] = predicate(status)
    if salesperson_id:
        filters["salesperson_id"] = predicate(salesperson_id)
    if source:
        filters["source"] = predicate(source)

    if date_from or date_to:
        rng: dict = {}
        if date_from:
            rng["$gte"] = date_from
        if date_to:
            rng["$lte"] = date_to
        filters["visited_at"] = rng
    if search:
        filters["$or"] = [
            {"customer_name": {"$regex": search, "$options": "i"}},
            {"customer_phone": {"$regex": search, "$options": "i"}},
            {"salesperson_name": {"$regex": search, "$options": "i"}},
            {"source": {"$regex": search, "$options": "i"}},
            {"notes": {"$regex": search, "$options": "i"}},
        ]
    docs = await db.walkins.find(scoped_query(user, filters, floor_ids or floor_id), {"_id": 0}).sort("visited_at", -1).to_list(2000)
    if priority:
        docs = [d for d in docs if (d.get("manual_priority_override") or "medium") in values(priority)]
    return [WalkIn(**d) for d in docs]


# ---------- Dashboard KPIs ----------
@router.get("/dashboard")
async def walkins_dashboard(floor_ids: Optional[str] = None, user: UserPublic = Depends(get_current_user)):
    docs = await db.walkins.find(scoped_query(user, {"is_deleted": False, "showroom_followup_id": None, "showroom_transferred_at": None}, floor_ids), {"_id": 0}).to_list(5000)
    now = datetime.now(timezone.utc)
    today = now.date()
    week_start = today.fromordinal(today.toordinal() - today.weekday())

    def visited_date(d):
        dt = parse_iso(d.get("visited_at"))
        return dt.date() if dt else None

    today_count = sum(1 for d in docs if visited_date(d) == today)
    week_count = sum(1 for d in docs if visited_date(d) and visited_date(d) >= week_start)
    pending = sum(1 for d in docs if d.get("status") in WALKIN_OPEN_STATUSES)
    selection_scheduled = sum(1 for d in docs if d.get("status") == "selection_scheduled")
    converted = sum(1 for d in docs if d.get("status") in ("selection_completed", "quotation_created", "converted"))
    lost = sum(1 for d in docs if d.get("status") == "lost")
    closed = converted + lost
    conversion_rate = round((converted / closed) * 100, 1) if closed else 0.0

    conv_days = []
    for d in docs:
        if d.get("status") in ("selection_completed", "quotation_created", "converted"):
            v = parse_iso(d.get("visited_at"))
            u = parse_iso(d.get("updated_at"))
            if v and u:
                conv_days.append((u - v).total_seconds() / 86400)
    avg_conversion_days = round(sum(conv_days) / len(conv_days), 1) if conv_days else 0.0

    return {
        "today_walkins": today_count, "this_week": week_count, "pending_followups": pending,
        "selections_scheduled": selection_scheduled, "converted": converted, "lost": lost,
        "conversion_rate": conversion_rate, "avg_conversion_days": avg_conversion_days,
        "total": len(docs),
    }


# ---------- Analytics funnel ----------
@router.get("/analytics")
async def walkins_analytics(user: UserPublic = Depends(get_current_user)):
    walkins = await db.walkins.find(floor_query(user, {"is_deleted": False, "showroom_followup_id": None, "showroom_transferred_at": None}), {"_id": 0}).to_list(5000)
    customer_ids = list({w["customer_id"] for w in walkins})
    quotations = await db.quotations.find(
        floor_query(user, {"customer_id": {"$in": customer_ids}}), {"_id": 0},
    ).to_list(5000) if customer_ids else []
    selections = sum(1 for q in quotations if q.get("doc_type") == "tiles_selection")
    tiles_quotations = sum(1 for q in quotations if q.get("doc_type") == "tiles_quotation")
    orders = sum(1 for q in quotations if q.get("status") == "ordered")
    revenue = sum(float(q.get("grand_total") or 0) for q in quotations if q.get("status") == "ordered")
    lost = [w for w in walkins if w.get("status") == "lost"]
    revenue_lost = sum(float(w.get("budget") or 0) for w in lost)

    by_salesperson: dict[str, dict] = {}
    for w in walkins:
        key = w.get("salesperson_name") or "Unassigned"
        row = by_salesperson.setdefault(key, {"salesperson": key, "walkins": 0, "converted": 0, "lost": 0})
        row["walkins"] += 1
        if w.get("status") in ("selection_completed", "quotation_created", "converted"):
            row["converted"] += 1
        elif w.get("status") == "lost":
            row["lost"] += 1

    return {
        "funnel": {"walk_ins": len(walkins), "selections": selections, "quotations": tiles_quotations, "orders": orders},
        "conversion_rate_pct": round((orders / len(walkins)) * 100, 1) if walkins else 0.0,
        "lost_leads": len(lost), "revenue_generated": round(revenue, 2), "revenue_lost": round(revenue_lost, 2),
        "salesperson_performance": sorted(by_salesperson.values(), key=lambda r: -r["converted"]),
    }


# ---------- Detail / update / contact / actions ----------
@router.get("/{walkin_id}", response_model=WalkIn)
async def get_walkin(walkin_id: str, user: UserPublic = Depends(get_current_user)):
    doc = await db.walkins.find_one(floor_query(user, {"id": walkin_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Walk-in not found")
    return WalkIn(**doc)


@router.get("/{walkin_id}/timeline")
async def walkin_timeline(walkin_id: str, user: UserPublic = Depends(get_current_user)):
    doc = await db.walkins.find_one(floor_query(user, {"id": walkin_id}), {"_id": 0, "customer_id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Walk-in not found")
    return await timeline_for(customer_id=doc["customer_id"], limit=60, floor_ids=floor_scope_ids(user))


@router.post("/{walkin_id}/visit-showroom")
async def visit_showroom(walkin_id: str, user: UserPublic = Depends(require_min_role("sales"))):
    """Transfer immediately, with one stable identity even on repeated clicks.

    The follow-up is manually initiated so reconciliation respects staff
    completion/snoozing and never closes it merely because no delayed rule
    currently matches this walk-in.
    """
    query = floor_query(user, {"id": walkin_id, "is_deleted": False})
    walkin = await db.walkins.find_one(query, {"_id": 0})
    if not walkin:
        raise HTTPException(status_code=404, detail="Walk-in not found")
    if walkin.get("status") == "lost":
        raise HTTPException(status_code=409, detail="Reopen this lost walk-in before transferring to follow-ups")
    now = now_iso()
    followup_id = f"showroom:{walkin_id}"
    followup = Followup(
        id=followup_id, floor_id=walkin["floor_id"], source_key=f"visit_showroom:{walkin_id}",
        walkin_id=walkin_id, origin="visit_showroom", rule_type="manual", category="walk_in",
        customer_id=walkin["customer_id"], customer_name=walkin["customer_name"],
        customer_phone=walkin.get("customer_phone"), reason="Visit Showroom",
        next_action="Arrange showroom visit", next_action_reason="Transferred from the walk-in register",
        suggested_channel="visit", due_at=now, is_automated=False,
        assigned_to=walkin.get("salesperson_id"), assigned_to_name=walkin.get("salesperson_name"),
        tags=["WALK_IN", "VISIT_SHOWROOM"],
    ).model_dump()
    identity = {"id": followup_id, "floor_id": walkin["floor_id"]}
    try:
        await db.followups.update_one(identity, {"$setOnInsert": followup}, upsert=True)
    except DuplicateKeyError:
        # Another simultaneous click can win the unique source-key upsert.
        # Acknowledge only our exact, authorized follow-up identity.
        if not await db.followups.find_one(identity, {"_id": 0, "id": 1}):
            raise
    result = await db.walkins.update_one(
        {**{"id": walkin_id, "floor_id": walkin["floor_id"]}, "showroom_followup_id": {"$ne": followup_id}},
        {"$set": {"showroom_followup_id": followup_id, "showroom_transferred_at": now, "updated_at": now}},
    )
    # Retire any delayed walk-in reminder in favor of the immediate visit.
    await db.followups.update_many(
        {"source_key": f"walk_in_new:{walkin_id}", "floor_id": walkin["floor_id"], "status": {"$in": ["open", "snoozed"]}},
        {"$set": {"status": "done", "auto_resolved": True, "completed_at": now, "resolution_note": "Transferred to Visit Showroom"}},
    )
    if result.modified_count:
        await log_event(
            event_type="walkin.visit_showroom", entity_type="walkin", entity_id=walkin_id,
            customer_id=walkin["customer_id"], actor=user, floor_id=walkin["floor_id"],
            summary=f"{walkin.get('number')} transferred to Visit Showroom follow-ups",
        )
    return {"walkin_id": walkin_id, "followup_id": followup_id}


@router.patch("/{walkin_id}", response_model=WalkIn)
async def update_walkin(walkin_id: str, body: WalkInUpdate, user: UserPublic = Depends(require_min_role("sales"))):
    doc = await db.walkins.find_one(floor_query(user, {"id": walkin_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Walk-in not found")
    patch = body.model_dump(exclude_unset=True)
    if doc.get("showroom_followup_id") or doc.get("showroom_transferred_at"):
        raise HTTPException(status_code=409, detail="This walk-in is now in Visit Showroom follow-ups")
    if patch.get("status") != "lost" and ("notes" in patch or "lost_reason" in patch):
        raise HTTPException(status_code=422, detail="Notes can only be written when marking a client as lost")
    if patch.get("status") == "lost":
        resulting_notes = patch.get("notes") or patch.get("lost_reason")
        if not str(resulting_notes or "").strip():
            raise HTTPException(status_code=422, detail="A note is required before marking this client as lost")
        # Keep the note available in the legacy lost_reason field for existing
        # reports and audit consumers, while notes remains the user-facing
        # source of truth.
        patch["notes"] = str(resulting_notes).strip()
        patch["lost_reason"] = patch["notes"]
    patch["updated_at"] = now_iso()
    if patch.get("status") == "converted":
        patch["converted_at"] = now_iso()
    await db.walkins.update_one({"id": walkin_id}, {"$set": patch})
    if "status" in patch:
        await log_event(
            event_type="walkin.status_changed", entity_type="walkin", entity_id=walkin_id,
            customer_id=doc["customer_id"], actor=user,
            summary=f"Walk-in {doc.get('number')} → {patch['status']}",
        )
        asyncio.create_task(reconcile_followups())
    fresh = await db.walkins.find_one({"id": walkin_id}, {"_id": 0})
    return WalkIn(**fresh)


@router.patch("/{walkin_id}/reassign", response_model=WalkIn)
async def reassign_walkin(walkin_id: str, body: ReassignWalkInBody, user: UserPublic = Depends(require_min_role("sales"))):
    """Explicit salesperson reassignment (2026-08 CRM foundation spec) — never
    silent. Transfers ownership of this Walk-in's own open automated
    Follow-up to the new salesperson and preserves the change in the
    Customer's activity timeline."""
    doc = await db.walkins.find_one(floor_query(user, {"id": walkin_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Walk-in not found")
    new_sp = await _salesperson_for_floor(body.salesperson_id, doc["floor_id"])
    old_name = doc.get("salesperson_name") or "Unassigned"
    await db.walkins.update_one(
        {"id": walkin_id},
        {"$set": {"salesperson_id": body.salesperson_id, "salesperson_name": new_sp["full_name"], "updated_at": now_iso()}},
    )
    await db.followups.update_many(
        {"source_key": {"$in": [f"walk_in_new:{walkin_id}", f"visit_showroom:{walkin_id}"]}, "floor_id": doc["floor_id"]},
        {"$set": {"assigned_to": body.salesperson_id, "assigned_to_name": new_sp["full_name"]}},
    )
    await log_event(
        event_type="walkin.reassigned", entity_type="walkin", entity_id=walkin_id,
        customer_id=doc["customer_id"], actor=user,
        summary=f"Walk-in {doc.get('number')} reassigned from {old_name} to {new_sp['full_name']}",
    )
    fresh = await db.walkins.find_one({"id": walkin_id}, {"_id": 0})
    return WalkIn(**fresh)


@router.post("/{walkin_id}/contact")
async def contact_walkin(walkin_id: str, channel: str = Query(..., pattern="^(whatsapp|email)$"), user: UserPublic = Depends(get_current_user)):
    from services.email_service import build_email
    from services.messaging_service import build_message

    doc = await db.walkins.find_one(floor_query(user, {"id": walkin_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Walk-in not found")
    ctx = {"customer_name": (doc.get("customer_name") or "there").split()[0], "salesperson_name": doc.get("salesperson_name") or ""}
    now = now_iso()
    await db.walkins.update_one({"id": walkin_id}, {"$set": {"updated_at": now}})
    if channel == "whatsapp":
        msg = build_message("walk_in", doc.get("customer_phone"), ctx)
        return {"channel": "whatsapp", "message": msg["message"], "wa_url": msg["url"]}
    cust = await db.customers.find_one({"id": doc["customer_id"]}, {"_id": 0, "email": 1})
    email = build_email("quotation", cust.get("email") if cust else None, {**ctx, "quotation_number": ""})
    return {"channel": "email", **email}
