"""Regression coverage for sanitary go-down-stock intake accounting."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import routes.godown_stock_routes as godown


class _Result:
    def __init__(self, modified_count: int = 1):
        self.modified_count = modified_count


class _Rows:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, _limit):
        return self.rows


class _PurchaseOrders:
    def __init__(self, po):
        self.po = po
        self.queries = []

    async def update_one(self, query, update, **_kwargs):
        self.queries.append(query)
        item = self.po["items"][0]
        if "$inc" in update:
            for key, amount in update["$inc"].items():
                field = key.removeprefix("items.$.")
                item[field] = float(item.get(field) or 0) + amount
        if "$push" in update:
            item.setdefault("godown_transfer_history", []).append(update["$push"]["items.$.godown_transfer_history"])
        if "$pull" in update:
            stock_id = update["$pull"]["items.$.godown_transfer_history"]["stock_id"]
            item["godown_transfer_history"] = [entry for entry in item.get("godown_transfer_history", []) if entry["stock_id"] != stock_id]
        return _Result()


class _Quotations:
    def __init__(self, quote):
        self.quote = quote
        self.locked = False
        self.queries = []

    async def update_one(self, query, update, **_kwargs):
        self.queries.append((query, update))
        self.locked = True
        self.quote["payment_revision"] = self.quote.get("payment_revision", 0) + 1
        return SimpleNamespace(matched_count=1)

    async def find_one(self, *_args, **_kwargs):
        return self.quote


class _Payments:
    def __init__(self, settled: float):
        self.settled = settled
        self.inserted: list[dict] = []
        self.deleted: list[dict] = []

    def aggregate(self, *_args, **_kwargs):
        return _Rows([{"total": self.settled}] if self.settled else [])

    async def insert_one(self, doc, **_kwargs):
        self.inserted.append(doc)

    async def delete_one(self, query, **_kwargs):
        self.deleted.append(query)


class _GodownStock:
    def __init__(self, fail_insert: bool = False):
        self.fail_insert = fail_insert
        self.inserted: list[dict] = []
        self.deleted: list[dict] = []

    async def insert_one(self, doc, **_kwargs):
        if self.fail_insert:
            raise RuntimeError("lot insert failed")
        self.inserted.append(doc)

    async def delete_one(self, query, **_kwargs):
        self.deleted.append(query)


def _po() -> dict:
    return {
        "id": "po-1", "floor_id": "first-floor", "quotation_id": "q-1",
        "customer_id": "c-1", "customer_name": "Asha",
        "items": [{"id": "item-1", "product_id": "product-1", "name": "Mixer", "qty": 4, "qty_received": 4, "unit_cost": 250}],
    }


def _quote() -> dict:
    return {
        "id": "q-1", "floor_id": "first-floor", "number": "FQ-1", "status": "ordered",
        "customer_id": "c-1", "customer_name": "Asha", "grand_total": 1000,
    }


def _lot() -> dict:
    return {"id": "lot-1", "floor_id": "first-floor", "source_purchase_order_id": "po-1"}


def _user():
    return SimpleNamespace(id="warehouse-1", full_name="Warehouse Rep")


def test_customer_discount_does_not_carry_into_godown_mrp():
    discounted_item = {"unit_cost": 700}
    assert godown._stock_mrp({"mrp": 1000}, {"mrp": 900}, discounted_item) == 1000
    assert godown._stock_mrp({}, {"mrp": 900}, discounted_item) == 900


async def _persist(fake_db, *, qty: float = 2):
    po = fake_db.purchase_orders.po
    return await godown._persist_intake(
        po=po, item=po["items"][0], qty=qty, reason="Customer declined", user=_user(),
        lot=_lot(), at="2026-09-20T10:00:00+00:00",
    )


def test_intake_credits_the_source_order_and_accepts_legacy_line_without_transfer_counter(monkeypatch):
    po = _po()
    fake_db = SimpleNamespace(
        purchase_orders=_PurchaseOrders(po), quotations=_Quotations(_quote()),
        payments=_Payments(settled=100), godown_stock=_GodownStock(),
    )
    monkeypatch.setattr(godown, "db", fake_db)

    lot, payment = asyncio.run(_persist(fake_db))

    assert po["items"][0]["godown_transferred_qty"] == 2
    assert fake_db.purchase_orders.queries[0]["items"]["$elemMatch"]["$and"][0]["$or"][1] == {"godown_transferred_qty": {"$exists": False}}
    assert lot["transferred_value"] == 500
    assert lot["payment_credit_amount"] == 500
    assert payment and payment["amount"] == 500
    assert payment["entry_type"] == "godown_stock_credit"
    assert payment["godown_stock_id"] == "lot-1"
    assert "moved to godown stock" in payment["note"]
    assert fake_db.payments.inserted == [payment]


def test_intake_credit_never_over_settles_an_already_partially_paid_order(monkeypatch):
    po = _po()
    fake_db = SimpleNamespace(
        purchase_orders=_PurchaseOrders(po), quotations=_Quotations(_quote()),
        payments=_Payments(settled=800), godown_stock=_GodownStock(),
    )
    monkeypatch.setattr(godown, "db", fake_db)

    lot, payment = asyncio.run(_persist(fake_db))

    assert lot["transferred_value"] == 500
    assert lot["payment_credit_amount"] == 200
    assert payment and payment["amount"] == 200


def test_intake_uses_current_quote_price_after_order_reprice(monkeypatch):
    po = _po()
    po["items"][0]["quotation_line_id"] = "line-1"
    quote = {**_quote(), "grand_total": 1500, "items": [
        {"id": "line-1", "product_id": "product-1", "name": "Mixer", "sku": "M-1",
         "qty": 4, "unit_price": 375},
    ]}
    fake_db = SimpleNamespace(
        purchase_orders=_PurchaseOrders(po), quotations=_Quotations(quote),
        payments=_Payments(settled=0), godown_stock=_GodownStock(),
    )
    monkeypatch.setattr(godown, "db", fake_db)

    lot, payment = asyncio.run(_persist(fake_db, qty=2))

    assert lot["transferred_value"] == 750
    assert payment and payment["amount"] == 750
    assert po["items"][0]["godown_valued_qty"] == 2
    assert po["items"][0]["godown_transferred_value"] == 750


def test_intake_compensates_the_source_line_when_lot_creation_fails(monkeypatch):
    po = _po()
    fake_db = SimpleNamespace(
        purchase_orders=_PurchaseOrders(po), quotations=_Quotations(_quote()),
        payments=_Payments(settled=0), godown_stock=_GodownStock(fail_insert=True),
    )
    monkeypatch.setattr(godown, "db", fake_db)

    with pytest.raises(RuntimeError, match="lot insert failed"):
        asyncio.run(_persist(fake_db))

    item = po["items"][0]
    assert item["godown_transferred_qty"] == 0
    assert item["godown_transfer_history"] == []


def test_explicit_zero_received_quantity_cannot_be_moved_to_stock(monkeypatch):
    po = _po()
    po["items"][0]["qty_received"] = 0
    fake_db = SimpleNamespace(purchase_orders=_PurchaseOrders(po))
    monkeypatch.setattr(godown, "db", fake_db)

    async def scoped_po(*_args, **_kwargs):
        return po

    monkeypatch.setattr(godown, "get_floor_scoped_or_404", scoped_po)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(godown.intake_stock(
            godown.Intake(purchase_order_id="po-1", purchase_item_id="item-1", qty=1, reason="Declined"),
            _user(),
        ))
    assert exc.value.status_code == 409
    assert "Only 0 units" in exc.value.detail
    assert fake_db.purchase_orders.queries == []


def test_replacement_reserved_for_customer_return_cannot_move_to_godown(monkeypatch):
    from unittest.mock import AsyncMock
    import pytest
    from fastapi import HTTPException
    po = _po()
    po['items'][0]['loan_replenishment_promised_qty'] = 4
    monkeypatch.setattr(godown, 'get_floor_scoped_or_404', AsyncMock(return_value=po))
    with pytest.raises(HTTPException) as error:
        asyncio.run(godown.intake_stock(godown.Intake(purchase_order_id='po-1', purchase_item_id='item-1', qty=1, reason='Return stock'), _user()))
    assert error.value.status_code == 409
    assert 'Only 0 units' in error.value.detail


def test_intake_locks_shared_order_before_reading_settlement_total(monkeypatch):
    po = _po()
    quotes = _Quotations(_quote())

    class CheckedPayments(_Payments):
        def aggregate(self, *args, **kwargs):
            assert quotes.locked, "Every credit must reserve the shared order before reading its balance"
            return super().aggregate(*args, **kwargs)

    fake_db = SimpleNamespace(purchase_orders=_PurchaseOrders(po), quotations=quotes,
                              payments=CheckedPayments(settled=800), godown_stock=_GodownStock())
    monkeypatch.setattr(godown, "db", fake_db)
    lot, payment = asyncio.run(_persist(fake_db))
    assert quotes.queries == [({"id": "q-1", "floor_id": "first-floor"}, {"$inc": {"payment_revision": 1}})]
    assert payment["amount"] == lot["payment_credit_amount"] == 200


def test_intake_fails_closed_when_shared_order_lock_cannot_be_obtained(monkeypatch):
    from unittest.mock import AsyncMock
    from pymongo.errors import OperationFailure
    quote = _Quotations(_quote())
    quote.update_one = AsyncMock(side_effect=OperationFailure("dummy write conflict", code=112))
    po = _po()
    fake_db = SimpleNamespace(purchase_orders=_PurchaseOrders(po), quotations=quote,
                              payments=_Payments(settled=0), godown_stock=_GodownStock())
    monkeypatch.setattr(godown, "db", fake_db)
    with pytest.raises(OperationFailure):
        asyncio.run(_persist(fake_db))
    assert fake_db.purchase_orders.queries == []
    assert fake_db.payments.inserted == []
    assert fake_db.godown_stock.inserted == []


def test_live_intake_uses_retryable_transaction_and_never_falls_back_in_production(monkeypatch):
    from unittest.mock import AsyncMock
    from models import UserPublic
    po = _po()
    po["items"][0]["quotation_line_id"] = None
    fake_db = SimpleNamespace(purchase_orders=SimpleNamespace(),
                              products=SimpleNamespace(find_one=AsyncMock(return_value={"mrp": 100})),
                              quotations=SimpleNamespace(find_one=AsyncMock(return_value={})))
    monkeypatch.setattr(godown, "db", fake_db)
    monkeypatch.setattr(godown, "get_floor_scoped_or_404", AsyncMock(return_value=po))
    persist = AsyncMock()
    monkeypatch.setattr(godown, "_persist_intake", persist)

    class Session:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *_):
            return False
        async def with_transaction(self, callback):
            raise RuntimeError("Transaction numbers are only allowed on a replica set")

    monkeypatch.setattr(godown, "client", SimpleNamespace(start_session=AsyncMock(return_value=Session())))
    user = UserPublic(id="dummy-warehouse", email="dummy@example.test", full_name="Dummy",
                      role="warehouse", floor_ids=["first-floor"], active_floor_id="first-floor")
    with pytest.raises(HTTPException) as error:
        asyncio.run(godown.intake_stock(godown.Intake(purchase_order_id="po-1", purchase_item_id="item-1",
                                                     qty=1, reason="Dummy return"), user))
    assert error.value.status_code == 503
    persist.assert_not_awaited()


def test_intake_transaction_retry_starts_with_fresh_lot_fields(monkeypatch):
    from unittest.mock import AsyncMock
    from models import UserPublic
    po = _po()
    fake_db = SimpleNamespace(purchase_orders=SimpleNamespace(),
                              products=SimpleNamespace(find_one=AsyncMock(return_value={"mrp": 100})),
                              quotations=SimpleNamespace(find_one=AsyncMock(return_value={})))
    monkeypatch.setattr(godown, "db", fake_db)
    monkeypatch.setattr(godown, "get_floor_scoped_or_404", AsyncMock(return_value=po))
    monkeypatch.setattr(godown, "log_event", AsyncMock())
    monkeypatch.setattr(godown, "notify", AsyncMock())
    monkeypatch.setattr(godown.cache, "bump", AsyncMock())
    attempts = []

    async def persist(**kwargs):
        lot = kwargs["lot"]
        assert "payment_id" not in lot
        attempts.append(lot)
        lot["payment_id"] = "dummy-aborted-payment"
        return lot, None

    class Session:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *_):
            return False
        async def with_transaction(self, callback):
            # Model the driver rerunning a callback after an aborted attempt.
            await callback(self)
            return await callback(self)

    monkeypatch.setattr(godown, "_persist_intake", persist)
    monkeypatch.setattr(godown, "client", SimpleNamespace(start_session=AsyncMock(return_value=Session())))
    user = UserPublic(id="dummy-warehouse", email="dummy@example.test", full_name="Dummy",
                      role="warehouse", floor_ids=["first-floor"], active_floor_id="first-floor")
    result = asyncio.run(godown.intake_stock(godown.Intake(purchase_order_id="po-1", purchase_item_id="item-1",
                                                         qty=1, reason="Dummy return"), user))
    assert len(attempts) == 2
    assert attempts[0] is not attempts[1]
    assert result["id"] == attempts[1]["id"]
