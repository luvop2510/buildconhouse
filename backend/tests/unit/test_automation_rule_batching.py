"""Cadence initialization batches I/O and preserves saved or concurrent edits."""
import asyncio
import copy
from types import SimpleNamespace

from services import automation_rules as rules


class RuleCollection:
    def __init__(self, documents=()):
        self.documents = {doc["category"]: copy.deepcopy(doc) for doc in documents}
        self.reads = 0
        self.writes = []
        self.before_write = lambda: None

    def find(self, query, projection):
        self.reads += 1
        snapshot = [copy.deepcopy(doc) for key, doc in self.documents.items()
                    if key in query["category"]["$in"]]

        async def rows():
            for row in snapshot:
                yield row
        return rows()

    async def bulk_write(self, operations, *, ordered):
        assert ordered
        self.before_write()
        self.writes.append(operations)
        for operation in operations:
            if "$setOnInsert" in operation._doc:
                document = operation._doc["$setOnInsert"]
                category = document["category"]
                assert operation._filter == {"_id": f"automation-default:{category}"}
                self.documents.setdefault(category, copy.deepcopy(document))
                continue
            existing = self.documents.get(operation._filter["category"])
            if existing and existing["reminder_offsets_days"] == operation._filter["reminder_offsets_days"]:
                existing.update(operation._doc["$set"])


def test_missing_defaults_share_one_write_and_repeat_is_read_only(monkeypatch):
    collection = RuleCollection()
    monkeypatch.setattr(rules, "db", SimpleNamespace(automation_rules=collection))

    async def run():
        await rules.ensure_seeded()
        assert collection.reads == 1
        assert len(collection.writes) == 1
        assert len(collection.writes[0]) == len(rules.DEFAULT_RULES)
        first = copy.deepcopy(collection.documents)
        await rules.ensure_seeded()
        assert collection.documents == first
        assert collection.reads == 2
        assert len(collection.writes) == 1
    asyncio.run(run())


def test_legacy_upgrade_and_missing_defaults_share_a_batch_without_replacing_edits(monkeypatch):
    collection = RuleCollection([
        {"category": "selection", "reminder_offsets_days": [2, 4, 7, 10]},
        {"category": "quotation_tiles", "reminder_offsets_days": [3, 11], "is_active": False},
        {"category": "custom", "reminder_offsets_days": [6]},
    ])
    monkeypatch.setattr(rules, "db", SimpleNamespace(automation_rules=collection))
    asyncio.run(rules.ensure_seeded())
    assert collection.documents["selection"]["reminder_offsets_days"] == [0, 2, 4, 7, 10]
    assert collection.documents["quotation_tiles"] == {
        "category": "quotation_tiles", "reminder_offsets_days": [3, 11], "is_active": False,
    }
    assert collection.documents["custom"]["reminder_offsets_days"] == [6]
    assert len(collection.writes) == 1
    assert len(collection.writes[0]) == 2


def test_legacy_upgrade_does_not_overwrite_a_concurrent_staff_edit(monkeypatch):
    collection = RuleCollection([{"category": "selection", "reminder_offsets_days": [2, 4, 7, 10]}])
    collection.before_write = lambda: collection.documents["selection"].update(reminder_offsets_days=[0, 3, 8])
    monkeypatch.setattr(rules, "db", SimpleNamespace(automation_rules=collection))
    asyncio.run(rules.ensure_seeded())
    assert collection.documents["selection"]["reminder_offsets_days"] == [0, 3, 8]
