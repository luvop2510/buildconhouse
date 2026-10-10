"""Server-enforced per-user capabilities and explicit API operation policy."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable
from uuid import uuid4
from re import fullmatch


# Resource names are stable API/UI concepts, not URL prefixes.  Keeping this
# registry explicit prevents a typo in stored Mongo data from becoming an
# unexpected authorization bypass.
RESOURCE_REGISTRY: dict[str, dict[str, str]] = {
    "dashboard": {"label": "Dashboard"},
    "quotations": {"label": "Quotations"},
    "tiles": {"label": "Tile quotations"},
    "catalog": {"label": "Catalog"},
    "customers": {"label": "Customers"},
    "purchases": {"label": "Purchases"},
    "godown_stock": {"label": "Godown stock"},
    "payments": {"label": "Payments"},
    "followups": {"label": "Follow-ups"},
    "orders": {"label": "Tile orders & dispatches"},
    "walkins": {"label": "Walk-ins"},
    "reports": {"label": "Reports"},
    "notifications": {"label": "Notifications"},
}

ACTIONS = frozenset({"view", "create", "update", "delete", "export"})
HTTP_ACTIONS = {
    "GET": "view", "HEAD": "view", "POST": "create",
    "PUT": "update", "PATCH": "update", "DELETE": "delete",
}

# The intentionally small set of endpoints a custom-grant user needs to
# establish a session and render an authorized shell. Everything else must
# resolve through the registry below; unknown business endpoints deny rather
# than silently inheriting the role hierarchy.
CUSTOM_ACCESS_COMMON_PATHS = frozenset({
    "/api/auth/me", "/api/auth/logout", "/api/auth/change-password",
    "/api/auth/sessions", "/api/settings/floor-access", "/api/settings/floors",
    "/api/settings/permission-matrix", "/api/roles", "/api/downloads/token",
    "/api/settings/access-grants/me",
    "/api/exports/page.xlsx",
})


def is_common_access_request(method: str, path: str) -> bool:
    """Shell/session exemptions are actions, never unrestricted URL prefixes."""
    method = method.upper()
    if (method, path) in MFA_ACCOUNT_REQUESTS:
        return True
    if method == "GET":
        return path in CUSTOM_ACCESS_COMMON_PATHS - {"/api/downloads/token", "/api/exports/page.xlsx", "/api/auth/logout", "/api/auth/change-password"}
    if method == "POST":
        return path in {"/api/auth/logout", "/api/auth/change-password", "/api/auth/sessions/logout-all", "/api/downloads/token", "/api/exports/page.xlsx"}
    return method == "DELETE" and fullmatch(r"/api/auth/sessions/[^/]+", path) is not None


MFA_ACCOUNT_REQUESTS = frozenset({
    ("GET", "/api/auth/mfa/status"),
    ("POST", "/api/auth/mfa/enroll"), ("POST", "/api/auth/mfa/confirm"),
    ("POST", "/api/auth/mfa/disable"), ("POST", "/api/auth/mfa/recovery"),
})

# These POST commands modify existing business records. Full matching keeps
# unrelated child creation routes and future endpoints from inheriting an
# action merely because their name contains "move", "cancel", or "confirm".
POST_UPDATE_ROUTE_PATTERNS = (
    r"/api/quotations/[^/]+/items/[^/]+/cancel",
    r"/api/quotations/[^/]+/move-to-quotation",
    r"/api/quotations/[^/]+/place-order/confirm",
    r"/api/quotations/[^/]+/use-godown-stock",
    r"/api/purchases/items/[^/]+/move",
    r"/api/purchases/items/[^/]+/cancel",
    r"/api/purchases/items/bulk-move",
    r"/api/purchases/items/[^/]+/transfer",
    r"/api/purchases/legacy/items/[^/]+/transfer",
    r"/api/purchases/transfers/[^/]+/return",
    r"/api/purchases/settings",
    r"/api/purchases/shortages/[^/]+/dismiss",
    r"/api/purchases/[^/]+/chalans/[^/]+/godown-received",
    r"/api/purchases/[^/]+/chalans/[^/]+/dispatch",
    r"/api/purchase-orders/[^/]+/status",
    r"/api/purchase-orders/[^/]+/receive",
    r"/api/tile-orders/purchase-orders/[^/]+/ready",
    r"/api/tile-orders/purchase-orders/[^/]+/items/move-to-godown",
    r"/api/tile-orders/dispatches/[^/]+/godown-received",
    r"/api/tile-orders/dispatches/[^/]+/delivered",
    r"/api/godown-stock/customer-transfers/[^/]+/return",
)


def action_for_api_request(method: str, path: str, query=None) -> str | None:
    """Exports require the export capability even for direct authenticated GETs."""
    method = method.upper()
    if method == "POST" and fullmatch(r"/api/furniture-quotations/[^/]+/whatsapp-send", path):
        return "export"
    if method in {"POST", "DELETE"} and fullmatch(r"/api/quotations/[^/]+/whatsapp-draft", path):
        return "export"
    if method == "POST" and any(fullmatch(pattern, path) for pattern in POST_UPDATE_ROUTE_PATTERNS):
        return "update"
    if method in {"GET", "HEAD"}:
        if path.endswith(("/pdf", "/pptx", "/export", "/export.xlsx")):
            return "export"
        if path.startswith("/api/analytics/") and query and query.get("format") in {"csv", "xlsx"}:
            return "export"
    return action_for_http_method(method)


def granted_floor_ids(grants, *, user_id: str, path: str, action: str) -> list[str] | None:
    """Floors authorized for this operation; None represents an explicit global grant."""
    floors = []
    for grant in grants:
        floor = grant.get("floor_id")
        # Ground-floor tile grants cannot widen the shared quotations API to
        # another floor, including when the stored grant is organization-wide.
        resources = resource_candidates_for_api_path(path, floor)
        if grant.get("resource") == "tiles" and floor is None:
            floor = "ground-floor"
            resources = resource_candidates_for_api_path(path, floor)
        if any(grant_allows(grant, user_id=user_id, resource=resource, action=action, floor_id=floor) for resource in resources):
            if floor is None:
                return None
            floors.append(floor)
    return list(dict.fromkeys(floors))


def resource_for_api_path(path: str) -> str | None:
    """Map a business API path to its explicit grant registry resource.

    This is intentionally a registry, not a permissive URL-prefix fallback.
    Adding a page means adding its resource and mapping here before a custom
    account can reach it.  That keeps custom access default-deny as the app
    expands.
    """
    path = path.split("?", 1)[0]
    for prefix, resource in (
        ("/api/dashboard", "dashboard"),
        ("/api/payments", "payments"),
        ("/api/quotations", "quotations"),
        ("/api/furniture-quotations", "quotations"),
        ("/api/whatsapp", "quotations"),
        ("/api/catalog", "catalog"), ("/api/products", "catalog"),
        ("/api/brands", "catalog"), ("/api/categories", "catalog"),
        ("/api/customers", "customers"),
        ("/api/purchases", "purchases"), ("/api/purchase-orders", "purchases"),
        ("/api/suppliers", "purchases"), ("/api/followups", "followups"),
        ("/api/godown-stock", "godown_stock"),
        ("/api/notifications", "notifications"),
        ("/api/tile-orders", "orders"), ("/api/walkins", "walkins"),
        ("/api/reports", "reports"),
    ):
        if path == prefix or path.startswith(f"{prefix}/"):
            return resource
    return None


def resource_candidates_for_api_path(path: str, floor_id: str | None) -> tuple[str, ...]:
    """Return every deliberately compatible resource for one API request.

    Tile quotations share the quotations API, but a Ground Floor tile grant
    must never authorize a Sanitary quotation. The explicit floor header is
    what makes this compatibility mapping safe.
    """
    resource = resource_for_api_path(path)
    if resource is None:
        return ()
    if resource == "quotations" and floor_id == "ground-floor":
        return ("quotations", "tiles")
    return (resource,)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_valid_resource(resource: object) -> bool:
    return isinstance(resource, str) and resource in RESOURCE_REGISTRY


def normalized_actions(actions: object) -> list[str] | None:
    """Return a de-duplicated action list or ``None`` for an invalid grant."""
    if not isinstance(actions, list) or not actions:
        return None
    if any(not isinstance(action, str) or action not in ACTIONS for action in actions):
        return None
    return list(dict.fromkeys(actions))


def is_expired(expires_at: object, *, now: datetime | None = None) -> bool:
    """Malformed expiries fail closed; an absent expiry is intentionally open-ended."""
    if expires_at is None:
        return False
    if not isinstance(expires_at, str):
        return True
    try:
        expires = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    if expires.tzinfo is None:
        return True
    return expires <= (now or datetime.now(timezone.utc))


def grant_is_valid(grant: dict[str, Any]) -> bool:
    """Validate a persisted grant strictly before it can ever authorize."""
    floor_id = grant.get("floor_id")
    return (
        isinstance(grant.get("user_id"), str) and bool(grant["user_id"])
        and is_valid_resource(grant.get("resource"))
        and normalized_actions(grant.get("actions")) is not None
        and (floor_id is None or (isinstance(floor_id, str) and bool(floor_id)))
    )


def grant_allows(
    grant: dict[str, Any], *, user_id: str, resource: str, action: str,
    floor_id: str | None = None, now: datetime | None = None,
) -> bool:
    """Whether one persisted grant authorizes one capability request.

    A floor-specific grant never applies outside its named floor.  A grant
    without ``floor_id`` is intentionally organization-wide for that resource.
    Invalid, expired, or over-broad malformed data never authorizes access.
    """
    if not grant_is_valid(grant) or is_expired(grant.get("expires_at"), now=now):
        return False
    if grant["user_id"] != user_id or grant["resource"] != resource or action not in grant["actions"]:
        return False
    scoped_floor = grant.get("floor_id")
    return scoped_floor is None or scoped_floor == floor_id


def grants_allow(
    grants: Iterable[dict[str, Any]], *, user_id: str, resource: str,
    action: str, floor_id: str | None = None, now: datetime | None = None,
) -> bool:
    """Fail-closed resolver used by future route dependencies.

    Example: a grant ``payments + [view] + ground-floor`` returns true for a
    GET/view in Ground Floor and false for every create/update/delete/export
    attempt or another floor.
    """
    if not is_valid_resource(resource) or action not in ACTIONS:
        return False
    return any(
        grant_allows(
            grant, user_id=user_id, resource=resource, action=action,
            floor_id=floor_id, now=now,
        )
        for grant in grants
    )


def action_for_http_method(method: str) -> str | None:
    return HTTP_ACTIONS.get(method.upper())


def build_grant(
    *, user_id: str, resource: str, actions: list[str], floor_id: str | None,
    expires_at: str | None, actor_id: str, actor_name: str | None,
    grant_id: str | None = None, created_at: str | None = None,
) -> dict[str, Any]:
    """Build a validated audit-ready document; callers persist it themselves."""
    clean_actions = normalized_actions(actions)
    candidate = {
        "id": grant_id or str(uuid4()), "user_id": user_id, "resource": resource,
        "actions": clean_actions, "floor_id": floor_id, "expires_at": expires_at,
    }
    if not grant_is_valid(candidate) or is_expired(expires_at):
        raise ValueError("Invalid access grant")
    timestamp = utc_now_iso()
    candidate.update({
        "created_at": created_at or timestamp,
        "created_by": actor_id,
        "created_by_name": actor_name,
        "updated_at": timestamp,
        "updated_by": actor_id,
        "updated_by_name": actor_name,
    })
    return candidate


async def ensure_access_grant_indexes(database: Any) -> None:
    """Indexes are idempotent in the normal MongoDB driver usage."""
    await database.access_grants.create_index(
        [("user_id", 1), ("resource", 1), ("floor_id", 1)], unique=True,
        name="access_grants_user_resource_floor_unique",
    )
    await database.access_grants.create_index(
        [("user_id", 1), ("expires_at", 1)], name="access_grants_user_expiry",
    )


async def grants_for_user(database: Any, user_id: str) -> list[dict[str, Any]]:
    """Return only structurally valid, unexpired grants; malformed rows deny."""
    rows = await database.access_grants.find({"user_id": user_id}, {"_id": 0}).to_list(500)
    return [row for row in rows if grant_is_valid(row) and not is_expired(row.get("expires_at"))]
