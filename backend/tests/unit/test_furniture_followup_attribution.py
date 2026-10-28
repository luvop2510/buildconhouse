import asyncio
from types import SimpleNamespace

from routes import followup_routes


def test_furniture_owner_is_not_displayed_as_salesperson(monkeypatch):
    class Cursor:
        async def to_list(self, count):
            assert count == 2
            return [{"id": "owner"}]

    class Users:
        def find(self, query, projection):
            assert set(query["id"]["$in"]) == {"owner", "worker"}
            assert query["role"] == "owner"
            return Cursor()

    monkeypatch.setattr(followup_routes, "db", SimpleNamespace(users=Users()))
    rows = [
        {"floor_id": "third-floor", "assigned_to": "owner", "assigned_to_name": "Owner"},
        {"floor_id": "third-floor", "assigned_to": "worker", "assigned_to_name": "Worker"},
        {"floor_id": "second-floor", "assigned_to": "owner", "assigned_to_name": "Owner"},
    ]
    asyncio.run(followup_routes._mask_furniture_owner_salesperson(rows))
    assert rows[0]["assigned_to_name"] is None
    assert rows[0]["assigned_to"] == "owner"
    assert rows[1]["assigned_to_name"] == "Worker"
    assert rows[2]["assigned_to_name"] == "Owner"
