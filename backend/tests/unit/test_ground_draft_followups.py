"""Saved Ground selections/quotations remain leads until an order or loss."""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from services import automation_rules, followup_engine as engine


@pytest.mark.parametrize("doc_type,rule", [("tiles_selection", "selection_waiting"), ("tiles_quotation", "quotation_tiles_waiting")])
@pytest.mark.parametrize("status", ["draft", "sent", "pending_approval", "approved", "won"])
def test_saved_ground_drafts_need_followup_even_without_items(monkeypatch, doc_type, rule, status):
    async def offsets(*args):
        return [2, 5, 10, 15]
    monkeypatch.setattr(automation_rules, "get_offsets", offsets)
    quote = {"id": "q", "number": "TQ-1", "floor_id": "ground-floor", "customer_id": "c", "status": status,
             "doc_type": doc_type, "created_at": (datetime.now(timezone.utc) - timedelta(days=3)).isoformat(), "items": []}
    rows = asyncio.run(engine._tiles_pipeline_producer([quote], {"c": {"id": "c", "name": "Customer"}}, {}))
    assert list(rows) == [f"{rule}:q"]
    assert rows[f"{rule}:q"]["floor_id"] == "ground-floor"
    assert rows[f"{rule}:q"]["quotation_id"] == "q"
    assert rows[f"{rule}:q"]["value"] == 0
    quote["status"] = "ordered"
    assert asyncio.run(engine._tiles_pipeline_producer([quote], {"c": {"id": "c"}}, {})) == {}


@pytest.mark.parametrize("status,outcome", [("lost", None), ("rejected", None), ("cancelled", None), ("draft", "lost"), ("approved", "won")])
def test_closed_ground_documents_do_not_reopen_reminders(monkeypatch, status, outcome):
    async def offsets(*args):
        return [2]
    monkeypatch.setattr(automation_rules, "get_offsets", offsets)
    for doc_type in ("tiles_selection", "tiles_quotation"):
        quote = {"id": "q", "customer_id": "c", "status": status, "customer_outcome": outcome, "doc_type": doc_type,
                 "created_at": (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()}
        assert asyncio.run(engine._tiles_pipeline_producer([quote], {"c": {"id": "c"}}, {})) == {}
