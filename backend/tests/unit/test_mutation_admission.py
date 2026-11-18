import asyncio
from types import SimpleNamespace

import pytest

from services.mutation_admission import MutationAdmissionMiddleware, admission, drain_mutation_admission, http_operation


class Gate:
    def __init__(self):
        self.acquiring = asyncio.Event()
        self.commit = asyncio.Event()
        self.tokens = set()

    def with_options(self, **kwargs):
        return self

    async def update_one(self, query, update, **kwargs):
        if "$setOnInsert" in update:
            return
        if "$pull" in update or query.get("exclusive"):
            self.tokens.discard(query.get("writers") or query["exclusive"])
        else:
            self.acquiring.set()
            await self.commit.wait()
            self.tokens.add(update["$addToSet"]["writers"] if "$addToSet" in update else update["$set"]["exclusive"])
        return SimpleNamespace(matched_count=1)


@pytest.mark.asyncio
@pytest.mark.parametrize("exclusive", [False, True])
async def test_cancelled_acquisition_releases_token_after_driver_settles(exclusive):
    gate = Gate()

    async def request():
        async with admission(SimpleNamespace(settings=gate), exclusive=exclusive):
            pytest.fail("A cancelled acquisition must not start the handler")

    task = asyncio.create_task(request())
    await asyncio.wait_for(gate.acquiring.wait(), 1)
    task.cancel()
    await asyncio.sleep(0)
    gate.commit.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert not gate.tokens


@pytest.mark.parametrize("path, expected", [
    ("/api/kitchen-projects/private-customer-id/commands", "http:POST:kitchen-projects"),
    ("/api/kitchen-customer-deletion/private-customer-id", "http:POST:kitchen-customer-deletion"),
    ("/api/customer-private-name", "http:POST:other"),
])
def test_operation_diagnostics_omit_customer_ids_and_unknown_path_content(path, expected):
    assert http_operation({"method": "POST", "path": path}) == expected


@pytest.mark.asyncio
async def test_cancelled_request_retains_token_until_handler_finishes(monkeypatch):
    import db
    gate = Gate()
    gate.commit.set()
    monkeypatch.setattr(db, "db", SimpleNamespace(settings=gate))
    entered = asyncio.Event()
    finished = asyncio.Event()

    async def save(*args):
        entered.set()
        await finished.wait()
        assert gate.tokens

    task = asyncio.create_task(MutationAdmissionMiddleware(save)(
        {"type": "http", "path": "/api/kitchen-projects/p/commands", "method": "POST"}, None, None,
    ))
    await asyncio.wait_for(entered.wait(), 1)
    task.cancel()
    await asyncio.sleep(0)
    assert gate.tokens
    finished.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert not gate.tokens


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_drain", [False, True])
async def test_shutdown_deadline_or_cancellation_does_not_release_an_active_writer(cancel_drain):
    gate = Gate()
    gate.commit.set()
    entered = asyncio.Event()
    finish = asyncio.Event()

    async def write():
        async with admission(SimpleNamespace(settings=gate)):
            entered.set()
            await finish.wait()

    writer = asyncio.create_task(write())
    try:
        await asyncio.wait_for(entered.wait(), 1)
        if cancel_drain:
            draining = asyncio.create_task(drain_mutation_admission(1))
            await asyncio.sleep(0)
            draining.cancel()
            with pytest.raises(asyncio.CancelledError):
                await draining
        else:
            await drain_mutation_admission(0)
        assert gate.tokens and not writer.done()
    finally:
        finish.set()
        await asyncio.wait_for(writer, 1)
    assert not gate.tokens
