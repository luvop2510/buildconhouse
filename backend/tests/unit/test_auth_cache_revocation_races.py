"""Session revocation cannot be undone by an overlapping principal cache fill."""
from types import SimpleNamespace
import asyncio

import pytest
from fastapi import HTTPException

import auth
from routes import auth_routes


@pytest.fixture(autouse=True)
def empty_principal_cache():
    auth._principal_cache.clear()
    yield
    auth._principal_cache.clear()


class RaceDb:
    def __init__(self):
        self.revoked = False
        self.read_started = asyncio.Event()
        self.release_read = asyncio.Event()
        self.write_started = asyncio.Event()
        self.release_write = asyncio.Event()
        self.delay_read = False
        self.delay_write = False
        self.fail_after_write = False
        self.user_sessions = self

    def __getitem__(self, _name):
        return SimpleNamespace(find_one=self.principal)

    async def principal(self, *_args, **_kwargs):
        return {"id": "member", "active": True}

    async def find_one(self, *_args, **_kwargs):
        snapshot = None if self.revoked else {"id": "session"}
        if self.delay_read:
            self.read_started.set()
            await self.release_read.wait()
        return snapshot

    async def update_one(self, _query, update):
        if update["$set"].get("revoked"):
            if self.delay_write:
                self.write_started.set()
                await self.release_write.wait()
            self.revoked = True
            if self.fail_after_write:
                raise RuntimeError("Write committed but acknowledgement was interrupted")
        return SimpleNamespace(matched_count=1, modified_count=1)

    update_many = update_one


async def load():
    return await auth._load_active_principal(
        {"sub": "member", "session_id": "session"}, kind="staff", collection="users",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("single_session", [False, True])
async def test_invalidation_during_read_cannot_repopulate_stale_cache(monkeypatch, single_session):
    db = RaceDb()
    db.delay_read = True
    monkeypatch.setattr(auth, "db", db)
    pending = asyncio.create_task(load())
    await db.read_started.wait()
    db.revoked = True
    auth.invalidate_principal_cache("staff", "member", "session" if single_session else None)
    db.release_read.set()
    await pending
    assert auth._cached_principal("staff", "member", "session") is None
    with pytest.raises(HTTPException) as exc:
        await load()
    assert exc.value.status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize("write_fails", [False, True])
@pytest.mark.parametrize("operation", ["all_helper", "logout", "logout_all", "revoke_one", "other_sessions", "mfa"])
async def test_revocation_clears_principal_cached_during_write(monkeypatch, operation, write_fails):
    db = RaceDb()
    db.delay_write = True
    db.fail_after_write = write_fails
    monkeypatch.setattr(auth, "db", db)
    monkeypatch.setattr(auth_routes, "db", db)
    identity = ("staff", "member", "current-session")
    header = "Bearer " + auth.create_token("member", "staff", {"session_id": "session"})
    if operation == "all_helper":
        revoke = auth.revoke_all_sessions("staff", "member")
    elif operation == "logout":
        revoke = auth_routes.logout_current_session(authorization=header)
    elif operation == "logout_all":
        revoke = auth_routes.logout_all_sessions(session=identity)
    elif operation == "revoke_one":
        revoke = auth_routes.revoke_one_session("session", session=identity)
    elif operation == "other_sessions":
        revoke = auth_routes._revoke_other_sessions("staff", "member", None)
    else:
        revoke = auth_routes._mfa_sessions(SimpleNamespace(id="member", session_id=None), 1, True)
    pending = asyncio.create_task(revoke)
    await db.write_started.wait()
    await load()  # Database write is pending: the old valid session fills the cache.
    assert auth._cached_principal("staff", "member", "session") is not None
    db.release_write.set()
    if write_fails:
        with pytest.raises(RuntimeError, match="acknowledgement was interrupted"):
            await pending
    else:
        await pending
    assert auth._cached_principal("staff", "member", "session") is None
    with pytest.raises(HTTPException) as exc:
        await load()
    assert exc.value.status_code == 401
