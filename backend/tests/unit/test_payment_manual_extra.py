"""Ground Floor collection extras preserve the original quotation total."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

import routes.payment_routes as payment_routes
from models import PaymentOrderExtraUpdate, UserPublic


def _user() -> UserPublic:
    return UserPublic(email="accounts@forge.app", full_name="Accounts", role="accounts", floor_ids=["ground-floor"], active_floor_id="ground-floor")


class _Quotations:
    def __init__(self, doc: dict):
        self.doc = doc
        self.update = None

    async def find_one(self, _query, _projection=None):
        return self.doc

    async def update_one(self, query, update, session=None):
        self.update = (query, update)


class _Payments:
    def __init__(self):
        self.inserted: list[dict] = []

    async def insert_one(self, doc, session=None):
        self.inserted.append(doc)


class _Session:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def start_transaction(self):
        return self


class _Client:
    async def start_session(self):
        return _Session()


class _Db:
    def __init__(self, doc: dict):
        self.quotations = _Quotations(doc)
        self.payments = _Payments()


class _Cache:
    async def bump(self, _key):
        return None


class _Cursor:
    def __init__(self, rows: list[dict]):
        self.rows = rows

    async def to_list(self, _length):
        return [dict(row) for row in self.rows]


class _HistoryCollection:
    def __init__(self, rows: list[dict]):
        self.rows = rows

    def find(self, *_args, **_kwargs):
        return _Cursor(self.rows)


class _HistoryDb:
    def __init__(self, quotation: dict, ledger_rows: list[dict]):
        self.quotations = _HistoryCollection([quotation])
        self.payments = _HistoryCollection(ledger_rows)
        self.floors = _HistoryCollection([{"id": "ground-floor", "name": "Ground Floor"}])


def test_additional_cost_is_appended_and_added_to_collection_total(monkeypatch):
    user = _user()
    fake_db = _Db({
        "id": "q-1", "number": "FQ-1", "floor_id": "ground-floor",
        "customer_id": "customer-1", "customer_name": "Customer One",
        "grand_total": 1000, "status": "ordered",
    })
    monkeypatch.setattr(payment_routes, "db", fake_db)
    monkeypatch.setattr(payment_routes, "cache", _Cache())
    monkeypatch.setattr(payment_routes, "client", _Client())

    result = asyncio.run(payment_routes.update_ground_floor_manual_extra(
        "q-1", PaymentOrderExtraUpdate(amount=250.125, name="  Labour cost "), user=user,
    ))

    assert result["quotation_total"] == 1000.0
    assert result["manual_extra_amount"] == 250.12
    assert result["manual_extra_name"] == "Labour cost"
    assert result["grand_total"] == 1250.12
    assert result["additional_cost"]["name"] == "Labour cost"
    assert result["additional_cost"]["amount"] == 250.12
    assert result["additional_cost"]["note"] is None
    assert result["additional_cost"]["recorded_by"] == user.id
    assert result["additional_cost"]["recorded_by_name"] == "Accounts"
    assert fake_db.quotations.update[1]["$push"]["payment_extra_history"] == result["additional_cost"]
    assert fake_db.quotations.update[1]["$inc"]["payment_extra_amount"] == 250.12
    assert fake_db.quotations.update[1]["$set"]["payment_extra_name"] == "Labour cost"
    assert fake_db.payments.inserted == [result["ledger_entry"]]
    ledger_entry = fake_db.payments.inserted[0]
    assert ledger_entry["entry_type"] == "additional_cost"
    assert ledger_entry["status"] == "adjustment"
    assert ledger_entry["mode"] == "adjustment"
    assert ledger_entry["cost_name"] == "Labour cost"
    assert ledger_entry["amount"] == 250.12
    assert ledger_entry["recorded_by"] == user.id
    assert ledger_entry["recorded_by_name"] == "Accounts"
    assert ledger_entry["created_at"] == result["additional_cost"]["created_at"]


def test_additional_cost_requires_a_name_at_schema_validation():
    with pytest.raises(ValueError, match="Field required"):
        PaymentOrderExtraUpdate(amount=100)


def test_ledger_enrichment_shows_cost_name_actor_timestamp_and_debit_balance(monkeypatch):
    cost = {
        "id": "cost-1", "quotation_id": "q-1", "floor_id": "ground-floor",
        "amount": 250, "mode": "adjustment", "status": "adjustment",
        "entry_type": "additional_cost", "additional_cost_id": "cost-1", "cost_name": "Labour cost",
        "recorded_by_name": "Accounts", "created_at": "2026-09-20T11:00:00+00:00",
    }
    payment = {
        "id": "payment-1", "quotation_id": "q-1", "floor_id": "ground-floor",
        "amount": 100, "mode": "cash", "status": "completed", "entry_type": "payment",
        "created_at": "2026-09-20T10:00:00+00:00",
    }
    quotation = {
        "id": "q-1", "number": "FQ-1", "grand_total": 1000,
        "payment_extra_history": [{"id": "cost-1", "amount": 250}],
    }
    monkeypatch.setattr(payment_routes, "db", _HistoryDb(quotation, [payment, cost]))

    rows = asyncio.run(payment_routes._enrich_history_rows([payment, cost]))
    by_id = {row["id"]: row for row in rows}

    assert by_id["payment-1"]["outstanding_before"] == 1000
    assert by_id["payment-1"]["outstanding_after"] == 900
    assert by_id["cost-1"]["label"] == "Additional cost · Labour cost"
    assert by_id["cost-1"]["recorded_by_name"] == "Accounts"
    assert by_id["cost-1"]["paid_at"] == "2026-09-20T11:00:00+00:00"
    assert by_id["cost-1"]["outstanding_before"] == 900
    assert by_id["cost-1"]["outstanding_after"] == 1150
