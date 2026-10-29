"""A repeat walk-in's required address must remain available to document lookup."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from models import UserPublic
from models_walkins import WalkInCreate
from routes import walkin_routes
from services import duplicate_detection


def install(monkeypatch):
    customer = {"id": "person", "name": "Visitor", "phone": "9876543210", "floor_id": "ground-floor",
                "address": "Old address", "email": "existing@example.test", "alternate_phone": "9000000000"}
    updates = []

    async def find_customer(query, *_args):
        return dict(customer) if all(customer.get(key) == value for key, value in query.items()) else None

    async def update_customer(query, patch):
        assert query == {"id": "person", "floor_id": "ground-floor"}
        updates.append(patch["$set"])
        customer.update(patch["$set"])

    db = SimpleNamespace(
        floors=SimpleNamespace(find_one=AsyncMock(return_value={"id": "ground-floor"})),
        customers=SimpleNamespace(find_one=AsyncMock(side_effect=find_customer), update_one=AsyncMock(side_effect=update_customer)),
        walkins=SimpleNamespace(insert_one=AsyncMock()),
    )
    matches = AsyncMock(side_effect=lambda **_kwargs: {"high": [dict(customer)], "medium": [], "low": []})
    log = AsyncMock()
    monkeypatch.setattr(walkin_routes, "db", db)
    monkeypatch.setattr(walkin_routes, "_salesperson_for_floor", AsyncMock(return_value={"full_name": "Worker"}))
    monkeypatch.setattr(walkin_routes, "_next_walkin_number", AsyncMock(return_value="WI-ADDRESS"))
    monkeypatch.setattr(walkin_routes, "log_event", log)
    monkeypatch.setattr(walkin_routes, "reconcile_followups_admitted", AsyncMock())
    monkeypatch.setattr(duplicate_detection, "find_customer_matches", matches)
    return customer, updates, db, matches, log


def user():
    return UserPublic(id="staff", email="staff@example.test", full_name="Staff", role="sales",
                      floor_ids=["ground-floor"], active_floor_id="ground-floor")


def body(**changes):
    return WalkInCreate(**{"customer_name": "Visitor", "customer_phone": "9876543210", "floor_id": "ground-floor",
                           "salesperson_id": "worker", "address": "  12 New Walk-in Road  ", **changes})


@pytest.mark.parametrize("explicit", [True, False])
def test_repeat_walkin_preserves_entered_address_for_exact_customer_and_audits_change(monkeypatch, explicit):
    customer, updates, db, matches, log = install(monkeypatch)
    original = dict(customer)
    result = asyncio.run(walkin_routes.create_walkin(body(use_existing_customer_id="person" if explicit else None), user()))
    assert result.customer_id == "person"
    assert customer["address"] == "12 New Walk-in Road"
    assert len(updates) == 1
    assert set(updates[0]) == {"address", "updated_at"}
    assert all(customer[key] == original[key] for key in ("name", "phone", "email", "alternate_phone", "floor_id"))
    assert db.walkins.insert_one.await_count == 1
    if explicit:
        matches.assert_not_awaited()
    else:
        assert matches.call_args.kwargs["floor_ids"] == ["ground-floor"]
    audit = next(call.kwargs for call in log.await_args_list if call.kwargs["event_type"] == "customer.updated")
    assert audit["floor_id"] == "ground-floor"
    assert audit["payload"] == {"before": {"address": "Old address"}, "after": {"address": "12 New Walk-in Road"}, "walkin_id": result.id}


@pytest.mark.parametrize("address", [None, "", "   ", "Old address"])
def test_legacy_blank_or_unchanged_address_does_not_overwrite_customer(monkeypatch, address):
    customer, updates, _db, _matches, log = install(monkeypatch)
    asyncio.run(walkin_routes.create_walkin(body(address=address, use_existing_customer_id="person"), user()))
    assert customer["address"] == "Old address"
    assert updates == []
    assert [call.kwargs["event_type"] for call in log.await_args_list] == ["walkin.created"]


def test_foreign_floor_is_rejected_before_customer_profile_writes(monkeypatch):
    _customer, updates, db, _matches, _log = install(monkeypatch)
    with pytest.raises(HTTPException) as error:
        asyncio.run(walkin_routes.create_walkin(body(floor_id="first-floor", use_existing_customer_id="person"), user()))
    assert error.value.status_code == 403
    db.customers.find_one.assert_not_awaited()
    db.walkins.insert_one.assert_not_awaited()
    assert updates == []


def test_explicit_foreign_customer_is_not_updated_through_authorized_floor(monkeypatch):
    customer, updates, db, _matches, _log = install(monkeypatch)
    customer["floor_id"] = "first-floor"
    with pytest.raises(HTTPException) as error:
        asyncio.run(walkin_routes.create_walkin(body(use_existing_customer_id="person"), user()))
    assert error.value.status_code == 404
    assert updates == []
    db.walkins.insert_one.assert_not_awaited()


def test_scope_admission_failure_leaves_address_and_walkin_unchanged(monkeypatch):
    customer, updates, db, _matches, _log = install(monkeypatch)
    monkeypatch.setattr(walkin_routes.lead_scope, "validate_scope", AsyncMock())
    scope = AsyncMock(side_effect=HTTPException(status_code=422, detail="Choose eligible floor workers"))
    monkeypatch.setattr(walkin_routes, "_walkin_scope", scope)
    with pytest.raises(HTTPException):
        asyncio.run(walkin_routes.create_walkin(body(use_existing_customer_id="person", interested_floor_ids=["ground-floor"]), user()))
    assert scope.call_args.kwargs["dry_run"] is True
    assert updates == []
    assert customer["address"] == "Old address"
    db.walkins.insert_one.assert_not_awaited()


def test_address_and_existing_referrer_update_share_one_exact_profile_write(monkeypatch):
    _customer, updates, _db, _matches, _log = install(monkeypatch)
    referrer = {"referrer_id": "architect", "referrer_name": "Architect", "referrer_type": "architect"}
    monkeypatch.setattr(walkin_routes.lead_scope, "referrer_fields", AsyncMock(return_value=referrer))
    asyncio.run(walkin_routes.create_walkin(body(use_existing_customer_id="person", referrer_id="architect"), user()))
    assert len(updates) == 1
    assert all(updates[0][key] == value for key, value in referrer.items())
    assert updates[0]["address"] == "12 New Walk-in Road"
