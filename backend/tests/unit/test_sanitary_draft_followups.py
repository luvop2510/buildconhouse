"""Customer quotation drafts get a seven-day reminder, even before items exist."""
import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import services.followup_engine as engine
from tests.unit.test_followup_reconcile_closed_keys import _Cursor, _FakeFollowups


def _fixture(monkeypatch, *, days=8, status="draft", floor="first-floor", items=None):
    created = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    quote = {"id": "draft-1", "customer_id": "customer-1", "number": "Q-1", "floor_id": floor,
             "created_at": created, "updated_at": created, "status": status, "items": items or []}
    rows = _FakeFollowups([])
    database = SimpleNamespace(
        customers=SimpleNamespace(find=lambda *args, **kwargs: _Cursor([{"id": "customer-1", "name": "Customer", "phone": "9000000000"}])),
        quotations=SimpleNamespace(find=lambda *args, **kwargs: _Cursor([quote])), followups=rows,
    )
    monkeypatch.setattr(engine, "db", database)

    async def empty(*args, **kwargs):
        return {}

    async def log(*args, **kwargs):
        pass

    monkeypatch.setattr(engine, "last_contact_map", empty)
    monkeypatch.setattr(engine, "_tiles_pipeline_producer", empty)
    monkeypatch.setattr(engine, "_walkin_producer", empty)
    monkeypatch.setattr(engine, "log_event", log)
    monkeypatch.setattr(engine, "notify", log)
    return quote, rows


def test_sanitary_draft_with_no_items_has_explicit_seven_day_reminder(monkeypatch):
    quote, followups = _fixture(monkeypatch)
    result = asyncio.run(engine._reconcile_followups_locked())
    assert result["created"] == 1
    reminder = followups.rows[0]
    assert reminder["source_key"] == "quotation_followup:draft-1"
    assert reminder["due_at"] == (engine.parse_iso(quote["created_at"]) + timedelta(days=7)).isoformat()
    assert "Quotation draft" in reminder["reason"]
    assert "no order placed" in reminder["reason"]
    assert reminder["floor_id"] == "first-floor"
    assert "Quotation draft" in reminder["tags"]
    asyncio.run(engine._reconcile_followups_locked())
    assert len(followups.rows) == 1


def test_sanitary_draft_is_not_due_before_seven_days(monkeypatch):
    _, followups = _fixture(monkeypatch, days=6)
    asyncio.run(engine._reconcile_followups_locked())
    assert followups.rows == []


def test_empty_tile_quotation_does_not_create_sanitary_reminder(monkeypatch):
    _, followups = _fixture(monkeypatch, floor="ground-floor")
    asyncio.run(engine._reconcile_followups_locked())
    assert followups.rows == []


def test_approved_unplaced_quotation_still_needs_contact(monkeypatch):
    _, followups = _fixture(monkeypatch, status="approved", items=[{"product_id": "p1"}])
    asyncio.run(engine._reconcile_followups_locked())
    assert len(followups.rows) == 1
    assert "no order placed" in followups.rows[0]["reason"]


def test_placing_order_retires_the_draft_reminder(monkeypatch):
    quote, followups = _fixture(monkeypatch)
    asyncio.run(engine._reconcile_followups_locked())
    quote["status"] = "ordered"
    result = asyncio.run(engine._reconcile_followups_locked())
    assert result["auto_resolved"] == 1
    assert followups.rows[0]["status"] == "done"
    assert followups.rows[0]["auto_resolved"] is True
