"""Verified BSON snapshots; restore only into a new, isolated database.

This is a logical export, not an Atlas point-in-time backup. Freeze writes for
a consistent disaster-recovery cut, or use Atlas PITR. Media bytes need their
own storage backup. No credentials or document contents are printed.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path

from bson import json_util
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import OperationFailure

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SAFE_NAME = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]*$")
COMMAND_PHASES = frozenset({
    "arguments", "configuration", "verify", "pull", "upload",
    "backup-export", "backup-private-upload", "restore",
})


def safe_recovery_error(exc: Exception, *, phase: str) -> dict:
    """Allowlist diagnostic fields; never return provider messages or bodies."""
    detail = {
        "complete": False,
        "exception_type": type(exc).__name__,
        "phase": phase if isinstance(phase, str) and phase in COMMAND_PHASES else "unknown",
    }
    code = getattr(exc, "code", None)
    if type(code) is int:
        detail["provider_code"] = code
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "response", None), "status_code", None)
    if type(status) is int and 100 <= status <= 599:
        detail["status_code"] = status
    if isinstance(exc, OperationFailure):
        # Atlas code 8000 is generic: it is not proof of a storage quota.
        # Inspect only the provider's errmsg, never arbitrary detail fields
        # that could contain echoed customer data. Without details, args[0]
        # is the original provider message rather than an appended body.
        provider_details = exc.details
        fields = provider_details if isinstance(provider_details, Mapping) else {}
        message = (fields.get("errmsg", "") if provider_details is not None
                   else exc.args[0] if exc.args else "")
        code_name = fields.get("codeName")
        quota_code = isinstance(code_name, str) and code_name in {
            "StorageQuotaExceeded", "DiskQuotaExceeded", "SpaceQuotaExceeded",
        }
        quota_message = isinstance(message, str) and bool(re.search(
            r"(?:\b(?:you are|database is|storage is) over (?:your |the |its )?(?:space|storage|disk) quota\b"
            r"|\bexceeded (?:your |the |its )?(?:space|storage|disk) quota\b"
            r"|\b(?:space|storage|disk) quota (?:has been |is )?(?:exceeded|reached|full)\b)",
            message, flags=re.IGNORECASE,
        ))
        if quota_code or quota_message:
            detail["category"] = "storage_quota_exceeded"
    return detail


def safe_name(name: str) -> str:
    if not SAFE_NAME.fullmatch(name) or name in {".", ".."}:
        raise ValueError("Unsafe database or collection name")
    return name


def private_write(path: Path, data: bytes) -> None:
    with path.open("xb") as stream:
        os.chmod(path, 0o600)
        stream.write(data)


def read_manifest(directory: Path) -> dict:
    manifest = json_util.loads((directory / "manifest.json").read_text())
    if manifest.get("format") != 1 or not manifest.get("collections"):
        raise ValueError("Unsupported or empty snapshot manifest")
    for name, entry in manifest["collections"].items():
        safe_name(name)
        path = directory / f"{name}.jsonl"
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Missing collection file: {name}")
        digest = hashlib.sha256()
        count = 0
        with path.open("rb") as stream:
            for line in stream:
                digest.update(line)
                doc = json_util.loads(line)
                if not isinstance(doc, dict) or "_id" not in doc:
                    raise ValueError(f"Missing BSON identity: {name}")
                count += 1
        if count != entry["count"] or digest.hexdigest() != entry["sha256"]:
            raise ValueError(f"Snapshot checksum/count mismatch: {name}")
    return manifest


async def export_database(db, directory: Path) -> dict:
    directory.mkdir(parents=True, mode=0o700, exist_ok=False)
    manifest = {"format": 1, "source_database": db.name,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "consistency": "logical export; freeze writes or use Atlas PITR",
                "excluded": ["user_sessions", "system collections", "views"],
                "collections": {}}
    cursor = await db.list_collections()
    async for info in cursor:
        name = info["name"]
        if name.startswith("system.") or name == "user_sessions" or info.get("type") == "view":
            continue
        safe_name(name)
        digest = hashlib.sha256()
        count = 0
        path = directory / f"{name}.jsonl"
        with path.open("xb") as stream:
            os.chmod(path, 0o600)
            async for doc in db[name].find({}).batch_size(500):
                line = (json_util.dumps(doc, json_options=json_util.CANONICAL_JSON_OPTIONS) + "\n").encode()
                stream.write(line)
                digest.update(line)
                count += 1
        indexes = [dict(index) async for index in db[name].list_indexes()]
        options = info.get("options", {})
        manifest["collections"][name] = {
            "count": count, "sha256": digest.hexdigest(),
            "indexes": indexes, "options": options,
        }
        print(f"Exported {name}: {count} records")
    # The manifest is the completion marker; incomplete exports have no marker.
    if not manifest["collections"]:
        raise ValueError("No collections exported")
    private_write(directory / "manifest.json", json_util.dumps(manifest, indent=2).encode())
    read_manifest(directory)
    return manifest


async def upload_verified(directory: Path, storage, bucket: str) -> None:
    manifest = read_manifest(directory)
    if bucket == os.environ.get("SUPABASE_PUBLIC_BUCKET", "forge-products"):
        raise ValueError("Database backups must use the private bucket")
    await storage.require_private_bucket(bucket)
    safe_name(directory.name)

    async def upload_or_verify(key, data, content_type, completion=False):
        existing = await storage.exists(bucket=bucket, key=key)
        created = False
        try:
            if not existing:
                try:
                    await storage.upload(bucket=bucket, key=key, data=data,
                                         content_type=content_type, upsert=False,
                                         cache_control="private, no-store")
                except Exception:
                    if completion:
                        # The provider may have committed a create before the
                        # client timed out. Accept only an exact byte readback;
                        # never delete a marker with uncertain ownership.
                        try:
                            committed = await storage.download(bucket=bucket, key=key)
                            if hashlib.sha256(committed).digest() == hashlib.sha256(data).digest():
                                return
                        except Exception:
                            pass
                        print(f"Ambiguous completion upload; quarantine snapshot {directory.name} until verified", file=sys.stderr)
                    raise
                created = True
            downloaded = await storage.download(bucket=bucket, key=key)
            if hashlib.sha256(downloaded).digest() != hashlib.sha256(data).digest():
                raise ValueError("Remote snapshot verification failed")
        except Exception:
            if completion and created:
                try:
                    await storage.delete(bucket=bucket, key=key)
                except Exception:
                    print("Completion marker cleanup failed; quarantine this remote snapshot", file=sys.stderr)
            raise
    manifest["remote_parts"] = {}
    for name in manifest["collections"]:
        parts = []
        with (directory / f"{name}.jsonl").open("rb") as stream:
            while data := stream.read(8 * 1024 * 1024):
                part = f"{name}.jsonl.part-{len(parts):05d}"
                key = f"recovery/{directory.name}/{part}"
                await upload_or_verify(key, data, "application/octet-stream")
                parts.append(part)
        manifest["remote_parts"][name] = parts
    # Manifest appears only after every bounded chunk is verified.
    data = json_util.dumps(manifest, indent=2).encode()
    key = f"recovery/{directory.name}/manifest.json"
    await upload_or_verify(key, data, "application/json", completion=True)
    print("Private remote snapshot upload and byte verification passed")


async def restore_database(directory: Path, db, confirm_database: str) -> dict:
    manifest = read_manifest(directory)
    safe_name(db.name)
    if confirm_database != db.name or db.name == manifest["source_database"]:
        raise ValueError("Restore requires an explicitly confirmed database different from the source")
    if await db.list_collection_names():
        raise ValueError("Restore target must be empty; use a new isolated database")
    # Validate every file before the first write; preserve BSON identities/types
    # and index options instead of inventing an upsert key for legacy records.
    for name, entry in manifest["collections"].items():
        await db.create_collection(name, **entry.get("options", {}))
        batch = []
        with (directory / f"{name}.jsonl").open("rb") as stream:
            for line in stream:
                batch.append(json_util.loads(line))
                if len(batch) == 500:
                    await db[name].insert_many(batch, ordered=True)
                    batch = []
        if batch:
            await db[name].insert_many(batch, ordered=True)
        for index in entry["indexes"]:
            if index["name"] == "_id_":
                continue
            options = {key: value for key, value in index.items() if key not in {"key", "v", "ns"}}
            await db[name].create_index(list(index["key"].items()), **options)
        if await db[name].count_documents({}) != entry["count"]:
            raise ValueError(f"Restored count mismatch: {name}")
        print(f"Restored {name}: {entry['count']} records")
    return manifest


async def pull_verified(directory: Path, storage, bucket: str, snapshot: str) -> None:
    await storage.require_private_bucket(bucket)
    safe_name(snapshot)
    prefix = f"recovery/{snapshot}"
    raw = await storage.download(bucket=bucket, key=f"{prefix}/manifest.json")
    manifest = json_util.loads(raw)
    if manifest.get("format") != 1 or not manifest.get("collections"):
        raise ValueError("Unsupported or empty remote snapshot")
    names = [safe_name(name) for name in manifest["collections"]]
    directory.mkdir(parents=True, mode=0o700, exist_ok=False)
    for name in names:
        parts = manifest.get("remote_parts", {}).get(name, [f"{name}.jsonl"])
        path = directory / f"{name}.jsonl"
        with path.open("xb") as stream:
            os.chmod(path, 0o600)
            for part in parts:
                safe_name(part)
                data = await storage.download(bucket=bucket, key=f"{prefix}/{part}")
                stream.write(data)
    private_write(directory / "manifest.json", raw)
    read_manifest(directory)
    print("Downloaded snapshot verified; no database writes")


async def main(*, diagnostics: dict | None = None) -> None:
    diagnostics = diagnostics if diagnostics is not None else {}
    diagnostics["phase"] = "arguments"
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    backup = commands.add_parser("backup")
    backup.add_argument("--output", required=True, type=Path)
    backup.add_argument("--upload-private", action="store_true")
    upload = commands.add_parser("upload")
    upload.add_argument("snapshot", type=Path)
    verify = commands.add_parser("verify")
    verify.add_argument("snapshot", type=Path)
    restore = commands.add_parser("restore")
    restore.add_argument("snapshot", type=Path)
    restore.add_argument("--target-db", required=True)
    restore.add_argument("--confirm-database", required=True)
    pull = commands.add_parser("pull")
    pull.add_argument("snapshot")
    pull.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.command == "verify":
        diagnostics["phase"] = "verify"
        manifest = read_manifest(args.snapshot)
        print(f"Snapshot verified: {len(manifest['collections'])} collections")
        return
    diagnostics["phase"] = "configuration"
    load_dotenv(ROOT / ".env")
    if args.command in {"pull", "upload"}:
        diagnostics["phase"] = args.command
        from media_storage.factory import get_media_storage, private_bucket
        storage = get_media_storage()
        try:
            if args.command == "pull":
                await pull_verified(args.output, storage, private_bucket(), args.snapshot)
            else:
                await upload_verified(args.snapshot, storage, private_bucket())
        finally:
            await storage.close()
        return
    client = AsyncIOMotorClient(os.environ["MONGO_URL"], serverSelectionTimeoutMS=10000)
    try:
        if args.command == "restore":
            diagnostics["phase"] = "restore"
            await restore_database(args.snapshot, client[safe_name(args.target_db)], args.confirm_database)
        else:
            diagnostics["phase"] = "backup-export"
            await export_database(client[os.environ["DB_NAME"]], args.output)
            if args.upload_private:
                diagnostics["phase"] = "backup-private-upload"
                from media_storage.factory import get_media_storage, private_bucket
                storage = get_media_storage()
                try:
                    await upload_verified(args.output, storage, private_bucket())
                finally:
                    await storage.close()
    finally:
        client.close()


def run_cli() -> int:
    diagnostics = {"phase": "arguments"}
    try:
        asyncio.run(main(diagnostics=diagnostics))
    except Exception as exc:
        print(json.dumps(safe_recovery_error(exc, phase=diagnostics["phase"])), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(run_cli())
