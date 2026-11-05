import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from models import UserPublic
from routes import quotation_routes


def test_staff_names_are_minimal_and_require_ground_floor(monkeypatch):
    rows = [{"id": "1", "full_name": "Staff One"}, {"id": "2", "full_name": "Staff Two"}]
    result = SimpleNamespace(to_list=AsyncMock(return_value=rows))
    cursor = SimpleNamespace(sort=lambda *_: result)
    users = SimpleNamespace(find=lambda query, projection: cursor)
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(users=users))
    allowed = UserPublic(email="a@example.test", full_name="Staff", role="sales", floor_ids=["ground-floor"])
    denied = UserPublic(email="b@example.test", full_name="Staff", role="sales", floor_ids=["first-floor"])
    assert asyncio.run(quotation_routes.quotation_staff_names(allowed)) == rows
    with pytest.raises(HTTPException) as error:
        asyncio.run(quotation_routes.quotation_staff_names(denied))
    assert error.value.status_code == 403
