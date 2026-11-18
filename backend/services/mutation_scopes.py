"""Relationships that destructive HTTP mutations must fence.

Unclassified writers remain global. A record key is declared only when the
route's side effects are confined to that record and its explicitly listed
relationships. Keys are digests, so admission metadata carries no URL or ID.
"""
from hashlib import sha256


def _keys(*resources):
    return dict.fromkeys(resources)


def _record(resource, identity, *related):
    return {resource: sha256(identity.encode()).hexdigest(), **_keys(*related)}


# The customer graph can include cross-floor child references. A floor header
# alone is insufficient proof that a write can proceed across graph cleanup.
BUSINESS_GRAPH = ("customers", "quotations", "drafts", "walkins", "followups",
                  "purchases", "payments", "stock", "kitchen", "customer-sessions",
                  "permission-policy", "deliveries")
CATALOG = _keys("catalog")
STAFF_AUTH = _keys("staff-auth")
FOLLOWUP_AUTOMATION = _keys("quotations", "walkins", "followups", "purchases", "payments")
OUTBOX_DISPATCH = _keys("customers", "quotations", "purchases", "payments", "stock", "deliveries")
CUSTOMER_GRAPH_RELATED = tuple(resource for resource in BUSINESS_GRAPH if resource != "customers")
QUOTATION_GRAPH_RELATED = ("walkins", "followups", "purchases", "payments", "stock", "deliveries")
# Exact customer edits never create a dependent record for another customer.
CUSTOMER_WRITES = {("PATCH", ()), ("POST", ("send-invite",)), ("POST", ("reset-password",))}
WALKIN_SCOPE_WRITES = {("PATCH", ()), ("PATCH", ("reassign",)), ("POST", ("visit-showroom",))}


def is_mutating_read(scope):
    """Quotation PDF generation records a durable outbox event."""
    parts = scope["path"].rstrip("/").split("/")
    return scope["method"] == "GET" and len(parts) == 5 and parts[2] == "quotations" and parts[4] == "pdf"


def classify_http_mutation(scope):
    """Return (destructive, scope). None is a conservative global scope."""
    method = scope["method"]
    resource, *parts = scope["path"].removeprefix("/api/").rstrip("/").split("/")
    if parts and parts[0]:
        identity, *rest = parts
        subpath = tuple(rest)
    else:
        identity, subpath = None, ()

    if resource == "auth":
        if method == "POST" and parts in [["login"], ["change-password"], ["mfa", "enroll"],
                                           ["mfa", "confirm"], ["mfa", "recovery"], ["mfa", "disable"]]:
            return False, STAFF_AUTH
        return False, _keys("staff-auth", "customer-sessions")

    if resource == "team" or (resource == "settings" and identity in {"permission-matrix", "access-grants"}):
        return False, _keys("permission-policy", "staff-auth")

    if resource in {"categories", "brands", "products", "families", "media", "catalog"}:
        # Category membership, variants and related product IDs may be
        # modified from a different row. Fence the catalog domain as a unit.
        deleting = method == "DELETE" and identity and (
            resource == "categories" and not subpath or resource == "products" and subpath in {(), ("variants",)}
        )
        return bool(deleting), CATALOG

    if resource == "customers":
        if method == "POST" and parts == ["floor-reset"]:
            return True, None
        if method == "DELETE" and identity and not subpath:
            # Kitchen's recoverable deletion has its own policy and aggregate
            # fence. Other floors still use the reviewed hard-delete graph.
            if dict(scope.get("headers", [])).get(b"x-floor-id") == b"second-floor":
                return False, _keys("customers", "kitchen")
            return True, _record("customers", identity, *CUSTOMER_GRAPH_RELATED)
        if identity and (method, subpath) in CUSTOMER_WRITES:
            return False, _record("customers", identity)
        # Creation/import can establish cross-floor customer relationships.
        return False, _keys(*BUSINESS_GRAPH)

    if resource == "kitchen-customer-deletion" or resource == "kitchen-projects":
        return False, _keys("customers", "kitchen")

    if resource == "quotations":
        if not identity:
            return False, _keys("customers", "drafts", "catalog", "walkins", "stock")
        if identity == "client-draft":
            if method == "DELETE" and len(subpath) == 1:
                # May resolve an existing quotation through a receipt, or
                # race creation of a new draft. The path alone cannot tell.
                return True, _record("drafts", subpath[0], "quotations", *QUOTATION_GRAPH_RELATED)
            return False, _keys(*BUSINESS_GRAPH)
        if method == "DELETE" and not subpath:
            return True, _record("quotations", identity, *QUOTATION_GRAPH_RELATED)
        if method == "GET" and subpath == ("pdf",):
            return False, _record("quotations", identity)
        if method == "PATCH" and not subpath:
            # The PATCH body can add products. Category/product deletion must
            # fence that validation, while deleting another quote needn't.
            return False, _record("quotations", identity, "catalog")
        # Other commands can create related orders, payments, allocations,
        # deliveries, another quotation or a new customer relationship.
        return False, _record("quotations", identity, "customers", "catalog", *QUOTATION_GRAPH_RELATED)

    if resource == "walkins":
        if identity and method == "DELETE" and not subpath:
            return True, _record("walkins", identity)
        if identity and method == "POST" and subpath == ("contact",):
            return False, _record("walkins", identity)
        if identity and (method, subpath) in WALKIN_SCOPE_WRITES:
            return False, _record("walkins", identity, "followups")
        return False, _keys("customers", "walkins", "followups")

    if resource == "followups":
        if identity == "saved-views":
            return False, _keys("followup-views") if method == "DELETE" else _keys("customers", "followup-views")
        return False, _keys("customers", "quotations", "walkins", "followups", "purchases")

    if resource == "purchase-orders":
        if identity and method == "PATCH" and not subpath:
            return False, _record("purchases", identity)
        return bool(method == "DELETE" and identity and not subpath), _keys(
            "purchases", "quotations", "payments", "stock", "followups", "deliveries", "customer-sessions",
        )

    if resource == "payments":
        return bool(method == "DELETE" and identity and not subpath), _keys("payments", "stock", "purchases", "quotations")

    if resource == "whatsapp":
        return False, _keys("customers", "quotations", "deliveries")

    if resource == "godown-stock":
        if identity and not subpath and method == "DELETE":
            return True, _keys("stock", "payments", "purchases", "quotations", "catalog")
        if identity and len(subpath) == 2 and subpath[0] == "movements" and method == "DELETE":
            return True, _record("stock", identity)
        if identity and subpath in {("pricing",), ("quantity-count",), ("movements",), ("details",), ("image",)}:
            return False, _record("stock", identity)
        return False, _keys("stock", "customers", "purchases", "payments", "quotations", "catalog")

    return False, None
