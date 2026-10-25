"""Customer CRUD (admin) + customer-portal self-serve endpoints."""
import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from services.referrer_identity import resolve_referrer, referrer_query
from auth import (
    TILES_FLOOR_ID, accessible_floor_ids, floor_for_write, floor_inherit, floor_query, get_current_customer, get_current_user,
    get_floor_scoped_or_404, hash_password, invalidate_principal_cache, require_floor_access, require_min_role, revoke_all_sessions,
)
from db import db
from models import (
    CustomerCreate, CustomerPublic, CustomerUpdatePayload, UserPublic, now_iso,
)
from services.customer_completion import completed_customer_ids, confirmed_customer_ids
from services.activity_log import log_event
from services.invite_service import generate_temp_password, get_invite_service, temp_password_expiry_iso

router = APIRouter(tags=["customers"])


async def _referrer_fields(referrer_id: str | None, user: UserPublic) -> dict:
    """Resolve referral attribution server-side; never trust a display name."""
    if not referrer_id:
        return {"referrer_id": None, "referrer_name": None, "referrer_type": None}
    referrer = await resolve_referrer(db, referrer_id, user)
    if referrer.get("active") is False:
        raise HTTPException(status_code=400, detail="This referrer is archived")
    return {
        "referrer_id": referrer["id"],
        "referrer_name": referrer["name"],
        "referrer_type": referrer["type"],
    }


class ImportCustomerFromFloorPayload(BaseModel):
    """Import a customer profile into another floor without carrying product
    lines across two independent catalogues."""
    source_customer_id: str
    target_floor_id: str


# ---------- Staff-side ----------
# `skip`/`limit` are additive and opt-in — omitting them preserves the exact
# prior behavior (first 500, newest first). `X-Has-More` lets a future caller
# detect truncation without a breaking response-shape change; see
# PRODUCTION_FIXES_2026-07-16.md item 8 (pagination hardening).
@router.get("/customers", response_model=list[CustomerPublic])
async def list_customers(
    response: Response,
    skip: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=2000),
    confirmed_only: bool = False,
    completion: str | None = Query(None, pattern="^(active|completed)$"),
    user: UserPublic = Depends(get_current_user),
):
    query = floor_query(user)
    eligible_ids, complete_ids = await asyncio.gather(
        confirmed_customer_ids(db, user) if confirmed_only else asyncio.sleep(0, result=None),
        completed_customer_ids(db, user) if completion in ("active", "completed") else asyncio.sleep(0, result=None),
    )
    if confirmed_only:
        query = floor_query(user, {"id": {"$in": sorted(eligible_ids)}})
    if complete_ids is not None:
        query = {"$and": [query, {"id": {"$in" if completion == "completed" else "$nin": sorted(complete_ids)}}]}
    docs = await db.customers.find(
        query, {"_id": 0, "password_hash": 0},
    ).sort("created_at", -1).skip(skip).limit(limit + 1).to_list(limit + 1)
    response.headers["X-Has-More"] = "true" if len(docs) > limit else "false"
    return [CustomerPublic(**{**d, **({"purchase_completion_status": "completed" if d["id"] in complete_ids else "active"} if complete_ids is not None else {})}) for d in docs[:limit]]


@router.post("/customers", response_model=CustomerPublic)
async def create_customer(
    body: CustomerCreate,
    user: UserPublic = Depends(require_min_role("sales")),
):
    if body.email and await db.customers.find_one({"email": body.email.lower()}):
        raise HTTPException(status_code=409, detail="Customer email already exists")
    if not body.name or not body.name.strip():
        raise HTTPException(status_code=400, detail="Customer name is required")
    data = body.dict()
    data["floor_id"] = floor_for_write(user)
    data.update(await _referrer_fields(body.referrer_id, user))
    if data.get("email"):
        data["email"] = data["email"].lower()
    else:
        data["email"] = None
    password = data.pop("password", None)
    from models import CustomerPublic as CP
    cust = CP(**data)
    to_store = cust.dict()
    if password:
        to_store["password_hash"] = await run_in_threadpool(hash_password, password)
    # customers_email_unique is sparse, but sparse only skips ABSENT fields —
    # an explicit null still gets indexed, so the second no-email customer
    # ever created crashed with a duplicate-key error on {email: null}.
    # Store no key at all when there is no email.
    if to_store.get("email") is None:
        to_store.pop("email", None)
    await db.customers.insert_one(to_store)
    await log_event(
        event_type="customer.created", entity_type="customer", entity_id=cust.id,
        customer_id=cust.id, actor=user, summary="Customer Created",
    )
    return cust


def _import_defaults(source: dict, latest_quotation: dict | None) -> dict:
    """Fields a new builder can apply to its header after profile import.

    Product lines deliberately do not appear here: Ground Floor tiles and
    Sanitary Bathroom products are different catalogues.
    """
    quotation = latest_quotation or {}
    return {
        "project_name": quotation.get("project_name"),
        "phone": quotation.get("phone_snapshot") or source.get("phone"),
        "address": quotation.get("address_snapshot") or source.get("address"),
        "notes": quotation.get("notes") or source.get("notes"),
        "source_quotation_id": quotation.get("id"),
        "source_quotation_number": quotation.get("number"),
    }


async def _latest_floor_quotation(customer_id: str, floor_id: str) -> dict | None:
    docs = await db.quotations.find(
        {"customer_id": customer_id, "floor_id": floor_id}, {"_id": 0},
    ).sort("updated_at", -1).limit(1).to_list(1)
    return docs[0] if docs else None


@router.get("/customers/import-sources/ground-floor")
async def list_ground_floor_import_sources(
    limit: int = Query(100, ge=1, le=500),
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Customers and their latest Ground Floor document for the sanitary
    builder's "reuse bathroom details" chooser."""
    require_floor_access(TILES_FLOOR_ID, user)
    customers = await db.customers.find(
        {"floor_id": TILES_FLOOR_ID}, {"_id": 0, "password_hash": 0},
    ).sort("updated_at", -1).limit(limit).to_list(limit)
    results = []
    for customer in customers:
        latest = await _latest_floor_quotation(customer["id"], TILES_FLOOR_ID)
        results.append({
            "customer": CustomerPublic(**customer).dict(),
            "latest_quotation": ({
                "id": latest.get("id"), "number": latest.get("number"),
                "project_name": latest.get("project_name"), "updated_at": latest.get("updated_at"),
            } if latest else None),
            "defaults": _import_defaults(customer, latest),
        })
    return results


@router.post("/customers/import-from-floor")
async def import_customer_from_floor(
    body: ImportCustomerFromFloorPayload,
    user: UserPublic = Depends(require_min_role("sales")),
):
    """Create or select the target-floor customer matching a Ground Floor
    profile.  The returned header defaults let the caller populate a fresh
    quotation without copying incompatible tile line items."""
    require_floor_access(TILES_FLOOR_ID, user)
    require_floor_access(body.target_floor_id, user)
    source = await get_floor_scoped_or_404(
        db.customers, body.source_customer_id, user,
        not_found="Customer not found", projection={"_id": 0, "password_hash": 0},
    )
    if source.get("floor_id") != TILES_FLOOR_ID:
        raise HTTPException(status_code=400, detail="Only Ground Floor customers can be imported")

    latest = await _latest_floor_quotation(source["id"], TILES_FLOOR_ID)
    identity = []
    if source.get("phone"):
        identity.append({"phone": source["phone"]})
    if source.get("email"):
        identity.append({"email": str(source["email"]).lower()})
    if not identity:
        identity.append({"name": source["name"], "company": source.get("company")})
    target = await db.customers.find_one(
        {"floor_id": body.target_floor_id, "$or": identity}, {"_id": 0, "password_hash": 0},
    )
    if target:
        return {
            "customer": CustomerPublic(**target).dict(),
            "defaults": _import_defaults(source, latest),
            "created": False,
        }

    copied = {
        key: source.get(key) for key in (
            "name", "company", "phone", "address", "city", "state", "pincode", "gstin", "tier", "notes",
            "avatar_url", "alternate_phone", "preferred_contact_method", "preferred_contact_time", "assigned_branch",
            "tags", "lead_temperature",
        )
    }
    # The current database protects customer email globally, while profiles
    # are floor-local. Preserve the usable contact details (phone/address)
    # and avoid an index conflict; a later per-floor email migration can add
    # this field back without changing the import contract.
    target_customer = CustomerPublic(floor_id=body.target_floor_id, **copied)
    await db.customers.insert_one({**target_customer.dict(exclude={"email"}), "imported_from_customer_id": source["id"]})
    await log_event(
        event_type="customer.imported", entity_type="customer", entity_id=target_customer.id,
        customer_id=target_customer.id, actor=user, floor_id=body.target_floor_id,
        summary=f"Imported customer profile from Ground Floor: {target_customer.name}",
        payload={"source_customer_id": source["id"], "source_quotation_id": (latest or {}).get("id")},
    )
    return {
        "customer": target_customer.dict(),
        "defaults": _import_defaults(source, latest),
        "created": True,
    }


@router.get("/customers/{customer_id}", response_model=CustomerPublic)
async def get_customer(customer_id: str, with_completion: bool = False, user: UserPublic = Depends(get_current_user)):
    doc = await get_floor_scoped_or_404(
        db.customers, customer_id, user, not_found="Customer not found", projection={"_id": 0, "password_hash": 0},
    )
    from services.referrer_identity import acquired_counts, legacy_referrer_name
    if not doc.get("referrer_name"):
        doc = {**doc, "referrer_name": legacy_referrer_name(doc)}
    if not doc.get("referrer_id") and not doc.get("referrer_name"):
        # Notebook/walk-in legacy names were never part of CustomerPublic. Keep
        # the original spelling and only inspect this customer's actual floor.
        for collection in (db.followups, db.walkins):
            legacy = await collection.find_one({
                "customer_id": customer_id, "floor_id": doc["floor_id"], "is_deleted": {"$ne": True},
                "$or": [{key: {"$exists": True, "$nin": [None, ""]}} for key in
                        ("referrer_id", "referrer_name", "architect_name", "interior_designer_name", "architect_interior_designer", "architect")],
            }, {"_id": 0}, sort=[("updated_at", -1)])
            if legacy:
                doc = {**doc, "referrer_id": legacy.get("referrer_id"),
                       "referrer_name": legacy.get("referrer_name") or legacy_referrer_name(legacy),
                       "referrer_type": legacy.get("referrer_type")}
                break
    if doc.get("referrer_id"):
        # Attribution can originate on another interested floor. Restrict its
        # directory lookup to the caller's permitted floors, not the ambient one.
        selector = {"id": doc["referrer_id"]}
        floors = accessible_floor_ids(user)
        if floors is not None:
            selector["floor_id"] = {"$in": floors}
        partner = await db.referrers.find_one(referrer_query(selector), {"_id": 0})
        if partner:
            doc = {**doc, "referrer_name": partner.get("name") or doc.get("referrer_name"),
                   "referrer_type": partner.get("type") or doc.get("referrer_type"),
                   "referrer_company": partner.get("company")}
        counts = await acquired_counts(db, [doc["referrer_id"]], [doc["floor_id"]])
        doc["referrer_customers_acquired"] = counts.get(doc["referrer_id"], 0)
    if with_completion:
        completion_user = user.model_copy(update={"active_floor_id": doc["floor_id"]})
        complete_ids = await completed_customer_ids(db, completion_user, [customer_id])
        doc["purchase_completion_status"] = "completed" if customer_id in complete_ids else "active"
    return CustomerPublic(**doc)


@router.patch("/customers/{customer_id}", response_model=CustomerPublic)
async def update_customer(
    customer_id: str, body: CustomerUpdatePayload, user: UserPublic = Depends(require_min_role("sales")),
):
    """Customers > Edit Customer. Also where Portal Enabled is toggled — the
    only place that flag can be flipped besides Send Invite (which turns it
    on implicitly, see below)."""
    existing = await get_floor_scoped_or_404(db.customers, customer_id, user, not_found="Customer not found", projection={"_id": 0})

    patch = body.model_dump(exclude_unset=True)
    if "referrer_id" in patch:
        patch.update(await _referrer_fields(patch["referrer_id"], user))
    # Display/type fields are derived from the selected id, never accepted as
    # independent customer attribution input.
    if "referrer_id" not in patch:
        patch.pop("referrer_name", None)
        patch.pop("referrer_type", None)
    if "email" in patch and patch["email"]:
        patch["email"] = patch["email"].lower()
        dupe = await db.customers.find_one({"email": patch["email"], "id": {"$ne": customer_id}}, {"_id": 0, "id": 1})
        if dupe:
            raise HTTPException(status_code=409, detail="Another customer already uses this email")
    if "name" in patch and not (patch["name"] or "").strip():
        raise HTTPException(status_code=400, detail="Customer name is required")

    resulting_email = patch.get("email", existing.get("email"))
    resulting_portal = patch.get("portal_enabled", existing.get("portal_enabled", False))
    if resulting_portal and not resulting_email:
        raise HTTPException(status_code=400, detail="Add an email address before enabling portal access")

    if not patch:
        raise HTTPException(status_code=400, detail="Nothing to update")
    patch["updated_at"] = now_iso()
    await db.customers.update_one({"id": customer_id}, {"$set": patch})
    if patch.get("portal_enabled") is False:
        await revoke_all_sessions("customer", customer_id)

    if "portal_enabled" in patch and patch["portal_enabled"] != existing.get("portal_enabled", False):
        await log_event(
            event_type="customer.portal_enabled" if patch["portal_enabled"] else "customer.portal_disabled",
            entity_type="customer", entity_id=customer_id, customer_id=customer_id, actor=user,
            summary="Customer Portal Enabled" if patch["portal_enabled"] else "Customer Portal Disabled",
            floor_id=floor_inherit(existing),
        )
    else:
        await log_event(
            event_type="customer.updated", entity_type="customer", entity_id=customer_id,
            customer_id=customer_id, actor=user, summary="Customer Details Updated",
            floor_id=floor_inherit(existing),
        )

    doc = await db.customers.find_one({"id": customer_id}, {"_id": 0, "password_hash": 0})
    return CustomerPublic(**doc)


def _customer_deletion_owner(user: UserPublic = Depends(get_current_user)) -> UserPublic:
    # Cross-floor removal of paid financial data is deliberately not delegated
    # through page grants or the manager role.
    if user.role != "owner":
        raise HTTPException(403, "Only the owner can delete all customer data")
    return user


@router.get("/customers/{customer_id}/deletion-preview")
async def preview_customer_deletion(
    customer_id: str, furniture_ids: str = "", user: UserPublic = Depends(_customer_deletion_owner),
):
    _customer_deletion_owner(user)
    await get_floor_scoped_or_404(db.customers, customer_id, user, not_found="Customer not found")
    from services.customer_deletion import plan_deletion, public_plan
    return public_plan(await plan_deletion(db, customer_id=customer_id, furniture_ids=tuple(filter(None, furniture_ids.split(",")))), user.id)


@router.delete("/customers/{customer_id}")
async def delete_customer(
    customer_id: str, confirmation: str = "", furniture_ids: str = "",
    user: UserPublic = Depends(_customer_deletion_owner),
):
    """Remove exactly the owner's reviewed customer graph, including orders."""
    _customer_deletion_owner(user)
    if not confirmation:
        raise HTTPException(409, "Review the customer deletion summary before confirming.")
    from services.customer_deletion import delete_customer_graph
    if not await db.settings.find_one({"id": "customer-deletion:" + customer_id}):
        await get_floor_scoped_or_404(db.customers, customer_id, user, not_found="Customer not found")
    result = await delete_customer_graph(db, db.client, customer_id, user.id, confirmation, tuple(filter(None, furniture_ids.split(","))))
    # Invalidate current-process principal reads immediately. Other processes
    # reload the now-missing identity under their normal short cache expiry.
    invalidate_principal_cache("customer", customer_id)
    return result


async def _issue_temp_password(customer_id: str, *, kind: str, user: UserPublic):
    """Shared core for Send Invite + Reset Password — generates, hashes,
    stores, and delivers a temporary password. `kind` only affects the
    delivery message/audit summary."""
    target = await db.customers.find_one(floor_query(user, {"id": customer_id}), {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="Customer not found")
    if not target.get("email"):
        raise HTTPException(status_code=400, detail="Add an email address for this customer first")
    if not target.get("portal_enabled"):
        raise HTTPException(status_code=400, detail="Enable Portal Access for this customer first")

    temp_pw = generate_temp_password()
    expires_at = temp_password_expiry_iso()
    await db.customers.update_one(
        floor_query(user, {"id": customer_id}),
        {"$set": {
            "password_hash": await run_in_threadpool(hash_password, temp_pw),
            "must_change_password": True,
            "temp_password_expires_at": expires_at,
            "updated_at": now_iso(),
        }},
    )
    await revoke_all_sessions("customer", customer_id)
    result = await get_invite_service().deliver(
        recipient_email=target["email"], recipient_name=target.get("name", "this customer"),
        temp_password=temp_pw, expires_at=expires_at, kind=kind,
    )
    event_type, summary = (
        ("customer.portal_invite_generated", "Customer Portal Invite Generated") if kind == "customer_invite"
        else ("customer.password_reset", "Customer Password Reset")
    )
    await log_event(
        event_type=event_type, entity_type="customer", entity_id=customer_id,
        customer_id=customer_id, actor=user, summary=summary,
    )
    return {
        "delivery_method": result.delivery_method,
        "temporary_password": result.temporary_password,
        "expires_at": result.expires_at,
        "message": result.message,
    }


@router.post("/customers/{customer_id}/send-invite")
async def send_customer_invite(customer_id: str, user: UserPublic = Depends(require_min_role("sales"))):
    """Customers > Edit Customer > Send Invite. Requires Portal Enabled = On
    and an email already saved (see Edit Customer's toggle + Save first)."""
    return await _issue_temp_password(customer_id, kind="customer_invite", user=user)


@router.post("/customers/{customer_id}/reset-password")
async def reset_customer_password(customer_id: str, user: UserPublic = Depends(require_min_role("sales"))):
    """Customers > Edit Customer > Reset Password."""
    return await _issue_temp_password(customer_id, kind="customer_reset", user=user)


# ---------- Customer-portal ----------
@router.get("/portal/quotations")
async def portal_quotations(cust: CustomerPublic = Depends(get_current_customer)):
    docs = await db.quotations.find({"customer_id": cust.id}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return docs


@router.get("/portal/quotations/{quotation_id}")
async def portal_quotation_detail(quotation_id: str, cust: CustomerPublic = Depends(get_current_customer)):
    """Read-only detail view for the customer portal — full line items plus a
    lightweight revision index (metadata only, not the full historical
    snapshot) and a per-brand breakdown so the portal can offer brand-wise
    PDF download buttons without a second round trip."""
    doc = await db.quotations.find_one({"id": quotation_id, "customer_id": cust.id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Quotation not found")
    from routes.quotation_routes import _brand_grouped_preview
    brands_preview = await _brand_grouped_preview(doc)
    revisions = [
        {"revision_no": r.get("revision_no"), "created_at": r.get("created_at"), "reason": r.get("reason")}
        for r in (doc.get("revisions") or [])
    ]
    doc["revisions"] = revisions
    doc["brands"] = brands_preview.get("brands", [])
    return doc
