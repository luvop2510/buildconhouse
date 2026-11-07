"""Verify bounded portal summary pages at the authenticated HTTP boundary."""
import json
import re
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from auth import get_current_customer
from models import CustomerPublic
from routes import customer_routes


class Quotations:
    def __init__(self):
        self.rows = [
            {"id": f"quote-{i:03d}", "number": f"Q-{i:03d}", "customer_id": "customer-a",
             "created_at": "2026-11-01", "status": "draft", "grand_total": i,
             "items": [{"description": "Fixture line " * 200}] * 100,
             "revisions": [{"items": [{"fixture": "history" * 100}]}] * 5}
            for i in range(205)
        ] + [{"id": "foreign", "customer_id": "customer-b", "number": "Q-FOREIGN", "created_at": "2026-11-02"}]
        self.bounds = []
        self.queries = []

    def matching(self, query):
        assert query["customer_id"] == "customer-a"
        self.queries.append(query)
        return [row for row in self.rows if row["customer_id"] == query["customer_id"] and (
            not query.get("$or") or any(re.search(rule[field]["$regex"], row.get(field, ""), re.I)
                                        for rule in query["$or"] for field in rule))]

    def find(self, query, projection):
        rows = self.matching(query)
        bounds = self.bounds

        class Cursor:
            def sort(self, order):
                assert order == [("created_at", -1), ("id", -1)]
                rows.sort(key=lambda row: (row["created_at"], row["id"]), reverse=True)
                return self

            def skip(self, value):
                self.offset = value
                return self

            def limit(self, value):
                self.bound = value
                return self

            async def to_list(self, value):
                assert self.bound == value <= 50
                bounds.append(value)
                result = []
                for row in rows[self.offset:self.offset + value]:
                    summary = {}
                    for field, selected in projection.items():
                        if isinstance(selected, dict):
                            source = selected["$size"]["$ifNull"][0].removeprefix("$")
                            summary[field] = len(row.get(source) or [])
                        elif selected and field in row:
                            summary[field] = row[field]
                    result.append(summary)
                return result
        return Cursor()

    async def count_documents(self, query):
        return len(self.matching(query))


@pytest.fixture
def portal(monkeypatch):
    quotations = Quotations()
    monkeypatch.setattr(customer_routes, "db", SimpleNamespace(quotations=quotations))
    app = FastAPI()
    app.include_router(customer_routes.router, prefix="/api")
    app.dependency_overrides[get_current_customer] = lambda: CustomerPublic(id="customer-a", name="Fixture", floor_id="first-floor", portal_enabled=True)
    return app, quotations


@pytest.mark.asyncio
async def test_pages_bound_payload_and_cover_every_customer_document(portal):
    app, source = portal
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test") as client:
        pages = [await client.get(f"/api/portal/quotations/page?skip={skip}&limit=20") for skip in range(0, 220, 20)]
        home = await client.get("/api/portal/quotations/page?limit=1")
    assert all(page.status_code == 200 for page in pages)
    rows = [row for page in pages for row in page.json()["items"]]
    assert [row["id"] for row in rows] == [f"quote-{i:03d}" for i in reversed(range(205))]
    assert all(page.json()["total"] == 205 for page in pages)
    assert pages[0].json()["has_more"] and not pages[-1].json()["has_more"]
    assert home.json()["items"][0] == rows[0]
    assert len(home.json()["items"]) == 1 and home.json()["total"] == 205
    assert rows[0]["item_count"] == 100 and rows[0]["revision_count"] == 5
    assert "items" not in rows[0] and "revisions" not in rows[0]
    full_bytes = len(json.dumps(source.rows[:200]).encode())
    summary_bytes = len(pages[0].content)
    assert summary_bytes < full_bytes / 100
    print(f"Portal fixture payload: {full_bytes} full bytes -> {summary_bytes} page bytes; home {len(home.content)} bytes")


@pytest.mark.asyncio
async def test_search_is_literal_customer_scoped_and_pagination_is_validated(portal):
    app, source = portal
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test") as client:
        assert (await client.get("/api/portal/quotations/page?q=Q-204")).json()["total"] == 1
        for search in [".*", "Q-FOREIGN"]:
            response = await client.get("/api/portal/quotations/page", params={"q": search})
            assert response.json() == {"items": [], "total": 0, "has_more": False}
        for params in [{"limit": 51}, {"skip": -1}, {"q": "x" * 121}]:
            assert (await client.get("/api/portal/quotations/page", params=params)).status_code == 422
    assert source.bounds == [20, 20, 20]
