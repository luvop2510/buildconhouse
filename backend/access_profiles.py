"""Least-privilege API profiles for narrowly-scoped staff accounts."""
from __future__ import annotations

from re import fullmatch

GROUND_TILE_QUOTATIONS_FOLLOWUPS = "ground_tile_quotations_followups"
GROUND_PAYMENTS_DISPATCHES = "ground_payments_dispatches"
SANITARY_QUOTATIONS_FOLLOWUPS = "sanitary_quotations_followups"
SANITARY_PURCHASES = "sanitary_purchases"

PROFILE_MODULES = {
    GROUND_TILE_QUOTATIONS_FOLLOWUPS: {"tiles", "followups"},
    GROUND_PAYMENTS_DISPATCHES: {"payments", "orders"},
    SANITARY_QUOTATIONS_FOLLOWUPS: {"quotations", "followups"},
    SANITARY_PURCHASES: {"purchases"},
}

# Account/session functions and the single assigned-floor selector. No
# business records are exposed by these endpoints.
_COMMON = {
    ("GET", "/api/auth/me"), ("POST", "/api/auth/change-password"),
    ("POST", "/api/auth/logout"), ("GET", "/api/auth/sessions"),
    ("POST", "/api/auth/sessions/logout-all"),
    ("GET", "/api/settings/floor-access"), ("GET", "/api/settings/floors"),
    ("GET", "/api/settings/permission-matrix"), ("GET", "/api/roles"),
}


def _catalog_read(method: str, path: str) -> bool:
    return method == "GET" and (
        path.startswith("/api/products") or path.startswith("/api/catalog/")
        or path in {"/api/brands", "/api/categories"}
        or fullmatch(r"/api/families/[^/]+", path) is not None
        or fullmatch(r"/api/products/[^/]+/media", path) is not None
    )


def _customer_for_quotation(method: str, path: str) -> bool:
    """Lookup/create/update a quote's customer, never use CRM-only actions."""
    if path == "/api/customers":
        return method in {"GET", "POST"}
    return bool((fullmatch(r"/api/customers/[^/]+", path) and method in {"GET", "PATCH"})
                or (method == "GET" and fullmatch(r"/api/customers/[^/]+/po-final(?:/pdf)?", path)))


def _dispatch_surface(method: str, path: str) -> bool:
    """The complete tile-orders workspace, and no other business area.

    The ground-floor dispatch worker has full capability for tile orders.  This
    route family includes the supporting brand, inventory, history, chalan and
    release/movement calls required by that single workspace.
    """
    return path.startswith("/api/tile-orders/")


def _tile_customer_tracking(method: str, path: str) -> bool:
    """Read-only order-status lookup for the tile sales workspace.

    Sales staff need to answer a customer's "has my order been dispatched?"
    question, but must not receive dispatch, godown, or payment permissions.
    Keep this deliberately limited to the customer-order list, detail and
    timeline routes used by the delivery lookup.
    """
    return method == "GET" and bool(
        fullmatch(r"/api/tile-orders/customer-orders", path)
        or fullmatch(r"/api/tile-orders/customer-orders/[^/]+", path)
        or fullmatch(r"/api/tile-orders/customer-orders/[^/]+/timeline", path)
    )


def profile_allows_request(profile: str | None, method: str, path: str) -> bool:
    """Fail-closed API allow-list. No profile preserves existing staff access."""
    if not profile:
        return True
    method = method.upper()
    # Starlette provides `request.url.path` at runtime, but normalizing keeps
    # this policy helper correct and directly testable with complete URLs.
    path = path.split("?", 1)[0]
    if (method, path) in _COMMON or (method == "DELETE" and fullmatch(r"/api/auth/sessions/[^/]+", path)):
        return True
    # Converts rows already visible to this user into an Excel file; it reads
    # no server-side business records and grants no additional data access.
    if (method, path) == ("POST", "/api/exports/page.xlsx"):
        return True
    if profile in {GROUND_TILE_QUOTATIONS_FOLLOWUPS, SANITARY_QUOTATIONS_FOLLOWUPS}:
        return (path.startswith("/api/quotations") or path.startswith("/api/followups")
                or _customer_for_quotation(method, path) or _catalog_read(method, path)
                or (profile == GROUND_TILE_QUOTATIONS_FOLLOWUPS and _tile_customer_tracking(method, path))
                or (method in {"GET", "POST"} and path == "/api/referrers")
                or (method == "POST" and path == "/api/products/custom")
                or (method == "POST" and path == "/api/downloads/token"))
    if profile == GROUND_PAYMENTS_DISPATCHES:
        return (path.startswith("/api/payments") or _dispatch_surface(method, path)
                or (method == "POST" and path == "/api/downloads/token"))
    if profile == SANITARY_PURCHASES:
        return (path.startswith("/api/purchases") or path.startswith("/api/purchase-orders")
                or path.startswith("/api/suppliers")
                or (method == "GET" and path.startswith("/api/activity/purchase/"))
                or (method == "GET" and path == "/api/customers")
                or (method == "POST" and path == "/api/downloads/token"))
    return False
