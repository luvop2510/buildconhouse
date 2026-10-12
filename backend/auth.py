"""JWT + password hashing + role-based dependencies."""
from __future__ import annotations
import asyncio
from datetime import datetime, timedelta, timezone
from time import monotonic
from typing import Any, Optional
from uuid import uuid4

import bcrypt
import jwt
from fastapi import Depends, Header, HTTPException, Query, Request

from db import db
from models import Role, UserPublic, CustomerPublic
from settings import settings
from access_profiles import profile_allows_request
from services.access_grants import action_for_api_request, granted_floor_ids, grants_for_user, is_common_access_request, request_resource

JWT_SECRET = settings.jwt_secret
JWT_ALG = settings.jwt_algorithm
JWT_EXP_MIN = settings.jwt_exp_minutes


# Atlas is geographically remote from the preview runtime (~229 ms RTT). Every
# authenticated endpoint previously paid two sequential reads (session + user)
# before its own business query. Cache only a successfully validated principal
# for a deliberately short window: logout/session revocation remains bounded to
# 10 seconds, while normal page waterfalls avoid repeating the same two reads.
_PRINCIPAL_CACHE_TTL_SECONDS = 10.0
_PRINCIPAL_CACHE_MAX_ENTRIES = 2048
_principal_cache: dict[tuple[str, str, str], tuple[float, dict]] = {}
_principal_cache_generation = 0


def _cached_principal(kind: str, subject: str, session_id: str | None) -> dict | None:
    key = (kind, subject, session_id or "")
    hit = _principal_cache.get(key)
    if not hit:
        return None
    expires_at, doc = hit
    if expires_at <= monotonic():
        _principal_cache.pop(key, None)
        return None
    return doc.copy()


def _cache_principal(kind: str, subject: str, session_id: str | None, doc: dict) -> None:
    if len(_principal_cache) >= _PRINCIPAL_CACHE_MAX_ENTRIES:
        now = monotonic()
        expired = [key for key, (expires_at, _) in _principal_cache.items() if expires_at <= now]
        for key in expired:
            _principal_cache.pop(key, None)
        if len(_principal_cache) >= _PRINCIPAL_CACHE_MAX_ENTRIES:
            _principal_cache.pop(next(iter(_principal_cache)))
    _principal_cache[(kind, subject, session_id or "")] = (
        monotonic() + _PRINCIPAL_CACHE_TTL_SECONDS,
        doc.copy(),
    )


def invalidate_principal_cache(kind: str, subject: str, session_id: str | None = None) -> None:
    """Invalidate one session or every cached session for a principal."""
    # A read already in flight may have captured pre-revocation state. A
    # single bounded generation prevents it from putting that state back
    # after invalidation, without retaining per-user tombstones forever.
    global _principal_cache_generation
    _principal_cache_generation += 1
    if session_id is not None:
        _principal_cache.pop((kind, subject, session_id), None)
        return
    for key in [key for key in _principal_cache if key[0] == kind and key[1] == subject]:
        _principal_cache.pop(key, None)


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(pw: str, pw_hash: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode("utf-8"), pw_hash.encode("utf-8"))
    except Exception:
        return False


def create_token(subject: str, kind: str, extra: Optional[dict] = None) -> str:
    payload = {
        "sub": subject,
        "kind": kind,  # "staff" | "customer"
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=JWT_EXP_MIN),
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.PyJWTError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}") from e


def _extract_token(authorization: Optional[str]) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    return authorization.split(" ", 1)[1].strip()


async def _load_active_principal(payload: dict, *, kind: str, collection: str) -> dict:
    """Validate session + active principal, using a short safe cache on success."""
    subject = payload["sub"]
    session_id = payload.get("session_id")
    cached = _cached_principal(kind, subject, session_id)
    if cached:
        return cached

    # Security (BACKEND_AUDIT_2026-07-17.md High #8): a token without a
    # session_id used to skip the user_sessions check entirely and stay
    # valid until raw JWT expiry (up to JWT_EXP_MINUTES), with no revocation
    # path short of deactivating the whole account — logout/"sign out all
    # devices"/credential rotation could not touch it. Every login path
    # (staff, customer, Google, both) has embedded session_id since sessions
    # were introduced, so this is no longer a compatibility branch worth
    # keeping; a token without one is now simply invalid.
    if not session_id:
        raise HTTPException(status_code=401, detail="Session expired or was signed out. Please sign in again.")

    generation = _principal_cache_generation
    session_filter = {
        "id": session_id,
        "user_type": kind,
        "user_id": subject,
        "revoked": {"$ne": True},
    }
    session_doc, principal = await asyncio.gather(
        db.user_sessions.find_one(session_filter, {"_id": 0, "id": 1, "mfa_verified": 1, "mfa_version": 1}),
        db[collection].find_one({"id": subject}, {"_id": 0, "password_hash": 0,
            "mfa_secret_encrypted": 0, "mfa_pending": 0, "mfa_recovery_hashes": 0}),
    )
    if not session_doc:
        raise HTTPException(status_code=401, detail="Session expired or was signed out. Please sign in again.")
    # Best-effort "last seen" bump — never block the request on this.
    asyncio.ensure_future(db.user_sessions.update_one(
        {"id": session_id},
        {"$set": {"last_seen_at": datetime.now(timezone.utc).isoformat()}},
    ))

    if not principal or not principal.get("active", True):
        raise HTTPException(status_code=401, detail=(
            "User not found or inactive" if kind == "staff" else "Customer not found"
        ))
    if kind == "staff" and principal.get("mfa_enabled") and (
        session_doc.get("mfa_verified") is not True
        or session_doc.get("mfa_version") != principal.get("mfa_version", 0)
    ):
        raise HTTPException(status_code=401, detail="Second-factor verification is required. Please sign in again.")
    if generation == _principal_cache_generation:
        _cache_principal(kind, subject, session_id, principal)
    return principal


def _enforce_password_change(principal: dict, request: Request | None, *, kind: str) -> None:
    """Customer temporary credentials retain their first-login requirement.

    Staff credentials are permanently managed by the owner, including legacy
    accounts provisioned with the former temporary-password flags.
    """
    if kind == "staff":
        return
    if not principal.get("must_change_password"):
        return
    path = request.url.path if request else ""
    allowed = {
        "/api/auth/change-password" if kind == "staff" else "/api/auth/customer/change-password",
        "/api/auth/logout",
        "/api/auth/me" if kind == "staff" else "/api/auth/customer/me",
    }
    if path not in allowed:
        raise HTTPException(status_code=403, detail="password_change_required")


def apply_staff_password_policy(principal: dict) -> dict:
    """Do not expose obsolete staff onboarding restrictions to older clients."""
    normalized = {**principal, "must_change_password": False, "temp_password_expires_at": None}
    if principal.get("role") == "owner":
        normalized.update(access_profile=None, custom_access=False, floor_ids=[])
    return normalized


async def authorize_staff_request(user: UserPublic, request: Request | None) -> UserPublic:
    """Bind current profile/grants to every staff authentication path.

    Request-local floor constraints are private model metadata: response and
    persisted user fields retain the account's normal assignments.
    """
    if user.role == "owner":
        return user
    if request is None:
        if user.custom_access:
            raise HTTPException(status_code=403, detail="Custom access requires request context")
        return user
    path = request.url.path
    if not profile_allows_request(user.access_profile, request.method, path):
        raise HTTPException(status_code=403, detail="This account is not permitted to use this function")
    if user.custom_access and not is_common_access_request(request.method, path):
        action = action_for_api_request(request.method, path, request.query_params)
        cached_grants = getattr(request.state, "staff_access_grants", None)
        if cached_grants and cached_grants[0] == user.id:
            grants = cached_grants[1]
        else:
            grants = await grants_for_user(db, user.id)
            request.state.staff_access_grants = (user.id, grants)
        resource = await request_resource(db, path, request.query_params)
        if resource in {"notebook_walkins", "notebook_quotations"} and (path.count("/") > 4 or path.endswith("/contact")):
            object.__setattr__(user, "_custom_notebook_converted", resource == "notebook_quotations")
        floors = granted_floor_ids(grants, user_id=user.id, path=path, action=action, resource=resource, method=request.method) if action else []
        object.__setattr__(user, "_custom_grant_floor_ids", floors)
        permitted = accessible_floor_ids(user)
        if permitted == [] or (user.active_floor_id and permitted is not None and user.active_floor_id not in permitted):
            raise HTTPException(status_code=403, detail="This account is not permitted to use this function")
    return user


def _device_label(user_agent: Optional[str]) -> str:
    if not user_agent:
        return "Unknown device"
    ua = user_agent.lower()
    if "chrome" in ua and "edg" not in ua:
        browser = "Chrome"
    elif "crios" in ua:
        browser = "Chrome"
    elif "firefox" in ua:
        browser = "Firefox"
    elif "edg" in ua:
        browser = "Edge"
    elif "safari" in ua:
        browser = "Safari"
    else:
        browser = "Browser"
    if "iphone" in ua or "ipad" in ua:
        osname = "iOS"
    elif "android" in ua:
        osname = "Android"
    elif "mac os" in ua:
        osname = "macOS"
    elif "windows" in ua:
        osname = "Windows"
    elif "linux" in ua:
        osname = "Linux"
    else:
        osname = "device"
    return f"{browser} on {osname}"


async def create_session(
    user_type: str, user_id: str, request: Optional[Request], login_method: str = "password",
) -> str:
    """Record a device/browser session. Returns the session_id to embed in
    the JWT (`extra={"session_id": sid}` on create_token)."""
    sid = str(uuid4())
    ua = request.headers.get("user-agent") if request else None
    ip = (request.client.host if request and request.client else None)
    now = datetime.now(timezone.utc).isoformat()
    await db.user_sessions.insert_one({
        "id": sid, "user_type": user_type, "user_id": user_id, "login_method": login_method,
        "device_label": _device_label(ua), "user_agent": ua, "ip": ip,
        "created_at": now, "last_seen_at": now, "revoked": False,
    })
    return sid


def _download_request_target(request: Request) -> str:
    """Canonical path+query used to bind a browser download token."""
    pairs = [(key, value) for key, value in request.query_params.multi_items() if key != "dl"]
    query = "&".join(f"{key}={value}" for key, value in pairs)
    return f"{request.url.path}{'?' + query if query else ''}"


async def get_current_user(
    request: Request = None,
    authorization: Optional[str] = Header(None),
    x_floor_id: Optional[str] = Header(None, alias="X-Floor-Id"),
    dl: Optional[str] = Query(None, description="Short-lived single-use token for browser-download URLs (see POST /downloads/token)"),
) -> UserPublic:
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    if not token and dl:
        # Browser-download navigations (PDF/xlsx) can't send an Authorization
        # header, so they use a one-shot opaque token minted moments earlier
        # instead of embedding the real JWT in the URL. See services/download_tokens.py.
        from services.download_tokens import consume_download_token
        if request is None:
            raise HTTPException(status_code=401, detail="Download request context is required")
        record = await consume_download_token(dl, target=_download_request_target(request))
        if not record or record.get("kind", "staff") != "staff":
            raise HTTPException(status_code=401, detail="Download link expired or already used — reopen it from the app.")
        # The session_id recorded at mint time is replayed here. Without it
        # `_load_active_principal` sees a session-less payload and rejects it
        # outright (that check was tightened after download tokens shipped),
        # which 401'd every browser download — PDFs, chalans and exports
        # alike. Carrying it through also keeps download links revocable
        # along with the session that created them.
        doc = await _load_active_principal(
            {"sub": record["user_id"], "session_id": record.get("session_id")},
            kind="staff", collection="users",
        )
        _enforce_password_change(doc, request, kind="staff")
        user = apply_effective_floor_ids(UserPublic(**apply_staff_password_policy(doc)))
        # The header wins when present (it can be, for a fetch()-based
        # download); otherwise replay the floor recorded at mint time so the
        # download stays scoped to the unit the user was actually in.
        effective_floor = x_floor_id or record.get("floor_id")
        if effective_floor:
            allowed = accessible_floor_ids(user)
            if allowed is not None and effective_floor not in allowed:
                raise HTTPException(status_code=403, detail="You do not have access to this floor")
            user.active_floor_id = effective_floor
        user.session_id = record.get("session_id")
        return await authorize_staff_request(user, request)
    if not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    payload = decode_token(token)
    if payload.get("kind") != "staff":
        raise HTTPException(status_code=403, detail="Not a staff token")
    doc = await _load_active_principal(payload, kind="staff", collection="users")
    _enforce_password_change(doc, request, kind="staff")
    user = apply_effective_floor_ids(UserPublic(**apply_staff_password_policy(doc)))
    user.session_id = payload.get("session_id")
    if x_floor_id:
        allowed = accessible_floor_ids(user)
        if allowed is not None and x_floor_id not in allowed:
            raise HTTPException(status_code=403, detail="You do not have access to this floor")
        user.active_floor_id = x_floor_id
    return await authorize_staff_request(user, request)


async def get_current_customer(
    request: Request = None,
    authorization: Optional[str] = Header(None),
    dl: Optional[str] = Query(None, description="Short-lived single-use customer PDF download token"),
) -> CustomerPublic:
    if not authorization and dl:
        from services.download_tokens import consume_download_token
        if request is None:
            raise HTTPException(status_code=401, detail="Download request context is required")
        record = await consume_download_token(dl, target=_download_request_target(request))
        if not record or record.get("kind") != "customer":
            raise HTTPException(status_code=401, detail="Download link expired or already used — reopen it from the app.")
        doc = await _load_active_principal(
            {"sub": record["user_id"], "session_id": record.get("session_id")},
            kind="customer", collection="customers",
        )
        if not doc.get("portal_enabled"):
            raise HTTPException(status_code=403, detail="Portal access is disabled")
        _enforce_password_change(doc, request, kind="customer")
        return CustomerPublic(**doc)
    payload = decode_token(_extract_token(authorization))
    if payload.get("kind") != "customer":
        raise HTTPException(status_code=403, detail="Not a customer token")
    doc = await _load_active_principal(payload, kind="customer", collection="customers")
    if not doc.get("portal_enabled"):
        raise HTTPException(status_code=403, detail="Portal access is disabled")
    _enforce_password_change(doc, request, kind="customer")
    return CustomerPublic(**doc)


async def get_current_session(authorization: Optional[str] = Header(None)) -> tuple[str, str, str]:
    """Authenticated, unrevoked session identity for session-management APIs."""
    payload = decode_token(_extract_token(authorization))
    kind = payload.get("kind")
    if kind not in ("staff", "customer"):
        raise HTTPException(status_code=401, detail="Invalid token")
    subject = payload.get("sub")
    session_id = payload.get("session_id")
    if not subject or not session_id:
        raise HTTPException(status_code=401, detail="Session expired or was signed out. Please sign in again.")
    await _load_active_principal(payload, kind=kind, collection="users" if kind == "staff" else "customers")
    return kind, subject, session_id


async def revoke_all_sessions(kind: str, subject: str) -> int:
    """Invalidate every session after an administrator resets credentials."""
    invalidate_principal_cache(kind, subject)
    try:
        result = await db.user_sessions.update_many(
            {"user_type": kind, "user_id": subject, "revoked": {"$ne": True}},
            {"$set": {"revoked": True}},
        )
    finally:
        # Clear entries created while the write was pending, even when its
        # acknowledgement fails: the server may already have committed it.
        invalidate_principal_cache(kind, subject)
    return result.modified_count


# RBAC — capability sets keyed by role. Kept intentionally simple: routes just
# ask `require_roles("owner","admin","sales")`.
ROLE_HIERARCHY = {
    "owner": 100, "admin": 90, "manager": 70, "accounts": 60,
    "purchase": 50, "sales": 40, "warehouse": 30, "worker": 10,
}

# Single source of truth for display labels + human-readable capability blurbs
# per role. Exposed to the frontend via GET /api/roles (routes/roles_routes.py)
# so Team Management's "Assign role" picker and the Settings > Roles &
# permissions screen never hardcode the role list — if a role is ever
# renamed/added here, both screens update with zero frontend changes.
ROLE_LABELS: dict[str, str] = {
    "owner": "Owner", "admin": "Admin", "manager": "Manager", "accounts": "Accounts",
    "purchase": "Purchase", "sales": "Sales", "warehouse": "Warehouse", "worker": "Worker",
}

ROLE_CAPABILITIES: dict[str, list[str]] = {
    "owner": ["Everything, including team management and settings"],
    "admin": ["Company & PDF settings", "Catalog backup/export"],
    "manager": ["Approve catalog imports", "Full sales & purchase access"],
    "accounts": ["Payments & receivables", "Financial reporting"],
    "purchase": ["Purchase orders", "Catalog imports", "Supplier management"],
    "sales": ["Quotations", "Customers", "Follow-ups"],
    "warehouse": ["Stock movements", "Purchase receiving"],
    "worker": ["View-only access to assigned tasks"],
}


def require_owner(user: UserPublic = Depends(get_current_user)) -> UserPublic:
    """Account administration cannot be delegated through page grants."""
    if user.role != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can manage team accounts and passwords")
    return user


def require_roles(*allowed: Role):
    async def _dep(user: UserPublic = Depends(get_current_user)) -> UserPublic:
        # Custom allocations are an explicit, server-enforced allow-list in
        # ``server.enforce_access_profile``. Once that middleware has allowed
        # a request's resource, HTTP action, and floor, do not reintroduce a
        # broad role gate here: doing so would make an apparently granted
        # action unusable for a worker whose base role is intentionally low.
        # Sessions are revoked whenever a grant changes, so this cannot leave
        # an old custom allocation active.
        if user.custom_access:
            return user
        if user.role not in allowed:
            raise HTTPException(status_code=403, detail=f"Role '{user.role}' not allowed")
        return user
    return _dep


def require_min_role(min_role: Role):
    threshold = ROLE_HIERARCHY[min_role]

    async def _dep(user: UserPublic = Depends(get_current_user)) -> UserPublic:
        # See ``require_roles`` above. The custom-access middleware remains
        # the security boundary for custom allocations; role checks continue
        # to protect every standard (non-custom) account.
        if user.custom_access:
            return user
        if ROLE_HIERARCHY.get(user.role, 0) < threshold:
            raise HTTPException(status_code=403, detail="Insufficient role")
        return user
    return _dep


def has_all_floor_access(user: UserPublic) -> bool:
    return user.role == "owner" or (not getattr(user, "custom_access", False) and user.role == "manager")


PROFILE_FLOOR_IDS: dict[str, tuple[str, ...]] = {
    # Access profiles are workspaces, not merely menu filters. Binding them
    # here keeps their data scope in lockstep with the API allow-list, even
    # when an older staff row has stale floor_ids.
    "ground_tile_quotations_followups": ("ground-floor",),
    "ground_payments_dispatches": ("ground-floor",),
    "sanitary_quotations_followups": ("first-floor",),
    "sanitary_purchases": ("first-floor",),
}

# The profile allow-list grants exactly the workflow's API surface, but the
# normal route-level role gates still apply.  Keep the minimum role beside the
# profile binding so Team provisioning cannot create an account that can see a
# workspace but receives inexplicable 403s for its core actions.
PROFILE_MIN_ROLES: dict[str, Role] = {
    "ground_tile_quotations_followups": "sales",
    "ground_payments_dispatches": "accounts",
    "sanitary_quotations_followups": "sales",
    "sanitary_purchases": "purchase",
}


def profile_floor_ids(access_profile: str | None) -> list[str] | None:
    """Return the floor intrinsically assigned to a least-privilege profile."""
    floors = PROFILE_FLOOR_IDS.get(access_profile or "")
    return list(floors) if floors else None


def normalize_staff_access(*, role: Role, floor_ids: list[str], access_profile: str | None) -> tuple[Role, list[str]]:
    """Validate a staff assignment and apply the least role needed by a profile.

    A profile is authoritative for its floor.  Without one, every account
    below manager must be explicitly assigned at least one floor.  This is a
    security boundary, not a UI convenience: an empty assignment must never
    fall back to the legacy Sanitary Bathroom default.
    """
    if role == "owner":
        if access_profile is not None:
            raise HTTPException(status_code=422, detail="Owners use full access; delegate pages to staff accounts")
        return role, []
    profile_floors = profile_floor_ids(access_profile)
    if access_profile is not None and profile_floors is None:
        raise HTTPException(status_code=422, detail="Unknown access profile")
    if profile_floors is not None:
        minimum = PROFILE_MIN_ROLES[access_profile]
        if ROLE_HIERARCHY[role] < ROLE_HIERARCHY[minimum]:
            role = minimum
        floor_ids = profile_floors
    # Owners/managers are intentionally all-floor accounts. Everyone else
    # needs an explicit non-empty assignment, even if that user was loaded
    # from a legacy document without floor_ids.
    if role not in {"owner", "manager"} and not floor_ids:
        raise HTTPException(status_code=422, detail="Assign at least one floor to every non-owner, non-manager account")
    return role, list(dict.fromkeys(floor_ids))


def apply_effective_floor_ids(user: UserPublic) -> UserPublic:
    """Expose profile-bound floors consistently in authentication responses."""
    if user.role == "owner":
        user.access_profile = None
        user.custom_access = False
        user.floor_ids = []
        return user
    profile_floors = profile_floor_ids(user.access_profile)
    if profile_floors is not None:
        user.floor_ids = profile_floors
    return user


def accessible_floor_ids(user: UserPublic) -> list[str] | None:
    """None means all active floors; otherwise return explicit assignments."""
    if user.role == "owner":
        return None
    profile = getattr(user, "access_profile", None)
    profile_floors = profile_floor_ids(profile)
    if profile_floors is not None:
        allowed = profile_floors
    # A malformed legacy profile is fail-closed, rather than becoming a
    # normal staff account through an accidental typo or partial migration.
    elif profile is not None:
        allowed = []
    else:
        allowed = None if has_all_floor_access(user) else list(user.floor_ids or [])
    granted = getattr(user, "_custom_grant_floor_ids", None)
    if granted is not None:
        return list(granted) if allowed is None else [floor for floor in allowed if floor in granted]
    return allowed


def _resolve_floor_scope(user: UserPublic) -> list[str]:
    """Single source of truth for turning a caller into a concrete, non-empty
    list of floor ids — shared by every read helper below (`floor_query`,
    `floor_scope_ids`) AND `floor_for_write`.

    Historically these disagreed for one caller: an all-floors user
    (owner/manager) with no `active_floor_id` set. `floor_query()` treated
    that as "no floor filter at all" (reads BOTH business units in one
    call), while `floor_for_write()` picked a single floor
    ("first-floor"/Sanitary). Same caller, same request, read everything but
    wrote to one floor.

    That state is unreachable from the product today — the shell always
    pins a concrete `active_floor_id` immediately after login (see
    frontend/src/state/auth.tsx, frontend/src/hooks/use-floor-access.ts),
    and the one screen with a genuine "both floors" concept (Sales Data,
    routes/sales_data_routes.py) never calls floor_query() at all — it
    resolves its own explicit floor list from a query param, independent of
    `active_floor_id`. So no legitimate all-floors *read* depends on
    floor_query()'s old unrestricted branch (see task-5-report.md for the
    call-site survey), which makes it safe to narrow reads to match writes,
    per this function's single resolution used by both.

    Reads now share floor_for_write's existing, already-tested single-floor
    default (see tests/unit/test_quotation_floor_id_from_items.py) rather
    than raising: floor_for_write's default is depended on by real, tested
    write-path fallback logic (_floor_id_for_new_quotation in
    routes/quotation_routes.py), so changing that default — or replacing it
    with a hard error — would break currently-passing behavior for no
    isolation benefit. Mirroring it into reads closes the asymmetry without
    touching that contract.
    """
    allowed = accessible_floor_ids(user)
    if user.active_floor_id:
        # Never trust a persisted/request-scoped selection by itself: a
        # restricted account could otherwise construct UserPublic directly
        # with a floor it is not assigned.
        if allowed is None or user.active_floor_id in allowed:
            return [user.active_floor_id]
        return []
    if allowed is not None:
        return list(allowed)  # [] is a deliberate deny-all scope.
    return ["first-floor"]


def floor_query(user: UserPublic, base: dict | None = None) -> dict:
    """Compose a Mongo filter that scopes staff to their assigned floors."""
    base = base or {}
    scope = {"floor_id": {"$in": _resolve_floor_scope(user)}}
    return {"$and": [scope, base]} if base else scope


def floor_scope_ids(user: UserPublic) -> list[str]:
    """Resolve the caller's floor filter the same way `floor_query()` does
    for Mongo-filter-based queries, but as a plain list — for callers that
    build their own aggregation pipeline or in-memory filter rather than
    taking a Mongo filter dict."""
    return _resolve_floor_scope(user)


def floor_for_write(user: UserPublic) -> str:
    scope = _resolve_floor_scope(user)
    if not scope:
        raise HTTPException(status_code=403, detail="No floor access is assigned to this account")
    return scope[0]


def floor_inherit(source: dict | None) -> str:
    """Records derived from an existing document (quotation, PO, transfer,
    shortage, ...) stay on that source's floor rather than defaulting to
    first-floor, which would silently mix floors once non-default-floor
    records exist."""
    return (source or {}).get("floor_id", "first-floor")


def require_floor_access(floor_id: str, user: UserPublic) -> UserPublic:
    allowed = accessible_floor_ids(user)
    if allowed is not None and floor_id not in allowed:
        raise HTTPException(status_code=403, detail="You do not have access to this floor")
    return user


# The Tiles domain — tile quotations/selections, tile orders, brand
# releases, godown moves, dispatches, chalans and the material movement
# register — exists on Ground Floor and nowhere else.
TILES_FLOOR_ID = "ground-floor"


def tiles_floor_query(user: UserPublic, base: dict | None = None) -> dict:
    """Scope a Tiles-domain query to Ground Floor unconditionally.

    Deliberately does NOT go through `floor_query()`: that resolves the
    caller's ambient `X-Floor-Id` selection, which is exactly the wrong
    input here. An all-floors owner/manager sends no header at all while
    on the "All floors" view (yielding an unscoped query that returns
    every floor's records), and a stale/sticky selection can leave the
    header pointing at another floor entirely — both routes leaked
    Sanitary-Bathroom records into Tile Orders screens. Floor for this
    domain is a constant, so it is filtered in the database on every
    query rather than inherited from request state.
    """
    require_floor_access(TILES_FLOOR_ID, user)
    scope = {"floor_id": TILES_FLOOR_ID}
    return {"$and": [scope, base]} if base else scope


async def get_floor_scoped_or_404(
    collection: Any, doc_id: str, user: UserPublic, *,
    id_field: str = "id", not_found: str = "Not found",
    projection: dict | None = None, session: Any = None,
) -> dict:
    """Fetch a record by its own ID — never pre-filtered by the caller's
    ambient active-floor selection — then authorize against the record's
    OWN floor_id. Use this for every endpoint addressed by a specific
    record ID instead of `floor_query(user, {id_field: doc_id})`: filtering
    the initial query by ambient state 404s a legitimate request whenever
    that ambient state doesn't happen to match the record, even though the
    record exists and the caller genuinely has access to it.

    Cross-unit access raises 404, not 403 (owner decision 2026-08-02): the
    two business units behave as independent companies, so a 403 — which
    confirms "this id exists, just not for you" — is itself an existence
    oracle across the unit boundary. The detail is byte-identical to the
    genuinely-missing case for the same reason. A record with no floor_id
    is inaccessible rather than defaulting to Sanitary (first-floor) — the
    exact mistake migration 0014's design rejects."""
    doc = await collection.find_one({id_field: doc_id}, projection, session=session)
    if not doc:
        raise HTTPException(status_code=404, detail=not_found)
    floor_id = doc.get("floor_id")
    allowed = accessible_floor_ids(user)
    if floor_id is None or (allowed is not None and floor_id not in allowed):
        raise HTTPException(status_code=404, detail=not_found)
    return doc
