"""Private Kitchen file outages fail closed with recoverable HTTP responses."""
import copy
import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from auth import get_current_user
from media_storage import factory
from media_storage.base import StorageError
from routes import kitchen_routes
from services.kitchen_projects import resolved_policy
from tests.unit.test_kitchen_file_transfer_recovery import finishing_transfer
from tests.unit.test_kitchen_projects import create_request, setup


def kitchen_app(monkeypatch, database, owner, storage):
    monkeypatch.setattr(kitchen_routes, "db", database)
    monkeypatch.setattr(factory, "get_media_storage", lambda: storage)
    monkeypatch.setattr(factory, "private_bucket", lambda: "forge-private")
    app = FastAPI()
    app.include_router(kitchen_routes.router)
    app.dependency_overrides[get_current_user] = lambda: owner
    return app


def assert_retryable(response):
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "2"
    assert response.headers["Cache-Control"] == "no-store"
    assert "Kitchen file storage is temporarily unavailable" in response.json()["detail"]
    assert "secret" not in response.text


@pytest.mark.asyncio
async def test_upload_privacy_outage_leaves_project_unchanged_then_same_key_retries_once(setup, monkeypatch):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="storage-create"))
    original = copy.deepcopy(database.kitchen_projects.rows[0])
    storage = SimpleNamespace(require_private_bucket=AsyncMock(side_effect=[StorageError("secret-provider-response"), None]),
        exists=AsyncMock(return_value=False), upload=AsyncMock())
    app = kitchen_app(monkeypatch, database, owner, storage)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        async def upload():
            return await client.post(f"/kitchen-projects/{project['id']}/attachments",
                data={"expected_version": project["version"], "idempotency_key": "same-upload-after-outage"},
                files={"file": ("Design.pdf", b"%PDF-1.4\n", "application/pdf")})
        assert_retryable(await upload())
        assert database.kitchen_projects.rows[0] == original
        storage.exists.assert_not_awaited()
        storage.upload.assert_not_awaited()
        assert database.kitchen_configuration.rows[0]["active_command_count"] == 0
        assert database.kitchen_configuration.rows[0]["command_admissions"] == {}
        retry = await upload()
        replay = await upload()
    assert retry.status_code == replay.status_code == 200
    assert retry.json()["version"] == replay.json()["version"] == project["version"] + 1
    assert replay.json()["replayed"]
    assert len(database.kitchen_projects.rows[0]["attachments"]) == 1
    storage.upload.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("suffix", ["", "/parts/0"])
async def test_download_privacy_outage_returns_actionable_error_without_releasing_bytes(setup, monkeypatch, suffix):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="storage-download"))
    data = b"%PDF-1.4\n"
    database.kitchen_projects.rows[0]["attachments"] = [{"id": "design-2", "size_bytes": len(data),
        "bucket": "forge-private", "storage_key": "private/design-2", "sha256": hashlib.sha256(data).hexdigest(),
        "content_type": "application/pdf", "filename": "Design2.pdf"}]
    storage = SimpleNamespace(require_private_bucket=AsyncMock(side_effect=StorageError("secret-provider-response")),
        download=AsyncMock(return_value=data))
    app = kitchen_app(monkeypatch, database, owner, storage)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(f"/kitchen-projects/{project['id']}/attachments/design-2{suffix}")
    assert_retryable(response)
    storage.download.assert_not_awaited()


@pytest.mark.asyncio
async def test_transfer_finish_provider_failure_retains_parts_and_releases_claim_for_explicit_retry(setup, monkeypatch):
    database, _, owner = setup
    data = b"%PDF-1.4\n"
    digest = hashlib.sha256(data).hexdigest()
    service, collection, _, sessions = finishing_transfer([
        {"_id": "actor:owner:0", "transfer_id": "transfer", "data": data, "sha256": digest}])
    service.authorized = AsyncMock(return_value=({}, resolved_policy({})))
    service.session = AsyncMock(return_value={"state": "open", "size_bytes": len(data), "sha256": digest,
        "key": "same-staged-key", "filename": "Design.pdf", "content_type": "application/pdf"})
    service.projects.attach = AsyncMock(side_effect=[StorageError("secret-provider-response"), {"version": 2}])
    monkeypatch.setattr(kitchen_routes, "KitchenFileTransfers", lambda _database: service)
    app = kitchen_app(monkeypatch, database, owner, None)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/kitchen-projects/project/file-transfers/transfer/finish", json={"expected_version": 1})
        assert_retryable(response)
        collection.delete_many.assert_not_awaited()
        release = sessions.update_one.await_args
        assert release.args[0]["state"] == "finishing"
        assert release.args[1]["$set"]["state"] == "open"
        assert "finish_token" in release.args[1]["$unset"]
        retried = await client.post("/kitchen-projects/project/file-transfers/transfer/finish", json={"expected_version": 1})
    assert retried.status_code == 200 and retried.json()["version"] == 2
    assert service.projects.attach.await_count == 2
    assert all(call.kwargs["key"] == "same-staged-key" and call.kwargs["data"] == data
               for call in service.projects.attach.await_args_list)
    collection.delete_many.assert_awaited_once_with({"transfer_id": "transfer"})
