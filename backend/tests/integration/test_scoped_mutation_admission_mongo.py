"""Conflict and version compatibility on a disposable Mongo replica."""
import asyncio
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI, Header, HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import AutoReconnect

from routes import quotation_routes
from services.mutation_admission import KEY, SCOPED_EXCLUSIVE, AdmissionUnavailable, MutationAdmissionMiddleware, admission, admission_status
from tests.integration.test_tile_release_godown_mongo import tile_replica


@pytest_asyncio.fixture
async def database(tile_replica, monkeypatch):
    import db
    client = AsyncIOMotorClient(tile_replica, serverSelectionTimeoutMS=3000)
    database = client["forge_admission_qa_" + uuid4().hex]
    monkeypatch.setattr(db, "db", database)
    try:
        yield database
    finally:
        await client.drop_database(database.name)
        client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["successful", "failed", "interrupted"])
async def test_local_quotation_save_and_delete_only_conflict_on_same_record(database, failure):
    app = FastAPI()
    app.add_middleware(MutationAdmissionMiddleware)
    entered, settle, deleted = asyncio.Event(), asyncio.Event(), []

    @app.patch("/api/quotations/{identity}")
    async def save(identity):
        entered.set()
        await settle.wait()
        if failure == "failed":
            raise HTTPException(422, "Synthetic save failure")
        return {"saved": identity}

    @app.delete("/api/quotations/{identity}")
    async def remove(identity):
        deleted.append(identity)
        return {"deleted": identity}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://qa") as api:
        pending_save = asyncio.create_task(api.patch("/api/quotations/saved"))
        try:
            await asyncio.wait_for(entered.wait(), 3)
            if failure == "interrupted":
                pending_save.cancel()
            untouched = await api.delete("/api/quotations/unrelated")
            assert untouched.status_code == 200, untouched.text
            pending = await api.delete("/api/quotations/saved")
            assert pending.status_code == 409
            assert pending.json()["reason"] == "conflicting_mutation"
            assert deleted == ["unrelated"]
        finally:
            settle.set()
            if failure == "interrupted":
                with pytest.raises(asyncio.CancelledError):
                    await pending_save
            else:
                assert (await pending_save).status_code == (200 if failure == "successful" else 422)
        assert (await api.delete("/api/quotations/saved")).status_code == 200
    assert (await admission_status(database))["writer_count"] == 0


@pytest.mark.asyncio
async def test_two_deletes_fence_related_writes_and_older_runtime_admission(database):
    first, second = {"quotations": "quotation-one"}, {"quotations": "quotation-two"}
    async with admission(database, exclusive=True, scope=first):
        gate = database.settings
        old = await gate.update_one({"_id": KEY, "exclusive": None}, {"$addToSet": {"writers": "v1-writer"}})
        assert old.matched_count == 0
        async with admission(database, exclusive=True, scope=second):
            status = await admission_status(database)
            assert len(status["scoped_deletions"]) == 2
            with pytest.raises(HTTPException) as active:
                async with admission(database, scope=second):
                    pytest.fail("Conflicting write entered its handler")
            assert active.value.status_code == 409
            with pytest.raises(HTTPException):
                async with admission(database, exclusive=True, scope=first):
                    pytest.fail("Repeated delete entered its handler")
            async with admission(database, scope={"customers": None}):
                pass
        assert (await gate.find_one({"_id": KEY}))["exclusive"] == SCOPED_EXCLUSIVE
    assert (await gate.find_one({"_id": KEY}))["exclusive"] is None
    assert not (await admission_status(database))["scoped_deletions"]


@pytest.mark.asyncio
async def test_unknown_v1_writer_is_never_released_by_a_new_request(database):
    optimistic = {"quotations": "quotation-one"}
    await database.settings.insert_one({"_id": KEY, "exclusive": None, "writers": ["unowned-legacy-token"]})
    app = FastAPI()
    app.add_middleware(MutationAdmissionMiddleware)

    @app.delete("/api/quotations/{identity}")
    async def delete_too_early(identity):
        pytest.fail("Destructive snapshot admitted past an unknown v1 writer")

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://qa") as api:
        response = await api.delete("/api/quotations/test")
    assert response.status_code == 409
    assert response.json()["reason"] == "unverified_legacy_operation"
    async with admission(database, scope=optimistic):
        assert (await admission_status(database))["writer_count"] == 2
    assert (await database.settings.find_one({"_id": KEY}))["writers"] == ["unowned-legacy-token"]


@pytest.mark.asyncio
async def test_scope_wildcards_protect_a_customer_graph_from_related_child_writes(database):
    async with admission(database, scope={"quotations": "linked-quotation"}):
        with pytest.raises(HTTPException):
            async with admission(database, exclusive=True, scope={"customers": "target", "quotations": None}):
                pytest.fail("Graph cleanup overlapped its dependent writer")
        async with admission(database, exclusive=True, scope={"catalog": None}):
            pass
    async with admission(database, scope={"customers": "unrelated"}):
        async with admission(database, exclusive=True, scope={"customers": "target", "quotations": None}):
            pass


@pytest.mark.asyncio
@pytest.mark.parametrize("exclusive", [False, True])
async def test_timeout_fences_a_mongo_claim_that_arrives_after_cleanup(database, exclusive):
    class DelayedClaim:
        def with_options(self, **options):
            return self

        async def update_one(self, query, update, **options):
            if "cancelled_claims" in query:
                self.late_query, self.late_update = query, update
                raise AutoReconnect("Synthetic acknowledgement loss")
            return await database.settings.update_one(query, update, **options)

    gate = DelayedClaim()
    with pytest.raises(AdmissionUnavailable):
        async with admission(SimpleNamespace(settings=gate), exclusive=exclusive, scope={"quotations": "target"}):
            pytest.fail("Timed out reservation started a mutation")
    late = await database.settings.update_one(gate.late_query, gate.late_update)
    assert late.matched_count == 0
    status = await admission_status(database)
    assert status["writer_count"] == 0
    assert not status["scoped_deletions"]


@pytest.mark.asyncio
async def test_committed_quotation_deletion_replays_only_to_same_actor_and_floor(database, monkeypatch):
    import db
    from models import UserPublic

    monkeypatch.setattr(db, "client", database.client)
    monkeypatch.setattr(quotation_routes, "db", database)

    def actor(x_actor: str = Header(), x_floor_id: str = Header()):
        return UserPublic(id=x_actor, full_name="Synthetic operator", role="owner", active_floor_id=x_floor_id)

    app = FastAPI()
    app.add_middleware(MutationAdmissionMiddleware)
    app.dependency_overrides[quotation_routes.get_current_user] = actor
    app.include_router(quotation_routes.router, prefix="/api")
    await database.quotations.insert_one({"id": "quote", "floor_id": "first-floor", "status": "draft"})
    path = "/api/quotations/quote"
    headers = {"x-actor": "first-owner", "x-floor-id": "first-floor"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://qa") as api:
        initial = await api.delete(path, headers=headers)
        assert initial.status_code == 200, initial.text
        assert (await api.delete(path, headers=headers)).json() == initial.json()
        different_actor = await api.delete(path, headers={**headers, "x-actor": "other-owner"})
        assert different_actor.status_code == 404
        different_floor = await api.delete(path, headers={**headers, "x-floor-id": "ground-floor"})
        assert different_floor.status_code == 404
    assert await database.quotations.count_documents({"id": "quote"}) == 0
    receipt = await database.settings.find_one({"_id": "quotation-deletion:quote"})
    assert receipt["result"] == initial.json() and receipt["pending_private_files"] == []
