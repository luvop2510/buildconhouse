"""Bounded assembly and explicit discard survive ordinary transport retries."""
import hashlib
import math
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from services import kitchen_file_transfers as transfers_module
from services.kitchen_file_transfers import CHUNK_BYTES, KitchenFileTransfers, TransferFinish


def finishing_transfer(parts):
    cursor = Mock()
    cursor.limit.return_value = cursor
    cursor.to_list = AsyncMock(return_value=parts)
    collection = SimpleNamespace(find=Mock(return_value=cursor), delete_many=AsyncMock())
    sessions = SimpleNamespace(update_one=AsyncMock(return_value=SimpleNamespace(matched_count=1)))
    service = KitchenFileTransfers(SimpleNamespace(kitchen_file_parts=collection, kitchen_file_transfers=sessions))
    service.authorized = AsyncMock()
    service.projects.attach = AsyncMock(return_value={"version": 2})
    return service, collection, cursor, sessions


@pytest.mark.asyncio
async def test_finish_fetches_bounded_exact_slots_once_and_assembles_in_position_order():
    # Exercise the full new-PDF boundary. Mongo cursor order is intentionally
    # reversed, and one slot has the historical transfer-prefixed identity.
    data = b"%PDF-1.4\n" + b"a" * (10_000_000 - 9)
    count = math.ceil(len(data) / CHUNK_BYTES)
    parts = []
    for index in range(count):
        chunk = data[index * CHUNK_BYTES:(index + 1) * CHUNK_BYTES]
        parts.append({"_id": f"transfer:{index}" if index == 1 else f"actor:owner:{index}",
                      "transfer_id": "transfer", "index": index, "data": chunk,
                      "sha256": hashlib.sha256(chunk).hexdigest()})
    service, collection, cursor, sessions = finishing_transfer(list(reversed(parts)))
    service.session = AsyncMock(return_value={"state": "finishing", "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(), "key": "same-upload-key",
        "filename": "Design.pdf", "content_type": "application/pdf"})
    result = await service._finish(SimpleNamespace(id="owner"), "project", "transfer",
        TransferFinish(expected_version=1), None, "private", "token")
    assert result == {"version": 2}
    collection.find.assert_called_once_with({"$or": [
        {"_id": {"$in": [f"actor:owner:{i}" for i in range(count)]}, "transfer_id": "transfer"},
        {"_id": {"$in": [f"transfer:{i}" for i in range(count)]}},
    ]})
    cursor.limit.assert_called_once_with(count * 2)
    cursor.to_list.assert_awaited_once_with(count * 2)
    kwargs = service.projects.attach.await_args.kwargs
    assert kwargs["data"] == data and kwargs["key"] == "same-upload-key"
    assert kwargs["expected_version"] == 1
    assert sessions.update_one.await_count == 2
    collection.delete_many.assert_awaited_once_with({"transfer_id": "transfer"})


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["missing", "length", "checksum"])
async def test_batched_finish_keeps_part_integrity_checks_before_attachment_commit(invalid):
    data = b"%PDF-1.4\n"
    part = {"_id": "actor:owner:0", "data": data,
            "sha256": hashlib.sha256(data).hexdigest()}
    if invalid == "length":
        part["data"] += b"x"
    elif invalid == "checksum":
        part["sha256"] = "0" * 64
    service, collection, _, sessions = finishing_transfer([] if invalid == "missing" else [part])
    service.session = AsyncMock(return_value={"state": "finishing", "size_bytes": len(data)})
    with pytest.raises(HTTPException) as error:
        await service._finish(SimpleNamespace(id="owner"), "project", "transfer",
            TransferFinish(expected_version=1), None, "private", "token")
    assert error.value.status_code == 409
    service.projects.attach.assert_not_awaited()
    sessions.update_one.assert_not_awaited()
    collection.delete_many.assert_not_awaited()


@pytest.mark.asyncio
async def test_discard_absent_exact_actor_transfer_is_idempotent_without_touching_other_parts(monkeypatch):
    capability = AsyncMock()
    monkeypatch.setattr(transfers_module.access, "require_capability", capability)
    sessions = SimpleNamespace(find_one=AsyncMock(return_value=None), delete_one=AsyncMock())
    parts = SimpleNamespace(delete_many=AsyncMock())
    database = SimpleNamespace(kitchen_file_transfers=sessions, kitchen_file_parts=parts)
    user = SimpleNamespace(id="owner")
    assert await KitchenFileTransfers(database).cancel(user, "project", "old-transfer") == {"discarded": True}
    capability.assert_awaited_once_with(database, user, "view")
    sessions.find_one.assert_awaited_once_with({"_id": "owner", "project_id": "project", "transfer_id": "old-transfer"})
    sessions.delete_one.assert_not_awaited()
    parts.delete_many.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["finishing", "completed"])
async def test_discard_never_removes_finishing_or_published_upload(monkeypatch, state):
    monkeypatch.setattr(transfers_module.access, "require_capability", AsyncMock())
    sessions = SimpleNamespace(find_one=AsyncMock(return_value={"state": state}), delete_one=AsyncMock())
    parts = SimpleNamespace(delete_many=AsyncMock())
    with pytest.raises(HTTPException) as error:
        await KitchenFileTransfers(SimpleNamespace(kitchen_file_transfers=sessions, kitchen_file_parts=parts)).cancel(
            SimpleNamespace(id="owner"), "project", "transfer")
    assert error.value.status_code == 409
    sessions.delete_one.assert_not_awaited()
    parts.delete_many.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("current", [None, {"state": "finishing"}])
async def test_discard_race_only_acknowledges_exact_transfer_absence(monkeypatch, current):
    monkeypatch.setattr(transfers_module.access, "require_capability", AsyncMock())
    sessions = SimpleNamespace(find_one=AsyncMock(side_effect=[{"state": "open"}, current]),
        delete_one=AsyncMock(return_value=SimpleNamespace(deleted_count=0)))
    parts = SimpleNamespace(delete_many=AsyncMock())
    service = KitchenFileTransfers(SimpleNamespace(kitchen_file_transfers=sessions, kitchen_file_parts=parts))
    if current:
        with pytest.raises(HTTPException) as error:
            await service.cancel(SimpleNamespace(id="owner"), "project", "transfer")
        assert error.value.status_code == 409
        parts.delete_many.assert_not_awaited()
    else:
        assert await service.cancel(SimpleNamespace(id="owner"), "project", "transfer") == {"discarded": True}
        parts.delete_many.assert_awaited_once_with({"transfer_id": "transfer"})
