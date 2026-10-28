"""Real, isolated Mongo coverage of the threshold catalog read strategy."""
import asyncio
import importlib
from motor.motor_asyncio import AsyncIOMotorClient
from services import catalog_service as catalog
from services import catalog_database as database
from models import ProductMedia
from tests.integration.test_purchase_completion_mongo import mongo_url  # noqa: F401


def product(index, **extra):
    return {"id": f"p{index}", "sku": f"SKU-{index:05}", "name": f"Product {index:05}", "brand_id": "brand", "category_id": "category", "floor_id": "first-floor", "price": float(index + 1), "mrp": float(index + 1), "active": True, "family_key": f"family-{index // 2}", "family_name": f"Family {index // 2:05}", "images": [], **extra}


async def seed(db):
    await db.brands.insert_one({"id": "brand", "name": "Company", "floor_id": "first-floor"})
    await db.categories.insert_one({"id": "category", "name": "Furniture", "floor_id": "first-floor"})


def setup(monkeypatch, db):
    monkeypatch.setattr(catalog, "db", db)
    monkeypatch.setattr(database, "db", db)
    monkeypatch.setattr(catalog, "_snapshot", None)
    monkeypatch.setattr(catalog, "_background_refresh", None)


def list_arguments(**extra):
    return {"user_id": "user", "q": None, "brand_id": None, "category_id": None, "subcategory": None, "series": None, "family_key": None, "finish": None, "colour": None, "sort": "name", "skip": 0, "limit": 2, "floor_ids": ["first-floor"], **extra}


def test_catalog_over_ten_thousand_has_complete_pages_counts_families_and_media(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url); db = client.catalog_scale
        setup(monkeypatch, db)
        try:
            await seed(db)
            await db.products.insert_many([product(index) for index in range(10004)] + [product(90000, floor_id="ground-floor")])
            image = ProductMedia(product_id='p10002', floor_id='first-floor', brand_id='brand', family_key='family-5001', public_url='https://example.test/exact.png', is_primary=True, role='hero', source_type='supplier', bucket='public', storage_key='exact.png', sha1='exact').model_dump()
            await db.product_media.insert_one(image)
            await importlib.import_module('migrations.0029_catalog_revision_audit_index').up(db)
            marker = await catalog.refresh_catalog_snapshot()
            assert marker.database_backed and not marker.products
            result = await catalog.list_products_page(**list_arguments(skip=5001))
            assert result['total'] == 5002
            assert [row['id'] for row in result['items']] == ['p10002']
            assert result['items'][0]['hero_image_url'] == image['public_url']
            assert [row['id'] for row in result['items'][0]['family_variants']] == ['p10002', 'p10003']
            groups = await catalog.list_family_groups(brand_id=None, category_id=None, subcategory=None, series=None, q=None, limit=2, skip=5000, floor_ids=['first-floor'])
            assert groups['total'] == 5002
            assert [row['family_key'] for row in groups['items']] == ['family-5000', 'family-5001']
            brands = await catalog.list_brands_with_counts(['first-floor'])
            assert brands[0]['product_count'] == 10004
            facets = await catalog.facet_buckets(brand_id=None, category_id=None, subcategory=None, series=None, floor_ids=['first-floor'])
            assert facets['brands'] == [{'value': 'brand', 'count': 10004}]
            assert facets['price'] == {'min': 1.0, 'max': 10004.0}
            search = await catalog.search_catalog(q='SKU-10003', brand_id=None, category_id=None, subcategory=None, series=None, limit=10, group=False, floor_ids=['first-floor'])
            assert search['total'] == 1 and search['items'][0]['id'] == 'p10003'
        finally: client.close()
    asyncio.run(run())


def test_database_source_occurrences_counts_authority_filter_and_no_double_expansion(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url); db = client.catalog_placements
        setup(monkeypatch, db)
        monkeypatch.setattr(catalog, '_SNAPSHOT_ROW_LIMITS', {**catalog._SNAPSHOT_ROW_LIMITS, 'products': 1})
        try:
            await seed(db)
            await db.categories.insert_one({'id': 'category2', 'name': 'Second', 'floor_id': 'first-floor'})
            await db.brands.insert_many([{'id': 'authoritative', 'name': 'Workbook', 'floor_id': 'first-floor', 'catalog_authoritative': True, 'catalog_source': 'source2026'}, {'id': 'removed', 'name': 'AXOR', 'floor_id': 'first-floor'}])
            await db.products.insert_many([
                product(1, catalog_entries=[{'entry_id':'entry1','category_id':'category','name':'First placement','mrp':30,'source_order':1}, {'entry_id':'entry2','category_id':'category2','name':'Second placement','mrp':50,'source_order':2}]),
                product(2, brand_id='authoritative'),
                product(3, brand_id='removed'),
                product(4),
            ])
            await catalog.refresh_catalog_snapshot()
            second = await catalog.list_products_page(**list_arguments(category_id='category2', sort='source'))
            assert second['total'] == 1
            assert second['items'][0]['name'] == 'Second placement' and second['items'][0]['price'] == 50
            groups = await catalog.list_family_groups(brand_id=None, category_id='category2', subcategory=None, series=None, q=None, limit=10, skip=0, floor_ids=['first-floor'])
            assert groups['total'] == 1 and len(groups['items']) == 1
            assert groups['items'][0]['catalog_entry']['entry_id'] == 'entry2'
            counts = await catalog.list_categories_with_counts(None, ['first-floor'])
            assert {r['id']:r['product_count'] for r in counts} == {'category':2, 'category2':1}
            search = await catalog.search_catalog(q='Second', brand_id=None, category_id='category2', subcategory=None, series=None, limit=2, group=False, floor_ids=['first-floor'])
            assert search['total'] == 1 and search['items'][0]['name'] == 'Second placement'
        finally: client.close()
    asyncio.run(run())


def test_byte_threshold_and_normal_cache_dont_truncate_or_query_mongo_each_read(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url); db = client.catalog_bytes
        setup(monkeypatch, db)
        try:
            await seed(db); await db.products.insert_many([product(i) for i in range(4)])
            normal = await catalog.refresh_catalog_snapshot()
            assert not normal.database_backed
            class NoDatabase:
                def __getattr__(self, key): raise AssertionError('Normal-sized read must use its warm cache')
            monkeypatch.setattr(database, 'db', NoDatabase())
            assert (await catalog.list_products_page(**list_arguments()))['total'] == 2
            monkeypatch.setattr(database, 'db', db)
            monkeypatch.setattr(catalog, '_SNAPSHOT_MAX_BYTES', 100)
            oversized = await catalog.refresh_catalog_snapshot()
            assert oversized.database_backed and not oversized.products
            assert (await catalog.list_products_page(**list_arguments()))['total'] == 2
        finally: client.close()
    asyncio.run(run())


def test_catalog_without_sort_spilling_preserves_full_source_metadata(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url); db = client.catalog_sort_memory
        setup(monkeypatch, db)
        try:
            await client.admin.command({"setParameter": 1, "internalQueryMaxBlockingSortMemoryUsageBytes": 1024 * 1024})
            await seed(db)
            note = 'Exact supplier notes ' + 'x' * 32768
            rows = [product(index, specs={'supplier_notes': note}, catalog_entries=[{
                'entry_id': f'entry-{index}', 'category_id': 'category', 'name': f'Listed {index:05}',
                'source_order': index, 'mrp': 42, 'source_cells': {'supplier_note': note},
            }]) for index in range(200)]
            await db.products.insert_many(rows)
            monkeypatch.setattr(catalog, '_SNAPSHOT_ROW_LIMITS', {**catalog._SNAPSHOT_ROW_LIMITS, 'products': 1})
            monkeypatch.setattr(database, 'aggregate', lambda pipeline: db.products.aggregate(pipeline, allowDiskUse=False, maxTimeMS=30000))
            await catalog.refresh_catalog_snapshot()
            families = await catalog.list_family_groups(brand_id=None, category_id=None, subcategory=None, series=None, q=None, limit=2, skip=0, floor_ids=['first-floor'])
            assert families['total'] == 100 and len(families['items']) == 2
            assert families['items'][0]['catalog_entry']['source_cells']['supplier_note'] == note
            listed = await catalog.list_products_page(**list_arguments(sort='source'))
            assert listed['total'] == 100
            assert listed['items'][0]['catalog_entry']['source_cells']['supplier_note'] == note
            assert listed['items'][0]['specs']['supplier_notes'] == note
            searched = await catalog.search_catalog(q='Listed', brand_id=None, category_id=None, subcategory=None, series=None, limit=2, group=False, floor_ids=['first-floor'])
            assert searched['total'] == 200 and len(searched['items']) == 2
            assert searched['items'][0]['catalog_entry']['source_cells']['supplier_note'] == note
        finally:
            client.close()
    asyncio.run(run())


def test_database_matches_warm_cache_for_sort_details_related_sizes_media_and_usage(mongo_url, monkeypatch):
    async def run():
        from services.purchase_images import hydrate_purchase_images
        from routes import quotation_routes
        from services import purchase_images
        client = AsyncIOMotorClient(mongo_url); db = client.catalog_parity
        setup(monkeypatch, db)
        try:
            await seed(db)
            await db.categories.insert_one({'id':'accessories','name':'Accessories','floor_id':'first-floor'})
            await db.products.insert_many([
                product(0, size='600X600', finish='Matt', series='Range', stock=3),
                product(1, size='1200X1200', finish='Matt', series='Range', stock=4),
                product(2, category_id='accessories', series='Range', name='Accessory'),
                product(3, family_key='family-1', finish='Chrome'),
                product(4, floor_id='ground-floor', family_key='family-0', size='Foreign'),
                product(5),
            ])
            await db.product_usage.insert_many([{'product_id':'p1','user_id':'user','count':5,'last_used_at':'2026-10-10'}, {'product_id':'p0','user_id':'other','count':10,'last_used_at':'2026-10-09'}, {'product_id':'p0','user_id':'user','count':1,'last_used_at':'2026-10-08'}, {'product_id':'p3','user_id':'user','count':1,'last_used_at':'2026-10-07'}])
            image = ProductMedia(product_id='p0', floor_id='first-floor', brand_id='brand', family_key='family-0', public_url='https://example.test/real.png', is_primary=True, role='hero', source_type='supplier', bucket='public', storage_key='real.png', sha1='real').model_dump()
            await db.product_media.insert_one(image)
            await catalog.refresh_catalog_snapshot()
            expected = {}
            for sort in ['popular', 'recent', 'source', 'price_asc', 'price_desc', 'name']:
                expected[sort] = await catalog.list_products_page(**list_arguments(sort=sort, limit=10))
            expected['detail'] = await catalog.product_by_id('p0', ['first-floor'])
            expected['size'] = await catalog.resolve_size_variant('p0', '1200x1200', ['first-floor'])
            expected['family'] = await catalog.family_detail('family-0', ['first-floor'])
            expected['media'] = await catalog.media_for_product('p0', ['first-floor'])
            expected['alternate'] = await catalog.alternate_products('p0', 'user', 4, ['first-floor'])
            expected['complete'] = await catalog.complete_set_products('p0', 4, ['first-floor'])
            expected['recent_usage'] = await catalog.recent_or_frequent_products('user', limit=2, recent=True, floor_ids=['first-floor'])
            expected['frequent_usage'] = await catalog.recent_or_frequent_products('user', limit=2, recent=False, floor_ids=['first-floor'])
            assert [row['id'] for row in expected['recent_usage']] == ['p1', 'p3']
            monkeypatch.setattr(catalog, '_SNAPSHOT_ROW_LIMITS', {**catalog._SNAPSHOT_ROW_LIMITS, 'products':1})
            marker = await catalog.refresh_catalog_snapshot()
            assert marker.database_backed
            for sort in ['popular', 'recent', 'source', 'price_asc', 'price_desc', 'name']:
                actual = await catalog.list_products_page(**list_arguments(sort=sort, limit=10))
                assert [r['id'] for r in actual['items']] == [r['id'] for r in expected[sort]['items']], sort
                assert [r['usage_count'] for r in actual['items']] == [r['usage_count'] for r in expected[sort]['items']], sort
            assert await catalog.product_by_id('p0', ['first-floor']) == expected['detail']
            assert await catalog.resolve_size_variant('p0', '1200x1200', ['first-floor']) == expected['size']
            assert await catalog.family_detail('family-0', ['first-floor']) == expected['family']
            assert await catalog.media_for_product('p0', ['first-floor']) == expected['media']
            assert await catalog.alternate_products('p0', 'user', 4, ['first-floor']) == expected['alternate']
            assert await catalog.complete_set_products('p0', 4, ['first-floor']) == expected['complete']
            assert await catalog.recent_or_frequent_products('user', limit=2, recent=True, floor_ids=['first-floor']) == expected['recent_usage']
            assert await catalog.recent_or_frequent_products('user', limit=2, recent=False, floor_ids=['first-floor']) == expected['frequent_usage']
            await catalog.note_product_usage('user', ['p1'], '2026-10-11')
            assert (await catalog.get_catalog_snapshot()).database_backed
            assert await catalog.product_by_id('p4', ['first-floor']) is None
            rows = [{'product_id':'p0','floor_id':'first-floor','sku':'SKU-00000','image':'old.png'}]
            await hydrate_purchase_images(rows)
            assert rows[0]['image'] == image['public_url']
            monkeypatch.setattr(quotation_routes, 'db', db)
            canonical = await quotation_routes._canonicalize_item_images([{'product_id':'p0','sku':'SKU-00000','image':'old.png'}, {'product_id':'p4','sku':'SKU-00004','image':'foreign.png'}], 'first-floor')
            assert canonical[0]['image'] == image['public_url']
            assert canonical[1]['image'] is None
        finally: client.close()
    asyncio.run(run())


def test_unchanged_warm_refresh_reuses_catalog_and_real_mongo_changes_rebuild(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.catalog_unchanged_refresh
        setup(monkeypatch, db)
        try:
            await seed(db)
            await db.products.insert_one(product(1))
            first = await catalog.refresh_catalog_snapshot()
            unchanged = await catalog.refresh_catalog_snapshot()
            assert not unchanged.database_backed
            assert unchanged.product_by_id is first.product_by_id
            assert unchanged.source_signatures == first.source_signatures
            assert unchanged.loaded_at >= first.loaded_at
            # Simulate an offline import: no process-local invalidation event.
            await db.products.update_one({"id": "p1"}, {"$set": {"price": 456.0, "name": "Imported update"}})
            changed = await catalog.refresh_catalog_snapshot()
            assert changed.product_by_id["p1"]["price"] == 456.0
            assert changed.product_by_id["p1"]["name"] == "Imported update"
            assert changed.source_signatures != first.source_signatures
            assert first.product_by_id["p1"]["price"] == 2.0
            result = await catalog.list_products_page(**list_arguments())
            assert result["items"][0]["price"] == 456.0
        finally:
            client.close()
    asyncio.run(run())
