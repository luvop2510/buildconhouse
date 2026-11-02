"""Delete stock-photo metadata and safely retry unreferenced file cleanup."""
import logging
import re

logger = logging.getLogger(__name__)


async def detach_stock_photos(db, floor, stock_id, session):
    photos = await db.godown_stock_media.find({'floor_id': floor, 'stock_id': stock_id}, session=session).to_list(None)
    files = []
    for photo in photos:
        key, bucket = photo.get('storage_key'), photo.get('bucket')
        if not isinstance(key, str) or not key.startswith('godown/') or '..' in key.split('/') or not bucket:
            from fastapi import HTTPException
            raise HTTPException(409, 'The stock photo needs attention before deletion')
        entry = {'bucket': bucket, 'key': key}
        if entry not in files:
            files.append(entry)
    if photos:
        await db.godown_stock_media.delete_many({'floor_id': floor, 'stock_id': stock_id}, session=session)
        await db.settings.insert_one({'id': f'stock-media-deletion:{floor}:{stock_id}',
            'kind': 'stock_media_deletion_receipt', 'floor_id': floor, 'pending_files': files}, session=session)


async def _referenced(db, key):
    if await db.product_media.find_one({'storage_key': key}, {'_id': 1}): return True
    if await db.godown_stock_media.find_one({'storage_key': key}, {'_id': 1}): return True
    pattern = re.escape(key)
    for name, fields in (
        ('products', ('images', 'hero_image_url', 'dimension_image_urls', 'seat_cover_image_urls', 'gallery.url', 'variants.image', 'variants.images')),
        ('quotations', ('items.image',)), ('purchase_orders', ('items.image',)), ('godown_stock', ('image',)),
    ):
        if await db[name].find_one({'$or': [{field: {'$regex': pattern}} for field in fields]}, {'_id': 1}):
            return True
    return False


async def cleanup_stock_media(db, storage, limit=20):
    """Caller holds exclusive mutation admission while references are checked."""
    receipts = await db.settings.find({'kind': 'stock_media_deletion_receipt', 'pending_files.0': {'$exists': True}}).limit(limit).to_list(limit)
    for receipt in receipts:
        for entry in receipt['pending_files']:
            try:
                # Shared photos remain available for the records that use them.
                if not await _referenced(db, entry['key']):
                    await storage.delete(bucket=entry['bucket'], key=entry['key'])
                await db.settings.update_one({'_id': receipt['_id']}, {'$pull': {'pending_files': entry}})
            except Exception:
                logger.warning('Stock photo cleanup will retry', exc_info=True)
                break
