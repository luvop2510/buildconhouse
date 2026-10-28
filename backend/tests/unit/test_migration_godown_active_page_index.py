import asyncio
import importlib
from types import SimpleNamespace

import pytest
from pymongo.errors import OperationFailure

migration = importlib.import_module("migrations.0041_godown_active_page_index")


class Collection:
    def __init__(self, *, error=None, indexes=()):
        self.error, self.indexes, self.calls = error, indexes, []

    async def create_index(self, keys, *, name):
        self.calls.append((keys, name))
        if self.error:
            raise OperationFailure("Fixture index error", code=self.error)

    async def list_indexes(self):
        for index in self.indexes:
            yield index


def test_additive_index_is_repeatable_without_document_writes():
    collection = Collection()
    db = SimpleNamespace(godown_stock=collection)
    asyncio.run(migration.up(db))
    asyncio.run(migration.up(db))
    assert collection.calls == [(migration.KEYS, migration.NAME)] * 2


def test_equivalent_legacy_name_is_accepted():
    collection = Collection(error=85, indexes=[{"name": "legacy", "key": dict(migration.KEYS)}])
    asyncio.run(migration.up(SimpleNamespace(godown_stock=collection)))


@pytest.mark.parametrize("index", [
    {"key": {"floor_id": 1}},
    {"key": dict(migration.KEYS), "partialFilterExpression": {"archived": False}},
    {"key": dict(migration.KEYS), "sparse": True},
    {"key": dict(migration.KEYS), "hidden": True},
])
def test_name_conflict_does_not_conceal_an_inadequate_index(index):
    with pytest.raises(OperationFailure):
        asyncio.run(migration.up(SimpleNamespace(godown_stock=Collection(error=85, indexes=[index]))))


def test_operational_failure_propagates():
    with pytest.raises(OperationFailure) as error:
        asyncio.run(migration.up(SimpleNamespace(godown_stock=Collection(error=91))))
    assert error.value.code == 91
