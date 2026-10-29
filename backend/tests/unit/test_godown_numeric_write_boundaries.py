"""Finite operands must not overflow stock or quotation state after persistence."""
import asyncio
from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from models import UserPublic
from routes import godown_stock_routes as routes


def actor():
    return UserPublic(id="owner", email="owner@example.test", full_name="Owner", role="owner",
                      floor_ids=["first-floor"], active_floor_id="first-floor")


def stock(**changes):
    return {"id": "stock", "floor_id": "first-floor", "product_id": "product", "sku": "SKU",
            "name": "Basin", "available_qty": 2, "qty_received": 2, "loaned_out_qty": 0,
            "unit_price": 100, "mrp": 100, "price_variants": [], "updated_at": "version", **changes}


def quotation(**changes):
    return {"id": "quote", "floor_id": "first-floor", "status": "draft", "items": [],
            "subtotal": 0, "discount_total": 0, "grand_total": 0, **changes}


class Session:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def start_transaction(self):
        return self

    async def with_transaction(self, callback):
        return await callback(self)


@pytest.mark.parametrize("use_catalog,changes", [
    (False, {"unit_price": 1e308}),
    (False, {"unit_price": 1, "price_variants": [{"label": "Alternative", "price": 1e308}]}),
    (True, {"unit_price": 1e308}),
    (True, {}),
])
def test_direct_overflow_rejected_before_catalog_or_stock_write(monkeypatch, use_catalog, changes):
    product = {"id": "product", "floor_id": "first-floor", "mrp": 1e308}
    insert = AsyncMock()
    register = AsyncMock()
    monkeypatch.setattr(routes, "db", SimpleNamespace(products=SimpleNamespace(find_one=AsyncMock(return_value=product)),
                                                       godown_stock=SimpleNamespace(insert_one=insert)))
    monkeypatch.setattr(routes, "_intake_catalog_product", register)
    values = {"qty": 2, "sku": "SKU", "name": "Basin", **changes}
    if use_catalog:
        values["product_id"] = "product"
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes.direct_intake(routes.DirectIntake(**values), actor()))
    assert exc.value.status_code == 422
    register.assert_not_awaited()
    insert.assert_not_awaited()


@pytest.mark.parametrize("route,model", [
    (routes.update_stock_pricing, routes.StockPricingUpdate),
    (routes.update_stock_details, routes.StockDetailsUpdate),
])
def test_price_overflow_rejected_before_stock_write(monkeypatch, route, model):
    update = AsyncMock()
    monkeypatch.setattr(routes, "db", SimpleNamespace(godown_stock=SimpleNamespace(
        find_one=AsyncMock(return_value=stock()), find_one_and_update=update)))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(route("stock", model(unit_price=1e308), actor()))
    assert exc.value.status_code == 422
    update.assert_not_awaited()


@pytest.mark.parametrize("route,model", [
    (routes.update_stock_pricing, routes.StockPricingUpdate),
    (routes.update_stock_details, routes.StockDetailsUpdate),
])
def test_price_write_binds_validated_quantity_and_price_snapshot(monkeypatch, route, model):
    current = stock()
    update = AsyncMock(return_value=None)
    monkeypatch.setattr(routes, "db", SimpleNamespace(godown_stock=SimpleNamespace(
        find_one=AsyncMock(return_value=current), find_one_and_update=update)))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(route("stock", model(unit_price=50), actor()))
    assert exc.value.status_code == 409
    guard = update.call_args.args[0]["$and"][-1]
    assert guard["available_qty"] == current["available_qty"]
    assert guard["unit_price"] == current["unit_price"]
    assert guard["price_variants"] == current["price_variants"]


@pytest.mark.parametrize("changes,qty", [
    ({"available_qty": 1, "qty_received": 1, "unit_price": 1e308, "mrp": 1}, 1),
    ({"available_qty": 1e308, "qty_received": 1e308, "unit_price": 0, "mrp": 0}, 1e308),
    ({"available_qty": 0, "qty_received": 1e308, "unit_price": 0, "mrp": 0}, 1e308),
])
def test_receipt_rejects_derived_overflow_before_catalog_or_quantity_write(monkeypatch, changes, qty):
    update = AsyncMock()
    register = AsyncMock()
    monkeypatch.setattr(routes, "db", SimpleNamespace(godown_stock=SimpleNamespace(
        find_one=AsyncMock(return_value=stock(product_id="godown:stock", **changes)), find_one_and_update=update)))
    monkeypatch.setattr(routes, "_intake_catalog_product", register)
    body = routes.StockMovement(kind="receipt", qty=qty, occurred_on=date(2026, 1, 1),
                                reason="Counted receipt", expected_updated_at="version", idempotency_key="receipt-command")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes.record_stock_movement("stock", body, actor()))
    assert exc.value.status_code == 422
    update.assert_not_awaited()
    register.assert_not_awaited()


def test_opening_count_rejects_overflow_before_write(monkeypatch):
    update = AsyncMock()
    monkeypatch.setattr(routes, "db", SimpleNamespace(godown_stock=SimpleNamespace(
        find_one=AsyncMock(return_value=stock(available_qty=0, qty_received=0, quantity_missing=True, unit_price=1e308)),
        find_one_and_update=update), godown_customer_transfers=SimpleNamespace(find_one=AsyncMock(return_value=None))))
    body = routes.MissingQuantityCount(qty=2, counted_on=date(2026, 1, 1), reason="Opening count",
                                       expected_updated_at="version", idempotency_key="opening-count")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes.record_missing_quantity("stock", body, actor()))
    assert exc.value.status_code == 422
    update.assert_not_awaited()


def test_intake_rejects_source_value_overflow_before_any_write(monkeypatch):
    orders = SimpleNamespace(update_one=AsyncMock())
    quotes = SimpleNamespace(update_one=AsyncMock())
    lots = SimpleNamespace(insert_one=AsyncMock())
    monkeypatch.setattr(routes, "db", SimpleNamespace(purchase_orders=orders, quotations=quotes, godown_stock=lots))
    item = {"id": "item", "qty_received": 2, "unit_cost": 1e308}
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes._persist_intake(po={"id": "po", "floor_id": "first-floor", "quotation_id": "quote"},
                    item=item, qty=2, reason="Transfer stock", user=actor(), lot=stock(), at="now"))
    assert exc.value.status_code == 422
    orders.update_one.assert_not_awaited()
    quotes.update_one.assert_not_awaited()
    lots.insert_one.assert_not_awaited()


def test_customer_transfer_rejects_overflow_before_creating_customer_or_counters(monkeypatch):
    session = Session()
    customers = SimpleNamespace(insert_one=AsyncMock(), update_one=AsyncMock())
    monkeypatch.setattr(routes, "client", SimpleNamespace(start_session=AsyncMock(return_value=session)))
    monkeypatch.setattr(routes, "next_number", AsyncMock())
    monkeypatch.setattr(routes, "db", SimpleNamespace(
        settings=SimpleNamespace(find_one=AsyncMock(return_value=None)),
        godown_customer_transfers=SimpleNamespace(find_one=AsyncMock(return_value=None)),
        godown_stock=SimpleNamespace(find_one=AsyncMock(return_value=stock())), customers=customers))
    body = routes.CustomerTransfer(qty=2, unit_price=1e308, new_customer=routes.NewTransferCustomer(name="New customer"),
                                   idempotency_key="transfer-command")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes._transfer_stock_to_customer_once("stock", body, actor()))
    assert exc.value.status_code == 422
    customers.insert_one.assert_not_awaited()
    customers.update_one.assert_not_awaited()
    routes.next_number.assert_not_awaited()


def test_new_transfer_quote_rejects_overflow_before_number_mutation(monkeypatch):
    counter = AsyncMock()
    monkeypatch.setattr(routes, "next_number", counter)
    body = routes.CustomerTransfer(qty=2, unit_price=1e308, recipient_customer_id="customer", idempotency_key="transfer-command")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes._new_transfer_quotation(stock(), {"id": "customer"}, body, "stock", "now", actor(), Session()))
    assert exc.value.status_code == 422
    counter.assert_not_awaited()


def allocation_setup(monkeypatch, *, lot=None, quote=None, claim=None):
    session = Session()
    current = quotation() if quote is None else quote
    current_lot = stock() if lot is None else lot
    claim = AsyncMock(return_value={**current_lot, "available_qty": current_lot["available_qty"] - 1}) if claim is None else claim
    quotes = SimpleNamespace(find_one=AsyncMock(return_value=current), update_one=AsyncMock(return_value=SimpleNamespace(modified_count=1)))
    lots = SimpleNamespace(find_one=AsyncMock(return_value=current_lot), find_one_and_update=claim)
    monkeypatch.setattr(routes, "db", SimpleNamespace(quotations=quotes, godown_stock=lots))
    monkeypatch.setattr(routes, "client", SimpleNamespace(start_session=AsyncMock(return_value=session)))
    monkeypatch.setattr(routes, "authorize_staff_resource", AsyncMock())
    monkeypatch.setattr(routes, "log_event", AsyncMock())
    monkeypatch.setattr(routes, "notify", AsyncMock())
    return session, quotes, lots


def test_allocation_rejects_overflow_before_stock_claim(monkeypatch):
    _session, quotes, lots = allocation_setup(monkeypatch, lot=stock(unit_price=1e308))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes.allocate_stock("stock", routes.Allocation(quotation_id="quote", qty=2), actor()))
    assert exc.value.status_code == 422
    lots.find_one_and_update.assert_not_awaited()
    quotes.update_one.assert_not_awaited()


def test_allocation_checks_complete_quotation_sum_before_stock_claim(monkeypatch):
    line = {"id": "old", "product_id": "other", "sku": "OLD", "name": "Existing", "qty": 1, "unit_price": 1e308}
    _session, quotes, lots = allocation_setup(monkeypatch, lot=stock(available_qty=1, qty_received=1, unit_price=1e308),
        quote=quotation(items=[line], subtotal=1e308, grand_total=1e308))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes.allocate_stock("stock", routes.Allocation(quotation_id="quote", qty=1), actor()))
    assert exc.value.status_code == 422
    lots.find_one_and_update.assert_not_awaited()
    quotes.update_one.assert_not_awaited()


def test_allocation_price_race_cannot_reach_quote_write(monkeypatch):
    claim = AsyncMock(return_value=None)
    _session, quotes, _lots = allocation_setup(monkeypatch, claim=claim)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes.allocate_stock("stock", routes.Allocation(quotation_id="quote", qty=1), actor()))
    assert exc.value.status_code == 409
    assert claim.call_args.args[0]["unit_price"] == 100
    assert claim.call_args.args[0]["available_qty"] == 2
    quotes.update_one.assert_not_awaited()


def test_allocation_commits_validated_totals_and_stock_in_same_session(monkeypatch):
    session, quotes, lots = allocation_setup(monkeypatch)
    result = asyncio.run(routes.allocate_stock("stock", routes.Allocation(quotation_id="quote", qty=1), actor()))
    assert result["line"]["net_amount"] == 100
    assert result["remaining_qty"] == 1
    assert quotes.update_one.call_args.args[1]["$set"]["grand_total"] == 100
    assert quotes.update_one.call_args.kwargs["session"] is session
    assert lots.find_one_and_update.call_args.kwargs["session"] is session


def test_historical_stock_reads_are_not_given_new_write_constraints():
    # Historical documents remain inspectable for reconciliation. Only new
    # candidate writes invoke the stricter financial boundary.
    assert routes._stock_view(stock(unit_price=-1))["stock_value"] == -2


@pytest.mark.parametrize("stored_net", [None, 7.0])
def test_allocation_does_not_reprice_original_items_in_compare_filter(monkeypatch, stored_net):
    line = {"id": "old", "product_id": "other", "sku": "OLD", "name": "Existing", "qty": 1, "unit_price": 50}
    if stored_net is not None:
        line["net_amount"] = stored_net
    import copy
    stored_items = copy.deepcopy([line])
    _session, quotes, _lots = allocation_setup(monkeypatch, quote=quotation(items=[line], subtotal=50, grand_total=50))
    async def compare_and_write(query, update, **kwargs):
        assert query["items"] == stored_items
        assert update["$set"]["items"][0]["net_amount"] == 50
        return SimpleNamespace(modified_count=1)
    quotes.update_one.side_effect = compare_and_write
    asyncio.run(routes.allocate_stock("stock", routes.Allocation(quotation_id="quote", qty=1), actor()))
    assert [line] == stored_items
