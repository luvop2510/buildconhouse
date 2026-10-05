import hashlib
import json
from datetime import datetime, timezone

import pytest
from bson import ObjectId, json_util
from pymongo.errors import OperationFailure

from scripts import recovery_snapshot
from scripts.recovery_snapshot import export_database, pull_verified, read_manifest, restore_database, upload_verified


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def batch_size(self, size):
        return self

    def __aiter__(self):
        async def items():
            for row in self.rows:
                yield row
        return items()


class Collection:
    def __init__(self, rows):
        self.rows = rows
        self.indexes = [{"name": "_id_", "key": {"_id": 1}, "v": 2},
                        {"name": "sku_unique", "key": {"floor_id": 1, "sku": 1},
                         "unique": True, "partialFilterExpression": {"sku": {"$type": "string"}}}]

    def find(self, query):
        return Cursor(self.rows)

    def list_indexes(self):
        return Cursor(self.indexes)

    async def insert_many(self, rows, ordered):
        self.rows.extend(rows)

    async def create_index(self, keys, **options):
        self.indexes.append({"key": dict(keys), **options})

    async def count_documents(self, query):
        return len(self.rows)


class Database:
    def __init__(self, name, rows=None):
        self.name = name
        self.collections = {name: Collection(docs) for name, docs in (rows or {}).items()}

    async def list_collections(self):
        return Cursor([{"name": name, "type": "collection"} for name in self.collections])

    async def list_collection_names(self):
        return list(self.collections)

    def __getitem__(self, key):
        return self.collections[key]

    async def create_collection(self, name, **options):
        self.collections[name] = Collection([])


def test_storage_quota_diagnostic_preserves_code_without_provider_details():
    exc = OperationFailure("you are over your space quota https://user:password@host/customer", code=8000)
    report = recovery_snapshot.safe_recovery_error(exc, phase="restore")
    assert report == {"complete": False, "exception_type": "OperationFailure", "phase": "restore",
                      "provider_code": 8000, "category": "storage_quota_exceeded"}
    assert "password" not in json.dumps(report) and "customer" not in json.dumps(report)


@pytest.mark.parametrize("message", ["Authentication failed", "space quota is not exceeded"])
def test_generic_atlas_code_8000_is_not_assumed_to_be_quota(message):
    assert recovery_snapshot.safe_recovery_error(OperationFailure(message, code=8000), phase="restore") == {
        "complete": False, "exception_type": "OperationFailure", "phase": "restore", "provider_code": 8000,
    }


def test_quota_classifier_does_not_scan_echoed_customer_or_response_fields():
    exc = OperationFailure("request failed", code=8000, details={
        "errmsg": "operation rejected", "customer_note": "you are over your space quota",
        "uri": "mongodb+srv://user:private-secret@host/customer", "codeName": {"unsafe": "value"},
    })
    report = recovery_snapshot.safe_recovery_error(exc, phase="restore")
    assert "category" not in report
    assert set(report) == {"complete", "exception_type", "phase", "provider_code"}
    assert "private-secret" not in json.dumps(report)


def test_malformed_provider_details_fail_closed_without_chained_traceback(monkeypatch, capsys):
    class MalformedDetails(OperationFailure):
        @property
        def details(self):
            return ["you are over your space quota", "private-customer-data"]

    async def fail(*, diagnostics):
        diagnostics["phase"] = "restore"
        raise MalformedDetails("https://user:secret@host/customer", code=8000)

    monkeypatch.setattr(recovery_snapshot, "main", fail)
    assert recovery_snapshot.run_cli() == 1
    output = capsys.readouterr()
    assert json.loads(output.err) == {
        "complete": False, "exception_type": "MalformedDetails", "phase": "restore", "provider_code": 8000,
    }
    assert "Traceback" not in output.err and "private-customer-data" not in output.err and "secret" not in output.err


def test_dedicated_provider_storage_quota_code_and_errmsg_are_supported():
    for details in ({"codeName": "StorageQuotaExceeded"},
                    {"errmsg": "space quota has been exceeded; private-token"}):
        report = recovery_snapshot.safe_recovery_error(OperationFailure("failed", code=8000, details=details),
                                                       phase="backup-export")
        assert report["category"] == "storage_quota_exceeded" and report["provider_code"] == 8000
        assert "private-token" not in json.dumps(report)


def test_generic_exception_cannot_disclose_messages_or_claim_provider_quota():
    report = recovery_snapshot.safe_recovery_error(
        RuntimeError("space quota exceeded https://user:secret@host customer-document"),
        phase="https://secret.invalid",
    )
    assert report == {"complete": False, "exception_type": "RuntimeError", "phase": "unknown"}


def test_provider_http_status_is_numeric_and_boolean_code_is_omitted():
    class ProviderError(Exception):
        code = True
        response = type("Response", (), {"status_code": 503})()

    report = recovery_snapshot.safe_recovery_error(ProviderError("private response body"), phase="upload")
    assert report == {"complete": False, "exception_type": "ProviderError", "phase": "upload", "status_code": 503}


def test_cli_failure_reports_fixed_operation_phase_and_nonzero_exit(monkeypatch, capsys):
    async def fail(*, diagnostics):
        diagnostics["phase"] = "backup-private-upload"
        raise OperationFailure("you are over your space quota secret-customer-document", code=8000)

    monkeypatch.setattr(recovery_snapshot, "main", fail)
    assert recovery_snapshot.run_cli() == 1
    output = capsys.readouterr()
    assert output.out == "" and "secret-customer-document" not in output.err
    assert json.loads(output.err) == {
        "complete": False, "exception_type": "OperationFailure", "phase": "backup-private-upload",
        "provider_code": 8000, "category": "storage_quota_exceeded",
    }


def test_real_cli_restore_preflight_failure_retains_phase_and_closes_client(monkeypatch, tmp_path, capsys):
    target = Database("isolated_drill")

    class Client:
        closed = False

        def __getitem__(self, name):
            assert name == target.name
            return target

        def close(self):
            self.closed = True

    client = Client()
    monkeypatch.setattr(recovery_snapshot, "AsyncIOMotorClient", lambda *_args, **_kwargs: client)
    monkeypatch.setattr(recovery_snapshot, "load_dotenv", lambda *_args: None)
    monkeypatch.setenv("MONGO_URL", "mongodb://unit-only.invalid")
    monkeypatch.setattr(recovery_snapshot.sys, "argv", [
        "recovery_snapshot.py", "restore", str(tmp_path / "private-customer-snapshot"),
        "--target-db", target.name, "--confirm-database", target.name,
    ])
    assert recovery_snapshot.run_cli() == 1
    output = capsys.readouterr()
    assert json.loads(output.err) == {"complete": False, "exception_type": "FileNotFoundError", "phase": "restore"}
    assert "private-customer-snapshot" not in output.err
    assert target.collections == {} and client.closed


@pytest.mark.asyncio
async def test_snapshot_preserves_bson_identity_types_and_all_collections(tmp_path):
    oid = ObjectId()
    source = Database("source", {"tile_customer_orders": [
        {"_id": oid, "date": datetime(2026, 10, 5, tzinfo=timezone.utc), "sku": "123"}],
        "counters": [{"_id": "sequence", "value": 4}], "user_sessions": [{"_id": "session"}]})
    directory = tmp_path / "snapshot"
    manifest = await export_database(source, directory)
    assert set(manifest["collections"]) == {"tile_customer_orders", "counters"}
    target = Database("restore_drill")
    await restore_database(directory, target, "restore_drill")
    assert target["tile_customer_orders"].rows[0]["_id"] == oid
    assert isinstance(target["tile_customer_orders"].rows[0]["date"], datetime)
    assert target["counters"].rows == [{"_id": "sequence", "value": 4}]
    assert any(index.get("unique") and index.get("partialFilterExpression")
               for index in target["tile_customer_orders"].indexes)
    assert directory.stat().st_mode & 0o777 == 0o700
    assert (directory / "manifest.json").stat().st_mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_restore_preflights_all_files_before_writes_and_refuses_unsafe_targets(tmp_path):
    directory = tmp_path / "snapshot"
    await export_database(Database("source", {"products": [{"_id": "p"}]}), directory)
    with pytest.raises(ValueError, match="different from the source"):
        await restore_database(directory, Database("source"), "source")
    with pytest.raises(ValueError, match="explicitly confirmed"):
        await restore_database(directory, Database("drill"), "other")
    with pytest.raises(ValueError, match="empty"):
        await restore_database(directory, Database("drill", {"existing": []}), "drill")
    (directory / "products.jsonl").write_text(json_util.dumps({"_id": "tampered"}) + "\n")
    target = Database("drill")
    with pytest.raises(ValueError, match="mismatch"):
        await restore_database(directory, target, "drill")
    assert target.collections == {}


@pytest.mark.asyncio
async def test_remote_failure_never_publishes_manifest(tmp_path):
    directory = tmp_path / "snapshot"
    await export_database(Database("source", {"products": [{"_id": "p"}]}), directory)
    uploaded = []

    class Storage:
        async def require_private_bucket(self, bucket):
            assert bucket == "forge-private"

        async def exists(self, **kwargs):
            return False

        async def upload(self, **kwargs):
            uploaded.append(kwargs["key"])
            assert kwargs["cache_control"] == "private, no-store"
            assert kwargs["upsert"] is False

        async def download(self, **kwargs):
            return b"corrupt"

    with pytest.raises(ValueError, match="verification"):
        await upload_verified(directory, Storage(), "forge-private")
    assert uploaded == ["recovery/snapshot/products.jsonl.part-00000"]


@pytest.mark.asyncio
async def test_path_traversal_is_rejected(tmp_path):
    manifest = {"format": 1, "collections": {"../outside": {
        "count": 0, "sha256": hashlib.sha256(b"").hexdigest()}}}
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="Unsafe"):
        read_manifest(tmp_path)


@pytest.mark.asyncio
async def test_verified_remote_roundtrip_manifest_is_last(tmp_path):
    directory = tmp_path / "snapshot"
    await export_database(Database("source", {"products": [{"_id": ObjectId(), "sku": "A"}]}), directory)

    class Storage:
        def __init__(self):
            self.objects = {}

        async def require_private_bucket(self, bucket):
            assert bucket == "forge-private"

        async def exists(self, **kwargs):
            return kwargs["key"] in self.objects

        async def upload(self, **kwargs):
            self.objects[kwargs["key"]] = kwargs["data"]

        async def download(self, **kwargs):
            return self.objects[kwargs["key"]]

    storage = Storage()
    await upload_verified(directory, storage, "forge-private")
    assert list(storage.objects)[-1] == "recovery/snapshot/manifest.json"
    target = tmp_path / "downloaded"
    await pull_verified(target, storage, "forge-private", "snapshot")
    assert read_manifest(target)["collections"] == read_manifest(directory)["collections"]
    # Safe retry verifies existing bytes without overwriting them.
    await upload_verified(directory, storage, "forge-private")


@pytest.mark.asyncio
async def test_remote_backup_refuses_public_bucket_before_data_leaves(tmp_path):
    directory = tmp_path / "snapshot"
    await export_database(Database("source", {"users": [{"_id": "p", "password_hash": "sensitive"}]}), directory)

    class Storage:
        async def require_private_bucket(self, bucket):
            raise ValueError("public bucket")

        async def upload(self, **kwargs):
            pytest.fail("Sensitive data must never upload to a public bucket")

    with pytest.raises(ValueError, match="public bucket"):
        await upload_verified(directory, Storage(), "misconfigured-private")


@pytest.mark.asyncio
async def test_manifest_readback_failure_removes_only_new_completion_marker(tmp_path):
    directory = tmp_path / "snapshot"
    await export_database(Database("source", {"products": [{"_id": "p"}]}), directory)

    class Storage:
        def __init__(self):
            self.objects = {}

        async def require_private_bucket(self, bucket):
            pass

        async def exists(self, **kwargs):
            return kwargs["key"] in self.objects

        async def upload(self, **kwargs):
            self.objects[kwargs["key"]] = kwargs["data"]

        async def download(self, **kwargs):
            if kwargs["key"].endswith("manifest.json"):
                raise RuntimeError("readback failed")
            return self.objects[kwargs["key"]]

        async def delete(self, **kwargs):
            del self.objects[kwargs["key"]]

    storage = Storage()
    with pytest.raises(RuntimeError, match="readback"):
        await upload_verified(directory, storage, "forge-private")
    assert "recovery/snapshot/manifest.json" not in storage.objects
    assert "recovery/snapshot/products.jsonl.part-00000" in storage.objects


@pytest.mark.asyncio
async def test_manifest_commit_then_timeout_is_resolved_by_exact_readback(tmp_path):
    directory = tmp_path / "snapshot"
    await export_database(Database("source", {"products": [{"_id": "p"}]}), directory)

    class Storage:
        def __init__(self):
            self.objects = {}

        async def require_private_bucket(self, bucket):
            pass

        async def exists(self, **kwargs):
            return kwargs["key"] in self.objects

        async def upload(self, **kwargs):
            self.objects[kwargs["key"]] = kwargs["data"]
            if kwargs["key"].endswith("manifest.json"):
                raise TimeoutError("committed but reply lost")

        async def download(self, **kwargs):
            return self.objects[kwargs["key"]]

    storage = Storage()
    await upload_verified(directory, storage, "forge-private")
    assert "recovery/snapshot/manifest.json" in storage.objects
