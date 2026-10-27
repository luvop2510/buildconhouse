"""Cold identity bursts share work without sharing scope or cancellation."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import auth


class Database:
    def __init__(self):
        self.user_sessions = self
        self.session_reads = 0
        self.principal_reads = 0
        self.writes = 0
        self.pause_first = False
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.revoked = False
        self.active = True
        self.mfa = False
        self.failure = False

    def __getitem__(self, collection):
        async def principal(query, *_args):
            self.principal_reads += 1
            await asyncio.sleep(0)
            return {"id": query["id"], "active": self.active, "collection": collection,
                    "mfa_enabled": self.mfa, "mfa_version": 1}
        return SimpleNamespace(find_one=principal)

    async def find_one(self, *_args):
        self.session_reads += 1
        snapshot = None if self.revoked else {"id": "session"}
        if self.pause_first and self.session_reads == 1:
            self.started.set()
            await self.release.wait()
        if self.failure:
            raise RuntimeError("synthetic transport failure")
        return snapshot

    async def update_one(self, *_args):
        self.writes += 1


@pytest.fixture
def database(monkeypatch):
    auth._principal_cache.clear()
    auth._principal_inflight.clear()
    value = Database()
    monkeypatch.setattr(auth, "db", value)
    yield value
    auth._principal_cache.clear()
    auth._principal_inflight.clear()


async def load(subject="member", session="session", kind="staff", collection="users"):
    return await auth._load_active_principal(
        {"sub": subject, "session_id": session}, kind=kind, collection=collection,
    )


@pytest.mark.asyncio
async def test_cold_burst_reads_once_and_returns_independent_copies(database):
    results = await asyncio.gather(*(load() for _ in range(12)))
    await asyncio.sleep(0)
    assert database.session_reads == database.principal_reads == database.writes == 1
    assert not auth._principal_inflight
    results[0]["active"] = False
    assert all(result["active"] for result in results[1:])
    assert (await load())["active"]


@pytest.mark.asyncio
@pytest.mark.parametrize("different", [
    {"subject": "other"}, {"session": "other"},
    {"kind": "customer"}, {"collection": "customers"},
])
async def test_inflight_scope_never_crosses_identity_or_collection(database, different):
    await asyncio.gather(load(), load(**different))
    assert database.session_reads == database.principal_reads == 2


@pytest.mark.asyncio
async def test_canceling_one_waiter_does_not_cancel_another(database):
    database.pause_first = True
    first = asyncio.create_task(load())
    await database.started.wait()
    second = asyncio.create_task(load())
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    database.release.set()
    assert (await second)["id"] == "member"
    assert database.session_reads == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("single_session", [False, True])
async def test_new_call_after_invalidation_cannot_join_old_read(database, single_session):
    database.pause_first = True
    old = asyncio.create_task(load())
    await database.started.wait()
    database.revoked = True
    auth.invalidate_principal_cache("staff", "member", "session" if single_session else None)
    with pytest.raises(HTTPException) as error:
        await load()
    assert error.value.status_code == 401
    assert database.session_reads == 2
    database.release.set()
    await old
    assert auth._cached_principal("staff", "member", "session") is None


@pytest.mark.asyncio
@pytest.mark.parametrize("condition", ["revoked", "inactive", "mfa", "failure"])
async def test_shared_failure_cleans_up_and_retry_validates_again(database, condition):
    setattr(database, "active" if condition == "inactive" else condition, condition != "inactive")
    failures = await asyncio.gather(*(load() for _ in range(6)), return_exceptions=True)
    assert all(isinstance(error, RuntimeError if condition == "failure" else HTTPException) for error in failures)
    assert database.session_reads == 1
    assert not auth._principal_cache and not auth._principal_inflight
    database.revoked = database.mfa = database.failure = False
    database.active = True
    assert (await load())["active"]
    assert database.session_reads == 2


@pytest.mark.asyncio
async def test_inflight_map_is_bounded_without_dropping_validation(database, monkeypatch):
    monkeypatch.setattr(auth, "_PRINCIPAL_CACHE_MAX_ENTRIES", 1)
    database.pause_first = True
    old = asyncio.create_task(load())
    await database.started.wait()
    assert len(auth._principal_inflight) == 1
    assert (await load(subject="other"))["id"] == "other"
    assert len(auth._principal_inflight) == 1
    database.release.set()
    await old
    assert not auth._principal_inflight
    assert database.session_reads == 2
