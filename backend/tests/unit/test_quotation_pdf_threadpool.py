"""Quotation PDF rendering must never block the async API event loop."""
from __future__ import annotations

import asyncio

import routes.quotation_routes as quotation_routes


def test_render_pdf_dispatches_builder_to_threadpool(monkeypatch):
    call = {}

    def builder(document, customer, branding):
        return b"%PDF-test"

    async def fake_run_in_threadpool(fn, *args):
        call["fn"] = fn
        call["args"] = args
        return fn(*args)

    monkeypatch.setattr(quotation_routes, "run_in_threadpool", fake_run_in_threadpool)
    document = {"number": "FQ-1"}
    customer = {"name": "Mobile Customer"}
    branding = {"footer_company_name": "BuildCon House"}

    result = asyncio.run(quotation_routes._render_pdf(builder, document, customer, branding))

    assert result == b"%PDF-test"
    assert call == {"fn": builder, "args": (document, customer, branding)}


def test_portal_pdf_http_response_preserves_unicode_customer_filename(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from urllib.parse import unquote
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    doc = {"id": "q-unicode", "customer_id": "c1", "customer_name": "નિલેશભાઈ", "created_at": "2026-10-29T09:00:00Z"}
    customer = SimpleNamespace(id="c1", name="નિલેશભાઈ", model_dump=lambda: {"name": "નિલેશભાઈ"})
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(quotations=SimpleNamespace(find_one=AsyncMock(return_value=doc))))
    monkeypatch.setattr(quotation_routes, "_pdf_items", AsyncMock(return_value=[]))
    monkeypatch.setattr(quotation_routes, "_pdf_branding", AsyncMock(return_value={}))
    monkeypatch.setattr(quotation_routes, "_render_pdf", AsyncMock(return_value=b"%PDF-unicode-name"))
    app = FastAPI()
    app.include_router(quotation_routes.router)
    app.dependency_overrides[quotation_routes.get_current_customer] = lambda: customer
    with TestClient(app) as client:
        response = client.get("/quotations/q-unicode/portal-pdf")
    assert response.status_code == 200
    assert response.content == b"%PDF-unicode-name"
    disposition = response.headers["content-disposition"]
    assert 'filename="quotation.pdf"' in disposition
    assert unquote(disposition.split("UTF-8''", 1)[1]) == "નિલેશભાઈ 29-10-2026 quotation PDF.pdf"
