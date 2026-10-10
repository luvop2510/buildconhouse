import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from models import ProductMedia
from services import media_service


def test_identical_old_supplier_image_is_promoted_without_reupload(monkeypatch):
    doc = ProductMedia(id='old-image', product_id='p1', brand_id='b1', floor_id='first-floor', source_type='supplier', role='hero', bucket='forge-products', storage_key='same.jpg', sha1='same', is_primary=False).model_dump()
    collection = SimpleNamespace(find_one=AsyncMock(return_value=doc), update_one=AsyncMock())
    monkeypatch.setattr(media_service, 'db', SimpleNamespace(product_media=collection))
    monkeypatch.setattr(media_service, 'normalize_product_image', lambda data, mime, **kwargs: (data, mime))
    storage = SimpleNamespace(exists=AsyncMock(return_value=True), upload=AsyncMock())
    monkeypatch.setattr(media_service, 'get_media_storage', lambda: storage)
    demote = AsyncMock(); monkeypatch.setattr(media_service, '_demote_other_primaries', demote)
    result = asyncio.run(media_service.upload_and_register(data=b'same', mime='image/jpeg', brand_slug='b1', product_id='p1', brand_id='b1', floor_id='first-floor', source_type='supplier', role='hero', is_primary=True, sort_order=0))
    assert result.is_primary
    assert not storage.upload.called
    assert collection.update_one.call_args.args[0] == {'id': 'old-image', 'floor_id': 'first-floor'}
    assert demote.call_args.kwargs['keep_id'] == 'old-image'
