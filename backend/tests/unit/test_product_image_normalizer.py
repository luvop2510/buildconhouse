from io import BytesIO

from PIL import Image

import services.media_service as media_service
from media_storage.base import StoredObject
from services.product_image_normalizer import normalize_product_image


def _image_bytes(size: tuple[int, int], *, fmt: str = "PNG", exif_orientation: int | None = None) -> bytes:
    image = Image.new("RGB", size, "red")
    out = BytesIO()
    kwargs = {}
    if exif_orientation:
        exif = Image.Exif()
        exif[274] = exif_orientation
        kwargs["exif"] = exif
    image.save(out, format=fmt, **kwargs)
    return out.getvalue()


def _size(data: bytes) -> tuple[int, int]:
    with Image.open(BytesIO(data)) as image:
        return image.size


def test_portrait_image_keeps_its_upright_source_orientation():
    source = _image_bytes((60, 120))
    data, mime = normalize_product_image(source, "image/png")
    assert mime == "image/png"
    assert data == source
    assert _size(data) == (60, 120)


def test_square_and_wide_sources_are_not_cropped_to_a_document_canvas():
    square, _ = normalize_product_image(_image_bytes((100, 100)), "image/png")
    landscape, _ = normalize_product_image(_image_bytes((320, 200)), "image/png")
    assert _size(square) == (100, 100)
    assert _size(landscape) == (320, 200)


def test_exif_orientation_is_applied_without_a_second_rotation_or_crop():
    data, mime = normalize_product_image(_image_bytes((60, 120), fmt="JPEG", exif_orientation=6), "image/jpeg")
    assert mime == "image/jpeg"
    assert _size(data) == (120, 60)


def test_gif_bytes_are_not_reencoded():
    data, mime = normalize_product_image(_image_bytes((50, 100), fmt="GIF"), "image/gif")
    assert mime == "image/gif"
    assert _size(data) == (50, 100)


def test_non_image_media_is_not_modified():
    source = b"%PDF-1.4 sample"
    assert normalize_product_image(source, "application/pdf") == (source, "application/pdf")


def test_media_quality_uses_the_longest_edge_for_portrait_photography():
    """A usable tall image is not a thumbnail merely because it is narrow."""
    _width, _height, quality = media_service._detect_dims_and_quality(_image_bytes((240, 720)), "image/png")

    assert quality == "good"


def test_media_service_stores_normalized_bytes_and_dimensions(monkeypatch):
    class ProductMediaCollection:
        async def find_one(self, *_args, **_kwargs):
            return None

        async def insert_one(self, doc):
            self.inserted = doc

    class Db:
        product_media = ProductMediaCollection()

    uploaded = {}

    class Storage:
        async def upload(self, *, bucket, key, data, content_type):
            uploaded.update(bucket=bucket, key=key, data=data, content_type=content_type)
            return StoredObject(bucket, key, "https://example.test/image", len(data), content_type, "sha")

    async def no_log(**_kwargs):
        return None

    monkeypatch.setattr(media_service, "db", Db())
    monkeypatch.setattr(media_service, "get_media_storage", lambda: Storage())
    monkeypatch.setattr(media_service, "public_bucket", lambda: "products")
    monkeypatch.setattr(media_service, "log_event", no_log)

    import asyncio
    result = asyncio.run(media_service.upload_and_register(
        data=_image_bytes((50, 100)), mime="image/png", brand_slug="test", product_id="p1",
        floor_id="first-floor", source_type="manufacturer", role="gallery",
    ))

    assert _size(uploaded["data"]) == (50, 100)
    assert uploaded["content_type"] == "image/png"
    assert (result.width, result.height) == (50, 100)
