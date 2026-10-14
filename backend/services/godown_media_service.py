"""Stock-lot photographs use separate metadata from manufacturer product media.

Old photos remain registered because quotation and purchase snapshots can still
reference their immutable URLs after a lot's photo changes.
"""
import asyncio
import hashlib

from pymongo.errors import DuplicateKeyError

from db import db
from media_storage import get_media_storage
from media_storage.factory import public_bucket
from models import now_iso
from services.product_image_normalizer import normalize_product_image


async def upload_stock_photo(*, data: bytes, mime: str, lot: dict, actor_id: str) -> dict:
    data, mime = await asyncio.to_thread(normalize_product_image, data, mime)
    digest = hashlib.sha256(data).hexdigest()
    identity = hashlib.sha256(f"{lot['floor_id']}:{lot['id']}:{digest}".encode()).hexdigest()
    query = {"_id": f"godown-media:{identity}"}
    existing = await db.godown_stock_media.find_one(query)
    storage = get_media_storage()
    if existing:
        if not await storage.exists(bucket=existing["bucket"], key=existing["storage_key"]):
            await storage.upload(bucket=existing["bucket"], key=existing["storage_key"], data=data, content_type=mime)
        return {key: value for key, value in existing.items() if key != "_id"}
    extension = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}[mime]
    bucket = public_bucket()
    key = f"godown/{identity}.{extension}"
    obj = await storage.upload(bucket=bucket, key=key, data=data, content_type=mime)
    row = {**query, "id": identity, "stock_id": lot["id"], "floor_id": lot["floor_id"],
           "bucket": bucket, "storage_key": key, "public_url": obj.public_url,
           "sha256": digest, "mime": mime, "size_bytes": len(data), "uploaded_by": actor_id,
           "created_at": now_iso()}
    try:
        await db.godown_stock_media.insert_one(row)
    except Exception as exc:
        # Concurrent identical uploads share one deterministic key. Never
        # delete an object that the winning metadata insertion now owns.
        registered = await db.godown_stock_media.find_one(query)
        if registered and isinstance(exc, DuplicateKeyError):
            return {key: value for key, value in registered.items() if key != "_id"}
        if not registered:
            await storage.delete(bucket=bucket, key=key)
        raise
    return {key: value for key, value in row.items() if key != "_id"}
