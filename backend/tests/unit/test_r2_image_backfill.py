import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from scripts import backfill_r2_image_variants as backfill


class Database:
    def __init__(self, rows): self.rows = rows; self.pipeline = None
    def __getitem__(self, name): assert name == 'product_media'; return self
    def aggregate(self, pipeline): self.pipeline = pipeline; return self
    async def to_list(self, limit): return self.rows[:limit]


@pytest.mark.asyncio
async def test_dry_run_measures_without_writes_and_exposes_resume_cursor(monkeypatch):
    data = b'fixture source'; key = 'brand/original.png'
    db = Database([{'_id': key, 'mime': 'image/png', 'sha1': hashlib.sha1(data).hexdigest()}])
    storage = SimpleNamespace(download=AsyncMock(return_value=data), exists=AsyncMock(), upload=AsyncMock())
    monkeypatch.setattr(backfill, 'create_image_variants', lambda *_args: {320: b'webp'})
    result = await backfill.backfill_page(db, storage, bucket='public', collection='product_media', after='brand/a', limit=1)
    storage.upload.assert_not_awaited(); storage.exists.assert_not_awaited()
    assert result['after'] == key and result['has_more']
    assert result['display_320_bytes'] == 4 and result['processed'] == 1
    assert db.pipeline[0]['$match']['bucket'] == 'public'
    assert db.pipeline[0]['$match']['storage_key']['$gt'] == 'brand/a'


@pytest.mark.asyncio
async def test_apply_writes_only_missing_derivatives_with_no_overwrite(monkeypatch):
    db = Database([{'_id': 'brand/source.png', 'mime': 'image/png'}])
    storage = SimpleNamespace(download=AsyncMock(return_value=b'source'), exists=AsyncMock(side_effect=[True, False]), upload=AsyncMock())
    monkeypatch.setattr(backfill, 'create_image_variants', lambda *_args: {320: b'small', 640: b'medium'})
    result = await backfill.backfill_page(db, storage, bucket='public', collection='product_media', apply=True)
    assert result['existing'] == 1 and result['uploaded'] == 1
    storage.upload.assert_awaited_once_with(bucket='public', key='_image_variants/v1/w640/brand/source.png.webp', data=b'medium', content_type='image/webp', upsert=False)


@pytest.mark.asyncio
async def test_stale_source_checksum_cannot_publish_a_wrong_variant():
    db = Database([{'_id': 'brand/source.png', 'mime': 'image/png', 'sha256': hashlib.sha256(b'original').hexdigest()}])
    storage = SimpleNamespace(download=AsyncMock(return_value=b'replacement'), upload=AsyncMock())
    with pytest.raises(ValueError, match='checksum'):
        await backfill.backfill_page(db, storage, bucket='public', collection='product_media', apply=True)
    storage.upload.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize('collection,limit', [('private_files',100), ('product_media',0), ('product_media',501)])
async def test_backfill_rejects_private_collections_and_unbounded_pages(collection, limit):
    with pytest.raises(ValueError):
        await backfill.backfill_page(None, None, bucket='public', collection=collection, limit=limit)
