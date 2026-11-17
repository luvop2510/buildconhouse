"""Exercise the reviewed import against an isolated Mongo replica."""
import hashlib
import json
import os
from pathlib import Path
import sys
from uuid import uuid4

from motor.motor_asyncio import AsyncIOMotorClient
import pytest

from tests.integration.test_tile_release_godown_mongo import tile_replica


class LocalStorage:
    def __init__(self):
        self.objects = {}
        self.writes = 0

    async def require_private_bucket(self, bucket):
        assert bucket == "private"

    def get_public_url(self, *, bucket, key):
        assert bucket == "public"
        return "https://images.invalid/" + key

    async def exists(self, *, bucket, key):
        return (bucket, key) in self.objects

    async def upload(self, *, bucket, key, data, content_type, upsert):
        assert not upsert and (bucket, key) not in self.objects
        self.objects[bucket, key] = data
        self.writes += 1

    async def download(self, *, bucket, key):
        return self.objects[bucket, key]


@pytest.mark.asyncio
async def test_reviewed_mcm_import_uses_53_exact_variants_and_keeps_history(tile_replica, monkeypatch):
    workbook_filename = os.environ.get("MCM_TEST_WORKBOOK")
    if not workbook_filename:
        pytest.skip("Set MCM_TEST_WORKBOOK to the supplied non-repository workbook")
    source = Path(workbook_filename)
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "scripts"))
    from apply_mcm_catalogue import apply_reviewed
    from preview_mcm_catalogue import compare, read_source

    data, rows = read_source(source)
    client = AsyncIOMotorClient(tile_replica)
    db = client["mcm_qa_" + uuid4().hex]
    storage = LocalStorage()
    category = {"id": "tiles", "name": "Tiles", "slug": "tiles", "floor_id": "ground-floor"}
    other_brand = {"id": "other", "name": "Other", "slug": "other", "floor_id": "ground-floor"}
    other_product = {"id": "p-other", "sku": "other", "name": "Another supplier product", "brand_id": "other", "floor_id": "ground-floor"}
    historical_quote = {"id": "frozen-quote", "status": "approved", "items": [{"unit_price": 3950, "rate_sqft": 50}]}
    historical_order = {"id": "frozen-order", "items": [{"unit_price": 3950}]}
    await db.categories.insert_one(category.copy())
    await db.brands.create_index([("floor_id", 1), ("slug", 1)], unique=True)
    await db.products.create_index([("floor_id", 1), ("brand_id", 1), ("sku", 1)], unique=True)
    await db.brands.insert_one(other_brand.copy())
    await db.products.insert_one(other_product.copy())
    await db.quotations.insert_one(historical_quote.copy())
    await db.purchase_orders.insert_one(historical_order.copy())

    async def preview():
        return json.loads(json.dumps({
            **await compare(db, rows), "mode": "dry-run", "database": db.name,
            "source_sha256": hashlib.sha256(data).hexdigest(),
        }))

    async def apply(plan, *, create=False):
        return await apply_reviewed(
            db, storage, rows=rows, data=data, preview=plan, filename=source.name, public_bucket="public",
            private_bucket="private", actor_id="qa-owner", create_brand=create, verify_public=False,
        )

    try:
        initial = await preview()
        with pytest.raises(ValueError, match="explicit creation"):
            await apply(initial)
        assert storage.writes == 0
        receipt = await apply(initial, create=True)
        assert receipt["created_brand"]
        assert receipt["created_products"] == 53
        assert receipt["linked_images"] == 53
        assert receipt["unique_artwork_objects_verified"] == 52
        assert storage.writes == 53  # 52 assets plus the private original workbook

        brand_id = receipt["brand_id"]
        scope = {"brand_id": brand_id, "floor_id": "ground-floor"}
        products = {p["sku"]: p async for p in db.products.find(scope)}
        media = {m["product_id"]: m async for m in db.product_media.find(scope)}
        assert len(products) == len(media) == 53
        assert await db.catalog_import_snapshots.count_documents({"job_id": receipt["job_id"], **scope}) == 53
        for expected, report in zip(rows, initial["rows"], strict=True):
            product = products[expected.sku]
            assert (product["name"], product["size"], product["finish"], product["price"]) == (
                expected.name, expected.size, expected.finish, expected.mrp,
            )
            assert product["specs"]["price_unit"] == "sqft"
            assert product["specs"]["pcs_per_box"] == expected.specs["pcs_per_box"]
            assert product["specs"]["sqft_per_box"] == expected.specs["sqft_per_box"]
            picture = media[product["id"]]
            assert picture["is_primary"]
            stored = storage.objects[picture["bucket"], picture["storage_key"]]
            assert hashlib.sha1(stored).hexdigest() == report["normalized_image_sha1"]
        earth = [p for p in products.values() if p["name"] == "RAMMED EARTH YELLOW GREY"]
        assert len({p["family_key"] for p in earth}) == 1
        assert len({media[p["id"]]["storage_key"] for p in earth}) == 1

        with pytest.raises(ValueError, match="fresh preview"):
            await apply(initial, create=True)
        assert (await apply(await preview()))["unchanged"] == 53
        assert storage.writes == 53
        assert await db.catalog_imports.count_documents({}) == 1

        # Reprice the existing product in place while retaining unrelated
        # specifications, artwork, quotations, orders and catalogue records.
        sunny = products["MCM-SLATESUNNY-600X1200-STONE"]
        await db.products.update_one({"_id": sunny["_id"]}, {"$set": {"price": 1, "specs.staff_note": "keep"}})
        await db.products.insert_one({
            **scope, "id": "absent", "sku": "absent", "name": "Still available outside the workbook", "price": 9,
        })
        refreshed = await apply(await preview())
        assert refreshed["updated_products"] == 1
        assert refreshed["created_products"] == refreshed["linked_images"] == 0
        same_product = await db.products.find_one({"id": sunny["id"]})
        assert same_product["price"] == 390
        assert same_product["specs"]["staff_note"] == "keep"
        assert float(same_product["specs"]["sqft_per_box"]) * same_product["price"] == 54405
        assert await db.products.find_one({"id": "absent"}, {"price": 1, "_id": 0}) == {"price": 9}
        assert await db.products.find_one({"id": "p-other"}, {"_id": 0}) == other_product
        assert await db.quotations.find_one({}, {"_id": 0}) == historical_quote
        assert await db.purchase_orders.find_one({}, {"_id": 0}) == historical_order
    finally:
        await client.drop_database(db.name)
        client.close()
