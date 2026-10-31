"""PO Final loads one quotation body and overlaps independent scoped reads."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from routes import po_final_routes as routes


def test_final_reads_summary_choices_and_only_selected_history(monkeypatch):
    customer = {"id": "customer", "floor_id": "first-floor", "name": "Customer"}
    selected = {"id": "ordered", "number": "Q-1", "status": "ordered", "grand_total": 100,
                "items": [{"id": "line", "product_id": "product", "sku": "B-1", "name": "Basin", "qty": 1, "unit_price": 100}]}
    summaries = [{"id": "draft", "status": "draft"},
                 {key: selected[key] for key in ("id", "number", "status", "grand_total")}]
    calls = []

    class Cursor:
        def __init__(self, rows, name):
            self.rows, self.name = rows, name

        def sort(self, *args):
            return self

        async def to_list(self, limit):
            calls.append(self.name)
            if self.name in {"events", "transfers"}:
                # Both independent histories must start before either completes.
                while not {"events", "transfers"}.issubset(calls):
                    await asyncio.sleep(0)
            return self.rows

    def choices(query, projection):
        assert query == {"customer_id": "customer", "floor_id": "first-floor"}
        assert projection == {"_id": 0, "id": 1, "number": 1, "status": 1, "updated_at": 1, "grand_total": 1}
        return Cursor(summaries, "choices")

    async def detail(query, projection):
        assert query == {"id": "ordered", "customer_id": "customer", "floor_id": "first-floor"}
        assert projection == {"_id": 0}
        return selected

    def orders(query, projection):
        assert query == {"customer_id": "customer", "floor_id": "first-floor", "quotation_id": "ordered"}
        return Cursor([], "orders")

    def history(name):
        def find(query, projection):
            assert query["floor_id"] == "first-floor"
            return Cursor([], name)
        return find

    async def scoped(collection, document_id, user, **kwargs):
        assert document_id == "customer"
        return customer

    monkeypatch.setattr(routes, "get_floor_scoped_or_404", scoped)
    monkeypatch.setattr(routes, "db", SimpleNamespace(
        customers=object(), quotations=SimpleNamespace(find=choices, find_one=detail),
        purchase_orders=SimpleNamespace(find=orders),
        activity_events=SimpleNamespace(find=history("events")),
        godown_customer_transfers=SimpleNamespace(find=history("transfers")),
    ))

    async def run():
        return await asyncio.wait_for(routes._po_final("customer", None, None), 1)

    result = asyncio.run(run())
    assert result["quotation_id"] == "ordered"
    assert result["total"] == 100
    assert result["items"][0]["id"] == "line"
    assert [row["id"] for row in result["quotations"]] == ["draft", "ordered"]


def test_unrelated_requested_quotation_never_reads_its_body(monkeypatch):
    class Cursor:
        def sort(self, *args):
            return self

        async def to_list(self, limit):
            return [{"id": "own"}]

    monkeypatch.setattr(routes, "get_floor_scoped_or_404", AsyncMock(return_value={"id": "customer", "floor_id": "first-floor"}))
    detail = AsyncMock(side_effect=AssertionError("Unrelated quotation body was read"))
    monkeypatch.setattr(routes, "db", SimpleNamespace(customers=object(), quotations=SimpleNamespace(
        find=lambda *args: Cursor(), find_one=detail)))
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes._po_final("customer", "unrelated", None))
    assert error.value.status_code == 404
    detail.assert_not_awaited()
