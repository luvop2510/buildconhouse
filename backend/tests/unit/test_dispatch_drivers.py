from __future__ import annotations

import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, Response
from pydantic import ValidationError

from models import UserPublic
from routes import tile_orders
from services.dispatch_drivers import DriverSnapshotFields, normalize_driver_mobile, save_dispatch_driver, search_dispatch_drivers


class Profiles:
    def __init__(self):
        self.docs = {}
        self.calls = []

    async def update_one(self, query, update, **kwargs):
        self.calls.append((query, update, kwargs))
        self.docs.setdefault(query["_id"], deepcopy(update.get("$setOnInsert", {}))).update(deepcopy(update["$set"]))


@pytest.mark.parametrize("raw", ["9876543210", "+91 98765-43210", "09876543210", "(98765) 43210"])
def test_mobile_normalization(raw):
    assert normalize_driver_mobile(raw) == "9876543210"


@pytest.mark.parametrize("raw", ["123", "987654321O", "9876543210 ext 9", "+1 9876543210"])
def test_invalid_mobiles_are_rejected(raw):
    with pytest.raises(ValueError):
        DriverSnapshotFields(driver_name="Ramesh", driver_mobile=raw)


def test_name_is_required_to_save_mobile():
    with pytest.raises(ValidationError):
        DriverSnapshotFields(driver_mobile="9876543210")


def test_reuse_updates_one_profile_and_keeps_history_and_trip_fields_separate():
    profiles = Profiles()
    database = SimpleNamespace(dispatch_drivers=profiles)
    session = object()
    history = {"driver_name": "Ramesh", "driver_mobile": "9876543210", "vehicle_number": "GJ-01-1000"}

    async def scenario():
        first = tile_orders.SimpleDispatchBody(items=[{"po_item_id": "i", "qty": 1}], **history,
            receiver_name="Site One", destination_address="Trip address", reference_number="LR-1", labor_cost=400)
        await save_dispatch_driver(database, first, floor_id="ground-floor", actor_id="u", session=session)
        second = DriverSnapshotFields(driver_name="Rameshbhai", driver_mobile="+91 9876543210", vehicle_number="GJ-01-2000")
        await save_dispatch_driver(database, second, floor_id="ground-floor", actor_id="u", session=session)

    asyncio.run(scenario())
    assert len(profiles.docs) == 1
    saved = profiles.docs["ground-floor:9876543210"]
    assert saved["name"] == "Rameshbhai" and saved["vehicle_number"] == "GJ-01-2000"
    assert history["vehicle_number"] == "GJ-01-1000" and history["driver_name"] == "Ramesh"
    assert not set(saved) & {"receiver_name", "destination_address", "reference_number", "labor_cost"}
    assert all(call[2] == {"upsert": True, "session": session} for call in profiles.calls)


def test_unidentified_name_does_not_merge_drivers_or_touch_directory():
    asyncio.run(save_dispatch_driver(None, DriverSnapshotFields(driver_name="Ramesh"), floor_id="ground-floor", actor_id="u", session=None))


def test_directory_search_is_literal_bounded_and_floor_scoped():
    class Cursor:
        async def to_list(self, limit):
            assert limit == 12
            return []

    class Collection:
        def aggregate(self, pipeline):
            assert pipeline[0] == {"$match": {"floor_id": "ground-floor", "$or": [
                {"name": {"$regex": r"Ram\.\*", "$options": "i"}},
                {"vehicle_number": {"$regex": r"Ram\.\*", "$options": "i"}},
            ]}}
            assert pipeline[2:] == [
                {"$sort": {"search_rank": 1, "updated_at": -1, "_id": 1}},
                {"$limit": 12},
                {"$project": {"_id": 0, "name": 1, "mobile": 1, "vehicle_number": 1}},
            ]
            return Cursor()

    asyncio.run(search_dispatch_drivers(SimpleNamespace(dispatch_drivers=Collection()), floor_id="ground-floor", search="Ram.*"))


def test_driver_directory_rejects_other_floor_before_read(monkeypatch):
    query = AsyncMock()
    monkeypatch.setattr(tile_orders, "search_dispatch_drivers", query)
    user = UserPublic(id="u", email="u@example.test", full_name="Warehouse", role="warehouse", floor_ids=["first-floor"])
    with pytest.raises(Exception) as exc:
        asyncio.run(tile_orders.list_saved_drivers(Response(), "Ra", user))
    assert exc.value.status_code == 403
    query.assert_not_awaited()


@pytest.mark.parametrize("path", ["dispatch", "dispatch-from-released", "dispatch-from-godown"])
def test_all_dispatch_entrypoints_reject_bad_driver_before_transaction(monkeypatch, path):
    from auth import get_current_user
    from fastapi.exceptions import RequestValidationError
    from server import safe_request_validation_error

    start = AsyncMock(side_effect=AssertionError("Transaction must not begin"))
    monkeypatch.setattr(tile_orders, "client", SimpleNamespace(start_session=start))
    app = FastAPI()
    app.add_exception_handler(RequestValidationError, safe_request_validation_error)
    app.include_router(tile_orders.router, prefix="/api")
    app.dependency_overrides[get_current_user] = lambda: UserPublic(id="u", email="u@example.test", full_name="Warehouse", role="warehouse", floor_ids=["ground-floor"])
    payload = {"items": [{"po_item_id": "i", "qty": 1}], "driver_name": "Ramesh", "driver_mobile": "123"}
    if path == "dispatch":
        payload.update(destination_type="Customer", destination_name="Site", destination_address="Address", destination_city="City")
    async def request():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local") as client:
            return await client.post(f"/api/tile-orders/purchase-orders/p/{path}", json=payload)
    response = asyncio.run(request())
    assert response.status_code == 422
    start.assert_not_awaited()
