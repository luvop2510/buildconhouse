"""Private, byte-verified storage snapshots and isolated restore drills.

This captures current objects, not deleted versions or a point-in-time cut.
The separate recovery/ database archives are excluded explicitly. Restores
always use a fresh prefix in a verified private bucket; they never publish
images, rewrite database references, or overwrite production objects.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from bson import json_util

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
FORMAT = "forge-storage-snapshot-v1"
MAX_OBJECT_BYTES = 128 * 1024 * 1024
HEX = re.compile(r"^[a-f0-9]{64}$")
PREFIX = re.compile(r"^restore-drills/[A-Za-z0-9][A-Za-z0-9_-]{7,79}/$")


def key_ok(key: str) -> bool:
    return (isinstance(key, str) and bool(key)
            and not any(p in {"", ".", ".."} for p in key.split("/"))
            and not any(c in key for c in "\0\r\n"))


def identity(row: dict) -> tuple[str, str]:
    bucket, key = row.get("bucket"), row.get("key")
    if (not isinstance(bucket, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", bucket)
            or bucket in {".", ".."} or not key_ok(key)):
        raise ValueError("Unsafe storage identity")
    return bucket, key


def filename(row: dict) -> str:
    bucket, key = identity(row)
    return hashlib.sha256((bucket + "\0" + key).encode()).hexdigest() + ".bin"


def write_private(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def write_json(path: Path, value: dict) -> None:
    write_private(path, json.dumps(value, sort_keys=True, indent=2).encode())


def safe_directory(directory: Path) -> None:
    if directory.is_symlink() or not directory.is_dir() or directory.stat().st_mode & 0o077:
        raise ValueError("Snapshot directory must be private and regular")


def read_regular(path: Path) -> bytes:
    # O_NOFOLLOW avoids accepting a symlink substituted between checking and opening.
    import stat
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > MAX_OBJECT_BYTES:
            raise ValueError("Snapshot file must be private and regular")
        return stream.read()


def references(snapshot: Path | None) -> list[dict]:
    if snapshot is None:
        return []
    safe_directory(snapshot)
    manifest = json.loads(read_regular(snapshot / "manifest.json"))
    collections = manifest.get("collections", {})
    if manifest.get("format") != 1 or not isinstance(collections, dict) or not any(
            name in collections for name in ("product_media", "kitchen_projects")):
        raise ValueError("Missing logical snapshot media references")
    result = []
    for name in ("product_media", "kitchen_projects"):
        if name not in collections:
            continue
        record = collections[name]
        if not isinstance(record, dict):
            raise ValueError("Invalid logical snapshot reference manifest")
        data = read_regular(snapshot / f"{name}.jsonl")
        rows = [json_util.loads(line) for line in data.splitlines()]
        if hashlib.sha256(data).hexdigest() != record.get("sha256") or len(rows) != record.get("count"):
            raise ValueError("Logical snapshot reference checksum mismatch")
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("Invalid logical snapshot record")
            if name == "product_media":
                result.append({"bucket": row.get("bucket"), "key": row.get("storage_key"), "sha1": row.get("sha1")})
                continue
            attachments = row.get("attachments", [])
            if not isinstance(attachments, list):
                raise ValueError("Invalid Kitchen attachment references")
            for attachment in attachments:
                if not isinstance(attachment, dict):
                    raise ValueError("Invalid Kitchen attachment reference")
                digest, size = attachment.get("sha256"), attachment.get("size_bytes")
                if not isinstance(digest, str) or not HEX.fullmatch(digest) or type(size) is not int or not 0 <= size <= MAX_OBJECT_BYTES:
                    raise ValueError("Invalid Kitchen attachment checksum or size")
                result.append({"bucket": attachment.get("bucket"), "key": attachment.get("storage_key"),
                               "sha256": digest, "size_bytes": size})
    for reference in result:
        identity(reference)
    return result


async def inventory(storage, buckets: list[str], private_bucket: str) -> list[dict]:
    if len(buckets) != len(set(buckets)) or private_bucket not in buckets:
        raise ValueError("Invalid storage scope")
    await storage.require_private_bucket(private_bucket)
    rows, seen = [], set()
    for bucket in buckets:
        async for row in storage.iter_objects(bucket=bucket):
            pair = identity(row)
            if pair[0] != bucket or pair in seen:
                raise ValueError("Repeated or out-of-scope storage object")
            seen.add(pair)
            if bucket == private_bucket and row["key"].startswith("recovery/"):
                continue
            size = row.get("size_bytes")
            mime = row.get("content_type")
            if (type(size) is not int or not 0 <= size <= MAX_OBJECT_BYTES
                    or not isinstance(mime, str) or not mime or any(c in mime for c in "\r\n\0")):
                raise ValueError("Unsupported object metadata")
            rows.append(row)
    return sorted(rows, key=identity)


def verify(directory: Path) -> dict:
    safe_directory(directory)
    manifest = json.loads(read_regular(directory / "manifest.json"))
    if (manifest.get("format") != FORMAT or manifest.get("archive_complete") is not True
            or not isinstance(manifest.get("objects"), list) or not isinstance(manifest.get("missing_references"), list)
            or type(manifest.get("reference_coverage_complete")) is not bool
            or type(manifest.get("reference_check_performed")) is not bool
            or manifest["reference_coverage_complete"] != (manifest["reference_check_performed"] and not manifest["missing_references"])):
        raise ValueError("Incomplete or unsupported storage snapshot")
    seen, total = set(), 0
    for row in manifest["objects"]:
        pair = identity(row)
        if pair in seen or row.get("file") != filename(row):
            raise ValueError("Repeated identity or unsafe snapshot file")
        seen.add(pair)
        digest, size = row.get("sha256"), row.get("size_bytes")
        if not isinstance(digest, str) or not HEX.fullmatch(digest) or type(size) is not int or not 0 <= size <= MAX_OBJECT_BYTES:
            raise ValueError("Invalid snapshot checksum or size")
        mime = row.get("content_type")
        if not isinstance(mime, str) or not mime or any(c in mime for c in "\r\n\0"):
            raise ValueError("Invalid snapshot content type")
        data = read_regular(directory / row["file"])
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("Storage snapshot bytes failed verification")
        total += size
    if manifest.get("object_count") != len(seen) or manifest.get("total_bytes") != total:
        raise ValueError("Storage snapshot totals mismatch")
    return manifest


async def backup(storage, directory: Path, *, buckets: list[str], private_bucket: str,
                 refs: list[dict], concurrency: int = 6, progress=None) -> dict:
    if type(concurrency) is not int or not 1 <= concurrency <= 8:
        raise ValueError("Invalid worker count")
    rows = await inventory(storage, buckets, private_bucket)
    directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    safe_directory(directory)
    started = datetime.now(timezone.utc).isoformat()
    expected, expected_sha256, expected_size = {}, {}, {}
    for row in refs:
        pair = identity(row)
        sha1 = row.get("sha1")
        if sha1 is not None and (not isinstance(sha1, str) or not re.fullmatch(r"[a-f0-9]{40}", sha1)):
            raise ValueError("Invalid media reference checksum")
        expected.setdefault(pair, set()).add(sha1)
        digest, size = row.get("sha256"), row.get("size_bytes")
        if digest is not None:
            if not isinstance(digest, str) or not HEX.fullmatch(digest):
                raise ValueError("Invalid reference SHA256 checksum")
            expected_sha256.setdefault(pair, set()).add(digest)
        if size is not None:
            if type(size) is not int or not 0 <= size <= MAX_OBJECT_BYTES:
                raise ValueError("Invalid reference size")
            expected_size.setdefault(pair, set()).add(size)
    available = {identity(row) for row in rows}
    missing = [{"bucket": b, "key": k} for b, k in sorted(set(expected) - available)]
    write_json(directory / "inventory.json", {"format": FORMAT, "started_at": started, "objects": rows,
                                             "missing_references": missing})
    pending, saved = iter(rows), []

    async def worker():
        while (row := next(pending, None)) is not None:
            data = await storage.download(bucket=row["bucket"], key=row["key"])
            if len(data) != row["size_bytes"]:
                raise ValueError("Source object size changed")
            sha1 = hashlib.sha1(data).hexdigest()
            if any(value is not None and value != sha1 for value in expected.get(identity(row), set())):
                raise ValueError("Source object disagrees with media reference checksum")
            digest = hashlib.sha256(data).hexdigest()
            if any(value != digest for value in expected_sha256.get(identity(row), set())) or any(
                    value != len(data) for value in expected_size.get(identity(row), set())):
                raise ValueError("Source object disagrees with Kitchen reference checksum or size")
            name = filename(row)
            write_private(directory / name, data)
            saved.append({**row, "file": name, "sha256": digest})
            if progress and (len(saved) % 250 == 0 or len(saved) == len(rows)):
                progress(len(saved), len(rows))

    async with asyncio.TaskGroup() as group:
        for _ in range(min(concurrency, len(rows))):
            group.create_task(worker())
    # A moving source is retained as an incomplete archive, never certified.
    if await inventory(storage, buckets, private_bucket) != rows:
        raise ValueError("Storage inventory changed during backup")
    manifest = {"format": FORMAT, "archive_complete": True, "reference_coverage_complete": bool(refs) and not missing,
                "reference_rows": len(refs), "reference_check_performed": bool(refs),
                "missing_references": missing, "started_at": started,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "excluded": [{"bucket": private_bucket, "prefix": "recovery/",
                              "reason": "separately verified logical database snapshots"}],
                "objects": sorted(saved, key=identity), "object_count": len(saved),
                "total_bytes": sum(row["size_bytes"] for row in saved),
                "point_in_time": False, "deleted_versions_included": False}
    write_json(directory / "manifest.json", manifest)
    verify(directory)
    return manifest


async def restore(storage, directory: Path, *, target_bucket: str, target_prefix: str,
                  confirm_prefix: str, report: Path, progress=None) -> dict:
    # Verify every file before creating even the reservation marker.
    manifest = verify(directory)
    if not PREFIX.fullmatch(target_prefix) or confirm_prefix != target_prefix:
        raise ValueError("Restore needs an explicitly confirmed fresh drill prefix")
    if report.exists() or report.is_symlink():
        raise ValueError("Restore report must be new")
    safe_directory(report.parent)
    await storage.require_private_bucket(target_bucket)
    # Sharing a private bucket is allowed, sharing any source key is not.
    destinations = [(row, f"{target_prefix}{row['bucket']}/{row['key']}") for row in manifest["objects"]]
    source_keys = {(row["bucket"], row["key"]) for row in manifest["objects"]}
    if any((target_bucket, key) in source_keys for _, key in destinations):
        raise ValueError("Restore overlaps source objects")
    if [row async for row in storage.iter_objects(bucket=target_bucket, prefix=target_prefix)]:
        raise ValueError("Restore target prefix is occupied")
    marker_key = target_prefix + ".reservation.json"
    marker = json.dumps({"format": FORMAT, "snapshot_sha256": hashlib.sha256(read_regular(directory / "manifest.json")).hexdigest()}).encode()
    await storage.upload(bucket=target_bucket, key=marker_key, data=marker, content_type="application/json",
                         upsert=False, cache_control="private, no-store")
    if await storage.download(bucket=target_bucket, key=marker_key) != marker:
        raise ValueError("Restore reservation verification failed")
    verified = 0
    for row, key in destinations:
        data = read_regular(directory / row["file"])
        # Recheck immediately before upload as well as preflighting all files.
        if len(data) != row["size_bytes"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise ValueError("Snapshot changed during restore")
        await storage.upload(bucket=target_bucket, key=key, data=data, content_type=row["content_type"],
                             upsert=False, cache_control="private, no-store")
        if await storage.download(bucket=target_bucket, key=key) != data:
            raise ValueError("Restored object readback failed")
        verified += 1
        if progress and (verified % 250 == 0 or verified == len(destinations)):
            progress(verified, len(destinations))
    restored = [row async for row in storage.iter_objects(bucket=target_bucket, prefix=target_prefix)]
    expected_inventory = {key: (row["size_bytes"], row["content_type"]) for row, key in destinations}
    expected_inventory[marker_key] = (len(marker), "application/json")
    if {row["key"]: (row["size_bytes"], row["content_type"]) for row in restored} != expected_inventory:
        raise ValueError("Restore destination inventory or MIME disagrees with archive")
    result = {"format": FORMAT, "archived_objects_restored": True, "objects_verified": verified,
              "source_reference_coverage_complete": manifest["reference_coverage_complete"],
              "missing_reference_count": len(manifest["missing_references"]),
              "target_bucket": target_bucket, "target_prefix": target_prefix,
              "completed_at": datetime.now(timezone.utc).isoformat(), "production_promoted": False}
    write_json(report, result)
    return result


def public_result(manifest: dict) -> dict:
    return {key: manifest[key] for key in ("archive_complete", "reference_coverage_complete", "reference_check_performed",
            "object_count", "total_bytes", "point_in_time") if key in manifest} | {
        "missing_reference_count": len(manifest.get("missing_references", []))}


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    back = sub.add_parser("backup")
    back.add_argument("--output", type=Path, required=True)
    back.add_argument("--logical-snapshot", type=Path, required=True)
    back.add_argument("--concurrency", type=int, default=6)
    check = sub.add_parser("verify")
    check.add_argument("directory", type=Path)
    drill = sub.add_parser("restore-drill")
    drill.add_argument("directory", type=Path)
    drill.add_argument("--target-prefix", required=True)
    drill.add_argument("--confirm-prefix", required=True)
    drill.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "verify":
        print(json.dumps(public_result(verify(args.directory))))
        return
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    from media_storage import get_media_storage
    from settings import settings
    storage = get_media_storage()
    progress = lambda done, total: print(f"Object bytes verified: {done}/{total}", file=sys.stderr, flush=True)
    try:
        if args.command == "backup":
            result = await backup(storage, args.output, buckets=[settings.supabase_public_bucket, settings.supabase_private_bucket],
                                  private_bucket=settings.supabase_private_bucket, refs=references(args.logical_snapshot),
                                  concurrency=args.concurrency, progress=progress)
            print(json.dumps(public_result(result)))
        else:
            result = await restore(storage, args.directory, target_bucket=settings.supabase_private_bucket,
                                   target_prefix=args.target_prefix, confirm_prefix=args.confirm_prefix,
                                   report=args.report, progress=progress)
            print(json.dumps({"archived_objects_restored": result["archived_objects_restored"],
                              "objects_verified": result["objects_verified"], "production_promoted": False}))
    finally:
        await storage.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(json.dumps({"complete": False, "exception_type": type(exc).__name__}), file=sys.stderr)
        raise SystemExit(1) from None
