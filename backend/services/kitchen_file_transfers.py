"""Bounded same-origin transport for private Kitchen files up to 25 MB.

512 KiB parts fit existing 1 MiB JSON request envelopes after base64 encoding.
Uncommitted parts live only in private Mongo staging, not project/file history.
One live staging slot per actor prevents unbounded parallel staging. Explicit
cancel or 24-hour expiry removes only unfinished transfer bytes. Committed
objects remain under the existing retention policy and storage abstraction.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import math
import tempfile
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from weakref import WeakKeyDictionary

from fastapi import HTTPException
from pydantic import Field, StrictInt
from typing import Literal
from pymongo.errors import DuplicateKeyError

from models_kitchen import CommandKey, StrictModel
from services import kitchen_access as access
from services.kitchen_attachments import validate_file_metadata, validate_upload_size
from services.kitchen_projects import KitchenProjectService, fingerprint

MAX_TRANSFER_BYTES = 25_000_000
CHUNK_BYTES = 512 * 1024
MAX_BASE64_LENGTH = 4 * math.ceil(CHUNK_BYTES / 3)
FINISH_LEASE_SECONDS = 60
_limits = WeakKeyDictionary()


def transfer_limit():
    loop = asyncio.get_running_loop()
    if loop not in _limits:
        _limits[loop] = asyncio.Semaphore(2)
    return _limits[loop]


class TransferStart(StrictModel):
    expected_version: StrictInt = Field(ge=1)
    idempotency_key: CommandKey
    filename: str = Field(min_length=1, max_length=200)
    content_type: str = Field(min_length=1, max_length=150)
    size_bytes: StrictInt = Field(ge=1)
    sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    purpose: Literal["attachment", "final_production"] = "attachment"


class TransferChunk(StrictModel):
    data_base64: str = Field(min_length=1, max_length=MAX_BASE64_LENGTH)


class TransferFinish(StrictModel):
    expected_version: StrictInt = Field(ge=1)


def now():
    return datetime.now(timezone.utc)


def decode_part(encoded, expected_length):
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(422, "Invalid transfer part encoding") from exc
    if len(data) != expected_length or len(data) > CHUNK_BYTES:
        raise HTTPException(413, "Transfer part length does not match its declared position")
    return data


class KitchenFileTransfers:
    def __init__(self, database):
        self.db = database
        self.projects = KitchenProjectService(database)

    async def authorized(self, user, project_id):
        policy = await self.projects.policy()
        project = await self.db.kitchen_projects.find_one({"id": project_id, "floor_id": access.KITCHEN_FLOOR})
        await access.require_project(self.db, user, project, policy, "update")
        await access.require_current_task(self.db, user, project, policy)
        if project.get("lifecycle_status") in {"On Hold", "Cancelled", "Lost"}:
            raise HTTPException(422, "Resume the project before uploading")
        return project, policy

    async def session(self, user, project_id, transfer_id):
        row = await self.db.kitchen_file_transfers.find_one({"_id": user.id, "project_id": project_id, "transfer_id": transfer_id})
        if not row:
            raise HTTPException(404, "File transfer not found")
        expiry = row["expires_at"]
        if expiry.replace(tzinfo=timezone.utc) <= now():
            raise HTTPException(410, "Unfinished transfer expired; choose the file again")
        return row

    def public(self, row):
        return {"transfer_id": row["transfer_id"], "filename": row["filename"], "size_bytes": row["size_bytes"], "chunk_bytes": CHUNK_BYTES,
                "part_count": math.ceil(row["size_bytes"] / CHUNK_BYTES), "state": row["state"],
                "expires_at": row["expires_at"].isoformat()}

    async def begin(self, user, project_id, body):
        project, policy = await self.authorized(user, project_id)
        kind = validate_file_metadata(body.content_type, body.filename, policy)
        access.require_upload(user, project, kind)
        if body.purpose == "final_production":
            await access.require_command(self.db, user, project, "production_document")
            if project["stage"] not in {"order", "production"} or kind != "application/pdf":
                raise HTTPException(422, "Final Production PDF requires an Order/Production project and a PDF")
        else:
            validate_upload_size(body.size_bytes, kind, policy)
        signature = fingerprint({"project_id": project_id, "filename": body.filename, "content_type": kind,
                                 "size_bytes": body.size_bytes, "sha256": body.sha256, **({"purpose": body.purpose} if body.purpose != "attachment" else {})})
        row = {"_id": user.id, "project_id": project_id, "transfer_id": str(uuid4()), "key": body.idempotency_key,
               "fingerprint": signature, "filename": body.filename, "content_type": kind,
               "size_bytes": body.size_bytes, "sha256": body.sha256, "purpose": body.purpose, "state": "open", "expires_at": now() + timedelta(hours=24)}
        existing = await self.db.kitchen_file_transfers.find_one({"_id": user.id})
        if existing:
            if existing["key"] == body.idempotency_key or (body.sha256 is not None and existing["fingerprint"] == signature):
                if existing["fingerprint"] != signature:
                    raise HTTPException(409, "This transfer key was used with another file")
                await self.session(user, project_id, existing["transfer_id"])
                return self.public(existing)
            if project["version"] != body.expected_version:
                raise HTTPException(409, "Kitchen project changed; reload before uploading")
            expired = existing["expires_at"].replace(tzinfo=timezone.utc) <= now()
            if existing["state"] != "completed" and not expired:
                raise HTTPException(409, "Another file transfer is unfinished; resume it or discard its temporary parts first")
            result = await self.db.kitchen_file_transfers.replace_one({"_id": user.id, "transfer_id": existing["transfer_id"]}, row)
            if not result.matched_count:
                raise HTTPException(409, "File transfer changed; retry")
            await self.db.kitchen_file_parts.delete_many({"transfer_id": existing["transfer_id"]})
        else:
            if project["version"] != body.expected_version:
                raise HTTPException(409, "Kitchen project changed; reload before uploading")
            try:
                await self.db.kitchen_file_transfers.insert_one(row)
            except DuplicateKeyError as exc:
                raise HTTPException(409, "File transfer already started; retry with the same key") from exc
        return self.public(row)

    async def put_part(self, user, project_id, transfer_id, index, body):
        project, policy = await self.authorized(user, project_id)
        row = await self.session(user, project_id, transfer_id)
        access.require_upload(user, project, row["content_type"])
        if row.get("purpose") == "final_production" and row["expires_at"].replace(tzinfo=timezone.utc) < now() + timedelta(hours=12):
            expiry = now() + timedelta(hours=24)
            renewed = await self.db.kitchen_file_transfers.update_one({"_id": user.id, "transfer_id": transfer_id, "state": "open"}, {"$set": {"expires_at": expiry}})
            if not renewed.matched_count:
                raise HTTPException(409, "File transfer changed; retry the part")
            await self.db.kitchen_file_parts.update_many({"transfer_id": transfer_id}, {"$set": {"expires_at": expiry}})
            row["expires_at"] = expiry
        kind = validate_file_metadata(row["content_type"], row["filename"], policy)
        if row.get("purpose") != "final_production":
            validate_upload_size(row["size_bytes"], kind, policy)
        if row["state"] != "open":
            raise HTTPException(409, "This transfer has already finished")
        count = math.ceil(row["size_bytes"] / CHUNK_BYTES)
        if not 0 <= index < count:
            raise HTTPException(422, "Transfer part index is outside the file")
        data = decode_part(body.data_base64, min(CHUNK_BYTES, row["size_bytes"] - index * CHUNK_BYTES))
        digest = hashlib.sha256(data).hexdigest()
        # Fixed actor/index slots keep late canceled requests inside the same
        # 48-part quota. A stale transfer can never replace a new transfer's
        # submitted bytes, and all cleanup matches the exact transfer identity.
        key = f"actor:{user.id}:{index}"
        for attempt in range(2):
            try:
                await self.db.kitchen_file_parts.insert_one({"_id": key, "transfer_id": transfer_id, "index": index,
                    "sha256": digest, "data": data, "expires_at": row["expires_at"]})
                break
            except DuplicateKeyError:
                prior = await self.db.kitchen_file_parts.find_one({"_id": key}, {"sha256": 1, "transfer_id": 1})
                if prior and prior["transfer_id"] == transfer_id:
                    if prior["sha256"] != digest:
                        raise HTTPException(409, "This part was already uploaded with different bytes")
                    break
                current = await self.db.kitchen_file_transfers.find_one({"_id": user.id, "transfer_id": transfer_id, "state": "open"})
                if not current or not prior or attempt:
                    raise HTTPException(409, "File transfer changed; retry the part")
                await self.db.kitchen_file_parts.delete_one({"_id": key, "transfer_id": prior["transfer_id"]})
        current = await self.db.kitchen_file_transfers.find_one({"_id": user.id, "transfer_id": transfer_id})
        if not current or current["state"] == "completed":
            await self.db.kitchen_file_parts.delete_one({"_id": key, "transfer_id": transfer_id})
            if not current:
                raise HTTPException(409, "File transfer was discarded; no part was retained")
        return {"index": index, "sha256": digest, "size_bytes": len(data)}

    async def finish(self, user, project_id, transfer_id, body, storage, bucket):
        project, policy = await self.authorized(user, project_id)
        row = await self.session(user, project_id, transfer_id)
        access.require_upload(user, project, row["content_type"])
        if row["state"] == "completed":
            return await self.projects.get(user, project_id)
        validate_file_metadata(row["content_type"], row["filename"], policy)
        if row["state"] == "finishing" and row.get("assembled_sha256"):
            project = await self.db.kitchen_projects.find_one({"id": project_id, "floor_id": access.KITCHEN_FLOOR})
            signature = fingerprint({"command": "attachment", "sha256": row["assembled_sha256"],
                                     "filename": row["filename"], "content_type": row["content_type"]})
            if any(receipt["actor_id"] == user.id and receipt["key"] == row["key"] and receipt["fingerprint"] == signature
                   for receipt in project["command_receipts"]):
                await self.db.kitchen_file_transfers.update_one({"_id": user.id, "transfer_id": transfer_id,
                    "state": "finishing", "finish_token": row.get("finish_token")}, {"$set": {"state": "completed"}})
                await self.db.kitchen_file_parts.delete_many({"transfer_id": transfer_id})
                return await self.projects.get(user, project_id)
        if row.get("purpose") != "final_production":
            validate_upload_size(row["size_bytes"], row["content_type"], policy)
        token = str(uuid4())
        selector = {"_id": user.id, "transfer_id": transfer_id, "state": "open"}
        if row["state"] == "finishing":
            # A dead worker's exact claim is recoverable after a short lease.
            # Recovered finalizers submit the same immutable bytes/command key;
            # the canonical attachment receipt and project CAS arbitrate any
            # old writer that finishes after losing its lease.
            selector.update(state="finishing", finish_token=row.get("finish_token"))
            selector["$or"] = [{"finish_lease_until": {"$lte": now()}}, {"finish_lease_until": {"$exists": False}}]
        claimed = await self.db.kitchen_file_transfers.update_one(
            selector, {"$set": {"state": "finishing", "finish_token": token,
                               "finish_lease_until": now() + timedelta(seconds=FINISH_LEASE_SECONDS)}})
        if not claimed.matched_count:
            raise HTTPException(409, "File finalization is in progress; retry after it finishes")
        lost = asyncio.Event()
        work = asyncio.create_task(self._finish(user, project_id, transfer_id, body, storage, bucket, token))
        async def renew():
            try:
                while True:
                    await asyncio.sleep(FINISH_LEASE_SECONDS / 3)
                    renewed = await self.db.kitchen_file_transfers.update_one(
                        {"_id": user.id, "transfer_id": transfer_id, "state": "finishing", "finish_token": token,
                         "finish_lease_until": {"$gt": now()}},
                        {"$set": {"finish_lease_until": now() + timedelta(seconds=FINISH_LEASE_SECONDS)}})
                    if not renewed.matched_count:
                        lost.set()
                        work.cancel()
                        return
                    if row.get("purpose") == "final_production" and row["expires_at"].replace(tzinfo=timezone.utc) < now() + timedelta(hours=12):
                        expiry = now() + timedelta(hours=24)
                        renewed = await self.db.kitchen_file_transfers.update_one(
                            {"_id": user.id, "transfer_id": transfer_id, "state": "finishing", "finish_token": token}, {"$set": {"expires_at": expiry}})
                        if not renewed.matched_count:
                            lost.set()
                            work.cancel()
                            return
                        await self.db.kitchen_file_parts.update_many({"transfer_id": transfer_id}, {"$set": {"expires_at": expiry}})
                        row["expires_at"] = expiry
            except asyncio.CancelledError:
                raise
            except Exception:
                lost.set()
                work.cancel()
        heartbeat = asyncio.create_task(renew())
        try:
            return await work
        except asyncio.CancelledError:
            if lost.is_set():
                raise HTTPException(409, "File finalization lease changed; retry safely") from None
            raise
        finally:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            cleanup = asyncio.ensure_future(self.db.kitchen_file_transfers.update_one(
                {"_id": user.id, "transfer_id": transfer_id, "state": "finishing", "finish_token": token},
                {"$set": {"state": "open"}, "$unset": {"finish_token": "", "finish_lease_until": ""}}))
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                await cleanup
                raise

    async def _finish(self, user, project_id, transfer_id, body, storage, bucket, token):
        await self.authorized(user, project_id)
        row = await self.session(user, project_id, transfer_id)
        if row["state"] == "completed":
            return await self.projects.get(user, project_id)
        if row.get("purpose") == "final_production":
            return await self._finish_production_pdf(user, project_id, transfer_id, body, storage, bucket, token, row)
        async with transfer_limit():
            content = bytearray()
            count = math.ceil(row["size_bytes"] / CHUNK_BYTES)
            # Fetch the bounded, exact slots together. Per-part find_one calls
            # added up to 48 serial database round trips before provider I/O,
            # consuming the ordinary request deadline for large files.
            # Include only exact legacy slots for an upload begun before the
            # fixed actor-slot transport was installed, preferring current slots.
            actor_slots = [f"actor:{user.id}:{index}" for index in range(count)]
            legacy_slots = [f"{transfer_id}:{index}" for index in range(count)]
            parts = await self.db.kitchen_file_parts.find({"$or": [
                {"_id": {"$in": actor_slots}, "transfer_id": transfer_id},
                {"_id": {"$in": legacy_slots}},
            ]}).limit(count * 2).to_list(count * 2)
            by_slot = {part["_id"]: part for part in parts}
            for index in range(count):
                part = by_slot.get(actor_slots[index]) or by_slot.get(legacy_slots[index])
                if not part:
                    raise HTTPException(409, "File transfer is incomplete; retry the missing parts")
                data = part["data"]
                if len(data) != min(CHUNK_BYTES, row["size_bytes"] - index * CHUNK_BYTES) or hashlib.sha256(data).hexdigest() != part["sha256"]:
                    raise HTTPException(409, "Transfer part integrity verification failed")
                content.extend(data)
            digest = hashlib.sha256(content).hexdigest()
            if row["sha256"] and digest != row["sha256"]:
                raise HTTPException(409, "Transferred file does not match its original checksum")
            owned = await self.db.kitchen_file_transfers.update_one({"_id": user.id, "transfer_id": transfer_id,
                "state": "finishing", "finish_token": token, "finish_lease_until": {"$gt": now()}},
                {"$set": {"assembled_sha256": digest}})
            if not owned.matched_count:
                raise HTTPException(409, "File finalization lease changed; retry safely")
            # Existing atomic attachment command retains current policy/task,
            # immutable-content, expected-version and idempotency checks.
            result = await self.projects.attach(user, project_id, expected_version=body.expected_version,
                key=row["key"], filename=row["filename"], content_type=row["content_type"], data=bytes(content),
                storage=storage, bucket=bucket, max_file_bytes=MAX_TRANSFER_BYTES)
            completed = await self.db.kitchen_file_transfers.update_one({"_id": user.id, "transfer_id": transfer_id,
                "state": "finishing", "finish_token": token},
                {"$set": {"state": "completed", "sha256": digest}})
            if completed.matched_count:
                await self.db.kitchen_file_parts.delete_many({"transfer_id": transfer_id})
            return result

    async def _finish_production_pdf(self, user, project_id, transfer_id, body, storage, bucket, token, row):
        project, _ = await self.authorized(user, project_id)
        access.require_upload(user, project, "application/pdf")
        await access.require_command(self.db, user, project, "production_document")
        if project["stage"] not in {"order", "production"}:
            raise HTTPException(422, "Final Production PDF requires Order/Production")
        if not hasattr(storage, "upload_private_file") or not hasattr(storage, "download_range"):
            raise HTTPException(503, "Private storage does not support large PDF uploads")
        count = math.ceil(row["size_bytes"] / CHUNK_BYTES)
        digest = hashlib.sha256()
        async with transfer_limit():
            with tempfile.TemporaryFile() as file:
                for first in range(0, count, 16):
                    slots = [f"actor:{user.id}:{index}" for index in range(first, min(first + 16, count))]
                    parts = await self.db.kitchen_file_parts.find({"_id": {"$in": slots}, "transfer_id": transfer_id}).to_list(len(slots))
                    by_slot = {part["_id"]: part for part in parts}
                    for index, slot in enumerate(slots, first):
                        part = by_slot.get(slot)
                        if not part:
                            raise HTTPException(409, "File transfer is incomplete; retry the missing parts")
                        data = part["data"]
                        if len(data) != min(CHUNK_BYTES, row["size_bytes"] - index * CHUNK_BYTES) or hashlib.sha256(data).hexdigest() != part["sha256"]:
                            raise HTTPException(409, "Transfer part integrity verification failed")
                        if index == 0 and not data.startswith(b"%PDF-"):
                            raise HTTPException(415, "Attachment content does not match PDF format")
                        digest.update(data)
                        file.write(data)
                checksum = digest.hexdigest()
                if row.get("sha256") and checksum != row["sha256"]:
                    raise HTTPException(409, "Transferred file does not match its original checksum")
                owned = await self.db.kitchen_file_transfers.update_one({"_id": user.id, "transfer_id": transfer_id,
                    "state": "finishing", "finish_token": token, "finish_lease_until": {"$gt": now()}},
                    {"$set": {"assembled_sha256": checksum}})
                if not owned.matched_count:
                    raise HTTPException(409, "File finalization lease changed; retry safely")
                object_key = f"kitchen/{access.KITCHEN_FLOOR}/{project_id}/{checksum}"
                await storage.require_private_bucket(bucket)
                if not await storage.exists(bucket=bucket, key=object_key):
                    file.seek(0)
                    await storage.upload_private_file(bucket=bucket, key=object_key, file=file, content_type="application/pdf")
                check = hashlib.sha256()
                for offset in range(0, row["size_bytes"], 8 * 1024 * 1024):
                    check.update(await storage.download_range(bucket=bucket, key=object_key, start=offset,
                        end=min(row["size_bytes"], offset + 8 * 1024 * 1024) - 1))
                if check.hexdigest() != checksum:
                    raise HTTPException(409, "Stored attachment failed immutable-content verification")
                metadata = {"id": checksum, "storage_key": object_key, "bucket": bucket, "sha256": checksum,
                    "size_bytes": row["size_bytes"], "content_type": "application/pdf", "filename": row["filename"], "uploaded_by": user.id, "stage": "production"}
                result = await self.projects.attach(user, project_id, expected_version=body.expected_version,
                    key=row["key"], filename=row["filename"], content_type="application/pdf", data=None,
                    storage=storage, bucket=bucket, prepared=metadata)
            completed = await self.db.kitchen_file_transfers.update_one({"_id": user.id, "transfer_id": transfer_id,
                "state": "finishing", "finish_token": token}, {"$set": {"state": "completed", "sha256": checksum}})
            if completed.matched_count:
                await self.db.kitchen_file_parts.delete_many({"transfer_id": transfer_id})
            return result

    async def cancel(self, user, project_id, transfer_id):
        # Canceling one's uncommitted bytes does not authorize project changes.
        await access.require_capability(self.db, user, "view")
        row = await self.db.kitchen_file_transfers.find_one({"_id": user.id, "project_id": project_id, "transfer_id": transfer_id})
        if not row:
            # The exact actor/project/transfer is already absent after a lost
            # acknowledgement. Do not touch another slot or any stored object.
            foreign = await self.db.kitchen_file_transfers.find_one({"project_id": project_id, "transfer_id": transfer_id}, {"_id": 1})
            if foreign:
                raise HTTPException(404, "File transfer not found")
            return {"discarded": True}
        if row["state"] != "open":
            raise HTTPException(409, "A finishing or committed file cannot be discarded")
        removed = await self.db.kitchen_file_transfers.delete_one({"_id": user.id, "transfer_id": transfer_id, "state": "open"})
        if not removed.deleted_count:
            current = await self.db.kitchen_file_transfers.find_one({"_id": user.id, "project_id": project_id, "transfer_id": transfer_id})
            if current:
                raise HTTPException(409, "File transfer changed; retry")
        await self.db.kitchen_file_parts.delete_many({"transfer_id": transfer_id})
        return {"discarded": True}


# One immutable object per event loop, at most 25 MB, for 45 seconds. Every
# part still rechecks current project read access. This avoids downloading a
# 25 MB provider object again for each small same-origin response. No tokens,
# signed URLs or public cache are involved; cache misses reverify full bytes.
_download_cache = WeakKeyDictionary()


async def download_part(database, user, project_id, attachment_id, index, storage, purpose="download"):
    import time
    projects = KitchenProjectService(database)
    policy = await projects.policy()
    project = await database.kitchen_projects.find_one({"id": project_id, "floor_id": access.KITCHEN_FLOOR})
    await access.require_project(database, user, project, policy)
    metadata = next((row for row in project["attachments"] if row["id"] == attachment_id), None)
    if not metadata:
        raise HTTPException(404, "Kitchen attachment not found")
    access.require_attachment(user, project, metadata, purpose)
    visible = access.visible_attachment_ids(project, user)
    if visible is not None and attachment_id not in visible:
        raise HTTPException(404, "Kitchen attachment not found")
    size = metadata["size_bytes"]
    if not 0 < size or not 0 <= index < math.ceil(size / CHUNK_BYTES):
        raise HTTPException(422, "Download part is outside the supported file")
    if size > MAX_TRANSFER_BYTES:
        if not hasattr(storage, "download_range"):
            raise HTTPException(503, "Private storage does not support large PDF downloads")
        await storage.require_private_bucket(metadata["bucket"])
        start = index * CHUNK_BYTES
        part = await storage.download_range(bucket=metadata["bucket"], key=metadata["storage_key"], start=start, end=min(size, start + CHUNK_BYTES) - 1)
        return {"index": index, "data_base64": base64.b64encode(part).decode("ascii"),
                "sha256": hashlib.sha256(part).hexdigest(), "file_sha256": metadata["sha256"], "size_bytes": size}
    loop = asyncio.get_running_loop()
    identity = (id(storage), metadata["bucket"], metadata["storage_key"], metadata["sha256"])
    async with transfer_limit():
        cached = _download_cache.get(loop)
        if not cached or cached[0] != identity or cached[1] < time.monotonic():
            await storage.require_private_bucket(metadata["bucket"])
            content = await storage.download(bucket=metadata["bucket"], key=metadata["storage_key"])
            if len(content) != size or hashlib.sha256(content).hexdigest() != metadata["sha256"]:
                raise HTTPException(409, "Attachment content failed integrity verification")
            cached = (identity, time.monotonic() + 45, content)
            _download_cache[loop] = cached
        part = cached[2][index * CHUNK_BYTES:(index + 1) * CHUNK_BYTES]
    return {"index": index, "data_base64": base64.b64encode(part).decode("ascii"),
            "sha256": hashlib.sha256(part).hexdigest(), "file_sha256": metadata["sha256"], "size_bytes": size}
