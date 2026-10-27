"""Dispatch charges survive the HTTP ledger boundary without becoming cash."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from models import UserPublic
from routes import payment_routes, tile_orders


def _matches(row, query):
    for key, expected in query.items():
        if key == "$and":
            if not all(_matches(row, part) for part in expected):
                return False
        elif key == "$or":
            if not any(_matches(row, part) for part in expected):
                return False
        elif key == "$nor":
            if any(_matches(row, part) for part in expected):
                return False
        elif isinstance(expected, dict):
            for op, value in expected.items():
                if op == "$in" and row.get(key) not in value:
                    return False
                if op == "$ne" and row.get(key) == value:
                    return False
                if op == "$exists" and (key in row) != value:
                    return False
                assert op in ("$in", "$ne", "$exists"), op
        elif row.get(key) != expected:
            return False
    return True


class _Cursor:
    def __init__(self, rows):
        self.rows = deepcopy(rows)

    def sort(self, *_args):
        return self

    def skip(self, value):
        self.rows = self.rows[value:]
        return self

    def limit(self, value):
        self.rows = self.rows[:value]
        return self

    async def to_list(self, length):
        return self.rows[:length]


class _Collection:
    def __init__(self, rows):
        self.rows = rows

    def find(self, query, _projection=None):
        return _Cursor([row for row in self.rows if _matches(row, query)])

    async def find_one(self, query, _projection=None):
        return next((deepcopy(row) for row in self.rows if _matches(row, query)), None)

    async def count_documents(self, query):
        return sum(_matches(row, query) for row in self.rows)

    async def update_one(self, query, update, **kwargs):
        row = next((row for row in self.rows if _matches(row, query)), None)
        if row is None and kwargs.get("upsert"):
            self.rows.append(deepcopy(update["$setOnInsert"]))
        elif row is not None:
            row.update(update.get("$set", {}))
            for field, value in update.get("$inc", {}).items():
                row[field] = row.get(field, 0) + value
        return SimpleNamespace(matched_count=int(row is not None))

    def aggregate(self, pipeline):
        assert len(pipeline) == 2 and "$group" in pipeline[1]
        totals = {}
        for row in self.rows:
            if _matches(row, pipeline[0]["$match"]):
                totals[row["quotation_id"]] = totals.get(row["quotation_id"], 0) + row["amount"]
        return _Cursor([{"_id": qid, "total": amount} for qid, amount in totals.items()])


def test_dispatch_labor_appears_in_http_detail_and_history_with_actor_without_cash_credit(monkeypatch):
    quote = {
        "id": "quote-1", "number": "FQ-1", "floor_id": "ground-floor",
        "customer_id": "customer-1", "customer_name": "Asha", "status": "ordered",
        "grand_total": 1000, "items": [], "created_at": "2026-10-27T08:00:00Z",
    }
    common = {"quotation_id": "quote-1", "floor_id": "ground-floor", "created_at": "2026-10-27T08:00:00Z"}
    db = SimpleNamespace(
        quotations=_Collection([quote]),
        customers=_Collection([{"id": "customer-1", "floor_id": "ground-floor", "name": "Asha"}]),
        customer_orders=_Collection([]),
        floors=_Collection([{"id": "ground-floor", "name": "Ground Floor"}]),
        payments=_Collection([
            {**common, "id": "receipt-1", "amount": 200, "mode": "cash", "status": "completed"},
            {**common, "id": "placeholder-1", "amount": 1000, "mode": "bank", "status": "pending", "automation_key": "order:quote-1"},
            {**common, "id": "other-floor", "floor_id": "first-floor", "amount": 9999, "mode": "cash", "status": "completed"},
        ]),
    )
    monkeypatch.setattr(tile_orders, "db", db)
    monkeypatch.setattr(payment_routes, "db", db)
    monkeypatch.setattr(payment_routes, "_godown_value_by_quotation", lambda *_args, **_kwargs: asyncio.sleep(0, result={}))
    dispatch = {"id": "dispatch-1", "dispatch_number": "DSP-1", "created_by": "worker-1", "created_by_name": "Dispatch Operator"}
    po = {"quotation_id": quote["id"], "quotation_number": quote["number"], "customer_id": "customer-1", "customer_name": "Asha", "floor_id": "ground-floor"}
    asyncio.run(tile_orders._apply_dispatch_labor_cost(po, dispatch, 500, session=None))
    labor = next(row for row in db.payments.rows if row.get("label") == "labor cost")
    assert labor["recorded_by"] == "worker-1"
    assert labor["status"] == "pending"
    assert labor["automation_key"] == "dispatch:dispatch-1:labor_cost"

    user = UserPublic(email="accounts@forge.app", full_name="Accounts", role="accounts", floor_ids=["ground-floor"], active_floor_id="ground-floor")
    app = FastAPI()
    app.include_router(payment_routes.router)
    app.dependency_overrides[payment_routes.get_current_user] = lambda: user
    with TestClient(app) as client:
        detail_response = client.get("/payments/orders/quote-1")
        history_response = client.get("/payments/history")

    assert detail_response.status_code == history_response.status_code == 200
    detail = detail_response.json()
    assert {row["id"] for row in detail["payments"]} == {"receipt-1", labor["id"]}
    detail_labor = next(row for row in detail["payments"] if row["id"] == labor["id"])
    assert detail_labor["recorded_by_name"] == "Dispatch Operator"
    assert detail["grand_total"] == 1500
    assert detail["paid"] == detail["cash_received"] == 200
    assert detail["outstanding"] == 1300
    history = history_response.json()
    assert history_response.headers["X-Total-Count"] == "3"
    assert history["total"] == 3
    history_labor = next(row for row in history["items"] if row["id"] == labor["id"])
    assert history_labor["label"] == "Labor cost has been added · ₹500.00 by Dispatch Operator"
    assert history_labor["recorded_by"] == "worker-1"
    assert history_labor["outstanding_before"] is None
    assert history_labor["outstanding_after"] is None
    assert next(row for row in history["items"] if row["id"] == "receipt-1")["outstanding_after"] == 1300
    assert all(row["floor_id"] == "ground-floor" for row in history["items"])


def test_history_groups_reused_quotation_and_payment_ids_by_their_exact_floor(monkeypatch):
    receipts = [
        {"id": "receipt-1", "quotation_id": "quote-1", "floor_id": floor,
         "status": "completed", "amount": amount, "created_at": "2026-10-27T08:00:00Z"}
        for floor, amount in [("ground-floor", 100), ("first-floor", 200)]
    ]
    db = SimpleNamespace(
        payments=_Collection(receipts),
        quotations=_Collection([
            {"id": "quote-1", "floor_id": "ground-floor", "number": "GROUND-1", "grand_total": 1000},
            {"id": "quote-1", "floor_id": "first-floor", "number": "SANITARY-1", "grand_total": 9000},
        ]),
        floors=_Collection([]),
    )
    monkeypatch.setattr(payment_routes, "db", db)
    rows = asyncio.run(payment_routes._enrich_history_rows(receipts))
    by_floor = {row["floor_id"]: row for row in rows}
    assert by_floor["ground-floor"]["invoice_number"] == "GROUND-1"
    assert by_floor["ground-floor"]["outstanding_before"] == 1000
    assert by_floor["ground-floor"]["outstanding_after"] == 900
    assert by_floor["first-floor"]["invoice_number"] == "SANITARY-1"
    assert by_floor["first-floor"]["outstanding_before"] == 9000
    assert by_floor["first-floor"]["outstanding_after"] == 8800
