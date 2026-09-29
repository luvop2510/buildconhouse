"""Collections totals and age filters stay aligned with the active queue."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

import routes.payment_routes as payments
from models import UserPublic


def _user() -> UserPublic:
    return UserPublic(email="accounts@forge.app", full_name="Accounts", role="accounts", floor_ids=["first-floor"], active_floor_id="first-floor")


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, *_args):
        return self

    async def to_list(self, _limit):
        return self.rows


class Quotations:
    def __init__(self, rows):
        self.rows = rows

    def find(self, *_args):
        return Cursor(self.rows)

    async def find_one(self, *_args):
        return self.rows[0] if self.rows else None


class PurchaseOrders:
    def __init__(self, rows=None):
        self.rows = rows or []

    def find(self, *_args):
        return Cursor(self.rows)

    def aggregate(self, pipeline):
        if "quotation_id" in pipeline[0]["$match"]:
            qids = set(pipeline[0]["$match"]["quotation_id"]["$in"])
            totals: dict[str, float] = {}
            for po in self.rows:
                qid = po.get("quotation_id")
                if qid in qids:
                    totals[qid] = totals.get(qid, 0.0) + sum(
                        float(item.get("godown_transferred_qty") or 0) * float(item.get("unit_cost") or 0)
                        for item in po.get("items") or [] if not item.get("cancelled")
                    )
            return Cursor([{"_id": qid, "total": total} for qid, total in totals.items()])
        assert pipeline[0]["$match"]
        return Cursor([{"total": 1200}])


class PaymentRows:
    def aggregate(self, _pipeline):
        return Cursor([])

    def find(self, *_args):
        return Cursor([])


class Customers:
    async def find_one(self, *_args):
        return {"id": "c1", "name": "Client"}


class Db:
    def __init__(self, rows, pos=None):
        self.quotations = Quotations(rows)
        self.purchase_orders = PurchaseOrders(pos)
        self.payments = PaymentRows()
        self.customers = Customers()


def test_fully_paid_order_leaves_active_target(monkeypatch):
    rows = [
        {"id": "settled", "grand_total": 5000, "status": "ordered"},
        {"id": "open", "grand_total": 95000, "status": "ordered"},
    ]
    monkeypatch.setattr(payments, "db", Db(rows))

    async def paid_map(_ids, **_kwargs):
        return {"settled": 5000, "open": 20000}

    monkeypatch.setattr(payments, "_paid_by_quotation", paid_map)
    result = asyncio.run(payments.payment_stats(user=_user()))
    assert result["active_total"] == 95000
    assert result["active_received"] == 20000
    assert result["total_outstanding"] == 75000
    assert result["earned_total"] == 25000
    assert result["spending_total"] == 1200
    assert result["fully_paid"] == 1
    assert result["active_orders"] == 1


def test_godown_credit_reduces_balance_without_counting_as_cash(monkeypatch):
    monkeypatch.setattr(payments, "db", Db([{"id": "open", "grand_total": 5000, "status": "ordered"}]))

    async def paid_map(_ids, **kwargs):
        return {"open": 1000 if kwargs.get("cash_only") else 1500}

    monkeypatch.setattr(payments, "_paid_by_quotation", paid_map)
    result = asyncio.run(payments.payment_stats(user=_user()))
    assert result["earned_total"] == 1000
    assert result["active_received"] == 1000
    assert result["settlement_credits"] == 500
    assert result["active_total"] == 4500
    assert result["total_outstanding"] == 3500


def test_age_presets_and_custom_bounds(monkeypatch):
    now = datetime.now(timezone.utc)
    rows = [
        {"id": "recent", "number": "R", "customer_id": "c1", "customer_name": "Recent", "grand_total": 1000, "created_at": (now - timedelta(days=4)).isoformat()},
        {"id": "late", "number": "L", "customer_id": "c2", "customer_name": "Late", "grand_total": 1000, "created_at": (now - timedelta(days=9)).isoformat()},
        {"id": "old", "number": "O", "customer_id": "c3", "customer_name": "Old", "grand_total": 1000, "created_at": (now - timedelta(days=190)).isoformat()},
    ]
    monkeypatch.setattr(payments, "db", Db(rows))

    async def paid_map(_ids, **_kwargs):
        return {}

    monkeypatch.setattr(payments, "_paid_by_quotation", paid_map)
    week = asyncio.run(payments.list_orders(status_filter=None, overdue_period="1_week", custom_min_days=None, custom_max_days=None, limit=200, user=_user()))
    assert {row["id"] for row in week} == {"late", "old"}
    custom = asyncio.run(payments.list_orders(status_filter=None, overdue_period="custom", custom_min_days=5, custom_max_days=30, limit=200, user=_user()))
    assert [row["id"] for row in custom] == ["late"]
    old = asyncio.run(payments.list_orders(status_filter=None, overdue_period="over_6_months", custom_min_days=None, custom_max_days=None, limit=200, user=_user()))
    assert [row["id"] for row in old] == ["old"]


def test_invalid_custom_age_is_rejected():
    with pytest.raises(HTTPException) as error:
        payments._aging_range("custom", 30, 5)
    assert error.value.status_code == 400


def test_fully_paid_godown_intake_reports_refund_due_without_false_payment(monkeypatch):
    quote = {"id": "q1", "number": "Q-1", "customer_id": "c1", "floor_id": "first-floor",
             "grand_total": 1000, "status": "ordered", "created_at": "2026-09-01"}
    po = {"quotation_id": "q1", "items": [
        {"qty": 1, "unit_cost": 200, "godown_transferred_qty": 1},
        {"qty": 1, "unit_cost": 800},
    ]}
    monkeypatch.setattr(payments, "db", Db([quote], [po]))

    async def paid_map(_ids, **_kwargs):
        # Fully paid before stock moved: no godown credit is posted.
        return {"q1": 1000}

    monkeypatch.setattr(payments, "_paid_by_quotation", paid_map)
    monkeypatch.setattr(payments, "_mrp_for_quotation", lambda _quote: asyncio.sleep(0, result=1000))
    queue = asyncio.run(payments.list_orders(
        status_filter="all", overdue_period=None, custom_min_days=None,
        custom_max_days=None, limit=200, user=_user(),
    ))
    assert queue[0]["grand_total"] == 1000
    assert queue[0]["effective_order_total"] == 800
    assert queue[0]["godown_transferred_value"] == 200
    assert queue[0]["cash_received"] == 1000
    assert queue[0]["refund_due"] == 200
    assert queue[0]["outstanding"] == 0

    history = asyncio.run(payments.fully_paid_orders(
        q=None, business_unit=None, sort="date_desc", skip=0, limit=50, user=_user(),
    ))
    assert history["items"][0]["refund_due"] == 200

    detail = asyncio.run(payments.order_detail("q1", user=_user()))
    assert detail["effective_order_total"] == 800
    assert detail["cash_received"] == 1000
    assert detail["refund_due"] == 200
    assert detail["payments"] == []  # The summary does not fabricate a refund row.

    stats = asyncio.run(payments.payment_stats(user=_user()))
    assert stats["earned_total"] == 800
    assert stats["refund_due_total"] == 200


def test_fully_paid_orders_returns_one_row_per_order(monkeypatch):
    rows = [
        {"id": "settled", "number": "Q-1", "customer_id": "c1", "customer_name": "Client", "floor_id": "first-floor", "grand_total": 5000, "status": "ordered", "created_at": "2026-09-01"},
        {"id": "open", "number": "Q-2", "customer_id": "c2", "customer_name": "Other", "floor_id": "first-floor", "grand_total": 95000, "status": "ordered", "created_at": "2026-09-02"},
    ]
    monkeypatch.setattr(payments, "db", Db(rows))

    async def paid_map(_ids, **_kwargs):
        # Q-1 may have several completed payment records, but is one order.
        return {"settled": 5000, "open": 0}

    monkeypatch.setattr(payments, "_paid_by_quotation", paid_map)
    result = asyncio.run(payments.fully_paid_orders(q=None, business_unit=None, sort="date_desc", skip=0, limit=50, user=_user()))
    assert result["total"] == 1
    assert result["items"][0]["grand_total"] == 5000
    assert result["items"][0]["outstanding"] == 0
