"""Regression coverage for the GROHE/HANSGROHE taxonomy migration."""
from __future__ import annotations

import asyncio
import importlib
from copy import deepcopy


migration = importlib.import_module("migrations.0022_reorganize_grohe_hansgrohe_categories")


def _matches(doc: dict, query: dict) -> bool:
    for key, expected in query.items():
        actual = doc.get(key)
        if isinstance(expected, dict) and "$in" in expected:
            if actual not in expected["$in"]:
                return False
        elif actual != expected:
            return False
    return True


class _Cursor:
    def __init__(self, docs: list[dict]):
        self.docs = iter(docs)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return deepcopy(next(self.docs))
        except StopIteration:
            raise StopAsyncIteration


class _Collection:
    def __init__(self, docs: list[dict]):
        self.docs = docs

    async def find_one(self, query: dict, _projection=None):
        row = next((row for row in self.docs if _matches(row, query)), None)
        return deepcopy(row) if row else None

    def find(self, query: dict, _projection=None):
        return _Cursor([row for row in self.docs if _matches(row, query)])

    async def insert_one(self, doc: dict):
        self.docs.append(deepcopy(doc))

    async def update_many(self, query: dict, update: dict):
        for row in self.docs:
            if _matches(row, query):
                row.update(update["$set"])

    async def update_one(self, query: dict, update: dict):
        for row in self.docs:
            if _matches(row, query):
                row.update(update["$set"])
                return


class _Db:
    def __init__(self):
        category_names = set().union(*migration.GROHE_TARGETS.values(), *migration.HANSGROHE_TARGETS.values()) | {"Trigger & Tank"}
        self.categories = _Collection([
            {"id": f"legacy-{index}", "name": name, "floor_id": migration.FLOOR_ID, "slug": f"legacy-{index}"}
            for index, name in enumerate(sorted(category_names))
        ])
        by_name = {row["name"]: row["id"] for row in self.categories.docs}
        self.products = _Collection([
            {"id": "g-shower", "brand_id": migration.GROHE_BRAND_ID, "floor_id": migration.FLOOR_ID, "category_id": by_name["Showers"], "sku": "26863000"},
            {"id": "g-trigger", "brand_id": migration.GROHE_BRAND_ID, "floor_id": migration.FLOOR_ID, "category_id": by_name["Trigger & Tank"], "sku": "27513GN1"},
            {"id": "g-flush", "brand_id": migration.GROHE_BRAND_ID, "floor_id": migration.FLOOR_ID, "category_id": by_name["Trigger & Tank"], "sku": "38732GN0"},
            {"id": "g-valve", "brand_id": migration.GROHE_BRAND_ID, "floor_id": migration.FLOOR_ID, "category_id": by_name["Tall Body Basin Mixer"], "sku": "22041a00"},
            {"id": "g-kitchen", "brand_id": migration.GROHE_BRAND_ID, "floor_id": migration.FLOOR_ID, "category_id": by_name["Kitchen Tap"], "sku": "31615000"},
            {"id": "h-shower", "brand_id": migration.HANSGROHE_BRAND_ID, "floor_id": migration.FLOOR_ID, "category_id": by_name["Showers"], "sku": "27411000"},
            {"id": "h-kitchen", "brand_id": migration.HANSGROHE_BRAND_ID, "floor_id": migration.FLOOR_ID, "category_id": by_name["Kitchen"], "sku": "73830000"},
        ])


def test_migration_creates_brand_specific_labels_and_splits_workbook_skus():
    db = _Db()

    asyncio.run(migration.up(db))

    categories = {row["slug"]: row for row in db.categories.docs}
    assert categories["grohe-trigger"]["name"] == "TRIGGER"
    assert categories["grohe-flush-tanks"]["name"] == "FLUSH TANKS"
    assert categories["grohe-kitchen"]["name"] == "KITCHEN"
    assert categories["hansgrohe-kitchen"]["name"] == "kitchen"

    product_categories = {row["id"]: row["category_id"] for row in db.products.docs}
    assert product_categories["g-shower"] == categories["grohe-shower"]["id"]
    assert product_categories["g-trigger"] == categories["grohe-trigger"]["id"]
    assert product_categories["g-flush"] == categories["grohe-flush-tanks"]["id"]
    assert product_categories["g-valve"] == categories["grohe-trigger"]["id"]
    assert product_categories["g-kitchen"] == categories["grohe-kitchen"]["id"]
    assert product_categories["h-shower"] == categories["hansgrohe-showers"]["id"]
    assert product_categories["h-kitchen"] == categories["hansgrohe-kitchen"]["id"]

    target_count = len(migration.GROHE_TARGETS) + len(migration.HANSGROHE_TARGETS)
    asyncio.run(migration.up(db))
    assert len([row for row in db.categories.docs if row["slug"].startswith(("grohe-", "hansgrohe-"))]) == target_count
