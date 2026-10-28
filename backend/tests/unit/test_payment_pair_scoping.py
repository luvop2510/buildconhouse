"""Authorized order IDs never admit another floor's ledger or stock movements."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import Response

from models import UserPublic
from routes import payment_routes as routes


def matches(row, query):
    for field, condition in query.items():
        if field in {"$and", "$or"}:
            checks = [matches(row, part) for part in condition]
            if not (all(checks) if field == "$and" else any(checks)):
                return False
            continue
        if field == "items.godown_transferred_qty":
            if not any(item.get("godown_transferred_qty", 0) > condition["$gt"] for item in row.get("items", [])):
                return False
            continue
        value = row.get(field)
        if isinstance(condition, dict):
            for op, expected in condition.items():
                if op == "$in" and value not in expected or op == "$nin" and value in expected or op == "$ne" and value == expected:
                    return False
        elif value != condition:
            return False
    return True


class Cursor:
    def __init__(self, rows): self.rows = rows
    def sort(self, *_args): return self
    def skip(self, number): self.rows = self.rows[number:]; return self
    def limit(self, number): self.rows = self.rows[:number]; return self
    async def to_list(self, limit): return self.rows[:limit]


class Collection:
    def __init__(self, rows=(), stock=False):
        self.rows, self.stock, self.pipelines = list(rows), stock, []

    def find(self, query, projection):
        rows = [row for row in self.rows if matches(row, query)]
        if any(value for field, value in projection.items() if field != "_id"):
            rows = [{key: value for key, value in row.items() if projection.get(key)} for row in rows]
        return Cursor(rows)

    async def count_documents(self, query): return sum(matches(row, query) for row in self.rows)

    def aggregate(self, pipeline):
        self.pipelines.append(pipeline)
        group = pipeline[-1]["$group"]["_id"]
        if group is None or isinstance(group, dict) and "$substr" in group:
            return Cursor([])  # Unrelated supplier-spend/monthly KPIs.
        totals = {}
        for row in self.rows:
            if not matches(row, pipeline[0]["$match"]):
                continue
            key = (row["quotation_id"], row.get("floor_id")) if isinstance(group, dict) else row["quotation_id"]
            amount = sum(item.get("godown_transferred_qty", 0) * item.get("unit_cost", 0)
                         for item in row.get("items", []) if not item.get("cancelled")) if self.stock else row["amount"]
            totals[key] = totals.get(key, 0) + amount
        return Cursor([{"_id": {"quotation_id": key[0], "floor_id": key[1]} if isinstance(key, tuple) else key,
                        "total": total} for key, total in totals.items()])


@pytest.fixture
def database(monkeypatch):
    common = {"id": "reused-id", "customer_id": "customer", "status": "ordered", "grand_total": 100,
              "created_at": "2026-10-27T00:00:00Z"}
    database = SimpleNamespace(
        quotations=Collection([{**common, "floor_id": floor, "number": floor} for floor in ("ground-floor", "first-floor")]),
        payments=Collection([{"id": "other-receipt", "floor_id": "first-floor", "quotation_id": "reused-id",
                              "amount": 100, "status": "completed", "created_at": common["created_at"]}]),
        purchase_orders=Collection([{"floor_id": "first-floor", "quotation_id": "reused-id", "items": [
            {"godown_transferred_qty": 1, "unit_cost": 50}]}], stock=True),
    )
    monkeypatch.setattr(routes, "db", database)
    return database


def user(role="accounts"):
    return UserPublic(email="accounts@example.com", full_name="Accounts", role=role,
                      floor_ids=["ground-floor"], active_floor_id="ground-floor")


def test_ground_collections_and_stats_ignore_other_floor_payment_and_stock(database):
    async def run():
        queue = await routes.list_orders(q=None, status_filter="all", overdue_period=None,
                                        custom_min_days=None, custom_max_days=None, limit=200, user=user())
        assert len(queue) == 1
        assert queue[0]["paid"] == queue[0]["godown_transferred_value"] == 0
        assert queue[0]["outstanding"] == queue[0]["effective_order_total"] == 100
        stats = await routes.payment_stats(user=user())
        assert stats["total_outstanding"] == 100
        assert stats["earned_total"] == stats["fully_paid"] == 0
    asyncio.run(run())


def test_coexisting_floors_keep_separate_balances_and_only_settled_history(database, monkeypatch):
    async def enrich(rows): return rows
    monkeypatch.setattr(routes, "_enrich_history_rows", enrich)
    # Both floors contain receipts, but only First Floor is settled.
    database.payments.rows.append({"id": "ground-receipt", "floor_id": "ground-floor", "quotation_id": "reused-id",
                                   "amount": 20, "status": "completed", "created_at": "2026-10-27T00:00:00Z"})
    async def run():
        paid, cash, stock = await routes._order_balances(database.quotations.rows)
        assert paid == cash == {("reused-id", "first-floor"): 100, ("reused-id", "ground-floor"): 20}
        assert stock == {("reused-id", "first-floor"): 50}
        assert len(database.payments.pipelines) == 2 and len(database.purchase_orders.pipelines) == 1
        settled = await routes.fully_paid_orders(q=None, business_unit=None, sort="date_desc", skip=0, limit=50, user=user("owner"))
        assert [(row["floor_id"], row["received"], row["refund_due"]) for row in settled["items"]] == [("first-floor", 100, 50)]
        history = await routes.completed_payment_list(Response(), q=None, date_from=None, date_to=None,
            business_unit=None, mode=None, sort="date_desc", skip=0, limit=50, user=user("owner"))
        assert history["total"] == 1
        assert [row["id"] for row in history["items"]] == ["other-receipt"]
    asyncio.run(run())


def test_furniture_collections_and_history_exclude_other_floors(database, monkeypatch):
    from fastapi import HTTPException

    furniture = UserPublic(email="owner@example.com", full_name="Owner", role="owner",
                           active_floor_id="third-floor")
    database.quotations.rows.append({"id": "furniture-order", "floor_id": "third-floor",
        "customer_id": "customer", "status": "ordered", "grand_total": 100,
        "created_at": "2026-10-27T00:00:00Z"})
    database.payments.rows.append({"id": "furniture-receipt", "floor_id": "third-floor",
        "quotation_id": "furniture-order", "amount": 100, "status": "completed",
        "created_at": "2026-10-27T00:00:00Z"})
    async def enrich(rows): return rows
    monkeypatch.setattr(routes, "_enrich_history_rows", enrich)

    async def run():
        queue = await routes.list_orders(q=None, status_filter="all", overdue_period=None,
            custom_min_days=None, custom_max_days=None, limit=200, user=furniture)
        assert [row["id"] for row in queue] == ["furniture-order"]
        stats = await routes.payment_stats(user=furniture)
        assert stats["fully_paid"] == 1 and stats["total_outstanding"] == 0
        history = await routes.payment_history(Response(), q=None, date_from=None, date_to=None,
            customer_id=None, business_unit=None, mode=None, status=None, sort="date_desc",
            skip=0, limit=50, user=furniture)
        assert [row["id"] for row in history["items"]] == ["furniture-receipt"]
        paid = await routes.fully_paid_orders(q=None, business_unit=None, sort="date_desc",
            skip=0, limit=50, user=furniture)
        assert [row["id"] for row in paid["items"]] == ["furniture-order"]
        with pytest.raises(HTTPException):
            routes._resolve_history_floor_ids(furniture, "ground-floor")
    asyncio.run(run())
