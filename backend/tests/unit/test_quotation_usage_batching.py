"""Usage telemetry is deduplicated, bounded and acknowledged before caching."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from routes import quotation_routes as routes


@pytest.mark.parametrize("size,calls", [(0, 0), (100, 1), (501, 2), (1001, 3)])
def test_usage_writes_are_chunked_and_preserve_counter_semantics(monkeypatch, size, calls):
    operations = []
    async def bulk_write(batch, ordered):
        assert ordered is True
        assert 0 < len(batch) <= 500
        operations.extend(batch)
    write = AsyncMock(side_effect=bulk_write)
    cache = AsyncMock()
    monkeypatch.setattr(routes, "db", SimpleNamespace(product_usage=SimpleNamespace(bulk_write=write)))
    monkeypatch.setattr(routes.catalog_service, "note_product_usage", cache)
    ids = [f"p{index}" for index in range(size)]
    asyncio.run(routes._track_product_usage("user-a", ids + ids))
    assert write.await_count == calls
    assert [operation._filter for operation in operations] == [{"user_id": "user-a", "product_id": key} for key in ids]
    for operation in operations:
        assert operation._upsert is True
        assert operation._doc["$inc"] == {"count": 1}
        assert operation._doc["$set"]["last_used_at"] == cache.call_args.args[2]
    cache.assert_awaited_once()


def test_failed_usage_batch_does_not_publish_unacknowledged_counts_to_cache(monkeypatch):
    write = AsyncMock(side_effect=RuntimeError("database unavailable"))
    cache = AsyncMock()
    monkeypatch.setattr(routes, "db", SimpleNamespace(product_usage=SimpleNamespace(bulk_write=write)))
    monkeypatch.setattr(routes.catalog_service, "note_product_usage", cache)
    with pytest.raises(RuntimeError, match="database unavailable"):
        asyncio.run(routes._track_product_usage("user-a", ["p1", "p2"]))
    cache.assert_not_awaited()
