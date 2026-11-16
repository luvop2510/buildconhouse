import httpx
import pytest

from media_storage.base import StorageError, StorageObjectExists, StorageProviderError
from media_storage.supabase_driver import SupabaseStorageDriver


@pytest.mark.asyncio
@pytest.mark.parametrize("status,payload,allowed", [
    (200, {"public": False}, True), (200, {"public": True}, False),
    (200, {}, False), (403, {"public": False}, False),
])
async def test_provider_proves_bucket_visibility_before_backup(monkeypatch, status, payload, allowed):
    driver = SupabaseStorageDriver(url="https://storage.invalid", service_role_key="test-only")

    async def request(method, url, **kwargs):
        assert method == "GET"
        assert url == "https://storage.invalid/storage/v1/bucket/forge-private"
        return httpx.Response(status, json=payload)

    monkeypatch.setattr(driver, "_request", request)
    if allowed:
        await driver.require_private_bucket("forge-private")
    else:
        with pytest.raises(StorageError, match="visibility"):
            await driver.require_private_bucket("forge-private")


@pytest.mark.asyncio
@pytest.mark.parametrize(("status", "body", "error"), [
    (409, {"code": "ResourceAlreadyExists"}, StorageObjectExists),
    (400, {"error": "Duplicate"}, StorageObjectExists),
    (403, {"message": "sensitive provider payload"}, StorageProviderError),
])
async def test_supabase_create_only_errors_distinguish_duplicate_and_outage(monkeypatch, status, body, error):
    driver = SupabaseStorageDriver(url="https://storage.invalid", service_role_key="test-only")
    async def request(*args, **kwargs):
        return httpx.Response(status, json=body)
    monkeypatch.setattr(driver, "_request", request)
    with pytest.raises(error) as failure:
        await driver.upload(bucket="forge-private", key="files/sample.pdf", data=b"%PDF-1.4",
                            content_type="application/pdf", upsert=False)
    assert "sensitive" not in str(failure.value)
