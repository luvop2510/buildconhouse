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


def test_staff_tiles_excel_downloads_saved_ground_quotation(monkeypatch):
    from io import BytesIO

    from openpyxl import load_workbook

    document = {
        "id": "q2", "floor_id": "ground-floor", "customer_id": "c2", "doc_type": "tiles_quotation",
        "customer_name": "Saved customer", "subtotal": 1800, "transportation_fee": 100, "grand_total": 1900,
        "items": [{"name": "Tile", "qty": 1, "unit_price": 1800, "net_amount": 1800}],
    }

    async def quotation(query, projection, *, session):
        assert query == {"id": "q2"}
        return document

    async def customer(query, projection):
        assert query == {"id": "c2", "floor_id": "ground-floor"}
        return {"name": "Current customer"}

    monkeypatch.setattr(routes, "db", SimpleNamespace(quotations=SimpleNamespace(find_one=quotation),
                                                       customers=SimpleNamespace(find_one=customer)))
    user = UserPublic(email="sales@forge.app", full_name="Sales", role="sales", floor_ids=["ground-floor"])

    async def download():
        response = await routes.quotation_xlsx("q2", user=user)
        return response, b"".join([chunk async for chunk in response.body_iterator])

    response, data = asyncio.run(download())
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["content-disposition"].endswith("Saved%20customer%20Quotation.xlsx")
    sheet = load_workbook(BytesIO(data))["Tiles Quotation"]
    assert sheet["L5"].value == 1800
    assert sheet["J6"].value == "Transportation"
    assert sheet["L6"].value == 100
    assert sheet["L8"].value == 1900


@pytest.mark.parametrize(("doc_type", "floor", "allowed_floor", "status"), [
    ("tiles_selection", "ground-floor", "ground-floor", 400),
    ("tiles_quotation", "first-floor", "first-floor", 400),
    ("tiles_quotation", "ground-floor", "first-floor", 404),
])
def test_staff_tiles_excel_enforces_document_type_and_floor(monkeypatch, doc_type, floor, allowed_floor, status):
    async def quotation(query, projection, *, session):
        return {"id": "q2", "customer_id": "c2", "floor_id": floor, "doc_type": doc_type}

    async def customer(query, projection):
        assert status != 404
        return {}

    monkeypatch.setattr(routes, "db", SimpleNamespace(quotations=SimpleNamespace(find_one=quotation),
                                                       customers=SimpleNamespace(find_one=customer)))
    user = UserPublic(email="sales@forge.app", full_name="Sales", role="sales", floor_ids=[allowed_floor])
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.quotation_xlsx("q2", user=user))
    assert error.value.status_code == status
