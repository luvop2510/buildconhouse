"""Verify quotation PDF rendering and the download paths that use it."""
from __future__ import annotations

import asyncio
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pypdf import PdfReader
import pytest

import pdf_generator
import pdf_tiles
import routes.quotation_routes as quotation_routes
from services import whatsapp_delivery


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
    from urllib.parse import unquote

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


@pytest.mark.parametrize("floor_id,doc_type", [
    ("first-floor", "standard"), ("ground-floor", None), ("ground-floor", "tiles_quotation"),
], ids=["sanitary", "ground-legacy", "ground-tiles"])
def test_all_product_quotation_downloads_and_shares_omit_staff(monkeypatch, floor_id, doc_type):
    item = {"product_id": "product-1", "sku": "MIXER-1", "name": "Mixer Fixture", "qty": 2,
            "unit_price": 125, "image": "fixture.png", "net_amount": 250}
    doc = {
        "id": "q1", "number": "Q-FIXTURE", "floor_id": floor_id, "customer_id": "c1",
        "customer_name": "Fixture Customer", "status": "draft", "updated_at": "fixture-version",
        "reference_source": "Fixture Reference", "address_snapshot": "Fixture Address",
        "phone_snapshot": "9909906652", "subtotal": 250, "grand_total": 250,
        "attended_by": "Attendant Fixture", "prepared_by": "Preparer Fixture", "items": [item],
        "revisions": [{"revision_no": 1, "snapshot": {"items": [{**item, "name": "Previous Mixer"}]}}],
    }
    if doc_type:
        doc["doc_type"] = doc_type
    customer = {"name": doc["customer_name"], "phone": doc["phone_snapshot"], "floor_id": floor_id}
    portal_customer = SimpleNamespace(id="c1", name=customer["name"], model_dump=lambda: customer)
    products = SimpleNamespace(find=lambda *_args: SimpleNamespace(to_list=AsyncMock(return_value=[
        {"id": item["product_id"], "sku": item["sku"], "brand_id": "brand-1"},
    ])))
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(
        quotations=SimpleNamespace(find_one=AsyncMock(return_value=doc)),
        customers=SimpleNamespace(find_one=AsyncMock(return_value=customer)), products=products,
        event_outbox=SimpleNamespace(find_one=AsyncMock(return_value={"id": "existing-event"})),
    ))
    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", AsyncMock(return_value=doc))
    monkeypatch.setattr(quotation_routes, "_canonicalize_item_images", AsyncMock(side_effect=lambda items, _: items))
    monkeypatch.setattr(quotation_routes, "_pdf_branding", AsyncMock(return_value={}))
    monkeypatch.setattr(quotation_routes, "dispatch_event", AsyncMock())
    monkeypatch.setattr(pdf_generator, "prefetch_product_images", lambda _items: {})
    monkeypatch.setattr(pdf_tiles, "prefetch_product_images", lambda _items: {})
    send_document = AsyncMock(return_value={"status": "queued"})
    monkeypatch.setattr(whatsapp_delivery, "send_document", send_document)

    app = FastAPI()
    app.include_router(quotation_routes.router)
    app.dependency_overrides[quotation_routes.get_current_user] = lambda: SimpleNamespace(id="staff-1")
    app.dependency_overrides[quotation_routes.get_current_customer] = lambda: portal_customer
    with TestClient(app) as client:
        documents = []
        for path in ("pdf", "pdf?include_dimensions=true", "portal-pdf",
                     "portal-pdf/revision/1", "portal-pdf/brand/brand-1"):
            response = client.get(f"/quotations/q1/{path}")
            assert response.status_code == 200, response.text
            assert response.headers["content-type"] == "application/pdf"
            documents.append((response.content, "Previous Mixer" if path.endswith("revision/1") else "Mixer Fixture"))
        response = client.post("/quotations/q1/whatsapp-send", json={
            "message": "Please review", "expected_updated_at": doc["updated_at"],
            "idempotency_key": "quotation-delivery-test",
        })
        assert response.status_code == 200, response.text
        documents.append((send_document.call_args.kwargs["pdf_bytes"], "Mixer Fixture"))

    for data, product_name in documents:
        text = " ".join(" ".join(page.extract_text().split()) for page in PdfReader(BytesIO(data)).pages)
        assert all(value in text for value in ("PRODUCT QUOTATION", "Fixture Customer", "Q-FIXTURE",
                                               "Fixture Reference", "Fixture Address", "250.00", product_name))
        assert all(value not in text for value in ("ATTENDED BY", "PREPARED BY", "Attendant Fixture", "Preparer Fixture"))
