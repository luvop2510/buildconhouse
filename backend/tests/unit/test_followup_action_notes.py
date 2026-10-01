"""Human follow-up mutations require the action's note before any side effect."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from models import (
    FollowupCallOutcomePayload, FollowupCompletePayload, FollowupContactPayload,
    FollowupSnoozePayload, FollowupUpdate, NotebookCellPatchPayload,
    NotebookConversionPayload, NotebookOutcomePayload, NotebookReferrerPayload, UserPublic,
)
from routes import followup_routes as routes


def user():
    return UserPublic(email="manager@example.com", full_name="Manager", role="manager",
                      floor_ids=["first-floor", "second-floor"], active_floor_id="first-floor")


@pytest.mark.parametrize("notes", [None, "", " \n\t "])
@pytest.mark.parametrize("action,payload", [
    (routes.complete_followup, FollowupCompletePayload()),
    (routes.snooze_followup, FollowupSnoozePayload(preset="1h")),
    (routes.update_followup, FollowupUpdate(status="dismissed")),
    (routes.update_followup, FollowupUpdate(due_at="2026-10-09T10:00:00+00:00")),
    (routes.update_followup, FollowupUpdate(assigned_to="salesperson")),
    (routes.contact_followup, FollowupContactPayload(channel="call")),
    (routes.log_call, FollowupCallOutcomePayload(outcome="won")),
    (routes.log_call, FollowupCallOutcomePayload(outcome="no_answer")),
])
def test_missing_action_note_never_reads_or_mutates_database(monkeypatch, notes, action, payload):
    database = AsyncMock()
    events = AsyncMock()
    monkeypatch.setattr(routes, "db", database)
    monkeypatch.setattr(routes, "log_event", events)
    with pytest.raises(HTTPException) as failure:
        asyncio.run(action("followup-1", payload.model_copy(update={"notes": notes}), user()))
    assert failure.value.status_code == 422
    assert database.mock_calls == []
    events.assert_not_awaited()


@pytest.mark.parametrize("notes", [None, "", "   "])
def test_delete_requires_note_before_cleanup(monkeypatch, notes):
    database = AsyncMock()
    monkeypatch.setattr(routes, "db", database)
    with pytest.raises(HTTPException) as failure:
        asyncio.run(routes.delete_followup("followup-1", user(), notes))
    assert failure.value.status_code == 422
    assert database.mock_calls == []


@pytest.mark.parametrize("action,payload", [
    (routes.complete_notebook_outcome, NotebookOutcomePayload(outcome="won", updated_at="v1")),
    (routes.complete_notebook_outcome, NotebookOutcomePayload(outcome="lost", updated_at="v1")),
    (routes.convert_notebook, NotebookConversionPayload(quotation_price=12000, updated_at="v1")),
    (routes.patch_notebook, NotebookCellPatchPayload(field="status", value="pending", updated_at="v1")),
    (routes.patch_notebook, NotebookCellPatchPayload(field="quotation_price", value=12000, updated_at="v1")),
    (routes.patch_notebook, NotebookCellPatchPayload(field="notes", value=" \n ", updated_at="v1")),
    (routes.assign_notebook_referrer, NotebookReferrerPayload(referrer_id="partner-1", updated_at="v1")),
])
def test_notebook_status_changes_require_note_before_database(monkeypatch, action, payload):
    database = AsyncMock()
    monkeypatch.setattr(routes, "db", database)
    with pytest.raises(HTTPException) as failure:
        asyncio.run(action("second-floor", "lead-1", payload, user()))
    assert failure.value.status_code == 422
    assert database.mock_calls == []


@pytest.mark.parametrize("action,payload", [
    (routes.complete_followup, FollowupCompletePayload(notes="  Customer confirmed delivery  ")),
    (routes.snooze_followup, FollowupSnoozePayload(preset="1h", notes="  Customer is in a meeting  ")),
    (routes.update_followup, FollowupUpdate(status="dismissed", notes="  Duplicate reminder  ")),
])
def test_successful_changes_persist_note_and_history(monkeypatch, action, payload):
    collection = SimpleNamespace(
        find_one=AsyncMock(return_value={"id": "followup-1", "customer_id": "customer-1", "notes": "Old note"}),
        update_one=AsyncMock(),
    )
    events = AsyncMock()
    monkeypatch.setattr(routes, "db", SimpleNamespace(followups=collection))
    monkeypatch.setattr(routes, "log_event", events)
    asyncio.run(action("followup-1", payload, user()))
    saved = collection.update_one.await_args.args[1]["$set"]
    assert saved["notes"] == payload.notes.strip()
    assert events.await_count >= 1
    if saved.get("status") == "dismissed":
        assert saved["resolution_note"] == payload.notes.strip()
    else:
        assert events.await_args.kwargs["payload"]["notes"] == payload.notes.strip()
