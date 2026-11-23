"""Exercise exact source artwork and idempotent imports on disposable Mongo."""

import hashlib
import os
from pathlib import Path
from uuid import uuid4

from motor.motor_asyncio import AsyncIOMotorClient
import pytest

from catalog_pipeline.grohe_ceramics import extract_images, load_manifest
from scripts.run_grohe_ceramics_import import apply_import, plan_import, report
from tests.integration.test_tile_release_godown_mongo import tile_replica  # noqa: F401


class LocalStorage:
    def __init__(self):
        self.objects = {}
        self.writes = 0
        self.fail_upload = False

    async def require_private_bucket(self, bucket):
        assert bucket == "private"

    def get_public_url(self, *, bucket, key):
        assert bucket == "public"
        return "https://images.invalid/" + key

    async def exists(self, *, bucket, key):
        return (bucket, key) in self.objects

    async def upload(self, *, bucket, key, data, content_type, upsert, **kwargs):
        if self.fail_upload and bucket == "public":
            raise ValueError("Simulated image storage failure")
        assert not upsert and (bucket, key) not in self.objects
        assert bucket == "public" or kwargs["cache_control"] == "private, no-store"
        self.objects[bucket, key] = data
        self.writes += 1

    async def download(self, *, bucket, key):
        return self.objects[bucket, key]


@pytest.mark.asyncio
async def test_grohe_ceramics_import_preserves_catalogue_identity_and_history(tile_replica, monkeypatch):
    from services import catalog_database, catalog_service
    from services.mutation_admission import AdmissionBusy, admission
    from services.mutation_scopes import CATALOG

    pdf_path = os.environ.get("GROHE_TEST_PDF")
    if not pdf_path:
        pytest.skip("Set GROHE_TEST_PDF to the supplied non-repository price catalogue")
    source = Path(pdf_path).read_bytes()
    manifest = load_manifest()
    assets = extract_images(source, manifest)
    client = AsyncIOMotorClient(tile_replica)
    database = client["grohe_ceramics_qa_" + uuid4().hex]
    storage = LocalStorage()
    namespace = {"floor_id": "first-floor", "brand_id": "grohe"}
    brand = {"id": "grohe", "name": "Grohe", "slug": "grohe", "floor_id": "first-floor",
             "catalog_authoritative": True, "catalog_source": "workbook.xlsx"}
    source_product = {
        **namespace, "id": "original-wc", "sku": "105536SH00", "name": "Old WC description", "stock": 5,
        "price": 32_000, "mrp": 35_000, "category_id": "old-wc", "specs": {"staff_note": "keep"},
        "catalog_source": "workbook.xlsx", "active": True,
        "catalog_entries": [{"entry_id": "existing-wc-placement", "category_id": "old-wc", "mrp": 35_000}],
    }
    unrelated = [
        {**source_product, "id": "old-bundle", "sku": "105536SH00 + 39577001"},
        {**source_product, "id": "other-floor", "floor_id": "ground-floor"},
        {**source_product, "id": "other-brand", "brand_id": "other-supplier"},
    ]
    quote = {"id": "old-quote", "items": [{"product_id": source_product["id"], "unit_price": 32_000}]}
    try:
        await database.brands.insert_one(brand.copy())
        await database.categories.create_index([("floor_id", 1), ("slug", 1)], unique=True)
        await database.products.create_index([("floor_id", 1), ("brand_id", 1), ("sku", 1)], unique=True)
        await database.categories.insert_many([
            {"id": "old-wc", "name": "WC", "slug": "grohe-wc", "floor_id": "first-floor"},
            {"id": "correct-wc", "name": "WC", "slug": "grohe-workbook-wc", **namespace},
            {"id": "accessories", "name": "Accessories", "slug": "accessories", "floor_id": "first-floor"},
        ])
        await database.products.insert_many([source_product.copy(), *(product.copy() for product in unrelated)])
        await database.quotations.insert_one(quote.copy())
        await database.purchase_orders.insert_one(quote.copy())

        async def inspect():
            return await plan_import(database, storage, "public", manifest, assets)

        async def publish(plan):
            return await apply_import(database, storage, "public", "private", manifest,
                                      assets, source, plan, verify_public=False)

        initial = await inspect()
        preview = report(manifest, initial)
        assert (preview["products_added"], preview["products_updated"], preview["create_basin_category"]) == (81, 1, True)
        assert not storage.writes
        storage.fail_upload = True
        with pytest.raises(ValueError, match="Simulated image storage failure"):
            await publish(initial)
        assert await database.products.count_documents({}) == len(unrelated) + 1
        assert await database.product_media.count_documents({}) == 0
        assert await database.categories.count_documents({"name": "Basin"}) == 0

        storage.fail_upload = False
        async with admission(database, scope=CATALOG):
            with pytest.raises(AdmissionBusy):
                await publish(initial)
        assert await database.products.count_documents({}) == len(unrelated) + 1
        async with admission(database, scope={"quotations": None}):
            job_id = await publish(initial)
        assert job_id
        assert (await database.catalog_import_snapshots.count_documents({"job_id": job_id})) == 82
        products = {product["sku"]: product async for product in database.products.find(namespace, {"_id": 0})}
        wc = products["105536SH00"]
        assert (wc["id"], wc["category_id"], wc["price"], wc["mrp"], wc["stock"]) == (
            "original-wc", "correct-wc", 32_000, 36_270, 5,
        )
        assert wc["catalog_entries"][0]["entry_id"] == "existing-wc-placement"
        assert wc["catalog_source"] == brand["catalog_source"]
        assert wc["specs"]["staff_note"] == "keep"
        seat = products["39577001"]
        included = wc["specs"]["default_included_parts"]
        assert len(included) == 1 and (included[0]["sku"], included[0]["product_id"], included[0]["mrp"]) == (
            seat["sku"], seat["id"], 8730,
        )
        assert included[0]["image"].startswith("https://images.invalid/")
        assert seat["id"] in wc["accessory_ids"]
        assert products["102486SH00"]["specs"]["availability"] == "Coming Soon"
        shower = products["39354SH1"]
        assert not shower["specs"].get("default_included_parts")
        assert shower["accessory_ids"] == [products["46944001"]["id"]]
        assert products["103575SH00"]["subcategory"] == "Basin Waste"
        assert products["103575SH00"]["category_id"] == "accessories"
        assert products["1137972430"]["category_id"] == preview["basin_category_id"]
        assert await database.categories.count_documents({"name": "Basin", **namespace}) == 1
        registered = {item["product_id"]: item async for item in database.product_media.find(namespace)}
        assert len(registered) == 82
        for row in manifest["products"]:
            product = products[row["sku"]]
            image = registered[product["id"]]
            assert image["is_primary"] and product["specs"]["grohe_ceramics_image_sha1"] == image["sha1"]
            stored = await storage.download(bucket=image["bucket"], key=image["storage_key"])
            assert hashlib.sha256(stored).hexdigest() == row["image_sha256"]
        assert storage.writes == 81  # 80 original artwork objects and one private source PDF.

        for product in unrelated:
            assert await database.products.find_one({"id": product["id"]}, {"_id": 0}) == product
        assert await database.quotations.find_one({}, {"_id": 0}) == quote
        assert await database.purchase_orders.find_one({}, {"_id": 0}) == quote
        monkeypatch.setattr(catalog_database, "db", database)
        monkeypatch.setattr(catalog_service, "db", database)
        monkeypatch.setattr(catalog_service, "_snapshot", None)
        catalog = await catalog_service.refresh_catalog_snapshot()
        assert not catalog.database_backed
        updated = await catalog_service.product_by_id(wc["id"], ["first-floor"], "existing-wc-placement")
        assert updated["hero_image_url"].startswith("https://images.invalid/")
        assert (updated["price"], updated["mrp"]) == (32_000, 36_270)
        mongo = await catalog_database.families({
            "floor_ids": ["first-floor"], "brand_id": "grohe", "category_id": preview["basin_category_id"],
            "subcategory": None, "series": None, "q": "1137972430", "limit": 30, "skip": 0,
        })
        assert mongo["total"] == 1
        retry = await inspect()
        assert report(manifest, retry)["unchanged"] == 82
        assert await publish(retry) is None
        assert storage.writes == 81
        assert await database.catalog_imports.count_documents({}) == 1
    finally:
        await catalog_service.stop_catalog_refresh()
        await client.drop_database(database.name)
        client.close()
