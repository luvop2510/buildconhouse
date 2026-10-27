"""Transient conflicts retry transactionally; post-commit effects run once."""
import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from pymongo.errors import OperationFailure
from services import domain_outbox as outbox


@pytest.mark.parametrize("transient", [True, False])
def test_outbox_transaction_recovery_keeps_claim_and_post_commit_once(monkeypatch, transient):
    row = {"id": "event", "status": "processing", "claim_id": "mine", "event_type": outbox.EVENT_ORDER_PLACED}
    calls = {"attempts": 0, "commits": 0, "notifications": 0, "bumps": 0}
    class Events:
        async def find_one(self, query, *args, **kwargs):
            return deepcopy(row) if all(row.get(key) == value for key, value in query.items()) else None
        async def update_one(self, query, update, **kwargs):
            assert query == {"id": "event", "claim_id": "mine"}
            row.update(update["$set"])
            calls["commits"] += 1
    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def with_transaction(self, operation):
            for attempt in range(2):
                try:
                    return await operation(self)
                except OperationFailure as error:
                    if attempt or not error.has_error_label("TransientTransactionError"):
                        raise
    async def session(): return Session()
    async def handler(event, session):
        assert event["claim_id"] == "mine"
        calls["attempts"] += 1
        if calls["attempts"] == 1:
            raise OperationFailure("transaction conflict", code=112, details={
                "errorLabels": ["TransientTransactionError"] if transient else [],
            })
        return {"count": 1, "post_commit_notification": {"user_id": "actor"}}
    async def bump(event_type):
        assert event_type == outbox.EVENT_ORDER_PLACED
        calls["bumps"] += 1
    async def notify(**kwargs): calls["notifications"] += 1
    monkeypatch.setattr(outbox, "db", SimpleNamespace(event_outbox=Events()))
    monkeypatch.setattr(outbox, "client", SimpleNamespace(start_session=session))
    monkeypatch.setattr(outbox, "_handle_order_placed", handler)
    monkeypatch.setattr(outbox, "_bump_analytics_versions", bump)
    monkeypatch.setattr(outbox, "notify", notify)
    if transient:
        assert asyncio.run(outbox.dispatch_event("event", claim_id="mine")) == {"count": 1}
        assert calls == {"attempts": 2, "commits": 1, "notifications": 1, "bumps": 1}
        assert row["status"] == "completed"
    else:
        with pytest.raises(OperationFailure):
            asyncio.run(outbox.dispatch_event("event", claim_id="mine"))
        assert calls == {"attempts": 1, "commits": 0, "notifications": 0, "bumps": 0}
        assert row["status"] == "processing"
