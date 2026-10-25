"""Regression coverage for the quotation builder's structured partner picker."""
from __future__ import annotations

import asyncio

from models import QuotationUpdate, UserPublic
from routes import quotation_routes


class _Quotations:
    def __init__(self, document: dict):
        self.document = document
        self.last_update: dict | None = None

    async def update_one(self, query, update):
        assert query == {"id": self.document["id"]}
        self.last_update = update["$set"]
        self.document.update(update["$set"])

    async def find_one(self, query, *_args):
        assert query == {"id": self.document["id"]}
        return dict(self.document)


def _user() -> UserPublic:
    return UserPublic(id="u1", email="sales@example.com", full_name="Sales", role="sales", floor_ids=["third-floor"], active_floor_id="third-floor")


def _quote() -> dict:
    return {
        "id": "q1", "floor_id": "third-floor", "number": "FQ-1", "customer_id": "c1",
        "customer_name": "Customer", "created_by": "u1", "created_by_name": "Sales",
        "created_at": "2026-01-01T00:00:00+00:00", "updated_at": "2026-01-01T00:00:00+00:00",
        "status": "draft", "items": [],
    }


def test_builder_referrer_assignment_resolves_and_persists_directory_fields(monkeypatch):
    quote = _quote()
    quotations = _Quotations(quote)
    monkeypatch.setattr(quotation_routes, "db", type("Db", (), {"quotations": quotations, "referrers": object()})())

    async def scoped(collection, record_id, *_args, **_kwargs):
        if record_id == "q1":
            return quote
        assert record_id == "r1"
        return {"id": "r1", "name": "Aster Architects", "type": "architect", "active": True, "floor_id": "third-floor"}

    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", scoped)
    async def partner(_database, record_id, _user):
        return await scoped(None, record_id)
    monkeypatch.setattr(quotation_routes, "resolve_referrer", partner)

    result = asyncio.run(quotation_routes.update_quotation("q1", QuotationUpdate(referrer_id="r1", silent=True), user=_user()))

    assert quotations.last_update is not None
    assert quotations.last_update["referrer_id"] == "r1"
    assert quotations.last_update["referrer_name"] == "Aster Architects"
    assert quotations.last_update["referrer_type"] == "architect"
    assert result.referrer_id == "r1"


def test_builder_referrer_clear_removes_all_attribution_fields(monkeypatch):
    quote = {**_quote(), "referrer_id": "r1", "referrer_name": "Aster Architects", "referrer_type": "architect"}
    quotations = _Quotations(quote)
    monkeypatch.setattr(quotation_routes, "db", type("Db", (), {"quotations": quotations})())

    async def scoped(_collection, record_id, *_args, **_kwargs):
        assert record_id == "q1"
        return quote

    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", scoped)
    result = asyncio.run(quotation_routes.update_quotation("q1", QuotationUpdate(referrer_id="", silent=True), user=_user()))

    assert quotations.last_update is not None
    assert {key: quotations.last_update[key] for key in ("referrer_id", "referrer_name", "referrer_type")} == {
        "referrer_id": None, "referrer_name": None, "referrer_type": None,
    }
    assert result.referrer_id is None
