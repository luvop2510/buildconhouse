"""Full SKU context must follow the selected workbook occurrence namespace."""
import asyncio

from motor.motor_asyncio import AsyncIOMotorClient
from services import catalog_service as catalog
from tests.integration.test_catalog_database_scale import list_arguments, product, seed, setup
from tests.integration.test_purchase_completion_mongo import mongo_url  # noqa: F401


def test_slim_listing_restores_occurrence_siblings_full_galleries_and_metadata(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.catalog_occurrence_context
        setup(monkeypatch, db)
        monkeypatch.setattr(catalog, '_SNAPSHOT_ROW_LIMITS', {**catalog._SNAPSHOT_ROW_LIMITS, 'products': 1})
        try:
            await seed(db)
            await db.categories.insert_many([
                {'id': 'occurrence', 'name': 'Workbook category', 'floor_id': 'first-floor'},
                {'id': 'sibling-canonical', 'name': 'Sibling canonical category', 'floor_id': 'first-floor'},
            ])
            images = ['https://example.test/one.png', 'https://example.test/two.png']
            entry = {'entry_id': 'occurrence-one', 'category_id': 'occurrence', 'name': 'Exact occurrence', 'mrp': 123, 'source_order': 1, 'source_cells': {'supplier_notes': 'Complete workbook provenance'}}
            await db.products.insert_many([
                product(1, family_key='shared', category_id='category', catalog_entries=[entry], images=images),
                product(2, family_key='shared', category_id='sibling-canonical', catalog_entries=[{
                    'entry_id': 'occurrence-two', 'category_id': 'occurrence', 'name': 'Other finish', 'mrp': 456, 'source_order': 2,
                }]),
                # Equal family key on another floor cannot become a variant.
                product(3, family_key='shared', floor_id='ground-floor', category_id='occurrence'),
            ])
            marker = await catalog.refresh_catalog_snapshot()
            assert marker.database_backed
            page = await catalog.list_products_page(**list_arguments(category_id='occurrence', q='Exact', sort='source'))
            selected = page['items'][0]
            assert selected['category_id'] == 'occurrence' and selected['price'] == 123
            assert selected['catalog_entry']['source_cells'] == entry['source_cells']
            assert selected['images'] == images
            assert {p['id'] for p in selected['family_variants']} == {'p1', 'p2'}
            assert {p['id'] for p in selected['variants']} == {'p2'}
            family = await catalog.list_family_groups(brand_id=None, category_id='occurrence', subcategory=None, series=None, q='Exact', limit=2, skip=0, floor_ids=['first-floor'])
            assert {p['id'] for p in family['items'][0]['variants']} == {'p1', 'p2'}
            search = await catalog.search_catalog(q='Exact', brand_id=None, category_id='occurrence', subcategory=None, series=None, limit=2, group=True, floor_ids=['first-floor'])
            assert {p['id'] for p in search['items'][0]['variants']} == {'p1', 'p2'}
        finally:
            client.close()
    asyncio.run(run())
