"""Regression test: fetching/updating a customer by ID must not 404 just
because the caller's ambient active-floor header doesn't match the
customer's floor (e.g. a tiles-builder save while the global floor
switcher is still on the sanitary floor)."""
from __future__ import annotations

import asyncio

from models import UserPublic
import routes.customer_routes as customer_routes


def _user(active_floor_id: str = "first-floor") -> UserPublic:
    return UserPublic(
        email="sales@forge.app", full_name="Sales", role="sales",
        floor_ids=["ground-floor", "first-floor"], active_floor_id=active_floor_id,
    )


class _FakeCustomers:
    def __init__(self, doc: dict):
        self._doc = dict(doc)  # Make a mutable copy
        self.updated_with: dict | None = None

    async def find_one(self, query, projection=None, session=None):
        # Verify the filter is just {"id": ...}, not floor-scoped.
        # Strict assertion ensures no code ever uses floor_query() on already-authorized documents.
        assert query == {"id": self._doc["id"]}, \
            f"find_one must use bare {{'id': '{self._doc['id']}'}} filter, got {query}"
        return self._doc

    async def update_one(self, query, update, session=None):
        # Verify the filter is just {"id": ...}, not floor-scoped
        assert query == {"id": self._doc["id"]}, f"Expected {{'id': '{self._doc['id']}'}}, got {query}"
        self.updated_with = update
        # Apply the update to simulate real Mongo behavior
        if "$set" in update:
            self._doc.update(update["$set"])
        return {"matched_count": 1, "modified_count": 1}


class _EmptyLeads:
    async def find_one(self, *_args, **_kwargs):
        return None


class _FakeDb:
    def __init__(self, doc: dict):
        self.customers = _FakeCustomers(doc)
        self.followups = _EmptyLeads()
        self.walkins = _EmptyLeads()


def test_get_customer_ignores_ambient_floor_mismatch(monkeypatch):
    doc = {"id": "c1", "floor_id": "ground-floor", "name": "JK"}
    monkeypatch.setattr(customer_routes, "db", _FakeDb(doc))

    result = asyncio.run(customer_routes.get_customer("c1", user=_user(active_floor_id="first-floor")))

    assert result.id == "c1"


def test_update_customer_works_cross_floor(monkeypatch):
    """Regression: update_customer must use bare {"id": ...} filter for both
    update_one and find_one (trailing re-fetch), not floor_query().

    When ambient floor mismatch occurs (e.g. editing ground-floor customer while
    active_floor is first-floor), using floor_query causes:
    1. update_one to silently match zero documents (Mongo doesn't raise on 0-match)
    2. find_one to return None (due to floor filter not matching)
    3. CustomerPublic(**None) to raise TypeError 500

    The fake's strict assertions on both update_one and find_one ensure this
    regression is caught immediately if anyone reverts to floor_query."""
    from models import CustomerUpdatePayload
    doc = {"id": "c1", "floor_id": "ground-floor", "name": "JK", "portal_enabled": False}
    monkeypatch.setattr(customer_routes, "db", _FakeDb(doc))
    monkeypatch.setattr(customer_routes, "log_event", lambda **_kw: asyncio.sleep(0))

    # Call update_customer with a customer on a different floor (ground-floor)
    # but with a user whose ambient active floor is first-floor (mismatch scenario)
    result = asyncio.run(customer_routes.update_customer(
        "c1", CustomerUpdatePayload(name="JK Updated"), user=_user(active_floor_id="first-floor"),
    ))

    # Verify the update succeeded and returned a valid Customer
    assert result.id == "c1"
    assert result.floor_id == "ground-floor"
    assert result.name == "JK Updated"  # Verify the patch was actually applied

    # Verify update_one was called with bare {"id": ...} filter
    # (the assertion inside update_one checks this; if floor_query were used, it would fail)
    assert customer_routes.db.customers.updated_with["$set"]["name"] == "JK Updated"
