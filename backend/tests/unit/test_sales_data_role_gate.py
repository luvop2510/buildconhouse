"""Legacy overview role policy; drilldown route wiring is tested separately
in test_sales_data_routes.py because the new reports also admit managers."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from auth import require_roles
from models import UserPublic


def _user(role: str) -> UserPublic:
    return UserPublic(id="u1", email="u@forge.app", full_name="U", role=role)


@pytest.mark.parametrize("role", ["sales", "manager", "accounts", "purchase", "warehouse", "worker"])
def test_non_owner_admin_roles_rejected(role):
    dep = require_roles("owner", "admin")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(dep(user=_user(role)))
    assert exc.value.status_code == 403


@pytest.mark.parametrize("role", ["owner", "admin"])
def test_owner_and_admin_allowed(role):
    dep = require_roles("owner", "admin")
    result = asyncio.run(dep(user=_user(role)))
    assert result.role == role
