import hashlib
import json
from datetime import datetime, timezone

import pytest
from bson import ObjectId, json_util

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
