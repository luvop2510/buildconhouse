"""Revocable PDF snapshots for manually reviewed WhatsApp drafts.

Only a SHA256 token digest is persisted. Anyone holding the link can download
this one PDF for 24 hours; source deletion and explicit revocation invalidate
it immediately. Files stay private and are never exposed as signed store URLs.
Expired metadata is retained until cleanup so its private object can be removed.
"""
from __future__ import annotations

import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import HTTPException

from db import db
from media_storage import get_media_storage
from media_storage.factory import private_bucket

SHARE_TTL_SECONDS = 24 * 60 * 60


def whatsapp_phone(value: str | None) -> str | None:
    raw = str(value or "").strip()
    if not raw or not re.fullmatch(r"\+?[0-9\s().-]+", raw):
        return None
    digits = re.sub(r"[^0-9]", "", raw)
    international = raw.startswith("+") or digits.startswith("00")
    if digits.startswith("00"):
        digits = digits[2:]
    if not international and len(digits) == 10:
        # Buildcon's contact forms use Indian local mobile numbers.
        if digits[0] not in "6789":
            return None
        digits = "91" + digits
    if not 8 <= len(digits) <= 15 or digits.startswith("0"):
        return None
    return digits


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def create_share(doc: dict, data: bytes, filename: str, user_id: str) -> dict:
    storage = get_media_storage()
    bucket = private_bucket()
    await storage.require_private_bucket(bucket)
    token = secrets.token_urlsafe(32)
    key = f"quotation-shares/{doc['id']}/{uuid4()}.pdf"
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=SHARE_TTL_SECONDS)
    await storage.upload(bucket=bucket, key=key, data=data, content_type="application/pdf",
                         upsert=False, cache_control="private, no-store")
    try:
        await db.quotation_shares.insert_one({
            "token_hash": token_digest(token), "quotation_id": doc["id"],
            "customer_id": doc["customer_id"], "floor_id": doc.get("floor_id"),
            "bucket": bucket, "storage_key": key, "filename": filename,
            "created_by": user_id, "expires_at": expires_at,
        })
    except Exception:
        await storage.delete(bucket=bucket, key=key)
        raise
    return {"pdf_path": f"/api/quotations/shared-pdf/{token}", "filename": filename,
            "expires_at": expires_at.isoformat(), "expires_in": SHARE_TTL_SECONDS}


async def read_share(token: str) -> tuple[bytes, str]:
    not_found = HTTPException(status_code=404, detail="This PDF link has expired or was revoked. Ask for a new quotation link.")
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        raise not_found
    share = await db.quotation_shares.find_one({
        "token_hash": token_digest(token), "expires_at": {"$gt": datetime.now(timezone.utc)}, "revoked": {"$ne": True},
    }, {"_id": 0})
    if not share:
        raise not_found
    # A surviving token must never resurrect a deleted customer's data.
    quotation = await db.quotations.find_one({
        "id": share["quotation_id"], "customer_id": share["customer_id"], "floor_id": share["floor_id"],
    }, {"id": 1})
    customer = await db.customers.find_one({"id": share["customer_id"], "floor_id": share["floor_id"]}, {"id": 1})
    if not quotation or not customer:
        raise not_found
    data = await get_media_storage().download(bucket=share["bucket"], key=share["storage_key"])
    return data, share["filename"]


async def revoke_shares(quotation_id: str, floor_id: str | None) -> None:
    query = {"quotation_id": quotation_id, "floor_id": floor_id}
    # Revoke first but retain object keys until deletion succeeds, so storage
    # downtime cannot leave live links or undiscoverable customer snapshots.
    await db.quotation_shares.update_many(query, {"$set": {"revoked": True}})
    shares = await db.quotation_shares.find({**query, "revoked": True}, {"_id": 0}).to_list(length=None)
    storage = get_media_storage()
    for share in shares:
        await storage.delete(bucket=share["bucket"], key=share["storage_key"])
        await db.quotation_shares.delete_one({"token_hash": share["token_hash"]})


from pymongo.errors import OperationFailure


async def ensure_quotation_share_indexes() -> None:
    for keys, name, unique in [
        ([("token_hash", 1)], "quotation_shares_token_hash", True),
        ([("quotation_id", 1), ("floor_id", 1)], "quotation_shares_document", False),
        ([("expires_at", 1)], "quotation_shares_expiry", False),
    ]:
        try:
            await db.quotation_shares.create_index(keys, name=name, unique=unique)
        except OperationFailure as error:
            if error.code != 85:
                raise


async def cleanup_expired_shares(batch_size: int = 100) -> int:
    """Bounded storage-first cleanup; failed objects remain discoverable for retry."""
    shares = await db.quotation_shares.find(
        {"$or": [{"expires_at": {"$lte": datetime.now(timezone.utc)}}, {"revoked": True}]},
    ).limit(batch_size).to_list(length=batch_size)
    storage = get_media_storage()
    cleaned = 0
    for share in shares:
        await storage.delete(bucket=share["bucket"], key=share["storage_key"])
        await db.quotation_shares.delete_one({"token_hash": share["token_hash"]})
        cleaned += 1
    return cleaned
