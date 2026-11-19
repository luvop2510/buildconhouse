"""Keep revision-bound copies of explicitly generated Sanitary staff PDFs."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import re
from uuid import uuid4

from media_storage import get_media_storage
from media_storage.base import StorageError
from media_storage.factory import private_bucket

SANITARY_FLOOR = "first-floor"
ARCHIVE_KIND = "sanitary_staff_pdf"
ARCHIVE_PROJECTION = {
    "quotation_id": 1, "customer_id": 1, "quotation_updated_at": 1,
    "bucket": 1, "storage_key": 1, "filename": 1, "sha256": 1, "saved_at": 1,
}
ARCHIVE_MATCH = {
    "kind": ARCHIVE_KIND, "floor_id": SANITARY_FLOOR,
    "archive_state": "ready", "revoked": {"$ne": True}, "expires_at": None,
}


class SavedQuotationPdfUnavailable(Exception):
    """There is no verified saved PDF for this version."""


def _matches_document(row, doc) -> bool:
    return bool(
        doc.get("updated_at") and doc.get("customer_id")
        and row.get("quotation_id") == doc["id"]
        and row.get("customer_id") == doc["customer_id"]
        and row.get("quotation_updated_at") == doc["updated_at"]
        and row.get("bucket") == private_bucket()
        and isinstance(row.get("storage_key"), str)
        and re.fullmatch(
            rf"quotation-shares/{re.escape(doc['id'])}/[0-9a-f]{{32}}\.pdf", row["storage_key"],
        )
        and isinstance(row.get("filename"), str) and row["filename"]
        and isinstance(row.get("sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", row["sha256"])
    )


async def archive_availability(db, docs: list[dict]) -> set[str]:
    indexed = {doc["id"]: doc for doc in docs if doc.get("updated_at") and doc.get("customer_id")}
    ids = list(indexed)
    available = set()
    for offset in range(0, len(ids), 500):
        query = {**ARCHIVE_MATCH, "quotation_id": {"$in": ids[offset:offset + 500]}}
        async for row in db.quotation_shares.find(query, ARCHIVE_PROJECTION).max_time_ms(5000):
            if _matches_document(row, indexed[row["quotation_id"]]):
                available.add(row["quotation_id"])
    return available


async def _latest(db, doc) -> dict | None:
    query = {
        **ARCHIVE_MATCH, "quotation_id": doc["id"], "customer_id": doc["customer_id"],
        "quotation_updated_at": doc["updated_at"],
    }
    return await db.quotation_shares.find_one(
        query, ARCHIVE_PROJECTION, sort=[("saved_at", -1), ("_id", -1)],
    )


async def save_quotation_pdf(db, doc: dict, data: bytes, filename: str) -> None:
    if (doc.get("floor_id") != SANITARY_FLOOR or (doc.get("doc_type") or "standard") != "standard"
            or not doc.get("updated_at") or not doc.get("customer_id")
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", str(doc.get("id", "")))
            or not data.startswith(b"%PDF-")):
        return
    digest = sha256(data).hexdigest()
    previous = await _latest(db, doc)
    if previous and previous.get("sha256") == digest and _matches_document(previous, doc):
        return

    storage = get_media_storage()
    bucket = private_bucket()
    await storage.require_private_bucket(bucket)
    archive_id = uuid4().hex
    key = f"quotation-shares/{doc['id']}/{archive_id}.pdf"
    now = datetime.now(timezone.utc)
    # Reserve metadata first so deletion tooling and the existing expiry
    # worker can find the object even after an uncertain provider response.
    await db.quotation_shares.insert_one({
        "_id": archive_id, "token_hash": f"archive:{archive_id}", "kind": ARCHIVE_KIND,
        "floor_id": SANITARY_FLOOR, "quotation_id": doc["id"], "customer_id": doc["customer_id"],
        "quotation_updated_at": doc["updated_at"],
        "archive_state": "uploading", "expires_at": now + timedelta(hours=24),
        "bucket": bucket, "storage_key": key, "filename": filename, "sha256": digest,
    })
    await storage.upload(bucket=bucket, key=key, data=data, content_type="application/pdf",
                         upsert=False, cache_control="private, no-store")
    current = await db.quotations.find_one({
        "id": doc["id"], "floor_id": SANITARY_FLOOR, "customer_id": doc["customer_id"],
        "updated_at": doc["updated_at"], "deleted_at": None, "is_deleted": {"$ne": True},
    }, {"_id": 1})
    if current is None:
        return  # The uploaded bytes cannot be served as the current revision.
    saved_at = datetime.now(timezone.utc)
    marked = await db.quotation_shares.update_one(
        {"_id": archive_id, "archive_state": "uploading", "revoked": {"$ne": True}},
        {"$set": {"archive_state": "ready", "saved_at": saved_at.isoformat()},
         "$unset": {"expires_at": ""}},
    )
    if marked.modified_count != 1:
        return
    # Retain the most recent successful copy only. Mark older artifacts for
    # storage-first cleanup rather than deleting a file another read may be
    # streaming. The revision check on each read remains the source of truth.
    latest = await _latest(db, doc)
    if latest:
        await db.quotation_shares.update_many({
            **ARCHIVE_MATCH, "quotation_id": doc["id"], "quotation_updated_at": {"$lte": doc["updated_at"]},
            "$or": [
                {"saved_at": {"$lt": latest["saved_at"]}},
                {"saved_at": latest["saved_at"], "_id": {"$lt": latest["_id"]}},
            ],
        }, {"$set": {"expires_at": saved_at + timedelta(hours=24)}})


async def load_saved_pdf(db, quotation_id: str) -> tuple[bytes, str]:
    query = {
        "id": quotation_id, "floor_id": SANITARY_FLOOR, "deleted_at": None,
        "is_deleted": {"$ne": True}, "doc_type": {"$in": [None, "", "standard"]},
    }
    projection = {"_id": 0, "id": 1, "customer_id": 1, "updated_at": 1}
    doc = await db.quotations.find_one(query, projection)
    if not doc or not doc.get("updated_at") or not doc.get("customer_id"):
        raise SavedQuotationPdfUnavailable
    archive = await _latest(db, doc)
    if not archive or not _matches_document(archive, doc):
        raise SavedQuotationPdfUnavailable

    try:
        storage = get_media_storage()
        async with asyncio.timeout(15):
            await storage.require_private_bucket(archive["bucket"])
            data = await storage.download(bucket=archive["bucket"], key=archive["storage_key"])
    except (StorageError, TimeoutError) as exc:
        raise SavedQuotationPdfUnavailable from exc
    if not data.startswith(b"%PDF-") or sha256(data).hexdigest() != archive["sha256"]:
        raise SavedQuotationPdfUnavailable
    # If this quotation changed or disappeared during the private store read,
    # the file now belongs to an older revision and must not be returned.
    if not await db.quotations.find_one(
        {**query, "customer_id": doc["customer_id"], "updated_at": doc["updated_at"]}, {"_id": 1},
    ):
        raise SavedQuotationPdfUnavailable
    return data, archive["filename"]
