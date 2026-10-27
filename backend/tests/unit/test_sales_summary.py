"""Compact sales reporting: bounded rows, exact totals, units and access."""
import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import Response

from models import UserPublic
from routes import sales_summary_routes
from services.analytics.filters import AnalyticsFilter, FloorAccessError
from services.analytics.sales_summary import ROW_LIMIT, financial_scope, shape_products


def test_products_deduplicate_order_customer_ids_and_keep_units_separate():
    rows = [
        {"_id": {"product_id": "p", "unit": "Boxes"}, "name": "Tile", "quantity": 2, "revenue": 200, "order_ids": ["a"], "customer_ids": ["c"]},
        {"_id": {"product_id": "p", "unit": "Pieces"}, "name": "Tile", "quantity": 3, "revenue": 300, "order_ids": ["a", "b"], "customer_ids": ["c", None]},
        {"_id": {"product_id": "deleted", "unit": "Pieces"}, "quantity": 1, "revenue": 75, "order_ids": ["b"], "customer_ids": ["c"]},
    ]
    products, brands, quantities = shape_products(rows, {"p": "b"}, {"b": "Qutone"})
    assert products[0]["orders"] == 2 and products[0]["customers"] == 1
    assert quantities == [{"unit": "Boxes", "quantity": 2}, {"unit": "Pieces", "quantity": 4}]
    assert brands[-1]["is_unlinked"] is True
    assert sum(row["revenue"] for row in brands) == sum(row["revenue"] for row in products) == 575


def test_totals_are_computed_before_the_display_limit():
    rows = [{"_id": {"product_id": str(i), "unit": "Pieces"}, "name": str(i), "quantity": 1, "revenue": i} for i in range(ROW_LIMIT + 1)]
    products, brands, quantities = shape_products(rows, {}, {})
    assert len(products) == ROW_LIMIT + 1
    assert quantities == [{"unit": "Pieces", "quantity": ROW_LIMIT + 1}]
    assert brands[0]["revenue"] == sum(range(ROW_LIMIT + 1))


def test_floor_scope_validates_before_excluding_non_catalog_units():
    with pytest.raises(FloorAccessError):
        financial_scope(AnalyticsFilter(floor_id="second-floor"), ["first-floor"])
    assert financial_scope(AnalyticsFilter(floor_id="all"), ["ground-floor"])["floor_id"] == {"$in": ["ground-floor"]}
    assert financial_scope(AnalyticsFilter(floor_id="all"), [])["floor_id"] == {"$in": []}


def test_empty_products_do_not_invent_a_unit_or_zero_row():
    assert shape_products([], {}, {}) == ([], [], [])


def test_route_denies_unauthorized_scope_before_data_or_cache(monkeypatch):
    async def forbidden(*args, **kwargs):
        raise AssertionError("Must not read or cache unauthorized data")
    monkeypatch.setattr(sales_summary_routes, "gather_financial_summary", forbidden)
    monkeypatch.setattr(sales_summary_routes, "gather_followup_summary", forbidden)
    user = UserPublic(id="restricted", email="restricted@example.test", full_name="Restricted", role="admin", floor_ids=["first-floor"], active_floor_id="first-floor")
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        asyncio.run(sales_summary_routes.sales_summary(Response(), floor_id="ground-floor", user=user))
    assert error.value.status_code == 403


def test_money_uses_exact_decimal_cents_for_saved_furniture_values():
    from bson.decimal128 import Decimal128
    from services.analytics.sales_summary import _money
    assert _money(Decimal128("123456789.125")) == 123456789.13
    assert _money(Decimal128("0.10")) == 0.10


def test_current_ledger_read_is_not_reused_after_furniture_deposit_edit(monkeypatch):
    calls = []
    async def financial(*args):
        calls.append(True)
        return {"kpis": {"outstanding_rnb": 20 if len(calls) == 1 else 5}}
    async def followups(*args):
        return {"followups": 0, "overdue_followups": 0}
    monkeypatch.setattr(sales_summary_routes, "gather_financial_summary", financial)
    monkeypatch.setattr(sales_summary_routes, "gather_followup_summary", followups)
    user = UserPublic(id="owner", email="owner@example.test", full_name="Owner", role="owner")
    async def run():
        first = await sales_summary_routes.sales_summary(Response(), floor_id="third-floor", user=user)
        second = await sales_summary_routes.sales_summary(Response(), floor_id="third-floor", user=user)
        assert first["kpis"]["outstanding_rnb"] == 20
        assert second["kpis"]["outstanding_rnb"] == 5
    asyncio.run(run())
    assert len(calls) == 2


def test_selected_basis_and_referrer_requirement_are_explicit():
    from services.analytics.kitchen_referrals import kitchen_referral_pipeline
    ordinary = kitchen_referral_pipeline({"floor_id": {"$in": ["second-floor"]}, "status": "ordered"})
    assert ordinary[0]["$match"]["referrer_id"] == {"$nin": [None, ""]}
    unreferenced = kitchen_referral_pipeline({"floor_id": {"$in": ["second-floor"]}, "status": "ordered"}, require_referrer=False)
    assert "referrer_id" not in unreferenced[0]["$match"]
    assert "$_basis.quote" in str(unreferenced)
    assert "$$order.quotation_version_id" in str(unreferenced)
    assert "$$quote.design_version_id" in str(unreferenced)
