"""Exercise real auth boundaries with hermetic principals/storage, not UI policy."""
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import Response

import auth
import server
import routes.customer_routes as customers
import routes.settings_routes as settings_routes
import services.download_tokens as download_tokens
from models import CustomerUpdatePayload, UserPublic


def request(path, method="GET", floor="ground-floor", query=""):
    headers = [(b"authorization", b"Bearer test")]
    if floor:
        headers.append((b"x-floor-id", floor.encode()))
    return Request({"type": "http", "method": method, "path": path, "headers": headers,
                    "query_string": query.encode(), "scheme": "https", "server": ("test", 443)})


def staff(custom=True, role="worker"):
    return {"id": "staff-1", "email": "staff@example.com", "full_name": "Staff", "role": role,
            "floor_ids": ["ground-floor", "first-floor"], "custom_access": custom}


def grant(resource="quotations", actions=None, floor="ground-floor"):
    return {"id": "grant-1", "user_id": "staff-1", "resource": resource,
            "actions": actions or ["view"], "floor_id": floor, "expires_at": None}


def mock_staff(monkeypatch, grants, principal=None):
    async def load(*_args, **_kwargs):
        return principal or staff()
    async def load_grants(*_args):
        return grants
    monkeypatch.setattr(auth, "_load_active_principal", load)
    monkeypatch.setattr(auth, "grants_for_user", load_grants)
    monkeypatch.setattr(auth, "decode_token", lambda _token: {"sub": "staff-1", "kind": "staff", "session_id": "session-1"})


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["worker", "admin", "manager"])
async def test_custom_grant_binds_actual_object_and_related_floor(monkeypatch, role):
    mock_staff(monkeypatch, [grant()], staff(role=role))
    user = await auth.get_current_user(request=request("/api/quotations/q-first"), authorization="Bearer test", x_floor_id="ground-floor", dl=None)
    assert auth.accessible_floor_ids(user) == ["ground-floor"]
    assert user.model_dump()["floor_ids"] == ["ground-floor", "first-floor"]
    assert "_custom_grant_floor_ids" not in user.model_dump()

    class Quotes:
        async def find_one(self, *_args, **_kwargs):
            return {"id": "q-first", "floor_id": "first-floor"}
    with pytest.raises(HTTPException) as exc:
        await auth.get_floor_scoped_or_404(Quotes(), "q-first", user)
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException):
        auth.require_floor_access("first-floor", user)


@pytest.mark.asyncio
async def test_owner_can_manage_every_floor_despite_legacy_restricted_flags(monkeypatch):
    principal = {**staff(role="owner"), "access_profile": "ground_payments_dispatches"}
    mock_staff(monkeypatch, [], principal)
    user = await auth.get_current_user(request=request("/api/team"), authorization="Bearer test", x_floor_id="ground-floor", dl=None)
    assert auth.accessible_floor_ids(user) is None
    assert user.custom_access is False and user.access_profile is None
    assert auth.require_floor_access("first-floor", user) is user
    class Quotes:
        async def find_one(self, *_args, **_kwargs):
            return {"id": "q-first", "floor_id": "first-floor"}
    assert (await auth.get_floor_scoped_or_404(Quotes(), "q-first", user))["id"] == "q-first"
    reached = []
    async def next_handler(_request):
        reached.append(True)
        return Response(status_code=200)
    monkeypatch.setattr(server, "decode_token", lambda _token: {"kind": "staff"})
    response = await server.enforce_access_profile(request("/api/team"), next_handler)
    assert response.status_code == 200 and reached == [True]


@pytest.mark.asyncio
async def test_update_grant_cannot_borrow_view_grant_on_other_floor(monkeypatch):
    mock_staff(monkeypatch, [grant(actions=["update"]), grant(actions=["view"], floor="first-floor")])
    user = await auth.get_current_user(request=request("/api/quotations/q", "PATCH"), authorization="Bearer test", x_floor_id="ground-floor", dl=None)
    assert auth.accessible_floor_ids(user) == ["ground-floor"]


@pytest.mark.asyncio
@pytest.mark.parametrize("path,resource", [
    ("/api/quotations/quote-1/items/line-1/cancel", "quotations"),
    ("/api/quotations/quote-1/move-to-quotation", "quotations"),
    ("/api/quotations/quote-1/place-order/confirm", "quotations"),
    ("/api/purchases/items/item-1/move", "purchases"),
    ("/api/purchases/items/item-1/cancel", "purchases"),
    ("/api/purchases/items/bulk-move", "purchases"),
    ("/api/tile-orders/purchase-orders/po-1/items/move-to-godown", "orders"),
    ("/api/purchase-orders/po-1/status", "purchases"),
    ("/api/tile-orders/dispatches/dispatch-1/delivered", "orders"),
    ("/api/purchases/transfers/transfer-1/return", "purchases"),
])
@pytest.mark.parametrize("actions,allowed", [(["create"], False), (["update"], True)])
async def test_post_business_mutations_require_update_instead_of_create(monkeypatch, path, resource, actions, allowed):
    mock_staff(monkeypatch, [grant(resource=resource, actions=actions)])
    kwargs = dict(request=request(path, "POST"), authorization="Bearer test", x_floor_id="ground-floor", dl=None)
    if allowed:
        assert (await auth.get_current_user(**kwargs)).id == "staff-1"
    else:
        with pytest.raises(HTTPException) as exc:
            await auth.get_current_user(**kwargs)
        assert exc.value.status_code == 403


def test_semantic_mutation_patterns_are_exact_and_preserve_real_create_operations():
    from services.access_grants import action_for_api_request
    assert action_for_api_request("POST", "/api/quotations") == "create"
    assert action_for_api_request("POST", "/api/quotations/quote-1/duplicate") == "create"
    assert action_for_api_request("POST", "/api/quotations/quote-1/items") == "create"
    assert action_for_api_request("POST", "/api/purchases/po-1/chalans") == "create"
    assert action_for_api_request("POST", "/api/quotations/quote-1/place-order/confirm/extra") == "create"
    assert action_for_api_request("POST", "/api/purchases/items/item-1/move-other") == "create"
    assert action_for_api_request("GET", "/api/purchases/items/item-1/move") == "view"


@pytest.mark.asyncio
@pytest.mark.parametrize("resource,actions,allowed", [
    ("quotations", ["view", "create"], True),
    ("quotations", ["view", "update"], True),
    ("catalog", ["view", "update"], True),
    ("quotations", ["view"], False),
    ("catalog", ["view", "create"], False),
    ("payments", ["view", "update"], False),
])
async def test_concealed_default_save_requires_exact_quotation_or_catalog_capability(monkeypatch, resource, actions, allowed):
    mock_staff(monkeypatch, [grant(resource=resource, actions=actions, floor="first-floor")])
    kwargs = dict(request=request("/api/products/product-1/concealed-part", "PATCH", floor="first-floor"),
                  authorization="Bearer test", x_floor_id="first-floor", dl=None)
    if allowed:
        user = await auth.get_current_user(**kwargs)
        assert auth.accessible_floor_ids(user) == ["first-floor"]
    else:
        with pytest.raises(HTTPException) as exc:
            await auth.get_current_user(**kwargs)
        assert exc.value.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize("path,method,floor", [
    ("/api/products/product-1", "PATCH", "first-floor"),
    ("/api/products/product-1/concealed-part/extra", "PATCH", "first-floor"),
    ("/api/products/product-1/concealed-part", "POST", "first-floor"),
    ("/api/products/product-1/concealed-part", "PUT", "first-floor"),
    ("/api/products/product-1/concealed-part", "PATCH", "ground-floor"),
])
async def test_concealed_default_permission_cannot_expand_into_other_catalog_operations(monkeypatch, path, method, floor):
    mock_staff(monkeypatch, [grant(actions=["view", "create", "update"], floor=floor)])
    with pytest.raises(HTTPException) as exc:
        await auth.get_current_user(request=request(path, method, floor=floor), authorization="Bearer test", x_floor_id=floor, dl=None)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize("path", [
    "/api/products", "/api/products/families", "/api/products/recent", "/api/products/frequent",
    "/api/products/product-1", "/api/products/product-1/alternates",
    "/api/products/product-1/complete-the-set", "/api/products/product-1/size-variants",
    "/api/products/product-1/media", "/api/families/family-1", "/api/brands", "/api/categories",
    "/api/catalog/hierarchy", "/api/catalog/search", "/api/catalog/facets",
    "/api/customers", "/api/customers/customer-1",
])
@pytest.mark.parametrize("floor", ["first-floor", "ground-floor"])
async def test_quotation_only_page_can_load_builder_lookups_on_sanitary_floor(monkeypatch, path, floor):
    mock_staff(monkeypatch, [grant(floor="first-floor")])
    kwargs = dict(request=request(path, floor=floor), authorization="Bearer test", x_floor_id=floor, dl=None)
    if floor == "first-floor":
        user = await auth.get_current_user(**kwargs)
        assert auth.accessible_floor_ids(user) == ["first-floor"]
    else:
        with pytest.raises(HTTPException) as exc:
            await auth.get_current_user(**kwargs)
        assert exc.value.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize("path,method", [
    ("/api/catalog/imports", "GET"), ("/api/catalog/export.xlsx", "GET"),
    ("/api/customers/customer-1/quotations", "GET"),
    ("/api/customers/import-sources/ground-floor", "GET"),
    ("/api/customers", "POST"), ("/api/customers/customer-1", "PATCH"),
    ("/api/products", "POST"), ("/api/products/product-1/media", "POST"),
    ("/api/products/product-1", "PATCH"), ("/api/products/product-1", "DELETE"),
    ("/api/brands", "POST"), ("/api/categories", "POST"),
])
async def test_quotation_lookup_permissions_do_not_expose_other_pages_actions(monkeypatch, path, method):
    mock_staff(monkeypatch, [grant(actions=["view", "create", "update", "export"], floor="first-floor")])
    with pytest.raises(HTTPException) as exc:
        await auth.get_current_user(request=request(path, method, floor="first-floor"), authorization="Bearer test", x_floor_id="first-floor", dl=None)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/whatsapp/configuration", "/api/whatsapp/deliveries/quotation-1/request-1"])
@pytest.mark.parametrize("resource,grant_floor,actions,active_floor,allowed", [
    ("furniture_quotations", "third-floor", ["view", "export"], "third-floor", True),
    ("furniture_quotations", "third-floor", ["view"], "third-floor", False),
    ("furniture_quotations", "third-floor", ["view", "export"], "first-floor", False),
    ("quotations", "first-floor", ["view"], "third-floor", False),
    ("payments", "third-floor", ["view", "export"], "third-floor", False),
    ("quotations", "first-floor", ["view"], "first-floor", True),
])
async def test_whatsapp_furniture_status_requires_floor_export_and_preserves_sanitary_policy(monkeypatch, path, resource, grant_floor, actions, active_floor, allowed):
    principal = {**staff(), "floor_ids": ["first-floor", "third-floor"]}
    mock_staff(monkeypatch, [grant(resource=resource, actions=actions, floor=grant_floor)], principal)
    kwargs = dict(request=request(path, floor=active_floor), authorization="Bearer test", x_floor_id=active_floor, dl=None)
    if allowed:
        user = await auth.get_current_user(**kwargs)
        assert auth.accessible_floor_ids(user) == [active_floor]
    else:
        with pytest.raises(HTTPException) as exc:
            await auth.get_current_user(**kwargs)
        assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_tile_workflow_cannot_borrow_other_floor_header(monkeypatch):
    mock_staff(monkeypatch, [grant(resource="orders", floor="first-floor")])
    user = await auth.get_current_user(request=request("/api/tile-orders/history", floor="first-floor"), authorization="Bearer test", x_floor_id="first-floor", dl=None)
    with pytest.raises(HTTPException):
        auth.tiles_floor_query(user)


@pytest.mark.asyncio
async def test_global_tile_grant_remains_ground_floor_only(monkeypatch):
    mock_staff(monkeypatch, [grant(resource="tiles", floor=None)])
    user = await auth.get_current_user(request=request("/api/quotations/q"), authorization="Bearer test", x_floor_id="ground-floor", dl=None)
    assert auth.accessible_floor_ids(user) == ["ground-floor"]


@pytest.mark.asyncio
@pytest.mark.parametrize("download", [False, True])
@pytest.mark.parametrize("actions,allowed", [(["view"], False), (["export"], True)])
async def test_export_capability_checked_at_bearer_and_download_execution(monkeypatch, download, actions, allowed):
    mock_staff(monkeypatch, [grant(resource="catalog", actions=actions)])
    async def consume(*_args, **_kwargs):
        return {"user_id": "staff-1", "session_id": "session-1", "floor_id": "ground-floor", "kind": "staff"}
    monkeypatch.setattr(download_tokens, "consume_download_token", consume)
    kwargs = dict(request=request("/api/catalog/export.xlsx"), authorization=None if download else "Bearer test",
                  x_floor_id=None if download else "ground-floor", dl="opaque" if download else None)
    if allowed:
        user = await auth.get_current_user(**kwargs)
        assert auth.accessible_floor_ids(user) == ["ground-floor"]
    else:
        with pytest.raises(HTTPException) as exc:
            await auth.get_current_user(**kwargs)
        assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_middleware_uses_current_custom_mode_instead_of_old_token_claim(monkeypatch):
    mock_staff(monkeypatch, [])
    monkeypatch.setattr(server, "decode_token", lambda _token: {"kind": "staff", "custom_access": False})
    async def next_handler(_request):
        pytest.fail("ungranted business route was reached")
    response = await server.enforce_access_profile(request("/api/payments/orders"), next_handler)
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_current_profile_is_enforced_even_when_token_has_no_profile(monkeypatch):
    principal = {**staff(custom=False, role="sales"), "access_profile": "sanitary_quotations_followups"}
    mock_staff(monkeypatch, [], principal)
    with pytest.raises(HTTPException):
        await auth.get_current_user(request=request("/api/purchases/items", floor="first-floor"), authorization="Bearer test", x_floor_id="first-floor", dl=None)


@pytest.mark.asyncio
async def test_common_floor_read_does_not_authorize_floor_creation(monkeypatch):
    mock_staff(monkeypatch, [])
    with pytest.raises(HTTPException):
        await auth.get_current_user(request=request("/api/settings/floors", "POST"), authorization="Bearer test", x_floor_id="ground-floor", dl=None)
    assert (await auth.get_current_user(request=request("/api/settings/floors"), authorization="Bearer test", x_floor_id="ground-floor", dl=None)).id == "staff-1"


@pytest.mark.asyncio
@pytest.mark.parametrize("path,method", [
    ("status", "GET"), ("enroll", "POST"), ("confirm", "POST"), ("disable", "POST"), ("recovery", "POST"),
])
async def test_restricted_accounts_can_manage_their_own_mfa(monkeypatch, path, method):
    principal = {**staff(), "access_profile": "sanitary_quotations_followups"}
    mock_staff(monkeypatch, [], principal)
    user = await auth.get_current_user(request=request(f"/api/auth/mfa/{path}", method, floor="first-floor"), authorization="Bearer test", x_floor_id="first-floor", dl=None)
    assert user.id == "staff-1"


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled,session_fields,allowed", [
    (False, {}, True),
    (True, {}, False),
    (True, {"mfa_verified": False, "mfa_version": 2}, False),
    (True, {"mfa_verified": True, "mfa_version": 1}, False),
    (True, {"mfa_verified": True, "mfa_version": 2}, True),
])
async def test_current_mfa_enrollment_and_version_bind_every_staff_session(monkeypatch, enabled, session_fields, allowed):
    principal = {**staff(custom=False), "mfa_enabled": enabled, "mfa_version": 2}
    class Sessions:
        async def find_one(self, _query, projection):
            assert projection["mfa_verified"] == projection["mfa_version"] == 1
            return {"id": "mfa-session", **session_fields}
        async def update_one(self, *_args):
            pass
    class Users:
        async def find_one(self, _query, projection):
            for secret in ("password_hash", "password_encrypted", "mfa_secret_encrypted", "mfa_pending", "mfa_recovery_hashes"):
                assert projection[secret] == 0
            return principal
    class Database:
        user_sessions = Sessions()
        users = Users()
        def __getitem__(self, name):
            return getattr(self, name)
    monkeypatch.setattr(auth, "db", Database())
    auth.invalidate_principal_cache("staff", "staff-1")
    try:
        payload = {"sub": "staff-1", "session_id": "mfa-session"}
        if allowed:
            assert await auth._load_active_principal(payload, kind="staff", collection="users") == principal
        else:
            with pytest.raises(HTTPException) as exc:
                await auth._load_active_principal(payload, kind="staff", collection="users")
            assert exc.value.status_code == 401
            assert auth._cached_principal("staff", "staff-1", "mfa-session") is None
    finally:
        auth.invalidate_principal_cache("staff", "staff-1")


@pytest.mark.asyncio
@pytest.mark.parametrize("download", [False, True])
async def test_disabled_portal_rejects_existing_session_and_download(monkeypatch, download):
    async def principal(*_args, **_kwargs):
        return {"id": "customer-1", "name": "Customer", "floor_id": "first-floor", "portal_enabled": False}
    async def consume(*_args, **_kwargs):
        return {"kind": "customer", "user_id": "customer-1", "session_id": "session-1"}
    monkeypatch.setattr(auth, "_load_active_principal", principal)
    monkeypatch.setattr(auth, "decode_token", lambda _token: {"kind": "customer", "sub": "customer-1", "session_id": "session-1"})
    monkeypatch.setattr(download_tokens, "consume_download_token", consume)
    with pytest.raises(HTTPException) as exc:
        await auth.get_current_customer(request=request("/api/quotations/q/portal-pdf"), authorization=None if download else "Bearer test", dl="opaque" if download else None)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_disabling_portal_revokes_all_sessions_and_clears_cached_principals(monkeypatch):
    doc = {"id": "customer-1", "name": "Customer", "email": "customer@example.com", "floor_id": "first-floor", "portal_enabled": True}
    revocations = []
    class CustomerCollection:
        async def find_one(self, *_args, **_kwargs):
            return dict(doc)
        async def update_one(self, _query, update):
            doc.update(update["$set"])
    class Sessions:
        async def update_many(self, query, update):
            revocations.append((query, update))
            return SimpleNamespace(modified_count=2)
    async def log(**_kwargs):
        pass
    monkeypatch.setattr(customers, "db", SimpleNamespace(customers=CustomerCollection()))
    monkeypatch.setattr(auth, "db", SimpleNamespace(user_sessions=Sessions()))
    monkeypatch.setattr(customers, "log_event", log)
    auth._cache_principal("customer", "customer-1", "session-1", dict(doc))
    try:
        result = await customers.update_customer("customer-1", CustomerUpdatePayload(portal_enabled=False), UserPublic(**staff(custom=False, role="sales")))
        assert result.portal_enabled is False
        assert revocations == [({"user_type": "customer", "user_id": "customer-1", "revoked": {"$ne": True}}, {"$set": {"revoked": True}})]
        assert auth._cached_principal("customer", "customer-1", "session-1") is None
    finally:
        auth.invalidate_principal_cache("customer", "customer-1")


@pytest.mark.asyncio
async def test_catalog_backup_queries_each_collection_with_admin_floor_scope(monkeypatch):
    queries = []
    class Collection:
        def find(self, query, projection):
            queries.append(query)
            assert query == {"floor_id": {"$in": ["ground-floor"]}}
            return self
        async def to_list(self, _limit):
            return [{"floor_id": "ground-floor", "name": "allowed"}]
    class Database:
        def __getitem__(self, _name):
            return Collection()
    monkeypatch.setattr(settings_routes, "db", Database())
    user = UserPublic(**{**staff(custom=False, role="admin"), "floor_ids": ["ground-floor"]})
    response = await settings_routes.catalog_backup(user)
    body = b"".join([part async for part in response.body_iterator])
    payload = json.loads(body)
    assert len(queries) == 3
    assert all(payload[key] == [{"floor_id": "ground-floor", "name": "allowed"}] for key in settings_routes.CATALOG_BACKUP_COLLECTIONS)


@pytest.mark.asyncio
async def test_runtime_scan_revokes_renamed_staff_and_customer_without_mutating_passwords(monkeypatch):
    import bcrypt
    unsafe_hash = bcrypt.hashpw(server.LEGACY_DEMO_PASSWORD.encode(), bcrypt.gensalt(rounds=4)).decode()
    safe_hash = bcrypt.hashpw(b"unique-runtime-fixture-password", bcrypt.gensalt(rounds=4)).decode()
    revocations = []
    page_queries = []
    class Accounts:
        def __init__(self, docs):
            self.docs = docs
        def find(self, query, projection):
            assert "email" not in query
            assert projection == {"_id": 0, "id": 1, "password_hash": 1}
            page_queries.append(query)
            docs = [doc for doc in self.docs if doc["id"] > query["id"].get("$gt", "")]
            class Cursor:
                def sort(self, field, direction):
                    assert (field, direction) == ("id", 1)
                    return self
                def limit(self, bound):
                    assert bound == 1
                    return self
                async def to_list(self, bound):
                    assert bound == 1
                    return docs[:bound]
            return Cursor()
    class Sessions:
        async def update_many(self, query, update):
            revocations.append((query, update))
            return SimpleNamespace(modified_count=2)
    database = SimpleNamespace(
        users=Accounts([{"id": "renamed-staff", "password_hash": unsafe_hash}, {"id": "safe-staff", "password_hash": safe_hash}]),
        customers=Accounts([{"id": "customer-with-default", "password_hash": unsafe_hash}]),
        user_sessions=Sessions(),
    )
    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(auth, "db", database)
    monkeypatch.setattr(server, "_CREDENTIAL_SCAN_BATCH_SIZE", 1)
    subjects = [("staff", "renamed-staff"), ("customer", "customer-with-default")]
    for kind, subject in subjects:
        auth._cache_principal(kind, subject, "old-session", {"id": subject})
    try:
        await server._revoke_published_default_sessions()
        assert revocations == [({"user_type": kind, "user_id": subject, "revoked": {"$ne": True}}, {"$set": {"revoked": True}}) for kind, subject in subjects]
        assert len(page_queries) == 5
        for kind, subject in subjects:
            assert auth._cached_principal(kind, subject, "old-session") is None
        assert database.users.docs[0]["password_hash"] == unsafe_hash
        assert database.customers.docs[0]["password_hash"] == unsafe_hash
    finally:
        for kind, subject in subjects:
            auth.invalidate_principal_cache(kind, subject)


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/products/custom", "/api/products/custom-with-media"])
@pytest.mark.parametrize("resource,actions,grant_floor,active_floor,allowed", [
    ("quotations", ["create"], "first-floor", "first-floor", True),
    ("quotations", ["view"], "first-floor", "first-floor", False),
    ("quotations", ["update"], "first-floor", "first-floor", False),
    ("quotations", ["create"], "first-floor", "ground-floor", False),
    ("quotations", ["create"], "ground-floor", "ground-floor", False),
    ("tiles", ["create"], "ground-floor", "ground-floor", True),
    ("tiles", ["view"], "ground-floor", "ground-floor", False),
    ("tiles", ["create"], "ground-floor", "first-floor", False),
    ("catalog", ["create"], "first-floor", "first-floor", True),
])
async def test_custom_product_uses_exact_create_grant_on_workflow_floor(monkeypatch, path, resource, actions, grant_floor, active_floor, allowed):
    mock_staff(monkeypatch, [grant(resource=resource, actions=actions, floor=grant_floor)])
    kwargs = dict(request=request(path, "POST", floor=active_floor), authorization="Bearer test", x_floor_id=active_floor, dl=None)
    if allowed:
        user = await auth.get_current_user(**kwargs)
        assert auth.accessible_floor_ids(user) == [active_floor]
    else:
        with pytest.raises(HTTPException) as rejected:
            await auth.get_current_user(**kwargs)
        assert rejected.value.status_code == 403
