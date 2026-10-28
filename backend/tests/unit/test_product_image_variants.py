from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock

import asyncio
import pytest
from PIL import Image

from services.product_image_variants import WIDTHS, create_image_variants, variant_key
from media_storage.r2_driver import R2StorageDriver


def png(size=(1200, 800), mode='RGB'):
    image = Image.new(mode, size, (40, 90, 160, 120) if mode == 'RGBA' else (40, 90, 160))
    out = BytesIO(); image.save(out, 'PNG', compress_level=0)
    return out.getvalue()


def test_derivatives_reduce_display_bytes_without_changing_original():
    source = png(); before = bytes(source)
    variants = create_image_variants(source, 'image/png')
    assert source == before
    assert set(variants) == set(WIDTHS)
    for width, data in variants.items():
        with Image.open(BytesIO(data)) as image:
            assert image.format == 'WEBP'
            assert max(image.size) <= width
            assert image.width <= 1200 and image.height <= 800
            assert abs(image.width / image.height - 1.5) < .01
        assert len(data) < len(source) / 10


def test_transparent_photography_keeps_alpha_and_orientation():
    variants = create_image_variants(png((400, 800), 'RGBA'), 'image/png')
    with Image.open(BytesIO(variants[320])) as image:
        assert image.size == (160, 320)
        assert image.getpixel((80, 160))[3] == 120


def test_exif_orientation_is_baked_into_display_copy():
    image = Image.new('RGB', (800, 400), 'red'); out = BytesIO()
    exif = Image.Exif(); exif[274] = 6
    image.save(out, 'JPEG', exif=exif)
    variants = create_image_variants(out.getvalue() + b'\0' * 20000, 'image/jpeg')
    with Image.open(BytesIO(variants[320])) as rendered:
        assert rendered.size == (160, 320)
        assert rendered.getexif().get(274, 1) == 1


@pytest.mark.parametrize('mime', ['application/pdf', 'image/svg+xml', 'image/gif', 'application/octet-stream'])
def test_non_photographic_formats_are_not_transformed(mime):
    assert create_image_variants(b'x' * 20000, mime) == {}


def test_small_images_and_animations_remain_original():
    assert create_image_variants(b'small', 'image/png') == {}
    out = BytesIO()
    Image.new('RGB', (400, 400), 'red').save(out, 'PNG', save_all=True,
        append_images=[Image.new('RGB', (400, 400), 'blue')], compress_level=0, duration=100)
    assert create_image_variants(out.getvalue(), 'image/png') == {}


def test_pixel_budget_prevents_large_decode(monkeypatch):
    class Huge:
        mode = 'RGB'; width = height = 10000
        def __enter__(self): return self
        def __exit__(self, *_args): pass
    monkeypatch.setattr(Image, 'open', lambda *_args: Huge())
    assert create_image_variants(b'x' * 20000, 'image/png') == {}


def test_variant_keys_are_bounded_and_preserve_original_key():
    assert variant_key('brand/source-123.png', 640) == '_image_variants/v1/w640/brand/source-123.png.webp'
    with pytest.raises(ValueError): variant_key('brand/x.png', 639)


def driver():
    return R2StorageDriver(cfg=SimpleNamespace(supabase_public_bucket='public', supabase_private_bucket='private'), client=object())


@pytest.mark.asyncio
async def test_private_media_never_generates_public_derivatives():
    storage = driver(); storage._call = AsyncMock()
    assert await storage.publish_image_variants(bucket='private', key='photo.png', data=png(), content_type='image/png') == 0
    storage._call.assert_not_awaited()


@pytest.mark.asyncio
async def test_optional_failure_retains_original_upload_and_uploads_at_most_two(monkeypatch):
    storage = driver(); active = maximum = 0
    async def call(operation, **kwargs):
        nonlocal active, maximum
        assert operation == 'put_object'
        assert kwargs['Key'].startswith('_image_variants/v1/')
        active += 1; maximum = max(maximum, active)
        await asyncio.sleep(.001); active -= 1
    storage._call = call
    assert await storage.publish_image_variants(bucket='public', key='photo.png', data=png(), content_type='image/png') == 5
    assert maximum == 2
    storage._call = AsyncMock(side_effect=RuntimeError('Fixture unavailable'))
    assert await storage.publish_image_variants(bucket='public', key='photo.png', data=png(), content_type='image/png') == 0

@pytest.mark.asyncio
async def test_cancelled_request_does_not_admit_another_encoder_until_thread_finishes(monkeypatch):
    import threading
    import media_storage.r2_driver as module
    started, release = threading.Event(), threading.Event()
    def encode(*_args):
        started.set(); release.wait(3); return {320: b'webp'}
    monkeypatch.setattr(module, 'create_image_variants', encode)
    storage = driver(); storage._call = AsyncMock()
    task = asyncio.create_task(storage.publish_image_variants(bucket='public', key='photo.png', data=b'x' * 20000, content_type='image/png'))
    try:
        for _ in range(100):
            if started.is_set(): break
            await asyncio.sleep(.001)
        assert started.is_set()
        task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
        assert await storage.publish_image_variants(bucket='public', key='next.png', data=b'x' * 20000, content_type='image/png') == 0
        assert len(storage._variant_jobs) == 1
    finally:
        release.set()
        await asyncio.gather(*storage._variant_jobs)
    assert not storage._variant_slot.locked()


@pytest.mark.asyncio
async def test_original_upload_receipt_survives_derivative_failure(monkeypatch):
    storage = driver(); storage.cfg.r2_public_url = 'https://media.example.test'
    original = png(); calls = []
    async def call(operation, **kwargs):
        calls.append(kwargs)
        if kwargs['Key'].startswith('_image_variants/'):
            raise RuntimeError('Fixture failure')
    storage._call = call
    result = await storage.upload(bucket='public', key='photo.png', data=original, content_type='image/png')
    assert calls[0]['Body'] == original
    assert result.size_bytes == len(original)
    assert result.content_type == 'image/png'
    assert result.public_url == 'https://media.example.test/photo.png'
    await asyncio.gather(*storage._variant_jobs)

@pytest.mark.asyncio
async def test_acknowledged_upload_does_not_wait_for_image_encoder(monkeypatch):
    import threading
    import media_storage.r2_driver as module
    release = threading.Event()
    def encode(*_args):
        release.wait(3); return {}
    monkeypatch.setattr(module, 'create_image_variants', encode)
    storage = driver(); storage.cfg.r2_public_url = 'https://media.example.test'
    storage._call = AsyncMock()
    try:
        result = await asyncio.wait_for(storage.upload(bucket='public', key='photo.png', data=b'x' * 20000, content_type='image/png'), timeout=.2)
        assert result.size_bytes == 20000
        assert len(storage._variant_jobs) == 1
    finally:
        release.set(); await asyncio.gather(*storage._variant_jobs)
