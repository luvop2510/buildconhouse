"""Server-enforced per-user capabilities and explicit API operation policy."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable
from uuid import uuid4
from re import fullmatch


# Resource names are stable API/UI concepts, not URL prefixes.  Keeping this
# registry explicit prevents a typo in stored Mongo data from becoming an
# unexpected authorization bypass.
RESOURCE_REGISTRY: dict[str, dict[str, Any]] = {
    "dashboard": {"label": "Dashboard"},
    "quotations": {"label": "Quotations"},
    "tiles": {"label": "Tile quotations"},
    "catalog": {"label": "Catalog"},
    "customers": {"label": "Customers"},
    "kitchen_projects": {"label": "Kitchen projects", "floor_ids": ["second-floor"], "actions": ["view", "create", "update", "export"], "description": "Manage connected kitchen projects, stage history and protected documents. Assignment and manager authority require separate configuration."},
    "purchases": {"label": "Purchases"},
    "godown_stock": {"label": "Godown stock"},
    "payments": {"label": "Payments"},
    "followups": {"label": "Follow-ups"},
    "orders": {"label": "Tile orders & dispatches"},
    "walkins": {"label": "Walk-ins", "description": "The regular customer intake, journey, items and status register on every enabled floor."},
    "reports": {"label": "Reports"},
    "notifications": {"label": "Notifications"},
    "notebook_walkins": {"label": "Legacy lead notebook", "retired": True, "floor_ids": ["second-floor", "third-floor"], "actions": ["view", "create", "update"], "description": "Add walk-ins, record contact attempts, and move leads to quotation follow-up."},
    "notebook_quotations": {"label": "Quotation Follow-up", "retired": True, "floor_ids": ["second-floor", "third-floor"], "actions": ["view", "update"], "description": "Review converted leads, update quotation values, contact customers, and record outcomes."},
    "furniture_quotations": {"label": "RNB quotations", "floor_ids": ["third-floor"], "actions": ["view", "create", "update", "export"], "description": "Prepare RNB quotations, edit items and terms, download PDFs, and send configured WhatsApp exports."},
    "sales_data": {"label": "Sales Data", "actions": ["view", "export"], "description": "Review floor sales, customer and brand totals, and export reports."},
}

RESOURCE_REGISTRY["dashboard"].update(actions=["view"], description="View today's floor summary and activity.")
RESOURCE_REGISTRY["quotations"].update(floor_ids=["first-floor"], description="Create and manage Sanitary quotations, confirm orders, and export documents.")
RESOURCE_REGISTRY["tiles"].update(floor_ids=["ground-floor"], description="Create tile selections and quotations, confirm orders, and export documents.")
RESOURCE_REGISTRY["catalog"].update(floor_ids=["ground-floor", "first-floor"], description="Manage the selected Ground or Sanitary Bathroom catalog.")
RESOURCE_REGISTRY["orders"].update(floor_ids=["ground-floor"], description="Manage tile purchase orders, dispatches, and delivery stages.")
RESOURCE_REGISTRY["godown_stock"].update(floor_ids=["first-floor"], description="Manage godown stock and customer transfers.")
RESOURCE_REGISTRY["purchases"].update(floor_ids=["first-floor"], description="Manage Sanitary Bathroom purchases and purchasing stages.")
RESOURCE_REGISTRY["payments"].update(description="Manage payments and the Fully paid orders page.")
RESOURCE_REGISTRY["notifications"].update(actions=["view"], description="View your notifications for the selected floor.")
RESOURCE_REGISTRY["reports"].update(actions=["view", "export"])
RESOURCE_REGISTRY["followups"].update(floor_ids=["ground-floor", "first-floor", "second-floor", "third-floor"], description="Manage the selected floor's sales follow-up inbox.")
for _resource in ("catalog", "purchases", "godown_stock", "payments", "orders", "walkins"):
    RESOURCE_REGISTRY[_resource]["actions"] = ["view", "create", "update", "export"]

ACTION_DESCRIPTIONS = {
    "view": "Open the page and read its records.",
    "create": "Add new records on this page.",
    "update": "Edit records and perform workflow actions such as moving, confirming, or completing them.",
    "delete": "Remove records where the page supports deletion.",
    "export": "Download documents or spreadsheets and use supported document sharing actions.",
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
    "/api/auth/me", "/api/auth/logout",
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
        return path in CUSTOM_ACCESS_COMMON_PATHS - {"/api/downloads/token", "/api/exports/page.xlsx", "/api/auth/logout"}
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
    r"/api/kitchen-projects/[^/]+/commands",
    r"/api/kitchen-projects/[^/]+/attachments",
    r"/api/followups/notebook/[^/]+/[^/]+/(?:convert|outcome)",
    r"/api/followups/[^/]+/(?:contact|snooze|complete|log-call)",
    r"/api/walkins/[^/]+/(?:contact|visit-showroom)",
    r"/api/customers/[^/]+/(?:send-invite|reset-password)",
    r"/api/godown-stock/[^/]+/allocate",
    r"/api/godown-stock/[^/]+/image",
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
    if method == "POST" and fullmatch(r"/api/(?:furniture-quotations|quotations)/[^/]+/whatsapp-send", path):
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


def is_global_followup_admin_request(method: str, path: str) -> bool:
    """A floor page grant cannot change organization-wide automation."""
    return (method.upper() == "POST" and path == "/api/followups/reconcile"
            or method.upper() == "PUT" and fullmatch(r"/api/followups/config/(?:automation-rules|workflow-transitions)/[^/]+", path) is not None)


def granted_floor_ids(grants, *, user_id: str, path: str, action: str, resource: str | None = None, method: str | None = None) -> list[str] | None:
    """Floors authorized for this operation; None represents an explicit global grant."""
    floors = []
    for grant in grants:
        floor = grant.get("floor_id")
        furniture_delivery = method in {"GET", "HEAD"} and action == "view" and whatsapp_document_status(path)
        if furniture_delivery and grant.get("resource") == "furniture_quotations" and floor is None:
            floor = "third-floor"
        # Ground-floor tile grants cannot widen the shared quotations API to
        # another floor, including when the stored grant is organization-wide.
        resources = (resource,) if resource else resource_candidates_for_api_path(path, floor)
        if grant.get("resource") == "tiles" and floor is None:
            floor = "ground-floor"
            resources = resource_candidates_for_api_path(path, floor)
        # Saving a quotation's concealed default is also part of creating a
        # quotation. This exception is restricted to that exact PATCH action;
        # it never authorizes general product edits or catalog reads.
        quotation_default = method == "PATCH" and action == "update" and fullmatch(r"/api/products/[^/]+/concealed-part", path)
        quotation_lookup = method == "GET" and action == "view" and quotation_dependency_read(path)
        quotation_custom = method == "POST" and action == "create" and path in {"/api/products/custom", "/api/products/custom-with-media"}
        if (quotation_default or quotation_lookup or quotation_custom) and grant.get("resource") == "quotations" and floor is None:
            floor = "first-floor"
        if quotation_default and floor == "first-floor":
            resources = ("catalog", "quotations")
        elif quotation_lookup and floor == "first-floor":
            resources = (*resources, "quotations")
        elif quotation_custom and floor == "first-floor":
            resources = ("catalog", "quotations")
        elif quotation_custom and floor == "ground-floor":
            resources = ("catalog", "tiles")
        if any(grant_allows(grant, user_id=user_id, resource=candidate, action=capability, floor_id=floor)
               for candidate in resources
               for capability in (("export",) if furniture_delivery and candidate == "furniture_quotations"
                                  else ("create", "update") if quotation_default and candidate == "quotations" else (action,))):
            if grant.get("resource") in {"followups", "purchases", "catalog"}:
                supported = RESOURCE_REGISTRY[grant["resource"]]["floor_ids"]
                if floor is None:
                    floors.extend(supported)
                    continue
                if floor not in supported:
                    continue
            if floor is None:
                return None
            floors.append(floor)
    return list(dict.fromkeys(floors))


def quotation_dependency_read(path: str) -> bool:
    """The Sanitary builder's lookup surface, excluding imports and exports.

    A quotation page grant supplies the product/customer picker data needed
    inside that page. Separate Catalog/Customers grants still control those
    pages and every mutation of their underlying records.
    """
    return bool(path in {"/api/brands", "/api/categories", "/api/catalog/hierarchy", "/api/catalog/search", "/api/catalog/facets"}
                or fullmatch(r"/api/products(?:/[^/]+(?:/(?:alternates|complete-the-set|size-variants|media))?)?", path)
                or fullmatch(r"/api/families/[^/]+", path)
                or fullmatch(r"/api/customers(?:/[^/]+)?", path))


def whatsapp_document_status(path: str) -> bool:
    return bool(path == "/api/whatsapp/configuration" or fullmatch(r"/api/whatsapp/deliveries/[^/]+/[^/]+", path))


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
        ("/api/furniture-quotations", "furniture_quotations"),
        ("/api/whatsapp", "quotations"),
        ("/api/catalog", "catalog"), ("/api/products", "catalog"),
        ("/api/brands", "catalog"), ("/api/categories", "catalog"),
        ("/api/families", "catalog"),
        ("/api/customers", "customers"),
        ("/api/kitchen-projects", "kitchen_projects"),
        ("/api/purchases", "purchases"), ("/api/purchase-orders", "purchases"),
        ("/api/suppliers", "purchases"), ("/api/followups", "followups"),
        ("/api/godown-stock", "godown_stock"),
        ("/api/notifications", "notifications"),
        ("/api/tile-orders", "orders"), ("/api/walkins", "walkins"),
        ("/api/reports", "reports"),
        ("/api/analytics", "sales_data"), ("/api/executive-analytics", "sales_data"),
        ("/api/sales-data", "sales_data"),
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
    if floor_id == "third-floor" and whatsapp_document_status(path):
        return ("furniture_quotations",)
    if path == "/api/referrers" or path.startswith("/api/referrers/"):
        return ("quotations", "tiles", "notebook_walkins", "notebook_quotations", "sales_data")
    if path == "/api/followups/assignees":
        return ("notebook_walkins", "notebook_quotations") if floor_id in {"second-floor", "third-floor"} else ("followups", "walkins")
    resource = resource_for_api_path(path)
    if resource is None:
        return ()
    if resource == "quotations" and floor_id == "ground-floor":
        return ("quotations", "tiles")
    return (resource,)


async def request_resource(database: Any, path: str, query: Any = None) -> str | None:
    """Notebook sibling pages share URLs, so resolve rows from stored stage.

    A forged view query on a row URL cannot turn a walk-in permission into
    access to a converted quotation. Generic contact uses the same resolver.
    """
    notebook = fullmatch(r"/api/followups/notebook/([^/]+)(?:/([^/]+)(?:/[^/]+)?)?", path)
    generic = fullmatch(r"/api/followups/([^/]+)(?:/(snooze|complete|contact|log-call|interests))?", path)
    if generic and generic.group(1) in {"reconcile", "stats", "mission", "insights", "export", "saved-views", "page", "assignments", "assignees", "team-assign"}:
        generic = None
    if notebook and not notebook.group(2):
        return "notebook_quotations" if query and query.get("view") == "quotation" else "notebook_walkins"
    if notebook or generic:
        lookup = {"id": notebook.group(2) if notebook else generic.group(1)}
        if notebook:
            lookup["floor_id"] = notebook.group(1)
        row = await database.followups.find_one(lookup, {"_id": 0, "is_converted": 1, "notebook_key": 1})
        if generic and row and row.get("notebook_key") and generic.group(2) not in {"contact", "interests"}:
            # Generic detail returns related quotations/payments; a notebook
            # grant covers only its narrow DTO and must use notebook URLs.
            return "__notebook_route_required"
        if notebook or row and row.get("notebook_key"):
            return "notebook_quotations" if row and row.get("is_converted") else "notebook_walkins"
    return None


def resource_supports(resource: str, floor_id: str, actions: list[str]) -> bool:
    metadata = RESOURCE_REGISTRY.get(resource)
    return bool(metadata and (not metadata.get("floor_ids") or floor_id in metadata["floor_ids"])
                and set(actions).issubset(metadata.get("actions", ACTIONS)))


async def build_delegation_snapshot(database: Any, *, user_id: str, floor_ids: list[str], grants: list[dict], actor_id: str, actor_name: str | None) -> list[dict]:
    """Validate the entire draft before its single-document atomic save."""
    from fastapi import HTTPException
    if len(floor_ids) != len(set(floor_ids)) or any(not floor or not isinstance(floor, str) for floor in floor_ids):
        raise HTTPException(status_code=422, detail="Enabled floors must be distinct valid floor IDs")
    for floor_id in floor_ids:
        if not await database.floors.find_one({"id": floor_id, "active": {"$ne": False}}, {"_id": 0, "id": 1}):
            raise HTTPException(status_code=422, detail="Enable only active floors")
    seen = set()
    snapshot = []
    for grant in grants:
        floor_id, resource = grant.get("floor_id"), grant.get("resource")
        actions = normalized_actions(grant.get("actions"))
        if floor_id not in floor_ids:
            raise HTTPException(status_code=422, detail="Enable a floor before assigning its pages")
        if actions is None or "view" not in actions or not resource_supports(resource, floor_id, actions):
            raise HTTPException(status_code=422, detail="Select a supported page and its actions, including view")
        if (floor_id, resource) in seen:
            raise HTTPException(status_code=422, detail="Each floor page must be assigned only once")
        seen.add((floor_id, resource))
        snapshot.append(build_grant(user_id=user_id, resource=resource, actions=actions, floor_id=floor_id,
                                    expires_at=None, actor_id=actor_id, actor_name=actor_name))
    return snapshot


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
    user = await database.users.find_one({"id": user_id}, {"_id": 0, "delegation_grants": 1, "floor_ids": 1})
    if user is not None and "delegation_grants" in user:
        rows = user["delegation_grants"]
        if not isinstance(rows, list):
            return []
        return [row for row in rows if isinstance(row, dict) and grant_is_valid(row) and not is_expired(row.get("expires_at"))
                and row.get("user_id") == user_id and "view" in row["actions"]
                and row.get("floor_id") in (user.get("floor_ids") or [])
                and resource_supports(row["resource"], row["floor_id"], row["actions"])]
    rows = await database.access_grants.find({"user_id": user_id}, {"_id": 0}).to_list(500)
    return [row for row in rows if grant_is_valid(row) and not is_expired(row.get("expires_at"))]
