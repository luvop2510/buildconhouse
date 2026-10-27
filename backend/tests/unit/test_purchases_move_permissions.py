"""Regression test for the "can't move products" bug.

`backend/routes/purchases_tracker.py` gated move/bulk-move/transfer behind
`require_min_role("sales")` (rank 40), which silently rejects `warehouse`
(rank 30) even though `ROLE_CAPABILITIES["warehouse"]` documents "Stock
movements" and "Purchase receiving" as exactly what that role is for.

These tests call each route function's own wired-in dependency directly
(the `Depends(...)` default on the `user` parameter), so a regression that
re-tightens the threshold in `purchases_tracker.py` fails here even if
`require_min_role` itself is untouched.
"""
from __future__ import annotations

import asyncio
import inspect

import pytest

from models import UserPublic
from routes import purchases_tracker


def _dependency_for(route_func, param_name="user"):
    depends = inspect.signature(route_func).parameters[param_name].default
    return depends.dependency


def _user(role: str) -> UserPublic:
    return UserPublic(email=f"{role}@forge.app", full_name=role.title(), role=role)


@pytest.mark.parametrize(
    "route_func",
    [
        purchases_tracker.move_item,
        purchases_tracker.bulk_move,
        purchases_tracker.transfer_item_command,
        purchases_tracker.return_replacement_loans,
        purchases_tracker.return_purchase_transfer,
        purchases_tracker.transfer_item,
    ],
)
def test_warehouse_role_is_allowed_to_move_and_transfer_items(route_func):
    dep = _dependency_for(route_func)
    warehouse_user = _user("warehouse")

    result = asyncio.run(dep(user=warehouse_user))

    assert result is warehouse_user


@pytest.mark.parametrize(
    "route_func",
    [
        purchases_tracker.move_item,
        purchases_tracker.bulk_move,
        purchases_tracker.transfer_item_command,
        purchases_tracker.return_replacement_loans,
        purchases_tracker.return_purchase_transfer,
        purchases_tracker.transfer_item,
    ],
)
def test_worker_role_is_still_blocked_from_move_and_transfer(route_func):
    dep = _dependency_for(route_func)
    worker_user = _user("worker")

    with pytest.raises(Exception) as exc:
        asyncio.run(dep(user=worker_user))

    assert getattr(exc.value, "status_code", None) == 403
