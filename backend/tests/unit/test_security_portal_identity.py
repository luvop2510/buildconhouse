"""HTTP boundaries for customer-owned records and untrusted login/JWT inputs."""
from copy import deepcopy
from types import SimpleNamespace

import httpx
import jwt
import pytest
from fastapi import Depends, FastAPI

import auth
from models import CustomerPublic
from routes import auth_routes, customer_routes, quotation_routes


class Quotations:
    def __init__(self):
        # Both customers share the same floor: floor isolation cannot substitute
        # for customer ownership checks at the portal boundary.
        self.rows = [
            {"id": "quote-a", "customer_id": "customer-a", "floor_id": "first-floor", "created_at": "2026-10-11", "revisions": []},
            {"id": "quote-b", "customer_id": "customer-b", "floor_id": "first-floor", "created_at": "2026-10-12", "revisions": []},
        ]

    def find(self, query, _projection):
        rows = [deepcopy(row) for row in self.rows if all(row.get(key) == value for key, value in query.items())]
        class Cursor:
            def sort(self, key, direction):
                rows.sort(key=lambda row: row[key], reverse=direction < 0)
                return self

            async def to_list(self, limit):
                return rows[:limit]
        return Cursor()

    async def find_one(self, query, _projection):
        return next((deepcopy(row) for row in self.rows if all(row.get(key) == value for key, value in query.items())), None)


def portal_app(monkeypatch, customer_id):
    monkeypatch.setattr(customer_routes, "db", SimpleNamespace(quotations=Quotations()))
    app = FastAPI()
    app.include_router(customer_routes.router, prefix="/api")
    app.dependency_overrides[auth.get_current_customer] = lambda: CustomerPublic(
        id=customer_id, name="Portal customer", floor_id="first-floor", portal_enabled=True,
    )
    return app


@pytest.mark.asyncio
@pytest.mark.parametrize("customer_id,expected", [
    ("customer-a", ["quote-a"]), ("customer-b", ["quote-b"]), ("no-quotes", []),
])
async def test_portal_list_excludes_other_customers_on_same_floor(monkeypatch, customer_id, expected):
    app = portal_app(monkeypatch, customer_id)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test") as client:
        response = await client.get("/api/portal/quotations")
    assert response.status_code == 200
    assert [row["id"] for row in response.json()] == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("customer_id,own_id,foreign_id", [
    ("customer-a", "quote-a", "quote-b"), ("customer-b", "quote-b", "quote-a"),
])
async def test_portal_detail_ownership_rejects_foreign_id_before_preview(monkeypatch, customer_id, own_id, foreign_id):
    app = portal_app(monkeypatch, customer_id)
    previews = []
    async def preview(doc):
        previews.append(doc["id"])
        return {"brands": []}
    monkeypatch.setattr(quotation_routes, "_brand_grouped_preview", preview)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test") as client:
        foreign = await client.get(f"/api/portal/quotations/{foreign_id}")
        missing = await client.get("/api/portal/quotations/missing")
        assert foreign.status_code == missing.status_code == 404
        assert foreign.json() == missing.json() == {"detail": "Quotation not found"}
        assert previews == []
        own = await client.get(f"/api/portal/quotations/{own_id}")
    assert own.status_code == 200 and own.json()["customer_id"] == customer_id
    assert previews == [own_id]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["tampered-signature", "unsigned", "wrong-algorithm"])
async def test_staff_endpoint_rejects_invalid_jwt_before_database_lookup(monkeypatch, case):
    monkeypatch.setattr(auth, "JWT_SECRET", "hermetic-algorithm-boundary-fixture-secret-" * 2)
    valid = auth.create_token("member", "staff", {"session_id": "session"})
    payload = auth.decode_token(valid)
    if case == "tampered-signature":
        head, body, signature = valid.split(".")
        signature = ("A" if signature[0] != "A" else "B") + signature[1:]
        token = f"{head}.{body}.{signature}"
    elif case == "unsigned":
        token = jwt.encode(payload, key="", algorithm="none")
    else:
        token = jwt.encode(payload, key=auth.JWT_SECRET, algorithm="HS512")
    async def forbidden_lookup(*_args, **_kwargs):
        raise AssertionError("Invalid JWT must be rejected before loading its principal")
    monkeypatch.setattr(auth, "_load_active_principal", forbidden_lookup)
    app = FastAPI()
    @app.get("/protected")
    async def protected(user=Depends(auth.get_current_user)):
        return {"id": user.id}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test") as client:
        response = await client.get("/protected", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/auth/login", "/api/auth/customer/login"])
@pytest.mark.parametrize("operator", [{"$ne": None}, {"$regex": ".*"}])
async def test_login_operator_object_is_rejected_before_rate_limit_or_database(monkeypatch, path, operator):
    async def forbidden_attempt(*_args, **_kwargs):
        raise AssertionError("Operator input must be rejected by HTTP validation before login logic")
    monkeypatch.setattr(auth_routes, "reserve_login_attempt", forbidden_attempt)
    app = FastAPI()
    app.include_router(auth_routes.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test") as client:
        response = await client.post(path, json={"email": operator, "password": "fixture-password"})
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "email"]
