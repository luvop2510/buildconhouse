"""The launch switch denies direct API access without changing staff grants."""
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from auth import get_current_user
from models import UserPublic
from routes.kitchen_routes import router, require_kitchen_launch_access


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["admin", "manager", "sales", "worker"])
async def test_owner_launch_denies_every_kitchen_endpoint(monkeypatch, role):
    monkeypatch.setenv("FORGE_KITCHEN_OWNER_ONLY", "true")
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: UserPublic(
        id="launch-test", full_name="Launch test", role=role, floor_ids=["second-floor"],
        active_floor_id="second-floor")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        for route in router.routes:
            path = route.path
            for parameter in route.param_convertors:
                path = path.replace("{" + parameter + "}", "launch-test")
            for method in route.methods:
                response = await client.request(method, path)
                assert response.status_code == 403, (method, route.path, response.status_code)
                assert response.json()["detail"] == "Kitchen is currently available to the owner only"


@pytest.mark.asyncio
async def test_owner_launch_preserves_owner_and_normal_department_mode(monkeypatch):
    owner = UserPublic(id="owner-test", full_name="Owner test", role="owner")
    worker = UserPublic(id="worker-test", full_name="Worker test", role="worker")
    monkeypatch.setenv("FORGE_KITCHEN_OWNER_ONLY", "true")
    await require_kitchen_launch_access(owner)
    monkeypatch.setenv("FORGE_KITCHEN_OWNER_ONLY", "false")
    await require_kitchen_launch_access(worker)
