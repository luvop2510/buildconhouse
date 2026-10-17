"""Order confirmation must close existing sales follow-ups for that quote."""
from __future__ import annotations

import asyncio
import pytest
from fastapi import HTTPException

from models import QuotationUpdate, UserPublic
import routes.quotation_routes as quotation_routes


class _Followups:
    def __init__(self):
        self.rows = [
            {"id": "manual-open", "quotation_id": "q-1", "rule_type": "manual", "status": "open"},
            {"id": "automated-snoozed", "quotation_id": "q-1", "rule_type": "quotation_followup", "status": "snoozed"},
            # This is the post-confirmation operations handoff, not a sales
            # reminder.  Confirmation must never immediately close it.
            {"id": "ops", "quotation_id": "q-1", "rule_type": "order_confirmed_ops", "status": "open"},
            {"id": "already-done", "quotation_id": "q-1", "rule_type": "manual", "status": "done"},
            {"id": "other-order", "quotation_id": "q-2", "rule_type": "manual", "status": "open"},
        ]

    async def update_many(self, query, update, session=None):
        changed = 0
        for row in self.rows:
            if (
                row.get("quotation_id") == query["quotation_id"]
                and row.get("status") in query["status"]["$in"]
                and row.get("rule_type") != query["rule_type"]["$ne"]
            ):
                row.update(update["$set"])
                changed += 1
        return type("Result", (), {"modified_count": changed})()


def test_order_confirmation_completes_existing_sales_followups(monkeypatch):
    followups = _Followups()
    monkeypatch.setattr(quotation_routes, "db", type("Db", (), {"followups": followups})())

    changed = asyncio.run(
        quotation_routes._complete_pre_confirmation_followups("q-1", "FQ-2026-0042", creator_id="creator", creator_name="Original creator")
    )

    assert changed == 2
    for row_id in ("manual-open", "automated-snoozed"):
        row = next(row for row in followups.rows if row["id"] == row_id)
        assert row["status"] == "done"
        assert row["auto_resolved"] is True
        assert row["completed_outcome"] == "won"
        assert row["assigned_to"] == "creator"
        assert row["assigned_to_name"] == "Original creator"
        assert row["snoozed_until"] is None
        assert "FQ-2026-0042" in row["resolution_note"]

    assert next(row for row in followups.rows if row["id"] == "ops")["status"] == "open"
    assert next(row for row in followups.rows if row["id"] == "already-done")["status"] == "done"
    assert next(row for row in followups.rows if row["id"] == "other-order")["status"] == "open"


def test_direct_quotation_status_requires_real_place_order_confirmation(monkeypatch):
    """A status edit must not close leads without creating a real order."""
    doc = {
        "id": "q-1", "floor_id": "first-floor", "number": "FQ-2026-0042",
        "customer_id": "c-1", "customer_name": "Customer",
        "created_by": "u-1", "created_by_name": "Sales Rep",
        "created_at": "2026-08-01T00:00:00+00:00", "updated_at": "2026-08-01T00:00:00+00:00",
        "status": "draft", "items": [],
    }

    class _Quotations:
        async def find_one(self, query, *args, **kwargs):
            return dict(doc) if query.get("id") == doc["id"] else None

        async def update_one(self, _query, update, **kwargs):
            doc.update(update["$set"])

    monkeypatch.setattr(quotation_routes, "db", type("Db", (), {"quotations": _Quotations()})())
    completed = []

    async def _complete(quotation_id, quotation_number, *, session=None):
        completed.append((quotation_id, quotation_number, session))
        return 1

    async def _reconcile():
        return None

    monkeypatch.setattr(quotation_routes, "_complete_pre_confirmation_followups", _complete)
    monkeypatch.setattr(quotation_routes, "reconcile_followups", _reconcile)
    user = UserPublic(
        email="sales@example.com", full_name="Sales Rep", role="sales",
        floor_ids=["first-floor"], active_floor_id="first-floor",
    )

    with pytest.raises(HTTPException) as error:
        asyncio.run(quotation_routes.update_quotation("q-1", QuotationUpdate(status="ordered", silent=True), user=user))
    assert error.value.status_code == 409
    assert doc["status"] == "draft"
    assert completed == []


def test_repeating_ordered_status_does_not_close_new_followups(monkeypatch):
    doc = {
        "id": "q-1", "floor_id": "first-floor", "number": "FQ-2026-0042",
        "customer_id": "c-1", "customer_name": "Customer",
        "created_by": "u-1", "created_by_name": "Sales Rep",
        "created_at": "2026-08-01T00:00:00+00:00", "updated_at": "2026-08-01T00:00:00+00:00",
        "status": "ordered", "ordered_at": "2026-08-02T00:00:00+00:00", "items": [],
    }

    class _Quotations:
        async def find_one(self, query, *args, **kwargs):
            return dict(doc) if query.get("id") == doc["id"] else None

        async def update_one(self, _query, update, **kwargs):
            doc.update(update["$set"])

    monkeypatch.setattr(quotation_routes, "db", type("Db", (), {"quotations": _Quotations()})())
    completed = []

    async def _complete(*args, **kwargs):
        completed.append(args)
        return 0

    async def _reconcile():
        return None

    monkeypatch.setattr(quotation_routes, "_complete_pre_confirmation_followups", _complete)
    monkeypatch.setattr(quotation_routes, "reconcile_followups", _reconcile)
    user = UserPublic(email="sales@example.com", full_name="Sales Rep", role="sales", floor_ids=["first-floor"])

    asyncio.run(quotation_routes.update_quotation("q-1", QuotationUpdate(status="ordered", silent=True), user=user))

    assert completed == []
