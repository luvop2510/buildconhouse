"""A browser download must stay inside the business unit it was started from.

`?dl=` downloads (quotation PDFs, chalans, .xlsx exports) are plain browser
navigations, so they structurally cannot carry `X-Floor-Id`. That left
`user.active_floor_id` unset on exactly those requests, and for an all-floors
owner/manager an unset active floor makes `floor_query()` unrestricted — so a
download URL resolved against every unit's records rather than the one the user
was working in. It is the only in-product request path where the floor header is
absent by construction.

The floor is now recorded when the token is minted and replayed when it is
consumed, mirroring how `session_id` is already carried through.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import auth
import services.download_tokens as download_tokens


class _FakeTokens:
    def __init__(self):
        self.stored: dict | None = None

    async def insert_one(self, doc):
        self.stored = doc

    async def find_one_and_update(self, query, update):
        return self.stored


class _Db:
    def __init__(self, tokens):
        self.download_tokens = tokens


def test_mint_records_the_active_floor(monkeypatch):
    tokens = _FakeTokens()
    monkeypatch.setattr(download_tokens, "db", _Db(tokens))

    asyncio.run(download_tokens.create_download_token("u1", "s1", "ground-floor", "/api/quotations/q1/pdf"))

    assert tokens.stored["floor_id"] == "ground-floor"
    assert tokens.stored["session_id"] == "s1"
    assert tokens.stored["target"] == "/api/quotations/q1/pdf"
    assert tokens.stored["kind"] == "staff"


def test_customer_mint_records_customer_kind_without_staff_floor(monkeypatch):
    tokens = _FakeTokens()
    monkeypatch.setattr(download_tokens, "db", _Db(tokens))

    asyncio.run(download_tokens.create_download_token(
        "customer-1", "customer-session", None,
        "/api/quotations/q1/portal-pdf", kind="customer",
    ))

    assert tokens.stored["kind"] == "customer"
    assert tokens.stored["floor_id"] is None
    assert tokens.stored["session_id"] == "customer-session"
    assert tokens.stored["target"] == "/api/quotations/q1/portal-pdf"


def _request(path="/api/quotations/q1/pdf?dl=tok"):
    raw_path, _, raw_query = path.partition("?")
    return Request({"type": "http", "method": "GET", "path": raw_path, "query_string": raw_query.encode(), "headers": []})


def _consume(monkeypatch, *, record: dict, user_doc: dict, header_floor=None):
    async def fake_consume(_token, *, target=None):
        assert target == "/api/quotations/q1/pdf"
        return record

    async def fake_principal(_payload, kind=None, collection=None):
        return user_doc

    monkeypatch.setattr(download_tokens, "consume_download_token", fake_consume)
    monkeypatch.setattr(auth, "_load_active_principal", fake_principal)
    return asyncio.run(auth.get_current_user(
        request=_request(), authorization=None, x_floor_id=header_floor, dl="tok",
    ))


OWNER = {
    "id": "u1", "email": "owner@forge.app", "full_name": "Owner",
    "role": "owner", "floor_ids": ["ground-floor", "first-floor"],
}


def test_recorded_floor_is_replayed_when_no_header_is_present(monkeypatch):
    user = _consume(
        monkeypatch,
        record={"user_id": "u1", "session_id": "s1", "floor_id": "ground-floor"},
        user_doc=dict(OWNER),
    )
    assert user.active_floor_id == "ground-floor"


def test_an_explicit_header_still_wins(monkeypatch):
    """A fetch()-based download can send the header; it should be authoritative."""
    user = _consume(
        monkeypatch,
        record={"user_id": "u1", "session_id": "s1", "floor_id": "ground-floor"},
        user_doc=dict(OWNER),
        header_floor="first-floor",
    )
    assert user.active_floor_id == "first-floor"


def test_a_floor_the_caller_cannot_access_is_refused(monkeypatch):
    restricted = {**OWNER, "role": "sales", "floor_ids": ["first-floor"]}
    with pytest.raises(HTTPException) as exc:
        _consume(
            monkeypatch,
            record={"user_id": "u1", "session_id": "s1", "floor_id": "ground-floor"},
            user_doc=restricted,
        )
    assert exc.value.status_code == 403


def test_a_legacy_token_without_a_floor_still_works(monkeypatch):
    """Tokens minted before this change have no floor_id and are only valid for
    60 seconds, but they must not 401 during the rollover."""
    user = _consume(
        monkeypatch,
        record={"user_id": "u1", "session_id": "s1"},
        user_doc=dict(OWNER),
    )
    assert user.active_floor_id is None


def test_customer_download_token_replays_customer_session(monkeypatch):
    async def fake_consume(_token, *, target=None):
        assert target == "/api/quotations/q1/portal-pdf"
        return {"kind": "customer", "user_id": "customer-1", "session_id": "customer-session"}

    async def fake_principal(payload, *, kind, collection):
        assert payload == {"sub": "customer-1", "session_id": "customer-session"}
        assert (kind, collection) == ("customer", "customers")
        return {"id": "customer-1", "name": "Customer", "floor_id": "first-floor"}

    monkeypatch.setattr(download_tokens, "consume_download_token", fake_consume)
    monkeypatch.setattr(auth, "_load_active_principal", fake_principal)
    customer = asyncio.run(auth.get_current_customer(
        request=_request("/api/quotations/q1/portal-pdf?dl=tok"), authorization=None, dl="tok",
    ))
    assert customer.id == "customer-1"


def test_staff_token_cannot_authenticate_customer_pdf(monkeypatch):
    async def fake_consume(_token, *, target=None):
        return {"kind": "staff", "user_id": "staff-1", "session_id": "staff-session"}

    monkeypatch.setattr(download_tokens, "consume_download_token", fake_consume)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(auth.get_current_customer(
            request=_request("/api/quotations/q1/portal-pdf?dl=tok"), authorization=None, dl="tok",
        ))
    assert exc.value.status_code == 401
