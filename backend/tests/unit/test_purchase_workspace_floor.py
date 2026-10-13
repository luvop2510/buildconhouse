import asyncio

import pytest

from auth import floor_query, floor_scope_ids
from models import UserPublic
from services.purchase_workspace import get_purchase_workspace_user


FLOORS = ["first-floor", "ground-floor", "second-floor", "third-floor"]


@pytest.mark.parametrize("floor", FLOORS)
def test_selected_purchase_floor_excludes_every_other_floor(floor):
    user = UserPublic(email="staff@example.test", full_name="Staff", role="sales",
                      floor_ids=FLOORS, active_floor_id=floor)
    scoped = asyncio.run(get_purchase_workspace_user(user))
    assert floor_scope_ids(scoped) == [floor]
    assert floor_query(scoped, {"status": "ordered"}) == {
        "$and": [{"floor_id": {"$in": [floor]}}, {"status": "ordered"}],
    }


def test_missing_header_does_not_combine_assigned_purchase_floors():
    user = UserPublic(email="staff@example.test", full_name="Staff", role="sales",
                      floor_ids=["second-floor", "third-floor"])
    scoped = asyncio.run(get_purchase_workspace_user(user))
    assert scoped is not user
    assert user.active_floor_id is None
    assert floor_scope_ids(scoped) == ["second-floor"]


def test_owner_without_header_still_has_one_default_purchase_floor():
    user = UserPublic(email="owner@example.test", full_name="Owner", role="owner")
    assert floor_scope_ids(asyncio.run(get_purchase_workspace_user(user))) == ["first-floor"]


def test_purchase_scope_preserves_deny_all_and_custom_grants():
    user = UserPublic(email="staff@example.test", full_name="Staff", role="sales", floor_ids=FLOORS)
    object.__setattr__(user, "_custom_grant_floor_ids", ["third-floor"])
    scoped = asyncio.run(get_purchase_workspace_user(user))
    assert floor_scope_ids(scoped) == ["third-floor"]
    object.__setattr__(user, "_custom_grant_floor_ids", [])
    assert floor_scope_ids(asyncio.run(get_purchase_workspace_user(user))) == []
