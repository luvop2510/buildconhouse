"""Paged directory reads retain authorization, literal search and complete counts."""
import asyncio
import re
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from models import UserPublic
from routes import referrer_routes as routes
from routes import sales_workspace_routes as workspaces


def user():
    return UserPublic(id="sales", email="sales@example.test", full_name="Sales", role="sales",
                      floor_ids=["first-floor", "ground-floor"], active_floor_id="first-floor")


def contact(id, **values):
    return {"id": id, "name": "Same name", "type": "architect", "floor_id": "first-floor",
            "normalized_name": "same name", "created_by": "sales", **values}


def matches(doc, query):
    for key, value in query.items():
        if key == "$and":
            if not all(matches(doc, part) for part in value): return False
        elif key == "$or":
            if not any(matches(doc, part) for part in value): return False
        elif key == "$expr":
            code = ("ARC-" if doc.get("type") == "architect" else "INT-") + doc["id"].upper()
            if not re.search(value["$regexMatch"]["regex"], code, re.I): return False
        elif isinstance(value, dict):
            if "$in" in value and doc.get(key) not in value["$in"]: return False
            if "$ne" in value and doc.get(key) == value["$ne"]: return False
            if "$regex" in value and not re.search(value["$regex"], doc.get(key) or "", re.I): return False
        elif doc.get(key) != value:
            return False
    return True


class Cursor:
    def __init__(self, docs): self.docs = list(docs)
    def sort(self, fields):
        for key, direction in reversed(fields):
            self.docs.sort(key=lambda doc: doc.get(key) or "", reverse=direction < 0)
        return self
    def skip(self, offset): self.docs = self.docs[offset:]; return self
    def limit(self, limit): self.docs = self.docs[:limit]; return self
    async def to_list(self, limit): return self.docs[:limit]


class Collection:
    def __init__(self, docs): self.docs = docs; self.reads = []; self.counts = []
    def find(self, query, projection):
        self.reads.append((query, projection))
        rows = [doc for doc in self.docs if matches(doc, query)]
        if projection == {"_id": 0, "id": 1}: rows = [{"id": doc["id"]} for doc in rows]
        return Cursor(rows)
    async def count_documents(self, query):
        self.counts.append(query)
        return sum(matches(doc, query) for doc in self.docs)


def read(**values):
    return asyncio.run(routes.referrers_page(floor_id="all", type=None, search="", offset=0, limit=25, user=user(), **values))


def test_pages_include_late_rows_ties_and_filter_archived_before_limit(monkeypatch):
    docs = [contact(f"r-{i:04}") for i in reversed(range(2003))]
    docs += [contact(f"archived-{i}", name="A", active=False) for i in range(2100)]
    collection = Collection(docs)
    monkeypatch.setattr(routes, "db", SimpleNamespace(referrers=collection))
    page = read()
    assert page["total"] == 2003
    assert [row.id for row in page["rows"]] == [f"r-{i:04}" for i in range(25)]
    late = asyncio.run(routes.referrers_page(floor_id="all", search="", type=None, offset=2000, limit=25, user=user()))
    assert [row.id for row in late["rows"]] == ["r-2000", "r-2001", "r-2002"]
    assert len(collection.reads) == len(collection.counts) == 2
    assert collection.reads[0][0] == collection.counts[0]


def test_authorized_union_deduplicates_shared_without_private_floor_leak(monkeypatch):
    docs = [contact("own"), contact("other-authorized", floor_id="ground-floor"),
            contact("shared", floor_id="second-floor", shared_across_floors=True),
            contact("private", floor_id="second-floor", shared_across_floors=False)]
    collection = Collection(docs)
    monkeypatch.setattr(routes, "db", SimpleNamespace(referrers=collection))
    page = asyncio.run(routes.referrers_page(floor_id="first-floor,ground-floor", search="", type=None, offset=0, limit=25, user=user()))
    assert {row.id for row in page["rows"]} == {"own", "other-authorized", "shared"}
    assert page["total"] == 3 and len(collection.reads) == 1
    with pytest.raises(HTTPException) as forbidden:
        asyncio.run(routes.referrers_page(floor_id="first-floor,second-floor", search="", type=None, offset=0, limit=25, user=user()))
    assert forbidden.value.status_code == 403 and len(collection.reads) == 1
    denied = user(); denied.floor_ids = []
    with pytest.raises(HTTPException) as no_access:
        asyncio.run(routes.referrers_page(floor_id="all", search="", type=None, offset=0, limit=25, user=denied))
    assert no_access.value.status_code == 403


@pytest.mark.parametrize("search,expected", [("Studio (A)+", ["one"]), ("98765", ["one"]), ("ARC-ONE", ["one"]), ("rc-on", ["one"]), ("INT-TWO", ["two"]), (".*", [])])
def test_literal_name_phone_studio_and_full_reference_code_search(monkeypatch, search, expected):
    monkeypatch.setattr(routes, "db", SimpleNamespace(referrers=Collection([
        contact("one", company="Studio (A)+", phone="9876543210"), contact("two", type="interior_designer"),
    ])))
    page = asyncio.run(routes.referrers_page(floor_id="all", search=search, type=None, offset=0, limit=25, user=user()))
    assert [row.id for row in page["rows"]] == expected and page["total"] == len(expected)


def test_http_validation_bounds_and_serialization(monkeypatch):
    monkeypatch.setattr(routes, "db", SimpleNamespace(referrers=Collection([contact("one")])))
    app = FastAPI(); app.include_router(routes.router)
    route = next(route for route in routes.router.routes if route.path == "/referrers/page")
    dependency = next(dep.call for dep in route.dependant.dependencies if dep.name == "user")
    app.dependency_overrides[dependency] = user
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as api:
            result = await api.get("/referrers/page?floor_id=all")
            assert result.status_code == 200 and result.json()["rows"][0]["id"] == "one"
            for query in ("limit=51", "limit=0", "offset=-1", "search=" + "x" * 201, "type=other"):
                assert (await api.get("/referrers/page?" + query)).status_code == 422
    asyncio.run(run())


def test_history_resolves_only_report_ids_in_bounded_queries_and_scope(monkeypatch):
    collection = Collection([contact(f"r-{i}") for i in range(1001)] + [
        contact("shared", floor_id="second-floor", shared_across_floors=True),
        contact("private", floor_id="second-floor"), contact("archived", active=False),
    ])
    monkeypatch.setattr(workspaces, "db", SimpleNamespace(referrers=collection))
    reporting = [{"id": f"r-{i}"} for i in range(1001)] + [{"id": id} for id in ("shared", "private", "archived", "deleted")]
    result = asyncio.run(workspaces._mark_historical_references(reporting, "all", ["first-floor", "ground-floor"]))
    assert {row["id"] for row in result if row["historical"]} == {"private", "archived", "deleted"}
    assert len(collection.reads) == 3
    assert all(projection == {"_id": 0, "id": 1} for _, projection in collection.reads)
    assert all(len(query["id"]["$in"]) <= 500 for query, _ in collection.reads)
    assert all("historical" not in row for row in reporting)
    collection.reads.clear()
    assert asyncio.run(workspaces._mark_historical_references([], "all", [])) == []
    assert not collection.reads
