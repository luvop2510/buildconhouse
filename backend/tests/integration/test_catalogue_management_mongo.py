"""Catalogue commands over loopback against a disposable Mongo replica."""
from contextlib import asynccontextmanager
import asyncio
from base64 import b64encode
from io import BytesIO
import json
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
import httpx
from motor.motor_asyncio import AsyncIOMotorClient
from openpyxl import Workbook
from openpyxl.drawing.image import Image as WorkbookImage
from PIL import Image
import pytest
import uvicorn

from auth import get_current_user
from models import UserPublic
from routes import catalogue_management_routes as routes
from routes import quotation_routes
from services import catalog_database, catalog_service, catalogue_jobs as jobs
from tests.integration.test_tile_release_godown_mongo import tile_replica  # noqa: F401


CLI = Path(__file__).resolve().parents[3] / "scripts" / "buildcon_catalogue.py"
FLOOR = "first-floor"
TOKEN_OWNER = "synthetic-catalogue-owner"
TOKEN_WORKER = "synthetic-catalogue-worker"
BRAND = {"id": "supplier", "name": "Supplier", "slug": "supplier", "floor_id": FLOOR}
CATEGORY = {"id": "category", "name": "Basins", "slug": "basins", "brand_id": BRAND["id"], "floor_id": FLOOR}


@asynccontextmanager
async def local_api(database, monkeypatch):
    for module in (routes, jobs, catalog_database, catalog_service, quotation_routes):
        monkeypatch.setattr(module, "db", database)
    monkeypatch.setattr(catalog_service, "_snapshot", None)
    monkeypatch.setattr(catalog_service, "_background_refresh", None)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api")
    app.include_router(quotation_routes.router, prefix="/api")
    accounts = {
        TOKEN_OWNER: UserPublic(id="owner", email="owner@example.test", full_name="Owner", role="owner", floor_ids=[FLOOR]),
        TOKEN_WORKER: UserPublic(id="worker", email="worker@example.test", full_name="Worker", role="worker", floor_ids=[FLOOR]),
    }
    await database.users.insert_many([actor.model_dump() for actor in accounts.values()])
    await database.brands.insert_one(dict(BRAND))
    await database.categories.insert_one(dict(CATEGORY))
    await database.products.create_index([("floor_id", 1), ("brand_id", 1), ("sku", 1)], unique=True)

    async def actor(request: Request):
        user = accounts.get(request.headers.get("authorization", "").removeprefix("Bearer "))
        if not user:
            raise HTTPException(401, "Test bearer token required")
        return user

    app.dependency_overrides[get_current_user] = actor
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        server = uvicorn.Server(uvicorn.Config(app, log_config=None, access_log=False, lifespan="off"))
        task = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            async with asyncio.timeout(5):
                while not server.started:
                    if task.done():
                        await task
                        raise RuntimeError("Local catalogue API did not start")
                    await asyncio.sleep(.02)
            yield f"http://127.0.0.1:{listener.getsockname()[1]}"
        finally:
            server.should_exit = True
            await task
            if jobs._jobs:
                await asyncio.gather(*jobs._jobs.values())
            await catalog_service.stop_catalog_refresh()


async def cli(origin, *args, token=TOKEN_OWNER):
    process = await asyncio.create_subprocess_exec(
        sys.executable, str(CLI), "--url", origin, "--wait-seconds", "15", *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "BUILDCON_API_TOKEN": token},
    )
    async with asyncio.timeout(25):
        out, err = await process.communicate()
    return process.returncode, out.decode(), err.decode()


def fixture_product(sku, price=100, mrp=150):
    return {"id": f"product:{sku}", "sku": sku, "name": "Fixture Basin", "price": price, "mrp": mrp,
            "floor_id": FLOOR, "brand_id": BRAND["id"], "category_id": CATEGORY["id"],
            "updated_at": "2020-01-01T00:00:00Z", "active": True}


@pytest.mark.asyncio
async def test_price_cli_job_replay_conflict_rollback_and_employee_denial(tile_replica, monkeypatch, tmp_path):
    client = AsyncIOMotorClient(tile_replica)
    database = client[f"catalogue_{uuid4().hex}"]
    try:
        async with local_api(database, monkeypatch) as origin:
            await database.products.insert_many([fixture_product(sku) for sku in ("001", "002", "003")])
            await database.quotations.insert_one({"id": "previous", "floor_id": FLOOR,
                "items": [{"sku": "001", "unit_price": 91, "mrp": 149}]})
            supply = tmp_path / "price.csv"
            supply.write_text("Article No.,Current MRP,New MRP\n001,150,200\n002,150,201\n003,150,202\n", encoding="utf-8")
            args = ("import", "--floor", "sanitary", "--brand", BRAND["id"], "--operation", "prices", str(supply))
            denied, _, message = await cli(origin, *args, token=TOKEN_WORKER)
            assert denied == 1 and "403" in message
            assert await database.catalogue_imports.count_documents({}) == 0

            code, output, error = await cli(origin, *args)
            assert code == 0, error
            preview = json.loads(output)
            assert preview["status"] == "preview" and preview["summary"] == {"price": 3}
            assert (await database.products.find_one({"sku": "001"}))["mrp"] == 150
            await database.products.update_one({"sku": "002"}, {"$set": {"mrp": 275, "updated_at": "newer"}})

            code, output, error = await cli(origin, *args, "--apply")
            assert code == 0, error
            applied = json.loads(output)
            assert applied["status"] == "complete" and applied["id"] == preview["id"]
            assert applied["result"]["applied"] == 2 and applied["result"]["conflict"] == 1
            one = await database.products.find_one({"sku": "001"})
            assert one["mrp"] == 200 and one["price"] == 100
            assert one["catalog_mrp_only_override"] is True
            assert (await database.products.find_one({"sku": "002"}))["mrp"] == 275
            assert (await database.quotations.find_one({"id": "previous"}))["items"] == [{"sku": "001", "unit_price": 91, "mrp": 149}]
            code, output, error = await cli(origin, *args, "--apply")
            assert code == 0, error
            assert json.loads(output)["id"] == preview["id"]
            assert (await database.products.find_one({"sku": "001"}))["catalog_version"] == 1

            await database.products.update_one({"sku": "003"}, {"$set": {"name": "Legitimate later edit", "updated_at": "newer"}})
            code, output, error = await cli(origin, "job", "--floor", "sanitary", preview["id"], "--rollback")
            assert code == 0, error
            rolled = json.loads(output)
            assert rolled["status"] == "rolled_back" and rolled["rollback_result"] == {"restored": 1, "conflict": 1}
            one = await database.products.find_one({"sku": "001"})
            assert one["mrp"] == 150 and one["price"] == 100 and "catalog_mrp_only_override" not in one
            assert (await database.products.find_one({"sku": "003"}))["name"] == "Legitimate later edit"
    finally:
        await client.drop_database(database.name)
        client.close()


@pytest.mark.asyncio
async def test_file_parts_replay_and_additive_rollback_keep_product_identity(tile_replica, monkeypatch):
    client = AsyncIOMotorClient(tile_replica)
    database = client[f"catalogue_{uuid4().hex}"]
    try:
        async with local_api(database, monkeypatch) as origin:
            await database.products.insert_one(fixture_product("001"))
            file_data = b"Article No.,Product Name,Category,MRP\n001,Printed rename,Basins,999\n002,New Basin,Basins,345\n"
            headers = {"Authorization": f"Bearer {TOKEN_OWNER}", "x-floor-id": FLOOR}
            async with httpx.AsyncClient(base_url=origin, headers=headers, params={"floor_id": FLOOR}) as api:
                prefix = "/api/catalog/management/jobs"
                body = {"key": str(uuid4()), "brand_id": BRAND["id"], "operation": "add",
                        "filename": "add.csv", "size_bytes": len(file_data)}
                response = await api.post(prefix, json=body)
                assert response.is_success, response.text
                job_id = response.json()["id"]
                path = f"{prefix}/{job_id}"
                assert (await api.post(prefix, json=body)).json()["id"] == job_id
                await jobs.store_part({"_id": job_id, "size_bytes": len(file_data)}, 0, file_data)
                await jobs.store_part({"_id": job_id, "size_bytes": len(file_data)}, 0, file_data)
                with pytest.raises(HTTPException, match="different contents"):
                    await jobs.store_part({"_id": job_id, "size_bytes": len(file_data)}, 0, file_data[::-1])
                assert await database.catalogue_import_parts.count_documents({"job_id": job_id}) == 1
                assert (await api.post(f"{path}/preview", json={})).is_success
                await wait_status(api, path, "preview")
                assert (await api.post(f"{path}/apply", json={})).is_success
                await wait_status(api, path, "complete")
                assert (await database.products.find_one({"sku": "001"}))["name"] == "Fixture Basin"
                new = await database.products.find_one({"sku": "002"})
                assert new["active"] is True and new["mrp"] == 345
                assert await database.products.count_documents({"sku": "002"}) == 1
                assert (await api.post(f"{path}/rollback", json={})).is_success
                await wait_status(api, path, "rolled_back")
                after = await database.products.find_one({"sku": "002"})
                assert after["id"] == new["id"] and after["active"] is False
    finally:
        await client.drop_database(database.name)
        client.close()


async def wait_status(api, path, status):
    async with asyncio.timeout(12):
        while True:
            response = await api.get(path)
            assert response.is_success, response.text
            result = response.json()
            assert result["status"] != "failed", result.get("error")
            if result["status"] == status:
                return result
            await asyncio.sleep(.05)


@pytest.mark.asyncio
async def test_manual_creation_visible_in_every_department(tile_replica, monkeypatch):
    client = AsyncIOMotorClient(tile_replica)
    database = client[f"catalogue_{uuid4().hex}"]
    try:
        async with local_api(database, monkeypatch) as origin:
            async with httpx.AsyncClient(base_url=origin, headers={"Authorization": f"Bearer {TOKEN_OWNER}"}) as api:
                prefix = "/api/catalog/management"
                for floor in ("ground-floor", "first-floor", "second-floor", "third-floor"):
                    scope = {"floor_id": floor}
                    brand = await api.post(f"{prefix}/brands", params=scope, json={"name": "Local Fixture"})
                    assert brand.is_success, brand.text
                    brand_id = brand.json()["id"]
                    category = await api.post(f"{prefix}/categories", params=scope, json={"brand_id": brand_id, "name": "Floor fixture"})
                    assert category.is_success, category.text
                    product = {"brand_id": brand_id, "category_id": category.json()["id"], "sku": "000123",
                               "name": "Manual fixture", "mrp": 125.0, "price": 101.0}
                    if floor == "ground-floor":
                        product.update(size="600x600", specs={"price_unit": "sqft", "pcs_per_box": 4, "sqft_per_box": 16})
                    created = await api.post(f"{prefix}/products", params=scope, json=product)
                    assert created.is_success, created.text
                    replay = await api.post(f"{prefix}/products", params=scope, json=product)
                    assert replay.json()["id"] == created.json()["id"]
                    browse = await api.get(f"{prefix}/products", params={**scope, "q": "000123"})
                    assert browse.is_success, browse.text
                    assert [row["id"] for row in browse.json()["items"]] == [created.json()["id"]]
                assert await database.products.count_documents({"sku": "000123"}) == 4
    finally:
        await client.drop_database(database.name)
        client.close()


@pytest.mark.asyncio
async def test_embedded_image_repair_deduplicates_and_reaches_quotation_media(tile_replica, monkeypatch):
    from services import quotation_media

    class Storage:
        files = {}

        def get_public_url(self, *, bucket, key):
            return f"https://fixture.example.test/{bucket}/{key}"

        async def exists(self, *, bucket, key):
            return (bucket, key) in self.files

        async def upload(self, *, bucket, key, data, content_type):
            self.files[bucket, key] = data
            return SimpleNamespace(public_url=self.get_public_url(bucket=bucket, key=key))

        async def download(self, *, bucket, key):
            return self.files[bucket, key]

    client = AsyncIOMotorClient(tile_replica)
    database = client[f"catalogue_{uuid4().hex}"]
    storage = Storage()
    monkeypatch.setattr(jobs, "get_media_storage", lambda: storage)
    try:
        async with local_api(database, monkeypatch) as origin:
            old = fixture_product("001")
            old["images"] = ["https://fixture.example.test/lost.png"]
            await database.products.insert_one(old)
            photo = BytesIO()
            Image.new("RGB", (450, 400), "red").save(photo, format="PNG")
            photo.seek(0)
            book = Workbook()
            sheet = book.active
            sheet.title = "Products"
            sheet.append(["Article No.", "Product Image"])
            sheet.append(["001"])
            sheet.add_image(WorkbookImage(photo), "B2")
            blob = BytesIO()
            book.save(blob)
            source = blob.getvalue()
            headers = {"Authorization": f"Bearer {TOKEN_OWNER}", "x-floor-id": FLOOR}
            async with httpx.AsyncClient(base_url=origin, headers=headers, params={"floor_id": FLOOR}) as api:
                prefix = "/api/catalog/management/jobs"
                body = {"key": str(uuid4()), "brand_id": BRAND["id"], "operation": "images",
                        "filename": "images.xlsx", "size_bytes": len(source)}
                first = (await api.post(prefix, json=body)).json()
                path = f"{prefix}/{first['id']}"
                assert (await api.put(f"{path}/parts/0", json={"data_base64": b64encode(source).decode()})).is_success
                assert (await api.post(f"{path}/preview", json={})).is_success
                preview = await wait_status(api, path, "preview")
                assert preview["summary"] == {"image": 1}
                assert not any(bucket == jobs.public_bucket() for bucket, _ in storage.files)
                assert (await api.post(f"{path}/apply", json={})).is_success
                await wait_status(api, path, "complete")
                lines = await quotation_media.canonicalize_item_images([{"id": "q-line", "product_id": old["id"],
                    "sku": "001", "image": old["images"][0]}], FLOOR, include_candidates=True)
                assert "/catalogue-management/" in lines[0]["image"]
                assert (jobs.public_bucket(), lines[0]["image"].split("/" + jobs.public_bucket() + "/", 1)[1]) in storage.files

                another = (await api.post(prefix, json={**body, "key": str(uuid4())})).json()
                path = f"{prefix}/{another['id']}"
                assert (await api.put(f"{path}/parts/0", json={"data_base64": b64encode(source).decode()})).is_success
                assert (await api.post(f"{path}/preview", json={})).is_success
                assert (await wait_status(api, path, "preview"))["summary"] == {"unchanged": 1}
                assert await database.product_media.count_documents({"product_id": old["id"]}) == 1
    finally:
        await client.drop_database(database.name)
        client.close()
