"""Stable quotation paging adds one full-dataset read index and changes no rows."""
import asyncio
import importlib
from types import SimpleNamespace

import pytest
from pymongo.errors import OperationFailure

migration = importlib.import_module("migrations.0042_quotation_stable_list_page")


def test_index_migration_is_repeatable_and_only_creates_its_read_index():
    calls = []

    class Quotations:
        async def create_index(self, keys, *, name):
            calls.append((keys, name))

    database = SimpleNamespace(quotations=Quotations())
    asyncio.run(migration.up(database))
    asyncio.run(migration.up(database))
    assert calls == [(migration.KEYS, migration.NAME)] * 2
    assert migration.KEYS == [("floor_id", 1), ("status", 1), ("created_at", -1), ("id", -1)]


@pytest.mark.parametrize("options", [None, {}, {"sparse": True}, {"unique": True},
                                    {"partialFilterExpression": {"status": "draft"}},
                                    {"hidden": True}, {"collation": {"locale": "en"}}])
def test_equivalent_legacy_name_must_cover_the_same_complete_dataset(options):
    class Quotations:
        async def create_index(self, *_args, **_kwargs):
            raise OperationFailure("Existing key options", code=85)

        async def list_indexes(self):
            if options is not None:
                yield {"name": "legacy", "key": dict(migration.KEYS), **options}

    if options == {}:
        asyncio.run(migration.up(SimpleNamespace(quotations=Quotations())))
    else:
        with pytest.raises(OperationFailure) as error:
            asyncio.run(migration.up(SimpleNamespace(quotations=Quotations())))
        assert error.value.code == 85


def test_unrelated_index_failure_cannot_be_acknowledged_as_migrated():
    class Quotations:
        async def create_index(self, *_args, **_kwargs):
            raise OperationFailure("Unavailable", code=91)

    with pytest.raises(OperationFailure) as error:
        asyncio.run(migration.up(SimpleNamespace(quotations=Quotations())))
    assert error.value.code == 91
