from __future__ import annotations

import asyncio
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import boto3
import httpx
import pytest
from botocore.stub import Stubber

from media_storage.base import StorageError
from media_storage.r2_driver import R2StorageDriver
from media_storage import r2_driver
from scripts.migrate_storage_to_r2 import (FORMAT, apply_references, binding, copy_objects,
                                          digest, plan_references, rewrite, write_record)
from scripts.verify_backup_source import source_fingerprint
from settings import ConfigurationError, load_settings, settings


@pytest.fixture
def cfg():
    return replace(settings, media_storage_driver="r2", r2_account_id="a" * 32,
                   r2_access_key_id="unit", r2_secret_access_key="unit-secret",
                   r2_api_token="unit-token", r2_public_url="https://media.example.test")


@pytest.fixture
def sdk():
    client = boto3.client("s3", endpoint_url="https://unit.r2.cloudflarestorage.com",
                          aws_access_key_id="unit", aws_secret_access_key="unit", region_name="auto")
    with Stubber(client) as stub:
        yield client, stub
        stub.assert_no_pending_responses()
    client.close()


def r2_env():
    return {"MONGO_URL": "mongodb://localhost:27017", "DB_NAME": "unit_test",
            "JWT_SECRET": "x" * 32, "MEDIA_STORAGE_DRIVER": "r2",
            "SUPABASE_PUBLIC_BUCKET": "forge-products", "SUPABASE_PRIVATE_BUCKET": "forge-private",
            "R2_ACCOUNT_ID": "a" * 32, "R2_ACCESS_KEY_ID": "unit",
            "R2_SECRET_ACCESS_KEY": "unit", "R2_API_TOKEN": "unit",
            "R2_PUBLIC_URL": "https://media.example.test"}


def test_r2_runtime_does_not_require_supabase_credentials():
    cfg = load_settings(r2_env(), load_local_fallback=False)
    assert all(cfg.readiness_flags().values())
    assert not any(k.startswith("SUPABASE_") for k in cfg.readiness_flags())
    assert source_fingerprint(r2_env()) != source_fingerprint({**r2_env(), "R2_ACCOUNT_ID": "b" * 32})


@pytest.mark.parametrize("field,value", [("R2_SECRET_ACCESS_KEY", ""), ("R2_API_TOKEN", ""),
    ("R2_PUBLIC_URL", "http://media.test"), ("R2_PUBLIC_URL", "https://user:secret@media.test"),
    ("R2_PUBLIC_URL", "https://media.test/path"), ("R2_ACCOUNT_ID", "../wrong"),
    ("SUPABASE_PRIVATE_BUCKET", "forge-products")])
def test_r2_configuration_fails_closed(field, value):
    with pytest.raises(ConfigurationError):
        load_settings({**r2_env(), field: value}, load_local_fallback=False)


def test_private_bucket_cannot_be_exposed_as_public_url(cfg, sdk):
    driver = R2StorageDriver(cfg=cfg, client=sdk[0])
    with pytest.raises(StorageError):
        driver.get_public_url(bucket=cfg.supabase_private_bucket, key="backup.json")
    assert driver.get_public_url(bucket=cfg.supabase_public_bucket, key="brand/a #1.png").endswith("brand/a%20%231.png")


@pytest.mark.asyncio
async def test_conditional_private_upload_is_standard_and_no_store(cfg, sdk):
    client, stub = sdk
    stub.add_response("put_object", {}, {"Bucket": cfg.supabase_private_bucket, "Key": "backups/test.json",
        "Body": b"{}", "ContentType": "application/json", "CacheControl": "private, no-store",
        "StorageClass": "STANDARD", "IfNoneMatch": "*"})
    result = await R2StorageDriver(cfg=cfg, client=client).upload(bucket=cfg.supabase_private_bucket,
        key="backups/test.json", data=b"{}", content_type="application/json", upsert=False)
    assert result.public_url is None


@pytest.mark.asyncio
async def test_exists_does_not_treat_denied_access_as_missing(cfg, sdk):
    client, stub = sdk
    params = {"Bucket": cfg.supabase_public_bucket, "Key": "x.png"}
    stub.add_client_error("head_object", service_error_code="AccessDenied", http_status_code=403, expected_params=params)
    stub.add_client_error("head_object", service_error_code="NoSuchKey", http_status_code=404, expected_params=params)
    driver = R2StorageDriver(cfg=cfg, client=client)
    with pytest.raises(StorageError):
        await driver.exists(bucket=cfg.supabase_public_bucket, key="x.png")
    assert not await driver.exists(bucket=cfg.supabase_public_bucket, key="x.png")


@pytest.mark.asyncio
async def test_private_visibility_checks_managed_and_custom_domains(cfg, sdk, monkeypatch):
    driver = R2StorageDriver(cfg=cfg, client=sdk[0])
    statuses = {"managed": {"enabled": False}, "custom": {"domains": []}}
    paths = []
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def get(self, url, **kwargs):
            suffix = url.rsplit("/", 1)[1]
            paths.append(suffix)
            return httpx.Response(200, json={"success": True, "result": statuses[suffix]})
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    await driver.require_private_bucket(cfg.supabase_private_bucket)
    assert paths == ["managed", "custom"]
    statuses["custom"] = {"domains": [{"enabled": True}]}
    with pytest.raises(StorageError):
        await driver.require_private_bucket(cfg.supabase_private_bucket)
    statuses["custom"] = {"domains": []}
    statuses["managed"] = {"enabled": True}
    with pytest.raises(StorageError):
        await driver.require_private_bucket(cfg.supabase_private_bucket)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "connection", "json", "payload", "custom-row", "denied"])
async def test_visibility_provider_failures_are_sanitized_and_fail_closed(cfg, sdk, monkeypatch, failure):
    real_client = httpx.AsyncClient
    async def respond(request):
        if failure == "timeout":
            raise httpx.ReadTimeout("secret-provider-url-and-token", request=request)
        if failure == "connection":
            raise httpx.ConnectError("secret-provider-url-and-token", request=request)
        if failure == "json":
            return httpx.Response(200, text="secret-provider-body")
        if failure == "payload":
            return httpx.Response(200, json=[])
        if failure == "denied":
            return httpx.Response(403, text="secret-provider-body")
        result = {"enabled": False} if request.url.path.endswith("managed") else {"domains": ["invalid"]}
        return httpx.Response(200, json={"success": True, "result": result})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(respond), **kw))
    driver = R2StorageDriver(cfg=cfg, client=sdk[0])
    for _ in range(2):
        with pytest.raises(StorageError) as error:
            await driver.require_private_bucket(cfg.supabase_private_bucket)
        assert "secret" not in str(error.value)
    assert not driver._private_checks


@pytest.mark.asyncio
async def test_visibility_checks_share_only_inflight_proof_and_survive_one_cancelled_caller(cfg, sdk, monkeypatch):
    real_client = httpx.AsyncClient
    started, release = asyncio.Event(), asyncio.Event()
    paths = []
    publicly_enabled = False
    async def respond(request):
        paths.append(request.url.path.rsplit("/", 1)[1])
        if len(paths) == 2:
            started.set()
        await release.wait()
        result = {"enabled": publicly_enabled} if request.url.path.endswith("managed") else {"domains": []}
        return httpx.Response(200, json={"success": True, "result": result})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(respond), **kw))
    driver = R2StorageDriver(cfg=cfg, client=sdk[0])
    abandoned = asyncio.create_task(driver.require_private_bucket(cfg.supabase_private_bucket))
    remaining = asyncio.create_task(driver.require_private_bucket(cfg.supabase_private_bucket))
    await asyncio.wait_for(started.wait(), timeout=1)
    abandoned.cancel()
    with pytest.raises(asyncio.CancelledError):
        await abandoned
    assert not remaining.done()
    release.set()
    await remaining
    assert paths == ["managed", "custom"]
    # A subsequent operation must detect a newly enabled public domain rather
    # than reuse the successful proof just acknowledged above.
    publicly_enabled = True
    with pytest.raises(StorageError):
        await driver.require_private_bucket(cfg.supabase_private_bucket)
    assert paths == ["managed", "custom", "managed", "custom"]


@pytest.mark.asyncio
async def test_visibility_has_one_total_deadline_and_settles_both_requests(cfg, sdk, monkeypatch):
    real_client = httpx.AsyncClient
    cancelled = []
    async def respond(request):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.append(request.url.path.rsplit("/", 1)[1])
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(respond), **kw))
    monkeypatch.setattr(r2_driver, "VISIBILITY_TIMEOUT_SECONDS", 0.025)
    driver = R2StorageDriver(cfg=cfg, client=sdk[0])
    with pytest.raises(StorageError, match="TimeoutError"):
        await asyncio.wait_for(driver.require_private_bucket(cfg.supabase_private_bucket), timeout=1)
    assert sorted(cancelled) == ["custom", "managed"]
    assert not driver._private_checks


@pytest.mark.asyncio
async def test_signed_private_url_uses_s3_endpoint_and_has_expiry(cfg, sdk):
    driver = R2StorageDriver(cfg=cfg, client=sdk[0])
    result = await driver.get_signed_url(bucket=cfg.supabase_private_bucket, key="a.pdf", expires_in=90)
    assert "unit.r2.cloudflarestorage.com" in result
    assert "media.example.test" not in result
    with pytest.raises(ValueError):
        await driver.get_signed_url(bucket=cfg.supabase_private_bucket, key="a.pdf", expires_in=604801)


def test_nested_snapshots_move_only_verified_public_objects(cfg):
    prefix = f"{cfg.supabase_url}/storage/v1/object/public/{cfg.supabase_public_bucket}/"
    private = f"{cfg.supabase_url}/storage/v1/object/sign/{cfg.supabase_private_bucket}/a.pdf?token=unit"
    value = {"items": [{"image": prefix + "brand/a%20b.png"}], "private": private, "external": "https://supplier.test/a.png"}
    result = rewrite(value, cfg, {(cfg.supabase_public_bucket, "brand/a b.png")})
    assert result["items"][0]["image"] == "https://media.example.test/brand/a%20b.png"
    assert result["private"] == private and result["external"] == value["external"]
    assert value["items"][0]["image"].startswith(cfg.supabase_url)
    with pytest.raises(ValueError):
        rewrite(value, cfg, set())


@pytest.mark.asyncio
async def test_copy_refuses_existing_different_bytes_without_overwrite(cfg, tmp_path):
    tmp_path.chmod(0o700)
    row = {"bucket": cfg.supabase_private_bucket, "key": "backups/a.json", "size_bytes": 2, "content_type": "application/json"}
    class Storage:
        require_private_bucket = AsyncMock()
        ready = AsyncMock()
        upload = AsyncMock()
        async def iter_objects(self, *, bucket, **kwargs):
            if bucket == cfg.supabase_private_bucket:
                yield row
    source, target = Storage(), Storage()
    source.download = AsyncMock(return_value=b"{}")
    target.download = AsyncMock(return_value=b"[]")
    target.exists = AsyncMock(return_value=True)
    write_record(tmp_path / "inventory.json", {"format": FORMAT, "binding": binding(cfg), "objects": [row]})
    with pytest.raises(ValueError, match="will not be overwritten"):
        await copy_objects(source, target, cfg, tmp_path)
    target.upload.assert_not_awaited()
    assert not (tmp_path / "copy-complete.json").exists()


@pytest.mark.asyncio
async def test_reference_apply_is_conditional_and_rollback_reverses_only_changed_fields(cfg, tmp_path):
    tmp_path.chmod(0o700)
    write_record(tmp_path / "copy-complete.json", {"copy_complete": True})
    plan = {"format": FORMAT, "binding": binding(cfg), "database": "unit_test",
            "copy_sha256": digest((tmp_path / "copy-complete.json").read_bytes()), "changes": [
                {"collection": "products", "id": "p1", "before": {"image": "old"}, "after": {"image": "new"}}]}
    write_record(tmp_path / "references.json", plan)
    collection = SimpleNamespace(update_one=AsyncMock(return_value=SimpleNamespace(matched_count=1)), find_one=AsyncMock(return_value=None))
    class Database:
        name = "unit_test"
        def __getitem__(self, name): return collection
    assert await apply_references(Database(), cfg, tmp_path) == 1
    collection.update_one.assert_awaited_with({"_id": "p1", "image": "old"}, {"$set": {"image": "new"}})
    assert await apply_references(Database(), cfg, tmp_path, rollback=True) == 1
    collection.update_one.assert_awaited_with({"_id": "p1", "image": "new"}, {"$set": {"image": "old"}})
    collection.update_one.return_value = SimpleNamespace(matched_count=0)
    with pytest.raises(ValueError, match="Concurrent edit"):
        await apply_references(Database(), cfg, tmp_path)


def test_migration_binding_identifies_mongo_cluster_without_credentials(cfg):
    first = replace(cfg, mongo_url="mongodb+srv://first:secret@cluster-a.example.test", db_name="unit_test")
    rotated = replace(first, mongo_url="mongodb+srv://second:changed@CLUSTER-A.EXAMPLE.TEST")
    other_cluster = replace(first, mongo_url="mongodb+srv://first:secret@cluster-b.example.test")
    assert binding(first) == binding(rotated)
    assert binding(first) != binding(other_cluster)
    serialized = str(binding(first))
    assert "secret" not in serialized and "cluster-a" not in serialized


@pytest.mark.asyncio
async def test_reference_plan_preserves_audit_import_and_session_history(cfg, tmp_path):
    tmp_path.chmod(0o700)
    media = b"photo"
    (tmp_path / "photo.bin").write_bytes(media)
    (tmp_path / "photo.bin").chmod(0o600)
    row = {"bucket": cfg.supabase_public_bucket, "key": "photo.png", "file": "photo.bin", "sha256": digest(media)}
    write_record(tmp_path / "copy-complete.json", {"format": FORMAT, "binding": binding(cfg), "copy_complete": True, "objects": [row]})
    application = {"products", "product_media", "godown_stock", "godown_stock_media", "quotations", "quotation_shares", "settings", "brands", "furniture_quotations", "purchase_orders"}
    history = {"activity_events", "catalog_import_receipts", "_migrations", "user_sessions", "unknown_future_collection"}
    touched = []
    class Cursor:
        def __init__(self, rows): self.rows = rows
        def batch_size(self, _size): return self
        def __aiter__(self):
            async def rows():
                for row in self.rows: yield row
            return rows()
    class Collection:
        def __init__(self, name): self.name = name
        def find(self, _query):
            touched.append(self.name)
            return Cursor([{"_id": self.name, "image": f"{cfg.supabase_url}/storage/v1/object/public/{cfg.supabase_public_bucket}/photo.png"}])
    class Database:
        name = "unit_test"
        async def list_collections(self):
            return Cursor([{"name": name} for name in sorted(application | history)])
        def __getitem__(self, name): return Collection(name)
    plan = await plan_references(Database(), cfg, tmp_path)
    assert set(touched) == application
    assert {row["collection"] for row in plan["changes"]} == application
    assert len(plan["changes"]) == 10


@pytest.mark.asyncio
@pytest.mark.parametrize("rollback", [False, True])
@pytest.mark.parametrize("invalid", ["other_cluster", "legacy_binding", "audit_collection"])
async def test_reference_apply_refuses_wrong_identity_or_history_before_any_write(cfg, tmp_path, rollback, invalid):
    tmp_path.chmod(0o700)
    source = replace(cfg, mongo_url="mongodb+srv://member:private@cluster-a.example.test", db_name="unit_test")
    target = source
    write_record(tmp_path / "copy-complete.json", {"copy_complete": True})
    plan = {"format": FORMAT, "binding": binding(source), "database": "unit_test",
            "copy_sha256": digest((tmp_path / "copy-complete.json").read_bytes()), "changes": [
                {"collection": "products", "id": "p1", "before": {"image": "old"}, "after": {"image": "new"}}]}
    if invalid == "other_cluster":
        target = replace(source, mongo_url="mongodb+srv://member:private@cluster-b.example.test")
    elif invalid == "legacy_binding":
        plan["binding"].pop("source_fingerprint", None)
    else:
        plan["changes"].append({"collection": "activity_events", "id": "audit-1", "before": {"image": "old"}, "after": {"image": "new"}})
    write_record(tmp_path / "references.json", plan)
    collection = SimpleNamespace(update_one=AsyncMock(return_value=SimpleNamespace(matched_count=1)), find_one=AsyncMock(return_value=None))
    class Database:
        name = "unit_test"
        def __getitem__(self, _name): return collection
    with pytest.raises(ValueError):
        await apply_references(Database(), target, tmp_path, rollback=rollback)
    collection.update_one.assert_not_awaited()
