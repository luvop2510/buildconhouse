"""Move to Quotation: promotes an approved Tiles Selection into the
Quotation stage. Metadata-only — doc_type flips, status resets to draft,
`items` untouched (everything already filled in at Selection carries over
automatically; fields Selection never collects stay absent/open). Also
covers the new Confirmed-status gate on place_order_preview — the same gate
in place_order_confirm runs inside a real Mongo transaction
(client.start_session()), which isn't worth faking here; it's verified live
in Task 12 instead, since it's the exact same can_place_order() call on the
exact same doc shape."""
from __future__ import annotations

import asyncio

import pytest

from fastapi import HTTPException
from models import UserPublic
import routes.quotation_routes as quotation_routes
import services.walkin_service as walkin_service


def _user() -> UserPublic:
    return UserPublic(
        email="sales@forge.app", full_name="Sales Rep", role="sales",
        floor_ids=["ground-floor"], active_floor_id="ground-floor",
    )


class _Recorder:
    def __init__(self, doc: dict | None):
        self._doc = doc
        self.updates: list[dict] = []

    async def find_one(self, query, *_args, **_kwargs):
        if self._doc is None:
            return None
        # Support both {"id": ...} lookups (get_floor_scoped_or_404) and the
        # post-update re-fetch in the same shape this codebase uses elsewhere.
        return dict(self._doc)

    async def update_one(self, _query, update, **_kwargs):
        self.updates.append(update)
        if "$set" in update:
            self._doc.update(update["$set"])

    async def update_many(self, _query, update, **_kwargs):
        self.updates.append(update)
        return type("_Res", (), {"modified_count": 0})()


class _FakeDb:
    def __init__(self, doc: dict | None):
        self.quotations = _Recorder(doc)
        self.products = object()
        # services/walkin_service.on_moved_to_quotation touches these.
        self.walkins = _Recorder(None)
        self.activity_events = _Recorder(None)


async def _noop_reconcile(*_a, **_kw):
    return None


def _selection_doc(status: str = "approved") -> dict:
    return {
        "id": "q-1", "number": "FQ-2026-0100", "doc_type": "tiles_selection",
        "status": status, "floor_id": "ground-floor", "customer_id": "cust-1",
        "items": [{"id": "line-1", "product_id": "prod-1", "sku": "SKU-1", "name": "Tile A", "room": "Living", "qty": 1, "unit_price": 0}],
    }


@pytest.mark.parametrize("status", ["draft", "pending_approval", "approved", "sent", "won"])
def test_move_to_quotation_flips_doc_type_and_resets_status(monkeypatch, status):
    fake_db = _FakeDb(_selection_doc(status))
    monkeypatch.setattr(quotation_routes, "db", fake_db)
    # walkin_service holds its own module-level `db`, so the success path
    # reached the real motor client (bound to an already-closed loop under
    # `asyncio.run`). Same gotcha as services/sequence.py elsewhere.
    monkeypatch.setattr(walkin_service, "db", fake_db)
    monkeypatch.setattr(quotation_routes, "reconcile_followups_admitted", _noop_reconcile)

    result = asyncio.run(quotation_routes.move_to_quotation("q-1", user=_user()))

    assert result["doc_type"] == "tiles_quotation"
    assert result["status"] == "draft"
    # Promotion is metadata-only — items carried over byte-for-byte, nothing transformed.
    assert result["items"] == _selection_doc("approved")["items"]


def test_move_to_quotation_rejects_when_not_a_selection(monkeypatch):
    doc = _selection_doc("approved")
    doc["doc_type"] = "tiles_quotation"
    fake_db = _FakeDb(doc)
    monkeypatch.setattr(quotation_routes, "db", fake_db)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(quotation_routes.move_to_quotation("q-1", user=_user()))
    assert exc.value.status_code == 400


def test_move_to_quotation_rejects_closed_selection(monkeypatch):
    fake_db = _FakeDb(_selection_doc("ordered"))
    monkeypatch.setattr(quotation_routes, "db", fake_db)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(quotation_routes.move_to_quotation("q-1", user=_user()))
    assert exc.value.status_code == 400


@pytest.mark.parametrize("status", ["draft", "pending_approval", "approved", "sent", "won"])
def test_place_order_preview_allows_editable_tiles_quotation(monkeypatch, status):
    doc = {**_selection_doc(status), "doc_type": "tiles_quotation", "address_snapshot": "12 Site Road"}
    fake_db = _FakeDb(doc)
    monkeypatch.setattr(quotation_routes, "db", fake_db)
    async def preview(document):
        return {"quotation_id": document["id"], "brands": []}
    async def prices(*args, **kwargs):
        return {"changes": []}
    monkeypatch.setattr(quotation_routes, "_brand_grouped_preview", preview)
    monkeypatch.setattr(quotation_routes, "price_review", prices)
    result = asyncio.run(quotation_routes.place_order_preview("q-1", user=_user()))
    assert result["quotation_id"] == "q-1"


def test_place_order_preview_allows_confirmed_tiles_quotation(monkeypatch):
    doc = {
        "id": "q-3", "number": "FQ-2026-0102", "doc_type": "tiles_quotation",
        "status": "approved", "floor_id": "ground-floor", "customer_id": "cust-1",
        "items": [],
    }
    fake_db = _FakeDb(doc)
    monkeypatch.setattr(quotation_routes, "db", fake_db)

    # Empty items still 400s (pre-existing "no items" guard) — proves we
    # reached PAST the new confirmed-status check, not that everything passes.
    with pytest.raises(HTTPException) as exc:
        asyncio.run(quotation_routes.place_order_preview("q-3", user=_user()))
    assert "no items" in exc.value.detail.lower()
