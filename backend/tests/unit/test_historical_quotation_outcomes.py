"""Historical Won/Lost quotations never restart active sales automation."""
import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from models import Quotation, QuotationUpdate, UserPublic
from routes import quotation_routes
from services import automation_rules, domain_outbox, followup_engine


def _quote(outcome, *, doc_type="standard"):
    old = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
    return {
        "id": "history", "number": "FQ-HISTORY", "floor_id": "first-floor",
        "customer_id": "customer", "customer_name": "Customer", "status": "draft",
        "customer_outcome": outcome, "outcome_reason": "Historical outcome provided by owner",
        "created_by": "owner", "created_by_name": "Owner", "doc_type": doc_type,
        "created_at": old, "updated_at": old,
        "items": [{"id": "line", "product_id": "p", "sku": "P", "name": "Product", "qty": 1, "unit_price": 100}],
    }


class _Rows:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, _limit):
        return self.rows

    def __aiter__(self):
        async def iterate():
            for row in self.rows:
                yield row
        return iterate()


@pytest.mark.parametrize("outcome", ["won", "lost"])
def test_historical_outcomes_create_neither_quotation_nor_inactivity_reminders(monkeypatch, outcome):
    quotation = _quote(outcome)
    monkeypatch.setattr(followup_engine, "db", SimpleNamespace(
        customers=SimpleNamespace(find=lambda *a: _Rows([{"id": "customer", "name": "Customer"}])),
        quotations=SimpleNamespace(find=lambda *a: _Rows([quotation])),
    ))
    captured = []

    async def empty(*args):
        return {}

    async def persist(desired, *args):
        captured.append(desired)
        return desired

    monkeypatch.setattr(followup_engine, "last_contact_map", empty)
    monkeypatch.setattr(followup_engine, "_walkin_producer", empty)
    monkeypatch.setattr(followup_engine, "_tiles_pipeline_producer", empty)
    monkeypatch.setattr(followup_engine, "_persist_desired_followups", persist)
    asyncio.run(followup_engine._reconcile_followups_locked())
    assert captured == [{}]
    # An independent new quotation for the same customer still needs follow-up.
    quotation["customer_outcome"] = None
    asyncio.run(followup_engine._reconcile_followups_locked())
    assert "quotation_followup:history" in captured[1]
    assert "customer_inactive:customer" in captured[1]


@pytest.mark.parametrize("outcome", ["won", "lost"])
@pytest.mark.parametrize("doc_type", ["tiles_selection", "tiles_quotation"])
def test_historical_tile_outcomes_do_not_restart_waiting_reminders(monkeypatch, outcome, doc_type):
    async def offsets(*args):
        return [1, 2, 3, 4]
    monkeypatch.setattr(automation_rules, "get_offsets", offsets)
    rows = asyncio.run(followup_engine._tiles_pipeline_producer(
        [_quote(outcome, doc_type=doc_type)], {"customer": {"id": "customer"}}, {},
    ))
    assert rows == {}


@pytest.mark.parametrize("outcome", ["won", "lost"])
def test_pdf_workflow_does_not_reopen_historical_sales_followups(monkeypatch, outcome):
    # No collection can be accessed: terminal outcomes return before the
    # customer lookup or follow-up upsert performed by ordinary PDF generation.
    monkeypatch.setattr(domain_outbox, "db", SimpleNamespace())
    asyncio.run(domain_outbox._upsert_followup(
        key="pdf:history", quotation=_quote(outcome), reason="Review PDF", category="quotation", session=None,
    ))


@pytest.mark.parametrize("outcome", ["won", "lost"])
def test_regular_edits_preserve_historical_outcome_without_financial_writes(monkeypatch, outcome):
    doc = _quote(outcome)
    class Quotations:
        async def find_one(self, *args, **kwargs):
            return dict(doc)
        async def update_one(self, query, update):
            doc.update(update["$set"])
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(quotations=Quotations()))
    async def scoped(*args, **kwargs):
        return dict(doc)
    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", scoped)
    user = UserPublic(email="owner@example.com", full_name="Owner", role="owner")
    edited = asyncio.run(quotation_routes.update_quotation(
        "history", QuotationUpdate(project_name="Corrected project", silent=True), user,
    ))
    assert edited.customer_outcome == outcome
    assert edited.outcome_reason == "Historical outcome provided by owner"
    assert edited.status == "draft"
    assert edited.ordered_at is None


@pytest.mark.parametrize("outcome", ["won", "lost"])
def test_duplicate_starts_new_unclassified_quotation(monkeypatch, outcome):
    doc = _quote(outcome)
    async def source(*args, **kwargs):
        return doc
    async def create(body, user):
        assert "customer_outcome" not in body.model_dump()
        assert "outcome_reason" not in body.model_dump()
        return Quotation(**body.model_dump(), id="fresh", number="FQ-FRESH", floor_id="first-floor",
            customer_name=doc["customer_name"], created_by=user.id, created_by_name=user.full_name)
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(quotations=SimpleNamespace(find_one=source)))
    monkeypatch.setattr(quotation_routes, "create_quotation", create)
    user = UserPublic(email="owner@example.com", full_name="Owner", role="owner")
    fresh = asyncio.run(quotation_routes.duplicate_quotation("history", user))
    assert fresh.customer_outcome is None
    assert fresh.outcome_reason is None
    assert fresh.items[0].id != doc["items"][0]["id"]


@pytest.mark.parametrize("outcome", ["won", "lost"])
@pytest.mark.parametrize("command", ["preview", "confirm"])
def test_historical_outcomes_require_fresh_quotation_before_order(monkeypatch, outcome, command):
    async def scoped(*args, **kwargs):
        return _quote(outcome)
    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", scoped)
    # The guard must fire before any catalog, outbox, session, financial or
    # follow-up collection is touched, including direct confirm requests.
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(quotations=object()))
    user = UserPublic(email="owner@example.com", full_name="Owner", role="owner")
    with pytest.raises(HTTPException) as error:
        if command == "preview":
            asyncio.run(quotation_routes.place_order_preview("history", user))
        else:
            asyncio.run(quotation_routes.place_order_confirm("history", quotation_routes.PlaceOrderConfirmPayload(), user))
    assert error.value.status_code == 409
    assert "Duplicate" in error.value.detail
