"""Scaffold endpoints — the /purchase-orders scaffold has been REMOVED and replaced
by the full module at routes/purchase_routes.py. The /payments scaffold has been
REMOVED and replaced by routes/payment_routes.py. /followups has been REMOVED and
replaced by the full Sales Command Center module at routes/followup_routes.py."""

from fastapi import APIRouter, Depends, HTTPException

import os
from re import fullmatch
from urllib.parse import urlsplit

from access_profiles import profile_allows_request
from auth import accessible_floor_ids, floor_for_write, floor_query, floor_scope_ids, get_current_user, hash_password, invalidate_principal_cache, normalize_staff_access, require_min_role, revoke_all_sessions
from db import db
from models import FloorCreatePayload, FloorPublic, TeamCreatePayload, TeamUpdatePayload, UserPublic, now_iso
from services.activity_log import log_event
from services.access_grants import grants_allow, grants_for_user, resource_candidates_for_api_path
from services.download_tokens import create_download_token
from services.invite_service import generate_temp_password, get_invite_service, temp_password_expiry_iso
from settings import settings
from time import monotonic
from typing import Optional
from pydantic import BaseModel, Field

router = APIRouter(tags=["ops"])
_SYSTEM_HEALTH_CACHE_TTL_SECONDS = 30.0
_system_health_cache: tuple[float, dict] | None = None


class DownloadTokenRequest(BaseModel):
    target: str = Field(min_length=6, max_length=2048)


# Browser navigations cannot carry an Authorization header, so an opaque `dl`
# token is deliberately accepted by the destination route. Keep its issuance
# narrow: each pattern is a GET-only, file-producing endpoint used by the app.
# Do not broaden this to arbitrary API paths — that would bypass the normal
# profile/custom-grant middleware which reads the Authorization header.
_DOWNLOAD_TARGET_PATTERNS = (
    r"/api/purchases/export\.xlsx",
    r"/api/payments/history/export",
    r"/api/followups/export",
    r"/api/tile-orders/history/export",
    r"/api/tile-orders/chalans/[^/]+/pdf",
)


def _download_target_path(target: str) -> str:
    """Validate a relative, GET-only browser-download target and return its path."""
    parsed = urlsplit(target)
    if (
        parsed.scheme or parsed.netloc or parsed.fragment
        or any(pair.split("=", 1)[0].lower() == "dl" for pair in parsed.query.split("&") if pair)
        or not any(fullmatch(pattern, parsed.path) for pattern in _DOWNLOAD_TARGET_PATTERNS)
    ):
        raise HTTPException(status_code=400, detail="Download target is not permitted")
    return parsed.path

# Settings > System > Version. Bump manually alongside meaningful releases —
# there's no build pipeline yet to derive this automatically.
FORGE_VERSION = "1.0.0"

DEFAULT_FLOORS = [
    {"id": "ground-floor", "name": "Ground floor", "slug": "ground-floor"},
    {"id": "first-floor", "name": "The Sanitary Bathroom", "slug": "first-floor"},
    {"id": "second-floor", "name": "Kitchen Floor", "slug": "second-floor"},
    {"id": "third-floor", "name": "Furniture Floor", "slug": "third-floor"},
]


async def _ensure_default_floors() -> None:
    now = now_iso()
    for floor in DEFAULT_FLOORS:
        await db.floors.update_one(
            {"id": floor["id"]},
            {"$setOnInsert": {**floor, "active": True, "created_at": now, "updated_at": now}},
            upsert=True,
        )


@router.post("/downloads/token")
async def mint_download_token(body: DownloadTokenRequest, user: UserPublic = Depends(get_current_user)):
    """Call this (normal Authorization-header request) right before opening a
    browser-download URL (PDF/xlsx export). Returns a token good for one
    download within 60 seconds — see services/download_tokens.py.

    Uses `floor_for_write(user)` rather than `user.active_floor_id` directly:
    an all-floors owner/manager on the "All floors" view sends no
    X-Floor-Id, leaving `active_floor_id` empty, which would store
    `floor_id: None` on the token. The consume path then leaves
    `active_floor_id = None` on the resulting principal, making
    `floor_query()` unrestricted for that download — the exact leak
    described in services/download_tokens.py. `floor_for_write` always
    resolves to a concrete floor."""
    target_path = _download_target_path(body.target)
    if not profile_allows_request(user.access_profile, "GET", target_path):
        raise HTTPException(status_code=403, detail="This account is not permitted to download this file")
    floor_id = floor_for_write(user)
    if user.custom_access:
        grants = await grants_for_user(db, user.id)
        resources = resource_candidates_for_api_path(target_path, floor_id)
        if not resources or not any(
            grants_allow(grants, user_id=user.id, resource=resource, action="export", floor_id=floor_id)
            for resource in resources
        ):
            raise HTTPException(status_code=403, detail="This account is not permitted to download this file")
    token = await create_download_token(user.id, user.session_id, floor_id, body.target)
    return {"token": token, "expires_in": 60}


@router.get("/settings/floors", response_model=list[FloorPublic])
async def list_floors(user: UserPublic = Depends(get_current_user)):
    await _ensure_default_floors()
    floors = await db.floors.find({"active": True}, {"_id": 0}).sort("created_at", 1).to_list(50)
    allowed = accessible_floor_ids(user)
    return floors if allowed is None else [floor for floor in floors if floor["id"] in allowed]


@router.get("/settings/floor-access")
async def get_floor_access(user: UserPublic = Depends(get_current_user)):
    await _ensure_default_floors()
    floors = await db.floors.find({"active": True}, {"_id": 0}).sort("created_at", 1).to_list(50)
    allowed = accessible_floor_ids(user)
    visible = floors if allowed is None else [floor for floor in floors if floor["id"] in allowed]
    return {"all_floors": allowed is None, "floors": visible, "floor_ids": [floor["id"] for floor in visible]}


@router.post("/settings/floors", response_model=FloorPublic)
async def create_floor(body: FloorCreatePayload, _: UserPublic = Depends(require_min_role("owner"))):
    await _ensure_default_floors()
    slug = (body.slug or body.name).strip().lower().replace(" ", "-")
    if await db.floors.find_one({"slug": slug}):
        raise HTTPException(status_code=409, detail="A floor with this name already exists")
    floor = FloorPublic(name=body.name.strip(), slug=slug, active=body.active).dict()
    await db.floors.insert_one(floor)
    floor.pop("_id", None)
    return floor


def _sanitize_error(err: Optional[str]) -> Optional[str]:
    """Security audit (Phase 1, 2026-08): this endpoint is intentionally public
    (no auth) for ops/curl diagnostics, but driver exceptions (pymongo/httpx)
    can embed the connection string or internal hostnames in their message.
    Strip any credentials-looking substring and cap the length — callers only
    need the failure class, not a full stack-trace-grade string."""
    if not err:
        return err
    import re
    err = re.sub(r"://[^@/\s]+@", "://<redacted>@", err)
    return err[:200]


@router.get("/health/system")
async def health_system(_: UserPublic = Depends(require_min_role("admin"))):
    """Persistence & Disaster Recovery — startup/session health check.

    Admin-only and cached because it performs privileged storage checks and
    collection counts. It NEVER returns secret values. Covers every item in the
    "before you build a new feature" checklist: db reachability, storage
    reachability, data counts, and which required secrets are actually loaded
    in this session's environment.
    """
    global _system_health_cache
    if _system_health_cache and monotonic() - _system_health_cache[0] < _SYSTEM_HEALTH_CACHE_TTL_SECONDS:
        return _system_health_cache[1]

    mongo_url = settings.mongo_url
    is_local_mongo = ("localhost" in mongo_url) or ("127.0.0.1" in mongo_url) or (not mongo_url)

    mongo_ok = False
    mongo_error = None
    try:
        await db.command("ping")
        mongo_ok = True
    except Exception as exc:  # noqa: BLE001
        mongo_error = str(exc)

    counts = {}
    if mongo_ok:
        for name in [
            "products", "customers", "quotations", "purchase_orders",
            "payments", "followups", "users", "brands", "categories", "activity",
        ]:
            try:
                counts[name] = await db[name].count_documents({})
            except Exception:  # noqa: BLE001
                counts[name] = None

    supabase_url = settings.supabase_url
    supabase_key = settings.supabase_service_role_key
    supabase_configured = bool(supabase_url and supabase_key)
    supabase_ok = None
    supabase_error = None
    if supabase_configured:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=6.0) as client:
                resp = await client.get(
                    f"{supabase_url.rstrip('/')}/storage/v1/bucket",
                    headers={"apikey": supabase_key, "Authorization": f"Bearer {supabase_key}"},
                )
                supabase_ok = resp.status_code < 300
                if not supabase_ok:
                    supabase_error = f"HTTP {resp.status_code}"
        except Exception as exc:  # noqa: BLE001
            supabase_ok = False
            supabase_error = str(exc)

    secrets_loaded = settings.readiness_flags()
    monitoring_status = {
        "sentry_configured": bool((os.environ.get("SENTRY_DSN") or "").strip()),
        "posthog_configured": False,
    }

    warnings = []
    if is_local_mongo:
        warnings.append(
            "MongoDB is pointing at a LOCAL/ephemeral instance — all data will be lost on the "
            "next session reset. Migrate to MongoDB Atlas to make this permanent."
        )
    if not supabase_configured:
        warnings.append(
            "Supabase Storage is not configured — product images/PDFs/attachments will be lost "
            "on the next session reset. Provide SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY."
        )
    if mongo_ok and counts.get("products", 0) is not None and counts.get("products", 0) <= 20:
        warnings.append(
            "Product catalog looks like demo-seed data (<=20 items), not the full imported "
            "catalog. Re-run the catalog importers or restore from a backup."
        )

    result = {
        "backend": "running",
        "version": FORGE_VERSION,
        "mongo": {"connected": mongo_ok, "is_local": is_local_mongo, "error": _sanitize_error(mongo_error)},
        "supabase": {"configured": supabase_configured, "connected": supabase_ok, "error": _sanitize_error(supabase_error)},
        "counts": counts,
        "secrets_loaded": secrets_loaded,
        "monitoring": monitoring_status,
        "warnings": warnings,
        "healthy": mongo_ok and (supabase_ok is not False),
    }
    _system_health_cache = (monotonic(), result)
    return result


@router.get("/ops/outbox")
async def outbox_status(_: UserPublic = Depends(require_min_role("admin"))):
    """Operational visibility for durable events without exposing payloads."""
    pipeline = [
        {"$group": {"_id": "$status", "count": {"$sum": 1}, "oldest": {"$min": "$created_at"}}},
        {"$project": {"_id": 0, "status": "$_id", "count": 1, "oldest": 1}},
    ]
    rows = await db.event_outbox.aggregate(pipeline).to_list(20)
    return {"statuses": rows, "healthy": not any(row["status"] == "dead_letter" for row in rows)}


@router.get("/notifications")
async def list_notifications(user: UserPublic = Depends(get_current_user)):
    # Own-notifications only was never enough on its own: an owner/manager
    # receives notifications from both business units, so the bell mixed
    # Sanitary Bathroom alerts into Ground Floor and vice versa. Filtered in
    # Mongo on the floor each notification's source record belongs to.
    query: dict = {"user_id": user.id}
    floor_ids = floor_scope_ids(user)
    if floor_ids is not None:
        query["floor_id"] = {"$in": floor_ids}
    return await db.notifications.find(query, {"_id": 0}).sort("created_at", -1).to_list(100)


@router.get("/team")
async def list_team(_: UserPublic = Depends(require_min_role("manager"))):
    return await db.users.find({}, {"_id": 0, "password_hash": 0}).sort("full_name", 1).to_list(200)


@router.post("/team")
async def create_team_member(body: TeamCreatePayload, user: UserPublic = Depends(require_min_role("admin"))):
    if body.role == "owner" and user.role != "owner":
        raise HTTPException(status_code=403, detail="Only an owner can create another owner")
    if await db.users.find_one({"email": body.email.lower()}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=409, detail="A team member with this email already exists")
    role, floor_ids = normalize_staff_access(
        role=body.role, floor_ids=body.floor_ids, access_profile=body.access_profile,
    )
    doc = UserPublic(
        email=body.email.lower(), full_name=body.full_name, role=role, phone=body.phone,
        floor_ids=floor_ids,
        access_profile=body.access_profile,
        # New staff must set their own password on first login — the admin-
        # supplied password here is only a onboarding credential, never a
        # long-term secret someone else chose for them.
        must_change_password=True, temp_password_expires_at=temp_password_expiry_iso(),
    ).dict(exclude={"active_floor_id"})
    doc["password_hash"] = hash_password(body.password)
    await db.users.insert_one(doc)
    doc.pop("password_hash", None)
    doc.pop("_id", None)
    await log_event(
        event_type="user.created", entity_type="user", entity_id=doc["id"],
        actor=user, summary="Staff Account Created",
        payload={"role": role, "floor_ids": floor_ids, "access_profile": body.access_profile, "email": doc["email"]},
    )
    return doc


@router.patch("/team/{user_id}")
async def update_team_member(
    user_id: str, body: TeamUpdatePayload, user: UserPublic = Depends(require_min_role("admin")),
):
    if user_id == user.id and body.active is False:
        raise HTTPException(status_code=400, detail="You can't deactivate your own account")
    if user_id == user.id and body.role is not None and body.role != user.role:
        raise HTTPException(status_code=400, detail="You can't change your own role")
    before = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not before:
        raise HTTPException(status_code=404, detail="Team member not found")
    # `access_profile: null` is a meaningful request: it safely clears the
    # provisioner profile.  Other nulls retain PATCH's usual "not supplied"
    # semantics.
    supplied = body.model_dump(exclude_unset=True)
    patch = {k: v for k, v in supplied.items() if v is not None or k == "access_profile"}
    if not patch:
        raise HTTPException(status_code=400, detail="Nothing to update")
    target_is_owner = before.get("role") == "owner"
    promoting_to_owner = patch.get("role") == "owner" and not target_is_owner
    if user.role != "owner" and (target_is_owner or promoting_to_owner):
        raise HTTPException(status_code=403, detail="Only an owner can manage owner accounts")
    removes_owner = target_is_owner and (patch.get("active") is False or ("role" in patch and patch["role"] != "owner"))
    if removes_owner and await db.users.count_documents({"role": "owner", "active": {"$ne": False}}) <= 1:
        raise HTTPException(status_code=400, detail="At least one active owner is required")
    proposed_role, proposed_floors = normalize_staff_access(
        role=patch.get("role", before["role"]),
        floor_ids=patch.get("floor_ids", before.get("floor_ids") or []),
        access_profile=patch["access_profile"] if "access_profile" in patch else before.get("access_profile"),
    )
    # Profile provisioning may raise the requested role to the workflow's
    # minimum and always pins its corresponding floor. Store that correction
    # even when the client only supplied the profile.
    if proposed_role != before.get("role") or "role" in patch:
        patch["role"] = proposed_role
    if proposed_floors != (before.get("floor_ids") or []) or "floor_ids" in patch or "access_profile" in patch:
        patch["floor_ids"] = proposed_floors
    patch["updated_at"] = now_iso()
    await db.users.update_one({"id": user_id}, {"$set": patch})
    security_fields = ("role", "floor_ids", "access_profile")
    security_changed = any(field in patch and patch[field] != before.get(field) for field in security_fields)
    if security_changed:
        # Roles/floors/profiles are authorization claims. Revoke every device
        # before returning the updated account so stale tokens cannot retain
        # the old scope for their remaining JWT lifetime.
        await revoke_all_sessions("staff", user_id)
    doc = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})

    if "role" in patch and patch["role"] != before.get("role"):
        await log_event(
            event_type="user.role_changed", entity_type="user", entity_id=user_id, actor=user,
            summary="Staff Role Changed",
            payload={"from": before.get("role"), "to": patch["role"]},
        )
    if "active" in patch and patch["active"] != before.get("active", True):
        await log_event(
            event_type="user.enabled" if patch["active"] else "user.disabled",
            entity_type="user", entity_id=user_id, actor=user,
            summary="Staff Account Enabled" if patch["active"] else "Staff Account Disabled",
        )
    if "floor_ids" in patch and patch["floor_ids"] != (before.get("floor_ids") or []):
        await log_event(
            event_type="user.floor_access_changed", entity_type="user", entity_id=user_id, actor=user,
            summary="Staff Floor Access Changed",
            payload={"from": before.get("floor_ids") or [], "to": patch["floor_ids"]},
        )
    if "access_profile" in patch and patch["access_profile"] != before.get("access_profile"):
        await log_event(
            event_type="user.access_profile_changed", entity_type="user", entity_id=user_id, actor=user,
            summary="Staff Access Profile Changed",
            payload={"from": before.get("access_profile"), "to": patch["access_profile"]},
        )
    return doc


@router.post("/team/{user_id}/reset-password")
async def reset_team_member_password(user_id: str, user: UserPublic = Depends(require_min_role("admin"))):
    """Team > Reset Password. Generates a secure temporary password shown
    ONCE to the admin (manual-share, no email/SMS integration yet — see
    services/invite_service.py). The account is forced to change it on next
    login and it self-expires in 72h if unused."""
    if user_id == user.id:
        raise HTTPException(status_code=400, detail="Use Settings > Change password to reset your own password")
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="Team member not found")
    if target.get("role") == "owner" and user.role != "owner":
        raise HTTPException(status_code=403, detail="Only an owner can reset an owner password")
    temp_pw = generate_temp_password()
    expires_at = temp_password_expiry_iso()
    await db.users.update_one(
        {"id": user_id},
        {"$set": {
            "password_hash": hash_password(temp_pw),
            "must_change_password": True,
            "temp_password_expires_at": expires_at,
            "updated_at": now_iso(),
        }},
    )
    await revoke_all_sessions("staff", user_id)
    result = await get_invite_service().deliver(
        recipient_email=target.get("email"), recipient_name=target.get("full_name", "this team member"),
        temp_password=temp_pw, expires_at=expires_at, kind="staff_reset",
    )
    await log_event(
        event_type="user.password_reset", entity_type="user", entity_id=user_id, actor=user,
        summary="Staff Password Reset",
    )
    return {
        "delivery_method": result.delivery_method,
        "temporary_password": result.temporary_password,
        "expires_at": result.expires_at,
        "message": result.message,
    }


@router.get("/reports/overview")
async def reports_overview(user: UserPublic = Depends(get_current_user)):
    quotations = await db.quotations.find(floor_query(user, {}), {"_id": 0}).to_list(2000)
    by_status: dict[str, int] = {}
    revenue_by_month: dict[str, float] = {}
    for q in quotations:
        by_status[q.get("status", "draft")] = by_status.get(q.get("status", "draft"), 0) + 1
        if q.get("status") == "won":
            month = (q.get("updated_at") or "")[:7]
            if month:
                revenue_by_month[month] = revenue_by_month.get(month, 0) + q.get("grand_total", 0)
    return {"by_status": by_status, "revenue_by_month": revenue_by_month}
