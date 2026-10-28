"""The PDF upload ceiling applies before staging and to actual assembled bytes."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from services.kitchen_attachments import MAX_PDF_UPLOAD_BYTES, MAX_TRANSFER_BYTES, validate_file
from services.kitchen_file_transfers import KitchenFileTransfers, TransferStart, TransferFinish
from services.kitchen_projects import resolved_policy
from tests.unit.test_kitchen_projects import setup


@pytest.mark.parametrize("mime", ["application/pdf", "application/octet-stream", "Application/PDF; charset=binary"])
def test_pdf_actual_bytes_accept_ten_megabytes_and_reject_one_byte_more(mime):
    policy = resolved_policy({})
    policy["files"]["max_bytes"] = MAX_TRANSFER_BYTES
    data = b"%PDF-1.4\n" + b" " * (MAX_PDF_UPLOAD_BYTES - 9)
    assert len(data) == 10_000_000
    assert validate_file(data, mime, "Design.PDF", policy, MAX_TRANSFER_BYTES)
    with pytest.raises(HTTPException) as invalid:
        validate_file(data + b" ", mime, "Design.PDF", policy, MAX_TRANSFER_BYTES)
    assert invalid.value.status_code == 413 and "10000000" in invalid.value.detail
    policy["files"]["max_bytes"] = 500_000
    with pytest.raises(HTTPException, match="500000 bytes"):
        validate_file(data, mime, "Design.PDF", policy, MAX_TRANSFER_BYTES)


@pytest.mark.asyncio
async def test_oversized_pdf_is_rejected_before_transfer_staging_and_finish(setup):
    _, _, owner = setup
    collection = SimpleNamespace(find_one=AsyncMock(return_value=None), insert_one=AsyncMock(), update_one=AsyncMock())
    transfers = KitchenFileTransfers(SimpleNamespace(kitchen_file_transfers=collection))
    policy = resolved_policy({})
    policy["files"]["max_bytes"] = MAX_TRANSFER_BYTES
    transfers.authorized = AsyncMock(return_value=({"version": 1}, policy))
    body = TransferStart(expected_version=1, idempotency_key="pdf-limit-start", filename="Quote.pdf",
                         content_type="application/octet-stream", size_bytes=10_000_001)
    with pytest.raises(HTTPException) as invalid:
        await transfers.begin(owner, "project", body)
    assert invalid.value.status_code == 413
    collection.find_one.assert_not_awaited()
    collection.insert_one.assert_not_awaited()
    accepted = await transfers.begin(owner, "project", body.model_copy(update={"size_bytes": MAX_PDF_UPLOAD_BYTES}))
    assert accepted["size_bytes"] == MAX_PDF_UPLOAD_BYTES
    collection.insert_one.assert_awaited_once()
    transfers.session = AsyncMock(return_value={"state": "open", "content_type": "application/pdf", "filename": "Quote.pdf", "size_bytes": 10_000_001})
    with pytest.raises(HTTPException) as invalid:
        await transfers.finish(owner, "project", "old-transfer", TransferFinish(expected_version=1), None, "private")
    assert invalid.value.status_code == 413
    collection.update_one.assert_not_awaited()


@pytest.mark.asyncio
async def test_existing_pdf_above_new_upload_ceiling_remains_downloadable(setup):
    import hashlib
    import base64
    from services.kitchen_file_transfers import download_part
    from tests.unit.test_kitchen_projects import create_request
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="old-pdf-download"))
    data = b"%PDF-1.4\n" + b" " * (10_000_001 - 9)
    metadata = {"id": "old-large-pdf", "size_bytes": len(data), "content_type": "application/pdf",
        "bucket": "private", "storage_key": "old/private/pdf", "sha256": hashlib.sha256(data).hexdigest()}
    database.kitchen_projects.rows[0]["attachments"] = [metadata]
    storage = SimpleNamespace(require_private_bucket=AsyncMock(), download=AsyncMock(return_value=data))
    response = await download_part(database, owner, project["id"], metadata["id"], 0, storage)
    assert base64.b64decode(response["data_base64"]).startswith(b"%PDF-1.4")
    assert response["size_bytes"] == 10_000_001
