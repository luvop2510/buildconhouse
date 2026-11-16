"""Real authenticated department deletion; only a disposable replica is used."""
from uuid import uuid4

import pytest

from tests.integration.test_kitchen_projects_mongo import environment, headers
from tests.integration.test_tile_release_godown_mongo import tile_replica
from services.access_grants import build_grant


@pytest.fixture(autouse=True)
def owned_replica(tile_replica, monkeypatch):
    monkeypatch.setenv("KITCHEN_TEST_MONGO_URL", tile_replica.split("?")[0])
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")


@pytest.mark.asyncio
@pytest.mark.parametrize("floor", ["ground-floor", "first-floor", "third-floor"])
async def test_explicit_employee_grant_confirms_and_audits_only_selected_department(floor):
    async with environment() as env:
        database, api = env["db"], env["api"]
        employee = env["ids"]["worker"]
        customer = str(uuid4())
        await database.floors.update_one({"id": floor}, {"$set": {"id": floor, "name": floor, "active": True}}, upsert=True)
        await database.users.update_one({"id": employee}, {"$set": {"floor_ids": [floor]}})
        await database.customers.insert_one({"id": customer, "floor_id": floor, "name": "Deletion QA", "phone": "9000000001"})
        path = f"/api/customers/{customer}"
        request_headers = headers(env, "worker", floor)
        assert (await api.get(path + "/deletion-preview", headers=request_headers)).status_code == 403
        explicit = build_grant(user_id=employee, resource="customer_delete", actions=["view", "delete"], floor_id=floor,
            expires_at=None, actor_id=env["ids"]["owner"], actor_name="Owner")
        await database.users.update_one({"id": employee}, {"$set": {"delegation_grants": [explicit]}})
        preview = await api.get(path + "/deletion-preview", headers=request_headers)
        assert preview.status_code == 200, preview.text
        confirmation = {"confirmation": preview.json()["confirmation"]}
        assert (await api.delete(path, headers=request_headers)).status_code == 409
        await database.users.update_one({"id": employee}, {"$set": {"delegation_grants": []}})
        assert (await api.delete(path, headers=request_headers, params=confirmation)).status_code == 403
        assert await database.customers.count_documents({"id": customer}) == 1
        await database.users.update_one({"id": employee}, {"$set": {"delegation_grants": [explicit]}})
        removed = await api.delete(path, headers=request_headers, params=confirmation)
        assert removed.status_code == 200, removed.text
        assert await database.customers.count_documents({"id": customer}) == 0
        receipt = await database.settings.find_one({"id": "customer-deletion:" + customer})
        assert receipt["actor_id"] == employee and receipt["completed_at"] and receipt["floor_id"] == floor
        assert await database.customers.count_documents({"id": env["ids"]["customer"]}) == 1
        assert (await api.delete(path, headers=request_headers, params=confirmation)).status_code == 200
        await database.users.update_one({"id": employee}, {"$set": {"delegation_grants": []}})
        assert (await api.delete(path, headers=request_headers, params=confirmation)).status_code == 403


@pytest.mark.asyncio
async def test_role_permission_changes_take_effect_on_an_existing_cached_session():
    async with environment() as env:
        database, api = env["db"], env["api"]
        employee = env["ids"]["worker"]
        await database.users.update_one({"id": employee}, {"$set": {"role": "sales", "custom_access": False, "floor_ids": ["first-floor"]}})
        path = "/api/customers/" + env["ids"]["other_customer"]
        request_headers = headers(env, "worker", "first-floor")
        assert (await api.get(path + "/deletion-preview", headers=request_headers)).status_code == 403
        await database.settings.insert_one({"key": "permission_matrix", "overrides": {"sales": {"delete-customers": True}}})
        preview = await api.get(path + "/deletion-preview", headers=request_headers)
        assert preview.status_code == 200, preview.text
        await database.settings.update_one({"key": "permission_matrix"}, {"$set": {"overrides.sales.delete-customers": False}})
        assert (await api.delete(path, headers=request_headers, params={"confirmation": preview.json()["confirmation"]})).status_code == 403
        assert await database.customers.count_documents({"id": env["ids"]["other_customer"]}) == 1
