import asyncio
from types import SimpleNamespace

import pytest

from services.mutation_admission import MutationAdmissionMiddleware, admission


class Gate:
    def __init__(self):
        self.acquiring = asyncio.Event()
        self.commit = asyncio.Event()
        self.tokens = set()

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
