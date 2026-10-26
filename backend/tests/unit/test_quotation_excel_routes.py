"""Staff floor authorization and portal ownership apply to Excel downloads."""
import asyncio
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

from models import CustomerPublic, UserPublic
import routes.quotation_routes as routes


def test_staff_excel_uses_floor_scoped_lookup_and_private_customer(monkeypatch):
    document = {"id": "q1", "floor_id": "first-floor", "customer_id": "c1"}
    calls = []

    async def scoped(collection, identifier, user, **kwargs):
        calls.append((collection, identifier, user))
        return document

    async def customer(query, projection):
        assert query == {"id": "c1", "floor_id": "first-floor"}
        assert projection["password_hash"] == 0
        return {"name": "Customer"}

    async def build(doc, cust):
        assert doc == document and cust == {"name": "Customer"}
        return b"xlsx", "Customer.xlsx"

    monkeypatch.setattr(routes, "db", SimpleNamespace(quotations=object(), customers=SimpleNamespace(find_one=customer)))
    monkeypatch.setattr(routes, "get_floor_scoped_or_404", scoped)
    monkeypatch.setattr(routes, "_build_quotation_excel_file", build)
    user = UserPublic(email="sales@forge.app", full_name="Sales", role="sales", floor_ids=["first-floor"])
    response = asyncio.run(routes.quotation_xlsx("q1", user=user))
    assert calls == [(routes.db.quotations, "q1", user)]
    assert response.media_type.endswith("spreadsheetml.sheet")
    assert response.headers["cache-control"] == "private, no-store"


def test_portal_excel_cannot_read_another_customer_quotation(monkeypatch):
    async def quotation(query, projection):
        assert query == {"id": "foreign", "customer_id": "c1"}
        return None

    monkeypatch.setattr(routes, "db", SimpleNamespace(quotations=SimpleNamespace(find_one=quotation)))
    customer = CustomerPublic(id="c1", name="Customer", floor_id="first-floor")
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.portal_xlsx("foreign", cust=customer))
    assert error.value.status_code == 404


def test_shared_excel_renderer_resolves_exact_images_and_runs_off_loop(monkeypatch):
    document = {"items": [], "floor_id": "first-floor", "customer_name": "Client"}
    customer = {"name": "Customer"}
    calls = []

    async def images(items, floor):
        assert items == [] and floor == "first-floor"
        return [{"sku": "exact"}]

    async def thread(builder, doc, cust):
        calls.append(builder)
        assert doc["items"] == [{"sku": "exact"}] and cust is customer
        return b"xlsx"

    monkeypatch.setattr(routes, "_canonicalize_item_images", images)
    monkeypatch.setattr(routes, "run_in_threadpool", thread)
    data, filename = asyncio.run(routes._build_quotation_excel_file(document, customer))
    assert data == b"xlsx" and filename == "Client Quotation.xlsx"
    assert calls == [routes.build_quotation_excel]
    assert document["items"] == []


def test_tiles_excel_is_explicitly_rejected():
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes._build_quotation_excel_file({"doc_type": "tiles_selection"}, {}))
    assert error.value.status_code == 400
