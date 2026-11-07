import hashlib
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from PIL import Image

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
@pytest.mark.parametrize('algorithm', ['sha1', 'sha256'])
async def test_stale_source_checksum_cannot_publish_a_wrong_variant(monkeypatch, algorithm):
    db = Database([{'_id': 'brand/source.png', 'mime': 'image/png', algorithm: hashlib.new(algorithm, b'original').hexdigest()}])
    storage = SimpleNamespace(download=AsyncMock(return_value=b'replacement'), upload=AsyncMock())
    encoder = Mock(side_effect=OSError('Invalid image'))
    monkeypatch.setattr(backfill, 'create_image_variants', encoder)
    with pytest.raises(ValueError, match='checksum'):
        await backfill.backfill_page(db, storage, bucket='public', collection='product_media', apply=True)
    storage.upload.assert_not_awaited()
    encoder.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize('apply', [False, True])
@pytest.mark.parametrize('invalid_last', [False, True])
async def test_undecodable_raster_is_skipped_without_blocking_resume_or_changing_originals(apply, invalid_last):
    out = BytesIO()
    Image.new('RGB', (160, 160), 'red').save(out, 'PNG', compress_level=0)
    valid = out.getvalue()
    # Keep a real PNG header/IDAT prefix so decoding, rather than MIME admission,
    # fails with Pillow's truncated-raster OSError.
    invalid = valid[:len(valid) // 2]
    assert len(invalid) >= backfill.MIN_BYTES
    sources = {'brand/a.png': valid if invalid_last else invalid,
               'brand/b.png': invalid if invalid_last else valid}
    before = dict(sources)
    rows = [{'_id': key, 'mime': 'image/png', 'sha1': hashlib.sha1(data).hexdigest(),
             'sha256': hashlib.sha256(data).hexdigest()} for key, data in sources.items()]
    async def download(*, bucket, key):
        assert bucket == 'public'
        return sources[key]
    storage = SimpleNamespace(download=AsyncMock(side_effect=download), exists=AsyncMock(return_value=False), upload=AsyncMock())
    report = await backfill.backfill_page(Database(rows), storage, bucket='public', collection='product_media', limit=2, apply=apply)
    assert report['processed'] == 2 and report['skipped'] == 1
    assert report['after'] == 'brand/b.png' and report['has_more']
    assert report['source_bytes'] == len(valid) + len(invalid)
    assert report['display_320_bytes'] > len(invalid)
    assert sources == before
    if apply:
        assert report['uploaded'] > 0
        valid_key = 'brand/a.png' if invalid_last else 'brand/b.png'
        assert storage.upload.await_count == report['uploaded']
        for call in storage.upload.await_args_list:
            assert call.kwargs['key'].startswith('_image_variants/')
            assert call.kwargs['key'].endswith(valid_key + '.webp')
            assert call.kwargs['content_type'] == 'image/webp'
            assert call.kwargs['upsert'] is False
    else:
        storage.upload.assert_not_awaited()
        storage.exists.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize('operation', ['download', 'exists', 'upload'])
async def test_storage_oserror_still_stops_backfill_before_later_sources(monkeypatch, operation):
    db = Database([{'_id': 'brand/a.png', 'mime': 'image/png'}, {'_id': 'brand/b.png', 'mime': 'image/png'}])
    storage = SimpleNamespace(download=AsyncMock(return_value=b'source'), exists=AsyncMock(return_value=False), upload=AsyncMock())
    getattr(storage, operation).side_effect = OSError('Storage unavailable')
    monkeypatch.setattr(backfill, 'create_image_variants', lambda *_args: {320: b'webp'})
    with pytest.raises(OSError, match='Storage unavailable'):
        await backfill.backfill_page(db, storage, bucket='public', collection='product_media', apply=True)
    storage.download.assert_awaited_once_with(bucket='public', key='brand/a.png')


@pytest.mark.asyncio
@pytest.mark.parametrize('collection,limit', [('private_files',100), ('product_media',0), ('product_media',501)])
async def test_backfill_rejects_private_collections_and_unbounded_pages(collection, limit):
    with pytest.raises(ValueError):
        await backfill.backfill_page(None, None, bucket='public', collection=collection, limit=limit)
