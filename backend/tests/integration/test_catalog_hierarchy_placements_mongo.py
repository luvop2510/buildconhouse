"""Actual Mongo and warm catalog preserve identical selectable sections."""
import asyncio
from unittest.mock import AsyncMock

from motor.motor_asyncio import AsyncIOMotorClient

from services import catalog_service as catalog
from services import catalog_database as database
from tests.integration.test_purchase_completion_mongo import mongo_url  # noqa: F401
from tests.unit.test_catalog_hierarchy_placements import make_snapshot, source_products


def test_sections_facets_and_fallback_filters_match_real_mongo(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.hierarchy_placements
        try:
            snap = make_snapshot()
            await db.products.insert_many(source_products())
            await db.brands.insert_many(list(snap.brands))
            await db.categories.insert_many(list(snap.categories))
            monkeypatch.setattr(database, "db", db)
            monkeypatch.setattr(catalog, "get_catalog_snapshot", AsyncMock(return_value=snap))
            warm = await catalog.hierarchy_rows(["first-floor"])
            actual = await database.hierarchy({"floor_ids": ["first-floor"]})
            fields = ("brand_id", "category_id", "subcategory", "series", "family_key", "family_name")
            counts = lambda rows: {tuple(r["_id"].get(field) for field in fields): r["product_count"] for r in rows}
            assert counts(warm[0]) == counts(actual[0])
            assert {r["category_product_count"] for r in actual[0]} == {3}
            for subcategory, series in [(None, None), ("SHOWER PLATE 3", None), ("General", None),
                                        (None, "Uncategorised"), (["General", "SHOWER PLATE 3"], ["Uncategorised"]),
                                        (None, ""), (None, [""])]:
                arguments = dict(brand_id="grohe", category_id="showers", subcategory=subcategory,
                                 series=series, floor_ids=["first-floor"])
                assert await catalog.facet_buckets(**arguments) == await database.facets(arguments)
                families = {**arguments, "q": None, "limit": 60, "skip": 0, "finish": None, "colour": None, "size": None}
                expected = await catalog.list_family_groups(**families)
                actual = await database.families(families)
                assert actual["total"] == expected["total"]
                assert {r["sample_product_id"] for r in actual["items"]} == {r["sample_product_id"] for r in expected["items"]}
        finally:
            client.close()
    asyncio.run(run())


def test_equivalent_missing_branches_and_all_occurrence_price_ranges_match(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.hierarchy_missing_placements
        try:
            source = source_products()[0]
            source["catalog_entries"] = [
                {"entry_id": "missing", "category_id": "showers", "subcategory": None, "mrp": 100, "source_order": 1},
                {"entry_id": "empty", "category_id": "showers", "subcategory": "", "mrp": 200, "source_order": 2},
                {"entry_id": "named-fallback", "category_id": "showers", "subcategory": "General", "mrp": 300, "source_order": 3},
            ]
            reference = make_snapshot()
            snap = catalog._build_snapshot([source], [], list(reference.brands), list(reference.categories), [])
            await db.products.insert_one(source)
            await db.brands.insert_many(list(snap.brands))
            await db.categories.insert_many(list(snap.categories))
            monkeypatch.setattr(database, "db", db)
            monkeypatch.setattr(catalog, "get_catalog_snapshot", AsyncMock(return_value=snap))
            warm_rows, _, _ = await catalog.hierarchy_rows(["first-floor"])
            mongo_rows, _, _ = await database.hierarchy({"floor_ids": ["first-floor"]})
            assert sum(r["product_count"] for r in warm_rows) == sum(r["product_count"] for r in mongo_rows) == 1
            assert {r["category_product_count"] for r in mongo_rows} == {1}
            for subcategory in (None, "General", "", ["General", ""]):
                args = dict(brand_id="grohe", category_id="showers", subcategory=subcategory,
                            series=None, floor_ids=["first-floor"])
                warm = await catalog.facet_buckets(**args)
                mongo = await database.facets(args)
                assert warm == mongo
                assert warm["brands"] == [{"value": "grohe", "count": 1}]
                assert warm["price"] == ({"min": 100, "max": 300} if subcategory != "" else {"min": 200, "max": 200})
        finally:
            client.close()
    asyncio.run(run())
