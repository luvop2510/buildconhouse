"""Additive reference indexes retain data and refuse incompatible definitions."""
import asyncio
import importlib
from unittest.mock import AsyncMock
from types import SimpleNamespace

import pytest
from pymongo.errors import OperationFailure

migration = importlib.import_module("migrations.0040_reference_acquisition_reads")


@pytest.mark.parametrize("existing", [False, True])
def test_reference_read_indexes_repeat_without_business_record_writes(existing):
    collections = {}
    for name in ("customers", "walkins", "followups", "quotations", "furniture_quotations", "kitchen_projects"):
        collection = AsyncMock()
        collection.create_index.side_effect = OperationFailure("existing index", code=85) if existing else None
        collection.index_information.return_value = {"equivalent": {"key": [("referrer_id", 1), ("floor_id", 1), ("created_at", -1)]}}
        collections[name] = collection
    asyncio.run(migration.up(SimpleNamespace(**collections)))
    for collection in collections.values():
        collection.create_index.assert_awaited_once()
        assert collection.create_index.call_args.args == ([("referrer_id", 1), ("floor_id", 1), ("created_at", -1)],)
        collection.update_many.assert_not_called()
        collection.delete_many.assert_not_called()


def test_reference_read_indexes_do_not_hide_conflicting_or_failed_index_creation():
    for code in (85, 91):
        collection = AsyncMock()
        collection.create_index.side_effect = OperationFailure("conflict", code=code)
        collection.index_information.return_value = {"unique": {"key": [("referrer_id", 1), ("floor_id", 1), ("created_at", -1)], "unique": True}}
        with pytest.raises(OperationFailure):
            asyncio.run(migration.up(SimpleNamespace(customers=collection)))
