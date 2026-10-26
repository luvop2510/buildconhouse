import asyncio

import pytest
from fastapi import HTTPException

from models import UserPublic
from routes import po_final_routes as routes
from services.access_grants import action_for_api_request
from access_profiles import profile_allows_request, SANITARY_QUOTATIONS_FOLLOWUPS


def test_excel_exports_require_export_grant_and_allow_sales_profile():
    for path in ("/api/quotations/q1/xlsx", "/api/customers/c1/po-final/xlsx"):
        assert action_for_api_request("GET", path) == "export"
        assert profile_allows_request(SANITARY_QUOTATIONS_FOLLOWUPS, "GET", path)


def test_final_excel_uses_current_quantities_and_prices_without_double_discount(monkeypatch):
    import routes.quotation_routes as quotation_routes
    captured = {}
    data = {"quotation_id": "q1", "quotation_number": "Q-1", "customer": {"id": "c1", "name": "Customer"},
            "items": [{"id": "kept", "qty": 1, "total": 72}, {"id": "returned", "qty": 0, "total": 0}],
            "items_total": 72, "total": 72, "payable_total": 92}
    quotation = {"id": "q1", "floor_id": "first-floor", "project_discount_pct": 20,
                 "room_discounts": {"Bath": {"type": "percent", "value": 10}},
                 "category_discounts": {"c": 15}, "items": [
                     {"id": "kept", "name": "Stock replacement", "qty": 2, "unit_price": 100, "room": "Bath"},
                     {"id": "returned", "name": "Moved out", "qty": 1, "unit_price": 100}],
                 "payment_extra_history": [{"name": "Transport", "amount": 20}]}

    async def snapshot(customer_id, quotation_id, user):
        assert (customer_id, quotation_id) == ("c1", "q1")
        return data

    async def scoped(collection, document_id, user, **kwargs):
        assert document_id == "q1"
        return quotation

    async def build(document, customer):
        captured.update(document)
        assert customer == data["customer"]
        return b"test-xlsx", "Quotation.xlsx"

    monkeypatch.setattr(routes, "_po_final", snapshot)
    monkeypatch.setattr(routes, "get_floor_scoped_or_404", scoped)
    monkeypatch.setattr(quotation_routes, "_build_quotation_excel_file", build)
    user = UserPublic(id="u1", email="owner@example.test", full_name="Owner", role="owner")
    response = asyncio.run(routes.get_po_final_xlsx("c1", "q1", user))
    assert response.media_type.endswith("spreadsheetml.sheet")
    assert "PO-Final-Q-1.xlsx" in response.headers["Content-Disposition"]
    assert [(item["name"], item["qty"], item["unit_price"], item["discount_pct"]) for item in captured["items"]] == [("Stock replacement", 1, 72, 0)]
    assert captured["grand_total"] == 72
    assert captured["project_discount_pct"] == 0
    assert captured["room_discounts"] == captured["category_discounts"] == {}
    assert captured["_po_final"]["payable_total"] == 92


def test_final_excel_rejects_empty_customer(monkeypatch):
    async def empty(*args):
        return {"quotation_id": None}
    monkeypatch.setattr(routes, "_po_final", empty)
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.get_po_final_xlsx("c1", None, None))
    assert error.value.status_code == 404
