"""Payment read indexes are additive and never conceal a failed migration."""
import asyncio
import importlib
from types import SimpleNamespace

import pytest
from pymongo.errors import OperationFailure

migration = importlib.import_module("migrations.0038_ground_payment_read_indexes")


@pytest.mark.parametrize("existing_equivalent", [False, True])
def test_payment_read_migration_creates_each_index_without_writing_records(existing_equivalent):
    calls = []
    class Collection:
        def __init__(self, name): self.name = name
        async def create_index(self, keys, *, name):
            calls.append((self.name, keys, name))
            if existing_equivalent:
                raise OperationFailure("Equivalent index already exists", code=85)
    database = SimpleNamespace(payments=Collection("payments"), quotations=Collection("quotations"))
    asyncio.run(migration.up(database))
    assert calls == [
        ("payments", [("floor_id", 1), ("created_at", -1)], "payments_floor_created"),
        ("payments", [("floor_id", 1), ("quotation_id", 1), ("status", 1)], "payments_floor_quotation_status"),
        ("quotations", [("floor_id", 1), ("status", 1), ("updated_at", -1)], "quotations_floor_status_updated"),
    ]


def test_payment_read_migration_propagates_operational_failures():
    class Collection:
        async def create_index(self, *_args, **_kwargs):
            raise OperationFailure("Database shutting down", code=91)
    database = SimpleNamespace(payments=Collection(), quotations=Collection())
    with pytest.raises(OperationFailure) as error:
        asyncio.run(migration.up(database))
    assert error.value.code == 91
