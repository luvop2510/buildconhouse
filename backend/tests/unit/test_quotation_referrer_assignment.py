"""Regression coverage for the quotation builder's structured partner picker."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

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


def _customer_snapshot_route(monkeypatch, attribution):
    quote = {**_quote(), "floor_id": "ground-floor", "doc_type": "tiles_quotation",
             "address_snapshot": "Recorded site", **attribution}
    customer = {"id": "c1", "name": "Corrected customer", "phone": "9000000001",
                "referrer_id": "customer-referrer", "referrer_name": "Customer architect", "referrer_type": "architect"}
    quotations = _Quotations(quote)
    monkeypatch.setattr(quotation_routes, "db", type("Db", (), {"quotations": quotations, "customers": object()})())

    async def scoped(_collection, record_id, *_args, **_kwargs):
        return quote if record_id == "q1" else {**customer, "id": record_id}

    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", scoped)
    return quotations, customer, _user().model_copy(update={"floor_ids": ["ground-floor"], "active_floor_id": "ground-floor"})


@pytest.mark.parametrize("doc_type", ["tiles_selection", "tiles_quotation"])
@pytest.mark.parametrize("attribution", [
    {"referrer_id": "explicit-interior", "referrer_name": "Selected interior", "referrer_type": "interior_designer"},
    {"referrer_id": "archived-architect", "referrer_name": "Historical architect", "referrer_type": "architect"},
    {"referrer_id": None, "referrer_name": "Legacy free text reference", "referrer_type": None},
])
def test_same_customer_tile_snapshot_refresh_preserves_document_referral(monkeypatch, doc_type, attribution):
    quotations, _, user = _customer_snapshot_route(monkeypatch, attribution)
    quotations.document["doc_type"] = doc_type

    async def unexpected_resolution(*_args):
        raise AssertionError("Unchanged historical attribution must not require an active directory entry")

    monkeypatch.setattr(quotation_routes, "resolve_referrer", unexpected_resolution)
    result = asyncio.run(quotation_routes.update_quotation("q1", QuotationUpdate(customer_id="c1", silent=True), user=user))

    assert result.customer_name == "Corrected customer"
    assert result.phone_snapshot == "9000000001"
    assert all(getattr(result, field) == value for field, value in attribution.items())
    assert not any(field in quotations.last_update for field in attribution)


@pytest.mark.parametrize("customer_has_referrer", [True, False])
def test_changed_customer_tile_snapshot_inherits_new_customer_referral(monkeypatch, customer_has_referrer):
    quotations, customer, user = _customer_snapshot_route(monkeypatch, {
        "referrer_id": "previous-document-reference", "referrer_name": "Previous partner", "referrer_type": "interior_designer"})
    if not customer_has_referrer:
        customer.update(referrer_id=None, referrer_name=None, referrer_type=None)
    result = asyncio.run(quotation_routes.update_quotation("q1", QuotationUpdate(customer_id="c2", silent=True), user=user))

    assert result.customer_id == "c2"
    assert result.customer_name == "Corrected customer" and result.phone_snapshot == "9000000001"
    assert {field: getattr(result, field) for field in ("referrer_id", "referrer_name", "referrer_type")} == {
        field: customer[field] for field in ("referrer_id", "referrer_name", "referrer_type")}
    assert quotations.last_update["customer_id"] == "c2"


def test_same_customer_refresh_still_validates_explicit_archived_reference(monkeypatch):
    quotations, _, user = _customer_snapshot_route(monkeypatch, {})

    async def archived(_database, referrer_id, _user):
        return {"id": referrer_id, "name": "Archived architect", "type": "architect", "active": False}

    monkeypatch.setattr(quotation_routes, "resolve_referrer", archived)
    with pytest.raises(HTTPException) as rejected:
        asyncio.run(quotation_routes.update_quotation("q1", QuotationUpdate(customer_id="c1", referrer_id="archived", silent=True), user=user))
    assert rejected.value.status_code == 400
    assert quotations.last_update is None


def test_explicit_tile_partner_survives_following_customer_snapshot_refresh(monkeypatch):
    _, _, user = _customer_snapshot_route(monkeypatch, {})
    resolutions = []

    async def selected(_database, referrer_id, _user):
        resolutions.append(referrer_id)
        return {"id": referrer_id, "name": "Chosen studio", "type": "interior_designer", "active": True}

    monkeypatch.setattr(quotation_routes, "resolve_referrer", selected)
    saved = asyncio.run(quotation_routes.update_quotation("q1", QuotationUpdate(customer_id="c1", referrer_id="selected-studio", silent=True), user=user))
    assert saved.referrer_type == "interior_designer"
    refreshed = asyncio.run(quotation_routes.update_quotation("q1", QuotationUpdate(customer_id="c1", address_snapshot="Corrected site", silent=True), user=user))
    assert refreshed.referrer_id == "selected-studio" and refreshed.referrer_name == "Chosen studio"
    assert refreshed.address_snapshot == "Corrected site"
    assert resolutions == ["selected-studio"]
