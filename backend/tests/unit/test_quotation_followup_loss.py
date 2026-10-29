"""A linked loss and Place Order must serialize on the same quotation."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import db as database_module
from models import UserPublic
from routes import followup_routes, quotation_routes


def _fixture(monkeypatch, *, floor="ground-floor", quote_status="draft", changed=False):
    followup = {"id": "f", "floor_id": floor, "quotation_id": "q", "customer_id": "c", "status": "open", "updated_at": "v1"}
    quotation = {"id": "q", "floor_id": floor, "customer_id": "c", "status": quote_status}
    writes = []
    session = None

    class Session:
        transactions = 0
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def with_transaction(self, callback):
            self.transactions += 1
            return await callback(self)
    session = Session()

    class Rows:
        def __init__(self, row): self.row = row
        async def find_one(self, query, projection, **kwargs):
            assert query["floor_id"] == floor
            assert kwargs["session"] is session
            return {**self.row, **({"updated_at": "v2"} if changed and self.row is followup else {})}
        async def update_one(self, query, update, **kwargs):
            assert query["floor_id"] == floor
            assert kwargs["session"] is session
            writes.append((query, update))
            self.row.update(update["$set"])
        async def update_many(self, query, update, **kwargs):
            assert query == {"quotation_id": "q", "floor_id": floor, "status": {"$in": ["open", "snoozed"]}}
            assert kwargs["session"] is session
            writes.append((query, update))

    async def start_session(): return session
    monkeypatch.setattr(database_module, "client", SimpleNamespace(start_session=start_session))
    monkeypatch.setattr(followup_routes, "db", SimpleNamespace(quotations=Rows(quotation), followups=Rows(followup)))
    user = UserPublic(email="sales@forge.app", full_name="Sales", role="sales", floor_ids=[floor], active_floor_id=floor)
    patch = {"status": "dismissed", "completed_at": "v3", "completed_outcome": "lost", "resolution_note": "Another supplier",
             "lost_reason": "Another supplier", "updated_at": "v3"}
    return followup, quotation, patch, user, session, writes


@pytest.mark.parametrize("floor", ["ground-floor", "first-floor"])
def test_loss_commits_quotation_and_all_its_reminders_together(monkeypatch, floor):
    row, quote, patch, user, session, writes = _fixture(monkeypatch, floor=floor)
    asyncio.run(followup_routes._record_lost_quotation_followup(row.copy(), {"$set": patch}, user))
    assert session.transactions == 1
    assert len(writes) == 3
    assert quote["customer_outcome"] == "lost"
    assert quote["outcome_reason"] == row["lost_reason"] == "Another supplier"
    assert quote["status"] == "draft"  # preserve document and commercial history
    assert row["completed_outcome"] == "lost"
    with pytest.raises(HTTPException) as error:
        quotation_routes._require_active_sales_quotation(quote)
    assert error.value.status_code == 409


@pytest.mark.parametrize("quote_status,changed", [("ordered", False), ("draft", True)])
def test_placing_an_order_or_a_concurrent_followup_change_prevents_loss(monkeypatch, quote_status, changed):
    row, quote, patch, user, _, writes = _fixture(monkeypatch, quote_status=quote_status, changed=changed)
    with pytest.raises(HTTPException) as error:
        asyncio.run(followup_routes._record_lost_quotation_followup(row, {"$set": patch}, user))
    assert error.value.status_code == 409
    assert writes == []
    assert "customer_outcome" not in quote


@pytest.mark.parametrize("change,code", [("customer", 404), ("quotation", 409), ("won", 409), ("closed", 409), ("access", 403)])
def test_loss_rejects_invalid_links_closed_rows_and_unauthorized_floors(monkeypatch, change, code):
    row, quote, patch, user, _, writes = _fixture(monkeypatch)
    source = row.copy()
    if change == "customer": quote["customer_id"] = "another-customer"
    if change == "quotation": row["quotation_id"] = "another-quotation"
    if change == "won": quote["customer_outcome"] = "won"
    if change == "closed": row["status"] = "done"
    if change == "access": user = user.model_copy(update={"floor_ids": ["first-floor"], "active_floor_id": "first-floor"})
    with pytest.raises(HTTPException) as error:
        asyncio.run(followup_routes._record_lost_quotation_followup(source, {"$set": patch}, user))
    assert error.value.status_code == code
    assert writes == []


@pytest.mark.parametrize("status", ["lost", "rejected", "cancelled"])
def test_legacy_closed_quotations_cannot_place_an_order(status):
    with pytest.raises(HTTPException) as error:
        quotation_routes._require_active_sales_quotation({"status": status})
    assert error.value.status_code == 409
