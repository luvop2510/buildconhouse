"""Staff + customer authentication endpoints."""
from typing import Optional
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from auth import (
    apply_effective_floor_ids, create_session, create_token, decode_token, get_current_customer, get_current_session, get_current_user,
    hash_password, invalidate_principal_cache, verify_password,
)
from db import db
from models import (
    ChangePasswordPayload, CustomerLoginPayload, CustomerPublic, CustomerTokenResponse,
    LoginPayload, MFAProofPayload, SessionInfo, TokenResponse, UserPublic, now_iso,
)
from services.activity_log import log_event
from services.invite_service import is_temp_password_expired
from services.rate_limit import clear_login_attempts, reserve_login_attempt
from services import mfa
from services.password_policy import is_known_default_password
from services.login_identity import normalize_login_id

router = APIRouter(prefix="/auth", tags=["auth"])


def _client_ip(request: Request) -> str | None:
    return request.client.host if request and request.client else None


async def _revoke_other_sessions(kind: str, user_id: str, authorization: Optional[str]) -> None:
    """Sign out every other device after a password change — the standard
    "someone might have my old password" response. Keeps the session the
    request itself authenticated with alive (matches Google/GitHub UX: you
    are not logged out of the device where you just changed the password).

    Security (BACKEND_AUDIT_2026-07-17.md High #10): previously a password
    change only cleared a 10-second in-memory cache — every other
    already-issued session/token stayed valid for its full lifetime, so
    changing a compromised password did not actually lock an attacker out."""
    current_sid = None
    if authorization and authorization.lower().startswith("bearer "):
        try:
            current_sid = decode_token(authorization.split(" ", 1)[1].strip()).get("session_id")
        except HTTPException:
            current_sid = None
    query: dict = {"user_type": kind, "user_id": user_id, "revoked": {"$ne": True}}
    if current_sid:
        query["id"] = {"$ne": current_sid}
    await db.user_sessions.update_many(query, {"$set": {"revoked": True}})


@router.post("/login", response_model=TokenResponse)
async def staff_login(body: LoginPayload, request: Request):
    ip = _client_ip(request)
    identifier = normalize_login_id(body.email)
    await reserve_login_attempt(ip, identifier)
    if is_known_default_password(body.password):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    # Email is already unique. Usernames are explicitly stored normalized and
    # separately indexed; full names never become an implicit login alias.
    query = {"email": identifier} if "@" in identifier else {"login_id_key": identifier}
    doc = await db.users.find_one(query, {"_id": 0})
    if not doc or not verify_password(body.password, doc.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not doc.get("active", True):
        raise HTTPException(status_code=403, detail="Account disabled")
    if doc.get("must_change_password") and is_temp_password_expired(doc.get("temp_password_expires_at")):
        raise HTTPException(
            status_code=401,
            detail="This temporary password has expired. Ask an admin to reset it again.",
        )
    if doc.get("mfa_enabled"):
        await mfa.consume_factor(doc, body.mfa_code, body.recovery_code)
    await clear_login_attempts(ip, identifier)
    sid = await create_session("staff", doc["id"], request, login_method="password+mfa" if doc.get("mfa_enabled") else "password")
    if doc.get("mfa_enabled"):
        await db.user_sessions.update_one({"id": sid}, {"$set": {"mfa_verified": True, "mfa_version": doc.get("mfa_version", 0)}})
    token = create_token(doc["id"], "staff", {
        "role": doc["role"], "session_id": sid, "access_profile": doc.get("access_profile"),
        "custom_access": bool(doc.get("custom_access")),
    })
    doc.pop("password_hash", None)
    await log_event(
        event_type="user.login", entity_type="user", entity_id=doc["id"],
        actor_id=doc["id"], actor_name=doc.get("full_name"), summary="Staff Login",
    )
    return TokenResponse(access_token=token, user=apply_effective_floor_ids(UserPublic(**doc)))


@router.get("/me", response_model=UserPublic)
async def staff_me(user: UserPublic = Depends(get_current_user)):
    return user


@router.post("/change-password")
async def staff_change_password(
    body: ChangePasswordPayload,
    request: Request,
    user: UserPublic = Depends(get_current_user),
    authorization: Optional[str] = Header(None),
):
    """Settings > Account > Password. Also the exit path from a forced
    password change after Team > Reset Password issued a temporary one —
    clears must_change_password/temp_password_expires_at on success.

    Security: a valid session token alone (stolen or leaked) doesn't hand an
    attacker the account — they still need the CURRENT password, and this
    endpoint was the one path into that check with no throttling at all.
    Reuses the same (ip, identifier) rate limiter as /login, keyed on the
    user's own id rather than email so it's scoped per-account regardless of
    what email is on file."""
    ip = _client_ip(request)
    await reserve_login_attempt(ip, f"staff-pw:{user.id}")
    doc = await db.users.find_one({"id": user.id}, {"_id": 0, "password_hash": 1})
    if not doc or not verify_password(body.current_password, doc.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    await clear_login_attempts(ip, f"staff-pw:{user.id}")
    await db.users.update_one(
        {"id": user.id},
        {"$set": {
            "password_hash": hash_password(body.new_password),
            "must_change_password": False,
            "temp_password_expires_at": None,
            "updated_at": now_iso(),
        }},
    )
    invalidate_principal_cache("staff", user.id)
    await _revoke_other_sessions("staff", user.id, authorization)
    return {"changed": True}


@router.post("/customer/login", response_model=CustomerTokenResponse)
async def customer_login(body: CustomerLoginPayload, request: Request):
    ip = _client_ip(request)
    await reserve_login_attempt(ip, body.email)
    if is_known_default_password(body.password):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    doc = await db.customers.find_one({"email": body.email.lower()}, {"_id": 0})
    if not doc or not doc.get("password_hash") or not verify_password(body.password, doc["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not doc.get("portal_enabled"):
        raise HTTPException(status_code=403, detail="Portal access is disabled for this account. Contact your account manager.")
    if doc.get("must_change_password") and is_temp_password_expired(doc.get("temp_password_expires_at")):
        raise HTTPException(
            status_code=401,
            detail="This temporary password has expired. Ask your account manager to resend the invite.",
        )
    await clear_login_attempts(ip, body.email)
    sid = await create_session("customer", doc["id"], request, login_method="password")
    token = create_token(doc["id"], "customer", {"session_id": sid})
    doc.pop("password_hash", None)
    await log_event(
        event_type="customer.portal_login", entity_type="customer", entity_id=doc["id"],
        customer_id=doc["id"], actor_id=doc["id"], actor_name=doc.get("name"),
        summary="Customer Portal Login",
    )
    return CustomerTokenResponse(access_token=token, customer=CustomerPublic(**doc))


@router.post("/customer/change-password")
async def customer_change_password(
    body: ChangePasswordPayload,
    request: Request,
    cust: CustomerPublic = Depends(get_current_customer),
    authorization: Optional[str] = Header(None),
):
    """Customer Portal > exit path from a forced password change after
    Send Invite / Reset Password issued a temporary one. Same rate-limit
    reasoning as staff_change_password above."""
    ip = _client_ip(request)
    await reserve_login_attempt(ip, f"customer-pw:{cust.id}")
    doc = await db.customers.find_one({"id": cust.id}, {"_id": 0, "password_hash": 1})
    if not doc or not doc.get("password_hash") or not verify_password(body.current_password, doc["password_hash"]):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    await clear_login_attempts(ip, f"customer-pw:{cust.id}")
    await db.customers.update_one(
        {"id": cust.id},
        {"$set": {
            "password_hash": hash_password(body.new_password),
            "must_change_password": False,
            "temp_password_expires_at": None,
            "updated_at": now_iso(),
        }},
    )
    invalidate_principal_cache("customer", cust.id)
    await _revoke_other_sessions("customer", cust.id, authorization)
    return {"changed": True}


@router.get("/customer/me", response_model=CustomerPublic)
async def customer_me(cust: CustomerPublic = Depends(get_current_customer)):
    return cust


# ---------- Session management (works for either staff or customer token) ----------

def _principal_from_token(authorization: Optional[str]) -> tuple[str, str, Optional[str]]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    payload = decode_token(authorization.split(" ", 1)[1].strip())
    kind, sub, sid = payload.get("kind"), payload.get("sub"), payload.get("session_id")
    if kind not in ("staff", "customer") or not sub:
        raise HTTPException(status_code=401, detail="Invalid token")
    return kind, sub, sid


@router.post("/logout")
async def logout_current_session(authorization: Optional[str] = Header(None)):
    """Revoke only the current device's session (regular sign-out — NOT
    'logout everywhere'). Safe to call even for legacy tokens without a
    session_id (no-op in that case)."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return {"revoked": False}
    try:
        payload = decode_token(authorization.split(" ", 1)[1].strip())
    except HTTPException:
        return {"revoked": False}
    sid = payload.get("session_id")
    if not sid:
        return {"revoked": False}
    invalidate_principal_cache(payload.get("kind", ""), payload.get("sub", ""), sid)
    await db.user_sessions.update_one({"id": sid}, {"$set": {"revoked": True}})
    return {"revoked": True}


@router.get("/sessions", response_model=list[SessionInfo])
async def list_sessions(session: tuple[str, str, str] = Depends(get_current_session)):
    """Active devices/browsers for the signed-in user — 'remember trusted devices'."""
    kind, sub, current_sid = session
    docs = await db.user_sessions.find(
        {"user_type": kind, "user_id": sub, "revoked": {"$ne": True}}, {"_id": 0},
    ).sort("last_seen_at", -1).to_list(100)
    return [
        SessionInfo(
            id=d["id"], device_label=d.get("device_label"), login_method=d.get("login_method", "password"),
            created_at=d["created_at"], last_seen_at=d["last_seen_at"], current=(d["id"] == current_sid),
        )
        for d in docs
    ]


@router.post("/sessions/logout-all")
async def logout_all_sessions(session: tuple[str, str, str] = Depends(get_current_session)):
    """Revoke every active session for this user — 'logout from all devices'."""
    kind, sub, _ = session
    invalidate_principal_cache(kind, sub)
    res = await db.user_sessions.update_many(
        {"user_type": kind, "user_id": sub, "revoked": {"$ne": True}}, {"$set": {"revoked": True}},
    )
    return {"revoked_count": res.modified_count}


@router.delete("/sessions/{session_id}")
async def revoke_one_session(session_id: str, session: tuple[str, str, str] = Depends(get_current_session)):
    kind, sub, _ = session
    invalidate_principal_cache(kind, sub, session_id)
    res = await db.user_sessions.update_one(
        {"id": session_id, "user_type": kind, "user_id": sub}, {"$set": {"revoked": True}},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"revoked": True}


# MFA applies to every enrolled staff account, including owner/admin. Unenrolled
# operators remain usable until enrollment is completed with password + TOTP.
async def _mfa_password(body: MFAProofPayload, request: Request, user: UserPublic) -> dict:
    await reserve_login_attempt(_client_ip(request), f"staff-mfa:{user.id}")
    doc = await db.users.find_one({"id": user.id}, {"_id": 0})
    if not doc or not verify_password(body.current_password, doc.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    return doc


async def _mfa_sessions(user: UserPublic, version: int, enabled: bool) -> None:
    # Never revive a session concurrently revoked by password reset or logout.
    invalidate_principal_cache("staff", user.id)
    query = {"user_type": "staff", "user_id": user.id, "revoked": {"$ne": True}}
    if user.session_id:
        query["id"] = {"$ne": user.session_id}
    await db.user_sessions.update_many(query, {"$set": {"revoked": True}})
    if user.session_id:
        await db.user_sessions.update_one(
            {"id": user.session_id, "user_type": "staff", "user_id": user.id, "revoked": {"$ne": True}},
            {"$set": {"mfa_verified": enabled, "mfa_version": version}},
        )


@router.get("/mfa/status")
async def mfa_status(user: UserPublic = Depends(get_current_user)):
    doc = await db.users.find_one({"id": user.id}, {"_id": 0, "mfa_enabled": 1, "mfa_recovery_hashes": 1}) or {}
    return {"enabled": bool(doc.get("mfa_enabled")), "recovery_codes_remaining": len(doc.get("mfa_recovery_hashes", []))}


@router.post("/mfa/enroll")
async def mfa_enroll(body: MFAProofPayload, request: Request, user: UserPublic = Depends(get_current_user)):
    doc = await _mfa_password(body, request, user)
    if doc.get("mfa_enabled"):
        raise HTTPException(status_code=409, detail="Authenticator MFA is already enabled")
    pending, public = mfa.pending_enrollment(user.id, user.email)
    result = await db.users.update_one(
        {"id": user.id, "mfa_enabled": {"$ne": True}, "password_hash": doc["password_hash"]},
        {"$set": {"mfa_pending": pending}},
    )
    if result.matched_count != 1:
        raise HTTPException(status_code=409, detail="Account changed; restart enrollment")
    return public


@router.post("/mfa/confirm")
async def mfa_confirm(body: MFAProofPayload, request: Request, user: UserPublic = Depends(get_current_user)):
    doc = await _mfa_password(body, request, user)
    pending = doc.get("mfa_pending") or {}
    expires = pending.get("expires_at")
    if isinstance(expires, datetime) and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if doc.get("mfa_enabled") or not isinstance(expires, datetime) or expires <= datetime.now(timezone.utc):
        raise HTTPException(status_code=409, detail="Enrollment expired; restart setup")
    secret = mfa.decrypt_secret(pending.get("secret_encrypted", ""), user.id)
    counter = mfa.matching_counter(secret, body.mfa_code or "")
    if counter is None or body.recovery_code:
        raise HTTPException(status_code=401, detail="Enter a valid authenticator code")
    codes, hashed = mfa.new_recovery_codes()
    result = await db.users.update_one(
        {"id": user.id, "mfa_enabled": {"$ne": True}, "password_hash": doc["password_hash"],
         "mfa_pending.secret_encrypted": pending["secret_encrypted"], "mfa_pending.expires_at": {"$gt": datetime.now(timezone.utc)}},
        {"$set": {"mfa_enabled": True, "mfa_secret_encrypted": pending["secret_encrypted"],
                  "mfa_recovery_hashes": hashed, "mfa_last_counter": counter},
         "$inc": {"mfa_version": 1}, "$unset": {"mfa_pending": ""}},
    )
    if result.modified_count != 1:
        raise HTTPException(status_code=409, detail="Enrollment changed; restart setup")
    await _mfa_sessions(user, doc.get("mfa_version", 0) + 1, True)
    await log_event(event_type="user.mfa_updated", entity_type="user", entity_id=user.id, actor=user, summary="Authenticator security updated")
    return {"enabled": True, "recovery_codes": codes}


@router.post("/mfa/recovery")
async def mfa_recovery(body: MFAProofPayload, request: Request, user: UserPublic = Depends(get_current_user)):
    doc = await _mfa_password(body, request, user)
    await mfa.consume_factor(doc, body.mfa_code, body.recovery_code)
    codes, hashed = mfa.new_recovery_codes()
    result = await db.users.update_one(
        {"id": user.id, "mfa_enabled": True, "mfa_version": doc.get("mfa_version", 0), "password_hash": doc["password_hash"]},
        {"$set": {"mfa_recovery_hashes": hashed}, "$inc": {"mfa_version": 1}},
    )
    if result.modified_count != 1:
        raise HTTPException(status_code=409, detail="Account changed; try again")
    await _mfa_sessions(user, doc.get("mfa_version", 0) + 1, True)
    await log_event(event_type="user.mfa_updated", entity_type="user", entity_id=user.id, actor=user, summary="Authenticator security updated")
    return {"enabled": True, "recovery_codes": codes}


@router.post("/mfa/disable")
async def mfa_disable(body: MFAProofPayload, request: Request, user: UserPublic = Depends(get_current_user)):
    doc = await _mfa_password(body, request, user)
    await mfa.consume_factor(doc, body.mfa_code, body.recovery_code)
    result = await db.users.update_one(
        {"id": user.id, "mfa_enabled": True, "mfa_version": doc.get("mfa_version", 0), "password_hash": doc["password_hash"]},
        {"$set": {"mfa_enabled": False}, "$inc": {"mfa_version": 1},
         "$unset": {"mfa_secret_encrypted": "", "mfa_recovery_hashes": "", "mfa_last_counter": "", "mfa_pending": ""}},
    )
    if result.modified_count != 1:
        raise HTTPException(status_code=409, detail="Account changed; try again")
    await _mfa_sessions(user, doc.get("mfa_version", 0) + 1, False)
    await log_event(event_type="user.mfa_disabled", entity_type="user", entity_id=user.id, actor=user, summary="Authenticator MFA disabled")
    return {"enabled": False}
