"""GET /quotations gains an optional doc_type filter — backs the new
Quotation Tiles list screen (doc_type=tiles_selection or tiles_quotation).
Omitting it must keep today's "everything the caller's floor scope allows"
behavior."""
from __future__ import annotations

import asyncio

from models import UserPublic
import routes.quotation_routes as quotation_routes
import pytest


def _user() -> UserPublic:
    return UserPublic(
        email="sales@forge.app", full_name="Sales Rep", role="sales",
        floor_ids=["ground-floor"], active_floor_id="ground-floor",
    )


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    def sort(self, *_a, **_kw):
        return self

    def skip(self, *_a, **_kw):
        return self

    def limit(self, value, *_a, **_kw):
        self.limit_value = value
        return self

    async def to_list(self, _n):
        return self._rows


class _Recorder:
    def __init__(self):
        self.last_query = None

    def find(self, query, *_a, **_kw):
        self.last_query = query
        self.cursor = _Cursor([])
        return self.cursor


class _FakeDb:
    def __init__(self):
        self.quotations = _Recorder()


def _flatten(query):
    """Floor scoping wraps the caller's filter as {"$and": [scope, filter]}."""
    flat = {}
    for clause in query.get("$and", [query]):
        flat.update(clause)
    return flat


def test_list_quotations_with_no_filter_unchanged(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(quotation_routes, "db", fake_db)

    asyncio.run(quotation_routes.list_quotations(user=_user()))

    assert "doc_type" not in _flatten(fake_db.quotations.last_query)


def test_list_quotations_filters_by_doc_type(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(quotation_routes, "db", fake_db)

    asyncio.run(quotation_routes.list_quotations(doc_type="tiles_selection", user=_user()))

    assert _flatten(fake_db.quotations.last_query)["doc_type"] == "tiles_selection"


def test_tile_document_listing_is_pinned_to_ground_floor(monkeypatch):
    """A tile doc_type is a Ground Floor request by definition — it must not
    inherit the caller's ambient active floor (that is what surfaced tile
    documents inside The Sanitary Bathroom)."""
    fake_db = _FakeDb()
    monkeypatch.setattr(quotation_routes, "db", fake_db)

    sanitary_user = UserPublic(
        email="owner@forge.app", full_name="Owner", role="owner",
        floor_ids=["ground-floor", "first-floor"], active_floor_id="first-floor",
    )
    asyncio.run(quotation_routes.list_quotations(doc_type="tiles_quotation", user=sanitary_user))

    assert _flatten(fake_db.quotations.last_query)["floor_id"] == "ground-floor"


def test_standard_filter_includes_legacy_quotations_without_doc_type(monkeypatch):
    """`doc_type` postdates the Tiles module: pre-existing quotations have no
    such field, and `{"doc_type": "standard"}` never matches a missing key."""
    fake_db = _FakeDb()
    monkeypatch.setattr(quotation_routes, "db", fake_db)

    asyncio.run(quotation_routes.list_quotations(doc_type="standard", user=_user()))

    assert _flatten(fake_db.quotations.last_query)["doc_type"] == {"$in": ["standard", None]}


def test_list_quotations_separates_pending_and_completed_lifecycle_views(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(quotation_routes, "db", fake_db)

    asyncio.run(quotation_routes.list_quotations(view="pending", user=_user()))
    assert _flatten(fake_db.quotations.last_query)["status"] == {"$in": ["draft", "pending_approval", "sent"]}

    asyncio.run(quotation_routes.list_quotations(view="completed", user=_user()))
    assert _flatten(fake_db.quotations.last_query)["status"] == {"$in": ["approved", "ordered", "won"]}


def test_quotation_list_rejects_negative_skip_and_caps_limit(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(quotation_routes, "db", fake_db)

    with pytest.raises(ValueError):
        asyncio.run(quotation_routes.list_quotations(skip=-1, limit=20, user=_user()))

    asyncio.run(quotation_routes.list_quotations(skip=0, limit=101, user=_user()))
    assert fake_db.quotations.cursor.limit_value == 100
