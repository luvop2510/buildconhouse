"""Recovery must preserve bytes and fail before touching unsafe destinations."""
import hashlib
import json
from unittest.mock import AsyncMock

import httpx
import pytest
from bson import json_util

from media_storage.base import StorageError
from media_storage.supabase_driver import SupabaseStorageDriver
from scripts import media_object_snapshot as snapshots


class Storage:
    def __init__(self):
        self.data = {("public", "brand/product/original.jpg"): b"original-jpeg",
                     ("private", "catalog-sources/supplier.xlsx"): b"supplier-master",
                     ("private", "recovery/existing/chunk.bin"): b"separate-database-backup"}
        self.uploads = []
        self.types = {}
        self.private = True
        self.change_after_download = False
        self.corrupt_readback = False

    async def require_private_bucket(self, bucket):
        if not self.private or bucket != "private":
            raise StorageError("Not private")

    async def iter_objects(self, *, bucket, prefix="", page_size=1000):
        for (b, key), data in sorted(self.data.items()):
            if bucket == b and key.startswith(prefix):
                yield {"bucket": b, "key": key, "id": key, "size_bytes": len(data),
                       "content_type": self.types.get((b, key), "application/octet-stream"), "version": "1", "updated_at": "fixed", "etag": "etag"}

    async def download(self, *, bucket, key):
        data = self.data[(bucket, key)]
        if self.change_after_download and not key.startswith("restore-drills/"):
            self.data[(bucket, key)] = data + b"change"
        if self.corrupt_readback and key.startswith("restore-drills/") and not key.endswith(".reservation.json"):
            return b"wrong"
        return data

    async def upload(self, *, bucket, key, data, content_type, upsert, cache_control):
        assert upsert is False and cache_control == "private, no-store"
        if (bucket, key) in self.data:
            raise StorageError("Would overwrite")
        self.uploads.append((bucket, key, data, content_type))
        self.data[(bucket, key)] = data
        self.types[(bucket, key)] = content_type


async def archive(tmp_path, storage=None, refs=None):
    storage = storage or Storage()
    output = tmp_path / "snapshot"
    manifest = await snapshots.backup(storage, output, buckets=["public", "private"], private_bucket="private",
                                      refs=refs or [], concurrency=2)
    return storage, output, manifest


def rewrite(directory, manifest):
    path = directory / "manifest.json"
    path.write_text(json.dumps(manifest))


@pytest.mark.asyncio
async def test_archive_covers_nested_public_and_private_objects_and_known_missing_refs(tmp_path):
    refs = [{"bucket": "public", "key": "brand/product/original.jpg", "sha1": hashlib.sha1(b"original-jpeg").hexdigest()},
            {"bucket": "public", "key": "known-missing.jpg", "sha1": None}]
    storage, directory, manifest = await archive(tmp_path, refs=refs)
    assert manifest["object_count"] == 2
    assert manifest["archive_complete"] is True
    assert manifest["reference_coverage_complete"] is False
    assert manifest["missing_references"] == [{"bucket": "public", "key": "known-missing.jpg"}]
    assert snapshots.verify(directory) == manifest
    assert storage.uploads == []
    assert directory.stat().st_mode & 0o077 == 0
    assert all(path.stat().st_mode & 0o077 == 0 for path in directory.iterdir())


@pytest.mark.asyncio
@pytest.mark.parametrize("problem", ["tampered", "symlink", "traversal", "duplicate", "mime", "bucket", "coverage"])
async def test_restore_prevalidates_entire_archive_before_any_write(tmp_path, problem):
    storage, directory, manifest = await archive(tmp_path)
    row = manifest["objects"][-1]
    path = directory / row["file"]
    if problem == "tampered":
        path.write_bytes(b"different")
    elif problem == "symlink":
        outside = tmp_path / "outside"
        outside.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(outside)
    elif problem == "traversal":
        row["file"] = "../outside"
    elif problem == "duplicate":
        manifest["objects"].append(row)
    elif problem == "mime":
        row["content_type"] = "application/octet-stream\r\nInjected: true"
    elif problem == "bucket":
        row["bucket"] = ".."
    else:
        del manifest["reference_coverage_complete"]
    rewrite(directory, manifest)
    with pytest.raises((ValueError, OSError)):
        await snapshots.restore(storage, directory, target_bucket="private", target_prefix="restore-drills/test-1234/",
                                confirm_prefix="restore-drills/test-1234/", report=tmp_path / "result.json")
    assert storage.uploads == []


@pytest.mark.asyncio
@pytest.mark.parametrize("problem", ["public", "occupied", "unconfirmed", "unsafe"])
async def test_restore_refuses_unsafe_or_occupied_destination(tmp_path, problem):
    storage, directory, _ = await archive(tmp_path)
    prefix = "restore-drills/test-1234/"
    confirm = prefix
    if problem == "public":
        storage.private = False
    elif problem == "occupied":
        storage.data[("private", prefix + "other.jpg")] = b"existing"
    elif problem == "unconfirmed":
        confirm = "different"
    else:
        prefix = confirm = "catalog-sources/"
    with pytest.raises((ValueError, StorageError)):
        await snapshots.restore(storage, directory, target_bucket="private", target_prefix=prefix,
                                confirm_prefix=confirm, report=tmp_path / "result.json")
    assert storage.uploads == []


@pytest.mark.asyncio
async def test_restore_preserves_original_key_mime_bytes_without_changing_source(tmp_path):
    storage, directory, manifest = await archive(tmp_path)
    before = dict(storage.data)
    result = await snapshots.restore(storage, directory, target_bucket="private", target_prefix="restore-drills/test-1234/",
                                     confirm_prefix="restore-drills/test-1234/", report=tmp_path / "result.json")
    assert result["objects_verified"] == 2
    for row in manifest["objects"]:
        assert storage.data[("private", "restore-drills/test-1234/" + row["bucket"] + "/" + row["key"])] == before[(row["bucket"], row["key"])]
    assert all(storage.data[key] == value for key, value in before.items())
    assert result["production_promoted"] is False


@pytest.mark.asyncio
async def test_failed_restore_readback_never_publishes_success_report(tmp_path):
    storage, directory, _ = await archive(tmp_path)
    storage.corrupt_readback = True
    with pytest.raises(ValueError, match="readback"):
        await snapshots.restore(storage, directory, target_bucket="private", target_prefix="restore-drills/test-1234/",
                                confirm_prefix="restore-drills/test-1234/", report=tmp_path / "result.json")
    assert not (tmp_path / "result.json").exists()
    assert storage.uploads[0][1].endswith(".reservation.json")
    # Reservation remains, so another attempt cannot overwrite an ambiguous partial restore.
    with pytest.raises(ValueError, match="occupied"):
        await snapshots.restore(storage, directory, target_bucket="private", target_prefix="restore-drills/test-1234/",
                                confirm_prefix="restore-drills/test-1234/", report=tmp_path / "result.json")


@pytest.mark.asyncio
async def test_moving_inventory_and_wrong_reference_hash_cannot_create_complete_archive(tmp_path):
    storage = Storage()
    storage.change_after_download = True
    with pytest.raises(ValueError, match="changed"):
        await archive(tmp_path, storage)
    assert not (tmp_path / "snapshot" / "manifest.json").exists()
    refs = [{"bucket": "public", "key": "brand/product/original.jpg", "sha1": "0" * 40}]
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(ExceptionGroup):
        await archive(other, refs=refs)
    assert not (other / "snapshot" / "manifest.json").exists()


def entry(key):
    return {"id": "object-id", "name": key, "metadata": {"size": 7, "mimetype": "image/jpeg"}, "version": "1"}


def page(objects, next_cursor=None):
    return httpx.Response(200, json={"objects": objects, "folders": [], "hasNext": next_cursor is not None, "nextCursor": next_cursor})


@pytest.mark.asyncio
async def test_flat_inventory_follows_cursor_and_preserves_full_nested_keys():
    driver = SupabaseStorageDriver(url="https://storage.test", service_role_key="test")
    driver._request = AsyncMock(side_effect=[page([entry("brand/p1/original.jpg")], "cursor-1"), page([entry("brand/p2/original.jpg")])])
    rows = [row async for row in driver.iter_objects(bucket="public", page_size=1)]
    assert [row["key"] for row in rows] == ["brand/p1/original.jpg", "brand/p2/original.jpg"]
    assert driver._request.await_args_list[1].kwargs["json"]["cursor"] == "cursor-1"
    assert driver._request.await_args_list[0].kwargs["json"]["with_delimiter"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("responses", [
    [page([entry("same.jpg")], "cursor"), page([entry("other.jpg")], "cursor")],
    [page([entry("same.jpg")], "cursor"), page([entry("same.jpg")])],
    [page([entry("../unsafe.jpg")])],
    [httpx.Response(200, json={"folders": ["nested"], "objects": [], "hasNext": False})],
    [httpx.Response(403, text="customer secret must not escape")],
])
async def test_inventory_rejects_cycles_duplicates_unsafe_keys_and_provider_errors(responses):
    driver = SupabaseStorageDriver(url="https://storage.test", service_role_key="test")
    driver._request = AsyncMock(side_effect=responses)
    with pytest.raises(StorageError) as error:
        _ = [row async for row in driver.iter_objects(bucket="public")]
    assert "customer secret" not in str(error.value)


def kitchen_logical_snapshot(tmp_path, content):
    directory = tmp_path / "logical"
    directory.mkdir(mode=0o700)
    attachment = {"bucket": "private", "storage_key": "kitchen/second-floor/synthetic/drawing",
                  "sha256": hashlib.sha256(content).hexdigest(), "size_bytes": len(content)}
    data = (json_util.dumps({"_id": "synthetic-project", "attachments": [attachment]},
                           json_options=json_util.CANONICAL_JSON_OPTIONS) + "\n").encode()
    snapshots.write_private(directory / "kitchen_projects.jsonl", data)
    snapshots.write_json(directory / "manifest.json", {"format": 1, "collections": {
        "kitchen_projects": {"count": 1, "sha256": hashlib.sha256(data).hexdigest()}}})
    return directory, attachment


@pytest.mark.asyncio
async def test_kitchen_logical_references_bind_actual_bytes_and_restore_privately(tmp_path):
    content = b"AC1032" + bytes(32)
    logical, attachment = kitchen_logical_snapshot(tmp_path, content)
    refs = snapshots.references(logical)
    assert refs == [{"bucket": "private", "key": attachment["storage_key"],
                     "sha256": attachment["sha256"], "size_bytes": len(content)}]
    storage = Storage()
    storage.data[("private", attachment["storage_key"])] = content
    storage.types[("private", attachment["storage_key"])] = "image/vnd.dwg"
    _, archive_path, manifest = await archive(tmp_path, storage, refs)
    assert manifest["reference_coverage_complete"] is True
    assert manifest["reference_rows"] == 1
    assert manifest["missing_references"] == []
    restored = await snapshots.restore(storage, archive_path, target_bucket="private",
                                      target_prefix="restore-drills/kitchen-test-1234/",
                                      confirm_prefix="restore-drills/kitchen-test-1234/",
                                      report=tmp_path / "kitchen-restore.json")
    assert restored["objects_verified"] == 3
    assert storage.data[("private", "restore-drills/kitchen-test-1234/private/" + attachment["storage_key"])] == content
    assert storage.data[("private", attachment["storage_key"])] == content
    assert restored["production_promoted"] is False


@pytest.mark.asyncio
async def test_missing_kitchen_object_cannot_be_reported_as_complete_reference_coverage(tmp_path):
    logical, attachment = kitchen_logical_snapshot(tmp_path, b"private-kitchen-file")
    _, _, manifest = await archive(tmp_path, refs=snapshots.references(logical))
    assert manifest["reference_coverage_complete"] is False
    assert manifest["missing_references"] == [{"bucket": "private", "key": attachment["storage_key"]}]


@pytest.mark.asyncio
@pytest.mark.parametrize("problem", ["hash", "size"])
async def test_changed_kitchen_reference_bytes_fail_before_archive_completion(tmp_path, problem):
    logical, attachment = kitchen_logical_snapshot(tmp_path, b"expected-kitchen-bytes")
    storage = Storage()
    storage.data[("private", attachment["storage_key"])] = (b"different-kitchen-byte" if problem == "hash" else b"short")
    with pytest.raises(ExceptionGroup):
        await archive(tmp_path, storage, snapshots.references(logical))
    assert not (tmp_path / "snapshot/manifest.json").exists()
    assert storage.uploads == []


def test_tampered_kitchen_logical_reference_file_is_not_trusted(tmp_path):
    logical, _ = kitchen_logical_snapshot(tmp_path, b"private-kitchen-file")
    (logical / "kitchen_projects.jsonl").write_text('{}\n')
    with pytest.raises(ValueError, match="checksum"):
        snapshots.references(logical)
