"""Regression coverage for the browser-download token authorization boundary."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from models import CustomerPublic, UserPublic
import routes.misc_routes as misc_routes
import routes.quotation_routes as quotation_routes
from routes.misc_routes import DownloadTokenRequest, _download_target_path


@pytest.mark.parametrize("target", [
    "/api/quotations/quote-1/pdf?include_dimensions=true",
    "/api/purchases/export.xlsx?stage=received",
    "/api/purchases/po-1/chalans/chalan-1/pdf",
    "/api/payments/history/export?fmt=xlsx",
    "/api/followups/export",
    "/api/tile-orders/history/export?date_from=2026-09-01",
    "/api/tile-orders/chalans/chalan-1/pdf",
])
def test_download_token_targets_are_limited_to_known_get_file_routes(target):
    assert _download_target_path(target).startswith("/api/")


@pytest.mark.parametrize("target", [
    "/api/quotations/quote-1/portal-pdf",
    "/api/quotations/quote-1/portal-pdf/revision/2",
    "/api/quotations/quote-1/portal-pdf/brand/brand-1",
])
def test_customer_download_token_targets_are_limited_to_portal_pdfs(target):
    assert _download_target_path(target, customer=True).startswith("/api/")


@pytest.mark.parametrize("target", [
    "/api/quotations/quote-1/portal-pdf",
    "/api/quotations/quote-1/portal-pdf/revision/1",
    "/api/quotations/quote-1/portal-pdf/brand/brand-1",
    "/api/quotations/quote-1/pptx",
    "/api/quotations/quote-1/pdf/other",
    "/api/purchases/po-1/chalans/chalan-1/pdf/other",
    "/api/payments/orders",
    "/api/auth/users",
    "/api/purchases/export.xlsx?dl=attacker-token",
    "https://attacker.example/api/purchases/export.xlsx",
    "/api/tile-orders/chalans/chalan-1/pdf#fragment",
])
def test_download_token_rejects_arbitrary_or_pre_tokenized_targets(target):
    with pytest.raises(HTTPException) as exc:
        _download_target_path(target)
    assert exc.value.status_code == 400


@pytest.mark.parametrize("target", [
    "/api/quotations/quote-1/pdf",
    "/api/purchases/po-1/chalans/chalan-1/pdf",
    "/api/quotations/quote-1/portal-pdf/revision/not-a-number",
    "/api/quotations/quote-1/portal-pdf?dl=stolen",
])
def test_customer_download_token_rejects_staff_and_invalid_targets(target):
    with pytest.raises(HTTPException) as exc:
        _download_target_path(target, customer=True)
    assert exc.value.status_code == 400


def _post_request():
    return Request({"type": "http", "method": "POST", "path": "/api/downloads/token", "query_string": b"", "headers": []})


def test_customer_can_mint_only_portal_pdf_token(monkeypatch):
    calls = []

    async def customer_auth(**kwargs):
        calls.append("customer-auth")

    async def create_token(*args, **kwargs):
        calls.append((args, kwargs))
        return "opaque"

    monkeypatch.setattr(misc_routes, "get_current_customer", customer_auth)
    monkeypatch.setattr(misc_routes, "create_download_token", create_token)
    target = "/api/quotations/quote-1/portal-pdf/revision/2"
    response = asyncio.run(misc_routes.mint_download_token(
        DownloadTokenRequest(target=target), _post_request(),
        ("customer", "customer-1", "session-1"), "Bearer customer-jwt", None,
    ))
    assert response == {"token": "opaque", "expires_in": 60}
    assert calls == ["customer-auth", (("customer-1", "session-1", None, target), {"kind": "customer"})]

    with pytest.raises(HTTPException) as exc:
        asyncio.run(misc_routes.mint_download_token(
            DownloadTokenRequest(target="/api/quotations/quote-1/pdf"), _post_request(),
            ("customer", "customer-1", "session-1"), "Bearer customer-jwt", None,
        ))
    assert exc.value.status_code == 400


def test_staff_cannot_mint_customer_portal_token(monkeypatch):
    async def staff_auth(**kwargs):
        return UserPublic(id="staff-1", email="staff@example.com", full_name="Staff", role="owner")

    monkeypatch.setattr(misc_routes, "get_current_user", staff_auth)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(misc_routes.mint_download_token(
            DownloadTokenRequest(target="/api/quotations/quote-1/portal-pdf"), _post_request(),
            ("staff", "staff-1", "session-1"), "Bearer staff-jwt", None,
        ))
    assert exc.value.status_code == 400


@pytest.mark.parametrize("handler,extra", [
    (quotation_routes.portal_pdf, {}),
    (quotation_routes.portal_pdf_revision, {"revision_no": 1}),
    (quotation_routes.portal_pdf_brand, {"brand_id": "brand-1"}),
])
def test_portal_pdf_routes_keep_customer_ownership_check(monkeypatch, handler, extra):
    class Quotes:
        async def find_one(self, query, projection):
            assert query == {"id": "quote-1", "customer_id": "customer-1"}
            return None  # A quote belonging to another customer is invisible.

    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(quotations=Quotes()))
    customer = CustomerPublic(id="customer-1", name="Customer", floor_id="first-floor")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(handler("quote-1", cust=customer, **extra))
    assert exc.value.status_code == 404
