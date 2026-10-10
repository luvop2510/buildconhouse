"""Deleting or replacing one image must preserve files owned by siblings."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from media_storage.base import StorageError
from services import media_service as service


@pytest.fixture
def media_fakes(monkeypatch):
    collection = SimpleNamespace(find_one=AsyncMock(), delete_one=AsyncMock(), insert_one=AsyncMock(), update_one=AsyncMock(), update_many=AsyncMock())
    storage = SimpleNamespace(delete=AsyncMock(), upload=AsyncMock(return_value=SimpleNamespace(public_url="https://example.test/image.png")))
    log = AsyncMock()
    monkeypatch.setattr(service, "db", SimpleNamespace(product_media=collection))
    monkeypatch.setattr(service, "get_media_storage", lambda: storage)
    monkeypatch.setattr(service, "log_event", log)
    return collection, storage, log


@pytest.mark.asyncio
@pytest.mark.parametrize("shared", [False, True])
async def test_delete_preserves_shared_file_but_removes_only_requested_metadata(media_fakes, shared):
    collection, storage, log = media_fakes
    collection.find_one.side_effect = [{"id": "requested", "bucket": "public", "storage_key": "same.jpg", "product_id": "first"}, {"id": "sibling"} if shared else None]
    assert await service.delete_media("requested")
    assert collection.find_one.call_args.args[0] == {"bucket": "public", "storage_key": "same.jpg", "id": {"$ne": "requested"}}
    collection.delete_one.assert_awaited_once_with({"id": "requested"})
    if shared:
        storage.delete.assert_not_awaited()
    else:
        storage.delete.assert_awaited_once_with(bucket="public", key="same.jpg")
    log.assert_awaited_once()


@pytest.mark.asyncio
async def test_failed_unshared_storage_delete_preserves_pointer_for_retry(media_fakes):
    collection, storage, log = media_fakes
    collection.find_one.side_effect = [{"id": "requested", "bucket": "public", "storage_key": "same.jpg"}, None]
    storage.delete.side_effect = StorageError("provider unavailable")
    with pytest.raises(StorageError):
        await service.delete_media("requested")
    collection.delete_one.assert_not_awaited()
    log.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("shared", [False, True])
async def test_failed_upload_registration_never_deletes_sibling_file(media_fakes, shared, monkeypatch):
    collection, storage, _ = media_fakes
    collection.find_one.side_effect = [None, {"id": "sibling"} if shared else None]
    collection.insert_one.side_effect = RuntimeError("insert failed")
    monkeypatch.setattr(service, "public_bucket", lambda: "public")
    with pytest.raises(RuntimeError, match="insert failed"):
        await service.upload_and_register(data=b"<svg xmlns='http://www.w3.org/2000/svg'/>", mime="image/svg+xml", brand_slug="brand", product_id="first", family_key="family")
    if shared:
        storage.delete.assert_not_awaited()
    else:
        storage.delete.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("present", [False, True])
async def test_duplicate_upload_restores_only_missing_exact_bytes(media_fakes, present):
    import hashlib
    from models import ProductMedia
    collection, storage, log = media_fakes
    data = b"<svg xmlns='http://www.w3.org/2000/svg'/>"
    old = ProductMedia(product_id="first", floor_id="first-floor", source_type="manufacturer", role="hero", bucket="public", storage_key="original.svg", sha1=hashlib.sha1(data).hexdigest(), mime="image/svg+xml", size_bytes=len(data), public_url="https://example.test/original.svg").model_dump()
    collection.find_one.return_value = old
    storage.exists = AsyncMock(return_value=present)
    result = await service.upload_and_register(data=data, mime="image/svg+xml", brand_slug="brand", product_id="first", role="hero", is_primary=True)
    assert result.id == old["id"]
    collection.update_many.assert_awaited_once()
    collection.update_one.assert_awaited_once()
    collection.insert_one.assert_not_awaited()
    storage.delete.assert_not_awaited()
    if present:
        storage.upload.assert_not_awaited()
        log.assert_not_awaited()
    else:
        storage.upload.assert_awaited_once_with(bucket="public", key="original.svg", data=data, content_type="image/svg+xml")
        assert log.call_args.kwargs["event_type"] == "product.image_restored"


@pytest.mark.asyncio
async def test_failed_duplicate_restore_preserves_existing_metadata(media_fakes):
    import hashlib
    from models import ProductMedia
    collection, storage, _ = media_fakes
    data = b"<svg/>"
    old = ProductMedia(product_id="first", floor_id="first-floor", source_type="manufacturer", role="hero", bucket="public", storage_key="original.svg", sha1=hashlib.sha1(data).hexdigest(), mime="image/svg+xml", size_bytes=len(data)).model_dump()
    collection.find_one.return_value = old
    storage.exists = AsyncMock(return_value=False)
    storage.upload.side_effect = StorageError("upload unavailable")
    with pytest.raises(StorageError):
        await service.upload_and_register(data=data, mime="image/svg+xml", brand_slug="brand", product_id="first", role="hero")
    collection.insert_one.assert_not_awaited()
    collection.delete_one.assert_not_awaited()
    storage.delete.assert_not_awaited()
