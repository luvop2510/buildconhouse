"""Interest labels cannot widen operational floor/customer/staff access."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from models import UserPublic
from services import walkin_interests


class Cursor:
    def __init__(self, rows):
        self.rows = rows
    def sort(self, _):
        return self
    def limit(self, count):
        self.rows = self.rows[:count]
        return self
    async def to_list(self, count):
        return self.rows[:count]


class Floors:
    def find(self, selector, projection):
        assert set(projection) <= {"_id", "id", "name"}
        assert selector.get("active") == {"$ne": False}
        rows = [{"id": "ground-floor", "name": "Tiles"}, {"id": "second-floor", "name": "Kitchen"}, {"id": "future-floor", "name": "Future showroom"}]
        if "id" in selector:
            rows = [row for row in rows if row["id"] in selector["id"]["$in"]]
        return Cursor(rows)


def principal(**patch):
    return UserPublic(**{"id": "ground-staff", "full_name": "Ground employee", "role": "sales", "floor_ids": ["ground-floor"], "active_floor_id": "ground-floor", **patch})


@pytest.mark.asyncio
async def test_all_active_interests_are_retained_but_only_source_can_route():
    database = SimpleNamespace(floors=Floors())  # Any customer/staff access fails.
    user = principal()
    selected = ["ground-floor", "second-floor", "future-floor", "second-floor"]
    interests, routed = await walkin_interests.plan(database, user, selected, "ground-floor")
    assert interests == ["ground-floor", "second-floor", "future-floor"]
    assert routed == ["ground-floor"]
    assert user.floor_ids == ["ground-floor"] and user.active_floor_id == "ground-floor"
    assert await walkin_interests.floor_options(database) == [
        {"id": "ground-floor", "name": "Tiles"}, {"id": "second-floor", "name": "Kitchen"}, {"id": "future-floor", "name": "Future showroom"}]


@pytest.mark.asyncio
async def test_foreign_assignment_and_invalid_floor_fail_before_staff_or_customer_reads():
    database = SimpleNamespace(floors=Floors())
    for floors, assignment, status in ((["second-floor"], [{"floor_id": "second-floor", "user_id": "secret-worker"}], 403),
                                        (["deleted-floor"], [], 422), ([], [], 422)):
        with pytest.raises(HTTPException) as error:
            await walkin_interests.plan(database, principal(), floors, "ground-floor", assignment)
        assert error.value.status_code == status


@pytest.mark.asyncio
async def test_owner_routing_preserves_existing_multifloor_flow_and_local_origin():
    interests, routed = await walkin_interests.plan(SimpleNamespace(floors=Floors()), principal(role="owner"), ["second-floor", "future-floor"], "ground-floor")
    assert interests == ["second-floor", "future-floor"]
    assert routed == ["ground-floor", "second-floor", "future-floor"]


@pytest.mark.asyncio
async def test_custom_walkin_create_is_required_for_metadata_picker(monkeypatch):
    query = AsyncMock(return_value=[])
    monkeypatch.setattr(walkin_interests, "grants_for_user", query)
    with pytest.raises(HTTPException) as error:
        await walkin_interests.require_intake(SimpleNamespace(), principal(custom_access=True), "ground-floor")
    assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_custom_floor_assignment_does_not_imply_foreign_routing(monkeypatch):
    from services.access_grants import build_grant
    user = principal(custom_access=True, floor_ids=["ground-floor", "second-floor"])
    grant = build_grant(user_id=user.id, resource="walkins", actions=["view", "create", "update"], floor_id="second-floor", expires_at=None, actor_id="owner", actor_name="Owner")
    monkeypatch.setattr(walkin_interests, "grants_for_user", AsyncMock(return_value=[grant]))
    _, routed = await walkin_interests.plan(SimpleNamespace(floors=Floors()), user, ["ground-floor", "second-floor"], "ground-floor")
    assert routed == ["ground-floor"], "Walk-in module access is not permission to create a foreign follow-up"
