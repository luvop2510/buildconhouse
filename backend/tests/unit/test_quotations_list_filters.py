"""GET /quotations gains an optional doc_type filter — backs the new
Quotation Tiles list screen (doc_type=tiles_selection or tiles_quotation).
Omitting it must keep today's "everything the caller's floor scope allows"
behavior."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

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


def test_customer_quotation_filter_keeps_floor_and_lifecycle_scope(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(quotation_routes, "db", fake_db)
    asyncio.run(quotation_routes.list_quotations(customer_id="customer-1", view="pending", user=_user()))
    query = _flatten(fake_db.quotations.last_query)
    assert query["customer_id"] == "customer-1"
    assert query["floor_id"] == {"$in": ["ground-floor"]}
    assert query["status"] == {"$in": ["draft", "pending_approval", "sent"]}


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


def test_quotation_list_proves_images_in_one_snapshot_read_per_floor(monkeypatch):
    documents = [
        {"id": "first", "floor_id": "first-floor", "items": [{"product_id": "foreign", "sku": "F", "image": "foreign-snapshot"}]},
        {"id": "second", "floor_id": "first-floor", "items": [{"product_id": "own", "sku": "OWN", "image": "own-snapshot"}]},
        {"id": "third", "floor_id": "ground-floor", "items": [{"product_id": "foreign", "sku": "F"}]},
    ]
    class Quotations:
        def find(self, *args):
            return _Cursor(documents)
    reads = []
    async def snapshot():
        reads.append(True)
        return SimpleNamespace(product_by_id={
            "own": {"id": "own", "floor_id": "first-floor", "sku": "OWN"},
            "foreign": {"id": "foreign", "floor_id": "ground-floor", "sku": "F"},
        }, media_rows_by_product={
            "own": [{"product_id": "own", "public_url": "https://cdn.test/own.png"}],
            "foreign": [{"product_id": "foreign", "public_url": "https://cdn.test/foreign.png"}],
        })
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(quotations=Quotations()))
    monkeypatch.setattr(quotation_routes.catalog_service, "get_catalog_snapshot", snapshot)
    result = asyncio.run(quotation_routes.list_quotations(user=_user()))
    assert [doc["id"] for doc in result] == ["first", "second", "third"]
    assert [doc["items"][0]["image"] for doc in result] == [None, "https://cdn.test/own.png", "https://cdn.test/foreign.png"]
    assert len(reads) == 2  # three quotations, two floor groups, no DB media queries


def test_quotation_status_multi_select_intersects_lifecycle_scope(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(quotation_routes, "db", fake_db)
    asyncio.run(quotation_routes.list_quotations(status="draft,sent,draft", view="pending", user=_user()))
    assert _flatten(fake_db.quotations.last_query)["status"] == {"$in": ["draft", "sent"]}
    asyncio.run(quotation_routes.list_quotations(status="ordered,sent", view="pending", user=_user()))
    assert _flatten(fake_db.quotations.last_query)["status"] == {"$in": ["sent"]}
    asyncio.run(quotation_routes.list_quotations(status="ordered", view="pending", user=_user()))
    assert _flatten(fake_db.quotations.last_query)["status"] == {"$in": []}
    assert _flatten(fake_db.quotations.last_query)["floor_id"] == {"$in": ["ground-floor"]}
