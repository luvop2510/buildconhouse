"""Invalid financial input cannot poison durable records or shared reads."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from models import (
    Product, ProductCreate, ProductPatch, Quotation, QuotationCreate,
    QuotationLineItem, QuotationUpdate, RoomDiscountCfg, UserPublic,
)
from routes import catalog_routes, quotation_routes
from services.pricing import recalc_quotation_totals


def _user():
    return UserPublic(id="staff", email="staff@example.test", full_name="Fixture staff",
                      role="purchase", floor_ids=["first-floor", "ground-floor"],
                      active_floor_id="first-floor")


def _product(**changes):
    return {"id": "product", "floor_id": "first-floor", "name": "Fixture product",
            "sku": "FIXTURE", "brand_id": "brand", "category_id": "category",
            "price": 100.0, "mrp": 120.0, **changes}


def _line(**changes):
    return {"id": "line", "product_id": "product", "sku": "FIXTURE", "name": "Fixture product",
            "category_id": "category", "room": "Bath", "qty": 1.0, "unit_price": 100.0,
            **changes}


def _quotation(**changes):
    return {"id": "quotation", "floor_id": "first-floor", "number": "FQ-FIXTURE",
            "customer_id": "customer", "customer_name": "Fixture customer",
            "created_by": "staff", "created_by_name": "Fixture staff", "status": "draft",
            "project_discount_pct": 0, "category_discounts": {}, "room_discounts": {},
            "items": [_line(net_amount=100.0)], "subtotal": 100.0,
            "discount_total": 0.0, "grand_total": 100.0, **changes}


@pytest.mark.parametrize("model", [ProductCreate, ProductPatch])
@pytest.mark.parametrize("field", ["price", "mrp"])
@pytest.mark.parametrize("value", [-1, None, float("nan"), float("inf"), -float("inf")])
def test_product_write_payload_rejects_invalid_prices(model, field, value):
    values = _product() if model is ProductCreate else {}
    with pytest.raises(ValidationError):
        model(**{**values, field: value})


@pytest.mark.parametrize("model", [Product, ProductCreate, ProductPatch])
@pytest.mark.parametrize("field", ["unit_price", "mrp", "qty"])
@pytest.mark.parametrize("value", [float("inf"), float("nan"), "Infinity", "NaN", "1e999"])
def test_nested_concealed_part_numbers_must_be_finite(model, field, value):
    # Parent model settings do not propagate into nested Pydantic models.
    # String coercion also bypasses the raw JSON numeric-token guard.
    values = {} if model is ProductPatch else _product()
    with pytest.raises(ValidationError):
        model(**{**values, "concealed_part": {"sku": "ROUGH-IN", field: value}})


@pytest.mark.parametrize("model", [Product, ProductCreate, ProductPatch])
def test_finite_concealed_part_inputs_stay_valid(model):
    values = {} if model is ProductPatch else _product()
    result = model(**{**values, "concealed_part": {
        "sku": "ROUGH-IN", "unit_price": 0, "mrp": 120, "qty": 2,
    }})
    assert result.concealed_part.unit_price == 0
    assert result.concealed_part.mrp == 120
    assert result.concealed_part.qty == 2


@pytest.mark.parametrize("field", ["name", "sku", "brand_id", "category_id", "price", "mrp"])
def test_required_patch_fields_reject_explicit_null_but_omission_is_unchanged(field):
    assert ProductPatch().model_dump(exclude_unset=True) == {}
    with pytest.raises(ValidationError):
        ProductPatch(**{field: None})
    assert ProductPatch(description=None, concealed_part=None).model_dump(exclude_unset=True) == {
        "description": None, "concealed_part": None,
    }


@pytest.mark.parametrize("changes", [{"price": -1}, {"price": None}, {"price": float("inf")},
                                     {"mrp": float("nan")}, {"name": None}])
def test_product_candidate_is_validated_before_any_database_or_snapshot_write(monkeypatch, changes):
    write, snapshot, log = AsyncMock(), Mock(), AsyncMock()
    monkeypatch.setattr(catalog_routes, "db", SimpleNamespace(products=SimpleNamespace(update_one=write)))
    monkeypatch.setattr(catalog_routes.catalog_service, "patch_product_in_snapshot", snapshot)
    monkeypatch.setattr(catalog_routes, "log_event", log)
    # Exercise the last trusted write boundary too: internal callers can hold
    # stale or constructed model instances that skipped request validation.
    body = ProductPatch.model_construct(**changes)
    with pytest.raises(HTTPException) as raised:
        asyncio.run(catalog_routes._apply_product_updates("product", body, _user(), _product()))
    assert raised.value.status_code == 422
    write.assert_not_awaited()
    snapshot.assert_not_called()
    log.assert_not_awaited()


def test_zero_product_price_and_optional_clear_still_write_normally(monkeypatch):
    source = _product(description="Old")
    write, snapshot = AsyncMock(), Mock()

    async def updated_product(*_args, **_kwargs):
        return {**source, **write.await_args.args[1]["$set"]}

    monkeypatch.setattr(catalog_routes, "db", SimpleNamespace(products=SimpleNamespace(update_one=write)))
    monkeypatch.setattr(catalog_routes.catalog_service, "patch_product_in_snapshot", snapshot)
    monkeypatch.setattr(catalog_routes.catalog_service, "product_by_id", updated_product)
    monkeypatch.setattr(catalog_routes, "log_event", AsyncMock())
    result = asyncio.run(catalog_routes._apply_product_updates(
        "product", ProductPatch(price=0, description=None), _user(), source,
    ))
    assert isinstance(result, Product)
    assert result.price == 0 and result.description is None
    assert write.await_count == snapshot.call_count == 1


@pytest.mark.parametrize("model", [QuotationCreate, QuotationUpdate])
@pytest.mark.parametrize("kind", ["project", "category", "room"])
@pytest.mark.parametrize("value", [-1, 101, float("nan"), float("inf"), -float("inf")])
def test_new_quotation_percentage_inputs_are_finite_and_bounded(model, kind, value):
    changes = {"project_discount_pct": value} if kind == "project" else (
        {"category_discounts": {"category": value}} if kind == "category" else
        {"room_discounts": {"Bath": {"type": "percent", "value": value}}}
    )
    with pytest.raises(ValidationError):
        model(customer_id="customer", **changes)


@pytest.mark.parametrize("model", [QuotationCreate, QuotationUpdate])
@pytest.mark.parametrize("value", [-1, float("nan"), float("inf")])
def test_new_room_amount_and_transport_inputs_reject_invalid_values(model, value):
    for changes in [{"room_discounts": {"Bath": {"type": "amount", "value": value}}},
                    {"transportation_fee": value}]:
        with pytest.raises(ValidationError):
            model(customer_id="customer", **changes)


@pytest.mark.parametrize("field", ["qty", "unit_price", "mrp", "catalog_price", "catalog_mrp",
                                   "net_amount", "rate_sqft", "rate_box", "box_sqft", "offer_rate",
                                   "included_qty_per_parent"])
def test_nested_quotation_financial_inputs_reject_nonfinite_numbers(field):
    line = QuotationLineItem(**_line(**{field: float("inf")}))
    for model in [QuotationCreate, QuotationUpdate]:
        with pytest.raises(ValidationError):
            model(customer_id="customer", items=[line])
    with pytest.raises(ValidationError):
        quotation_routes.QuotationLineMutation(item=line)


def test_historical_negative_discount_results_stay_readable_but_new_writes_are_rejected():
    old = _quotation(category_discounts={"category": 150},
                     room_discounts={"Bath": {"type": "percent", "value": 150}},
                     items=[_line(net_amount=-50.0)], discount_total=150.0, grand_total=-50.0)
    result = Quotation(**old)
    assert result.grand_total == result.items[0].net_amount == -50
    assert RoomDiscountCfg(type="percent", value=150).value == 150
    with pytest.raises(HTTPException) as raised:
        quotation_routes._require_valid_quotation_financials(old)
    assert raised.value.status_code == 422


def test_historical_negative_discount_breakdown_remains_readable(monkeypatch):
    old = _quotation(category_discounts={"category": 150},
                     items=[_line(net_amount=-50)], discount_total=150.0, grand_total=-50.0)
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(
        quotations=SimpleNamespace(find_one=AsyncMock(return_value=old)),
    ))
    result = asyncio.run(quotation_routes.quotation_breakdown("quotation", _user()))
    assert result["totals"]["grand_total"] == -50.0


def test_valid_amount_discount_keeps_its_existing_subtotal_cap():
    body = QuotationCreate(customer_id="customer", items=[_line()],
                           room_discounts={"Bath": {"type": "amount", "value": 5000}})
    totals = recalc_quotation_totals(body.items, room_discounts=body.room_discounts)
    assert totals == {"subtotal": 100.0, "discount_total": 100.0, "grand_total": 0.0}
    quotation_routes._require_valid_quotation_financials({**body.model_dump(), **totals})


def _patch_quotation_dependencies(monkeypatch, doc):
    writes = SimpleNamespace(insert_one=AsyncMock(), update_one=AsyncMock())
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(quotations=writes, customers=SimpleNamespace()))
    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", AsyncMock(return_value=deepcopy(doc)))

    async def products(items, *_args, **_kwargs):
        return [_product(price=item.unit_price, mrp=item.unit_price,
                         floor_id=doc.get("floor_id", "first-floor")) for item in items]

    async def images(items, *_args, **_kwargs):
        return [item.model_dump() if hasattr(item, "model_dump") else dict(item) for item in items]

    monkeypatch.setattr(quotation_routes, "_quotation_catalog_products", products)
    monkeypatch.setattr(quotation_routes, "_canonicalize_item_images", images)
    monkeypatch.setattr(quotation_routes, "log_event", AsyncMock())
    return writes


def test_finite_operands_that_overflow_are_rejected_before_quotation_update(monkeypatch):
    writes = _patch_quotation_dependencies(monkeypatch, _quotation())
    body = QuotationUpdate(items=[_line(qty=1e308, unit_price=1e308)], silent=True)
    with pytest.raises(HTTPException) as raised:
        asyncio.run(quotation_routes.update_quotation("quotation", body, _user()))
    assert raised.value.status_code == 422
    writes.update_one.assert_not_awaited()


def test_transport_addition_overflow_is_rejected_before_quotation_update(monkeypatch):
    doc = _quotation(doc_type="tiles_quotation", floor_id="ground-floor")
    writes = _patch_quotation_dependencies(monkeypatch, doc)
    body = QuotationUpdate(items=[_line(unit_price=1e308)], transportation_fee=1e308, silent=True)
    with pytest.raises(HTTPException) as raised:
        asyncio.run(quotation_routes.update_quotation("quotation", body, _user()))
    assert raised.value.status_code == 422
    writes.update_one.assert_not_awaited()


def test_overflow_creation_rejects_before_number_allocation_or_insert(monkeypatch):
    writes = _patch_quotation_dependencies(monkeypatch, {"id": "customer", "name": "Fixture customer"})
    number = AsyncMock(return_value="FQ-NEVER-ALLOCATED")
    monkeypatch.setattr(quotation_routes, "_next_number", number)
    body = QuotationCreate(customer_id="customer", items=[_line(qty=1e308, unit_price=1e308)])
    with pytest.raises(HTTPException) as raised:
        asyncio.run(quotation_routes.create_quotation(body, _user()))
    assert raised.value.status_code == 422
    number.assert_not_awaited()
    writes.insert_one.assert_not_awaited()
