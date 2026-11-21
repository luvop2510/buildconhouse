"""Postponement and outcome commands own notes; routine edits preserve them."""
from __future__ import annotations
import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from fastapi import HTTPException
from models import (FollowupCallOutcomePayload, FollowupCompletePayload, FollowupContactPayload,
    FollowupSnoozePayload, FollowupUpdate, NotebookCellPatchPayload, NotebookConversionPayload,
    NotebookOutcomePayload, NotebookReferrerPayload, UserPublic)
from routes import followup_routes as routes
from services.access_grants import action_for_api_request


def user():
    return UserPublic(email="manager@example.com", full_name="Manager", role="manager",
        floor_ids=["first-floor", "second-floor"], active_floor_id="first-floor")


def test_record_note_uses_update_permission():
    assert action_for_api_request("POST", "/api/followups/followup-1/notes") == "update"


@pytest.mark.parametrize("action,payload", [
    (routes.complete_followup, FollowupCompletePayload(notes="Routine note")),
    (routes.snooze_followup, FollowupSnoozePayload(preset="1h", notes="Routine note")),
    (routes.update_followup, FollowupUpdate(status="dismissed", notes="Routine note")),
    (routes.update_followup, FollowupUpdate(notes="Standalone note")),
    (routes.contact_followup, FollowupContactPayload(channel="call", notes="Routine note")),
])
def test_non_loss_notes_rejected_before_database(monkeypatch, action, payload):
    database = AsyncMock()
    monkeypatch.setattr(routes, "db", database)
    with pytest.raises(HTTPException) as error:
        asyncio.run(action("followup-1", payload, user()))
    assert error.value.status_code == 422
    assert database.mock_calls == []


@pytest.mark.parametrize("action,payload", [
    (routes.complete_followup, FollowupCompletePayload()),
    (routes.snooze_followup, FollowupSnoozePayload(preset="1h")),
    (routes.update_followup, FollowupUpdate(status="dismissed")),
])
def test_routine_changes_preserve_historical_notes(monkeypatch, action, payload):
    due = routes.ist_day_bounds_utc()[0].isoformat()
    row = {
        "id": "followup-1", "customer_id": "customer-1", "notes": "Historical note",
        "status": "open", "floor_id": "first-floor", "due_at": due,
    }
    class Morning(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromisoformat(due).replace(tzinfo=timezone.utc).astimezone(tz) + routes.timedelta(hours=9)
    monkeypatch.setattr(routes, "datetime", Morning)
    collection = SimpleNamespace(find_one=AsyncMock(return_value=row), update_one=AsyncMock(),
        find_one_and_update=AsyncMock(return_value=row))
    monkeypatch.setattr(routes, "db", SimpleNamespace(followups=collection))
    monkeypatch.setattr(routes, "log_event", AsyncMock())
    asyncio.run(action("followup-1", payload, user()))
    write = collection.update_one.await_args or collection.find_one_and_update.await_args
    saved = write.args[1]["$set"]
    assert "notes" not in saved
    assert "Historical note" not in saved.values()


@pytest.mark.parametrize("action,payload", [
    (routes.convert_notebook, NotebookConversionPayload(quotation_price=12000, updated_at="v1", notes="Routine")),
    (routes.patch_notebook, NotebookCellPatchPayload(field="status", value="pending", updated_at="v1", notes="Routine")),
    (routes.patch_notebook, NotebookCellPatchPayload(field="notes", value="Standalone note", updated_at="v1")),
    (routes.assign_notebook_referrer, NotebookReferrerPayload(referrer_id="partner-1", updated_at="v1", notes="Routine")),
    (routes.complete_notebook_outcome, NotebookOutcomePayload(outcome="won", updated_at="v1", notes="Routine")),
])
def test_notebook_only_lost_can_write_note(monkeypatch, action, payload):
    database = AsyncMock()
    monkeypatch.setattr(routes, "db", database)
    caller = user()
    caller.active_floor_id = "second-floor"
    with pytest.raises(HTTPException) as error:
        asyncio.run(action("second-floor", "lead-1", payload, caller))
    assert error.value.status_code == 422
    assert database.mock_calls == []


@pytest.mark.parametrize("notes", [None, "", " \n\t "])
def test_lost_requires_fresh_reason_before_database(monkeypatch, notes):
    database = AsyncMock()
    monkeypatch.setattr(routes, "db", database)
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.log_call("followup-1", FollowupCallOutcomePayload(outcome="lost", notes=notes), user()))
    assert error.value.status_code == 422
    assert database.mock_calls == []
