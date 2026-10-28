import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from models import UserPublic
from routes.sales_identity_review_routes import IdentityDecision
from services.analytics.identity_review import duplicate_groups, review_identity, review_key
from services.analytics.unified import Query
from services.analytics.filters import FloorAccessError


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, limit):
        return deepcopy(self.rows[:limit])


class Collection:
    def __init__(self, rows=None):
        self.rows = rows or []

    def find(self, match, projection):
        return Cursor(self.rows)

    async def find_one(self, match):
        return deepcopy(next((row for row in self.rows if row.get("_id") == match["_id"]), None))

    async def insert_one(self, doc):
        self.rows.append(deepcopy(doc))

    async def update_one(self, match, update):
        row = next((row for row in self.rows if row.get("_id") == match["_id"] and row.get("revision") == match["revision"]), None)
        if row:
            row.update(deepcopy(update["$set"]))
            row["history"].append(deepcopy(update["$push"]["history"]))
        return SimpleNamespace(modified_count=int(row is not None))


class Database:
    def __init__(self):
        self.customers = Collection([{"id": "one", "name": "  Test Customer ", "floor_id": "ground-floor"}, {"id": "two", "name": "test   customer", "floor_id": "first-floor"}, {"id": "other", "name": "Another", "floor_id": "ground-floor"}])
        self.settings = Collection()

    def __getitem__(self, name):
        return getattr(self, name)


def owner(role="owner"):
    return UserPublic(id="reviewer", email="review@example.test", full_name="Owner", role=role)


def body(**values):
    return IdentityDecision(kind="customers", entity_ids=["one", "two"], decision="distinct", note="Compared stable IDs and source records", expected_revision=0, **values)


def test_candidates_group_names_for_review_without_joining_identities():
    db = Database()
    before = deepcopy(db.customers.rows)
    groups = asyncio.run(duplicate_groups(db, Query(), None, "customers"))
    assert len(groups) == 1
    assert {row["id"] for row in groups[0]["entities"]} == {"one", "two"}
    assert groups[0]["review"] is None and db.customers.rows == before
    assert review_key("customers", ["one", "two"]) == review_key("customers", ["two", "one"])


def test_review_revision_replay_and_history_preserve_canonical_records():
    db = Database()
    initial = deepcopy(db.customers.rows)
    one = asyncio.run(review_identity(db, Query(), None, owner(), body()))
    assert one["revision"] == 1 and one["decision"] == "distinct"
    replay = asyncio.run(review_identity(db, Query(), None, owner(), body()))
    assert replay == one and len(db.settings.rows[0]["history"]) == 1
    changed = body().model_copy(update={"decision": "needs_correction", "note": "Correct the source before resolving"})
    with pytest.raises(HTTPException) as error:
        asyncio.run(review_identity(db, Query(), None, owner(), changed))
    assert error.value.status_code == 409
    changed = changed.model_copy(update={"expected_revision": 1})
    assert asyncio.run(review_identity(db, Query(), None, owner(), changed))["revision"] == 2
    assert len(db.settings.rows[0]["history"]) == 2 and db.customers.rows == initial


def test_resolved_group_remains_reviewable_after_explicit_source_correction():
    db = Database()
    asyncio.run(review_identity(db, Query(), None, owner(), body()))
    db.customers.rows[1]["name"] = "Corrected customer name"
    updated = body().model_copy(update={"decision": "resolved", "expected_revision": 1, "note": "Verified source name correction"})
    asyncio.run(review_identity(db, Query(), None, owner(), updated))
    groups = asyncio.run(duplicate_groups(db, Query(), None, "customers"))
    assert len(groups) == 1 and groups[0]["review"]["decision"] == "resolved"


def test_review_rejects_unauthorized_or_missing_identity_before_write():
    db = Database()
    with pytest.raises(HTTPException) as error:
        asyncio.run(review_identity(db, Query(), None, owner("manager"), body()))
    assert error.value.status_code == 403 and not db.settings.rows
    with pytest.raises(FloorAccessError):
        asyncio.run(duplicate_groups(db, Query(floor_id="first-floor"), ["ground-floor"], "customers"))
    invalid = body().model_copy(update={"entity_ids": ["one", "inaccessible"]})
    with pytest.raises(HTTPException) as error:
        asyncio.run(review_identity(db, Query(), None, owner(), invalid))
    assert error.value.status_code == 404 and not db.settings.rows


def test_saved_notes_never_leak_when_only_some_group_members_accessible():
    db = Database()
    asyncio.run(review_identity(db, Query(), None, owner(), body()))
    db.customers.rows = [db.customers.rows[0]]
    assert asyncio.run(duplicate_groups(db, Query(), ["ground-floor"], "customers")) == []


def test_review_boundary_requires_nonblank_note_and_valid_revision():
    for value in ["", "   "]:
        with pytest.raises(ValidationError):
            IdentityDecision(**{**body().model_dump(), "note": value})
    with pytest.raises(ValidationError):
        IdentityDecision(**{**body().model_dump(), "expected_revision": -1})


def test_real_http_duplicate_permissions_revision_and_floor_boundary(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from auth import get_current_user
    from routes import sales_identity_review_routes as routes
    app = FastAPI()
    app.include_router(routes.router, prefix="/api")
    db = Database()
    monkeypatch.setattr(routes, "db", db)
    principal = {"user": owner("manager")}
    async def authenticated():
        return principal["user"]
    app.dependency_overrides[get_current_user] = authenticated
    with TestClient(app) as client:
        response = client.get("/api/sales-analytics/duplicates?kind=customers")
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        assert response.json()["total"] == 1
        assert client.post("/api/sales-analytics/duplicates/review", json=body().model_dump()).status_code == 403
        assert not db.settings.rows
        principal["user"] = owner()
        saved = client.post("/api/sales-analytics/duplicates/review", json=body().model_dump())
        assert saved.status_code == 200 and saved.json()["revision"] == 1
        replay = client.post("/api/sales-analytics/duplicates/review", json=body().model_dump())
        assert replay.status_code == 200 and replay.json() == saved.json()
        changed = {**body().model_dump(), "decision": "needs_correction", "note": "Different action"}
        assert client.post("/api/sales-analytics/duplicates/review", json=changed).status_code == 409
        invalid = {**body().model_dump(), "note": "   "}
        assert client.post("/api/sales-analytics/duplicates/review", json=invalid).status_code == 422
        principal["user"] = owner("admin").model_copy(update={"floor_ids": ["ground-floor"]})
        assert client.get("/api/sales-analytics/duplicates?kind=customers&floor_id=first-floor").status_code == 403
