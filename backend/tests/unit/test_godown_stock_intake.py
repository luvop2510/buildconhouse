"""Regression coverage for sanitary go-down-stock intake accounting."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

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
            item["godown_transferred_qty"] = float(item.get("godown_transferred_qty") or 0) + update["$inc"]["items.$.godown_transferred_qty"]
        if "$push" in update:
            item.setdefault("godown_transfer_history", []).append(update["$push"]["items.$.godown_transfer_history"])
        if "$pull" in update:
            stock_id = update["$pull"]["items.$.godown_transfer_history"]["stock_id"]
            item["godown_transfer_history"] = [entry for entry in item.get("godown_transfer_history", []) if entry["stock_id"] != stock_id]
        return _Result()


class _Quotations:
    def __init__(self, quote):
        self.quote = quote

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
    assert fake_db.purchase_orders.queries[0]["items"]["$elemMatch"]["$or"][1] == {"godown_transferred_qty": {"$exists": False}}
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
