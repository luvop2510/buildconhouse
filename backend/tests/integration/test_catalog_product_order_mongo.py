"""Exercise shared catalog ordering through signed HTTP on disposable Mongo."""
import asyncio
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from motor.motor_asyncio import AsyncIOMotorClient

import auth
from routes import catalog_routes
from services import catalog_database, catalog_service
from services.access_grants import build_grant
from tests.integration.test_purchase_completion_mongo import mongo_url  # noqa: F401


FLOOR = "first-floor"
BRAND = "grohe"
SHOWER = "shower"
LEVER = "single-lever"
PRODUCT_ORDER = "/api/catalog/product-order"
FAMILIES = "/api/products/families"


def _product(product_id, name, position, *, family=None, second_category=False):
    entries = [{"entry_id": f"{product_id}-shower", "category_id": SHOWER, "name": name,
                "source_order": position, "source_catalog": "grohe-2026", "mrp": position * 100}]
    if second_category:
        entries.append({"entry_id": f"{product_id}-lever", "category_id": LEVER, "name": name,
                        "source_order": position + 100, "source_catalog": "grohe-2026", "mrp": position * 100})
    return {"id": product_id, "sku": product_id, "name": name, "active": True,
            "price": position * 100, "floor_id": FLOOR, "brand_id": BRAND, "category_id": SHOWER,
            "family_key": family, "family_name": name, "catalog_entries": entries}


@pytest.mark.parametrize("database_mode", [False, True], ids=["warm", "bounded-mongo"])
def test_shared_product_order_across_sessions_sorts_categories_and_membership(mongo_url, monkeypatch, database_mode):
    async def exercise():
        client = AsyncIOMotorClient(mongo_url)
        database = client[f"catalog_order_acceptance_{uuid4().hex}"]
        try:
            for module in (auth, catalog_routes, catalog_database, catalog_service):
                monkeypatch.setattr(module, "db", database)
            monkeypatch.setattr(catalog_service, "_snapshot", None)
            if database_mode:
                monkeypatch.setattr(catalog_service, "_SNAPSHOT_ROW_LIMITS", {
                    **catalog_service._SNAPSHOT_ROW_LIMITS, "products": 1,
                })
            await database.brands.insert_many([
                {"id": BRAND, "name": "Grohe", "floor_id": FLOOR},
                {"id": "other", "name": "Other Brand", "floor_id": FLOOR},
            ])
            await database.categories.insert_many([
                {"id": category, "name": name, "floor_id": FLOOR}
                for category, name in [(SHOWER, "Shower"), (LEVER, "Single Lever")]
            ])
            first = ["tempesta-100", "tempesta-cosmo", "tempesta-210", "tempesta-250", "cube"]
            names = ["Tempesta 100", "Tempesta Cosmopolitan", "Tempesta 210", "Tempesta 250", "Cube Shower"]
            await database.products.insert_many([
                *[_product(product_id, name, index, family="tempesta-base" if index == 1 else None,
                           second_category=index in {1, 5})
                  for index, (product_id, name) in enumerate(zip(first, names, strict=True), 1)],
                _product("tempesta-variant", "Tempesta 100 Chrome", 6, family="tempesta-base"),
                {**_product("other-one", "Other Brand Shower", 12), "brand_id": "other"},
                {**_product("other-two", "Other Brand Mixer", 13), "brand_id": "other"},
                {**_product("lever-only", "Mixer Exclusive", 14), "category_id": LEVER, "catalog_entries": []},
            ])
            await database.product_media.insert_one({
                "id": "tempesta-preview", "product_id": "tempesta-100", "floor_id": FLOOR,
                "source_type": "supplier", "role": "hero", "bucket": "forge-products",
                "storage_key": "tempesta100.webp", "public_url": "https://images.example.test/tempesta100.webp",
                "sha1": "test-image-hash",
            })
            await database.product_usage.insert_many([
                {"product_id": "tempesta-variant", "user_id": "viewer", "count": 4, "last_used_at": "2026-11-15T04:00:00Z"},
                {"product_id": "tempesta-210", "user_id": "viewer", "count": 2, "last_used_at": "2026-11-18T04:00:00Z"},
            ])
            # The catalog has no write access to saved quotations.
            quotation = {"id": "original-quotation", "floor_id": FLOOR, "items": [{"product_id": "tempesta-250", "sort_order": 0}]}
            await database.quotations.insert_one(quotation)

            for user_id, role, custom, resources in [
                ("owner", "owner", False, []),
                ("viewer", "sales", True, [("quotations", ["view"])]),
                ("manager", "manager", False, []),
                ("catalog-manager", "sales", True, [("catalog", ["view", "update"])]),
                ("delegate", "sales", True, [("quotations", ["view"]), ("catalog_product_reorder", ["view", "update"])]),
            ]:
                grants = [build_grant(user_id=user_id, resource=resource, actions=actions, floor_id=FLOOR,
                                      expires_at=None, actor_id="owner", actor_name="Owner") for resource, actions in resources]
                await database.users.insert_one({"id": user_id, "email": f"{user_id}@example.test", "full_name": user_id,
                                                 "role": role, "floor_ids": [FLOOR], "custom_access": custom,
                                                 "active": True, "delegation_grants": grants})

            async def identity(user_id, floor=FLOOR):
                session_id = await auth.create_session("staff", user_id, None)
                token = auth.create_token(user_id, "staff", {"session_id": session_id})
                return {"Authorization": f"Bearer {token}", "X-Floor-Id": floor}

            snapshot = await catalog_service.refresh_catalog_snapshot()
            assert snapshot.database_backed is database_mode
            app = FastAPI()
            app.include_router(catalog_routes.router, prefix="/api")
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test") as api:
                owner = await identity("owner")
                viewer = await identity("viewer")
                delegate = await identity("delegate")
                manager = await identity("manager")
                catalog_manager = await identity("catalog-manager")
                params = {"brand_id": BRAND, "category_id": SHOWER}

                async def products(actor, sort="custom", category=SHOWER, *, brand=BRAND, skip=0, limit=10, version=None):
                    filters = {key: value for key, value in {"brand_ids": brand, "category_ids": category}.items() if value is not None}
                    response = await api.get(FAMILIES, params={**filters, "sort": sort, "skip": skip, "limit": limit}, headers=actor)
                    assert response.status_code == 200, response.text
                    body = response.json()
                    if version is not None:
                        assert body["order_version"] == version
                    return [row["sample_product_id"] for row in body["items"]]

                async def save(actor, order, expected, scope=params):
                    return await api.put(PRODUCT_ORDER, params=scope, headers=actor,
                                         json={"expected_version": expected, "product_ids": order})

                async def editor(actor, scope=params):
                    response = await api.get(PRODUCT_ORDER, params={**scope, "include_products": "true"}, headers=actor)
                    assert response.status_code == 200, response.text
                    assert response.headers["Cache-Control"] == "no-store"
                    return response.json()

                for actor, can_reorder in [(owner, True), (delegate, True), (catalog_manager, True), (viewer, False), (manager, False)]:
                    response = await api.get(PRODUCT_ORDER, params=params, headers=actor)
                    assert response.status_code == 200, response.text
                    assert response.headers["Cache-Control"] == "no-store"
                    assert response.json() == {"version": 0, "can_reorder": can_reorder}

                initial_editor = await editor(owner)
                assert initial_editor["version"] == 0
                assert [card["id"] for card in initial_editor["products"]] == await products(owner, sort="default")
                assert all(card.keys() == {"id", "sku", "name", "price", "price_unknown", "image"}
                           for card in initial_editor["products"])
                assert initial_editor["products"][0] == {
                    "id": "tempesta-100", "sku": "tempesta-100", "name": "Tempesta 100",
                    "price": 100, "price_unknown": False, "image": "https://images.example.test/tempesta100.webp",
                }
                assert await editor(viewer) == {"version": 0, "can_reorder": False}

                moved = [first[-1], *first[:-1]]
                other_order = await products(owner, category=LEVER, version=0)
                assert await products(owner, version=0) == first
                assert (await save(viewer, moved, 0)).status_code == 403
                assert (await save(manager, moved, 0)).status_code == 403
                assert (await save(owner, [*moved, moved[0]], 0)).status_code == 422
                assert (await save(owner, [*moved[:-1], "unknown"], 0)).status_code == 409

                changed = await save(delegate, moved, 0)
                assert changed.status_code == 200, changed.text
                assert changed.json() == {"version": 1, "can_reorder": True}
                assert (await save(delegate, moved, 0)).json() == changed.json()
                refreshed = await identity("viewer")
                assert await products(refreshed, limit=2, version=1) == moved[:2]
                assert await products(refreshed, skip=2, limit=3, version=1) == moved[2:]
                assert await products(refreshed, sort="price_asc") == first
                assert await products(refreshed, sort="price_desc") == list(reversed(first))
                assert await products(refreshed, sort="name") == ["cube", "tempesta-100", "tempesta-210", "tempesta-250", "tempesta-cosmo"]
                assert (await products(refreshed, sort="popular"))[:2] == ["tempesta-100", "tempesta-210"]
                assert (await products(refreshed, sort="recent"))[:2] == ["tempesta-210", "tempesta-100"]
                assert await products(refreshed, version=1) == moved
                assert await products(refreshed, category=LEVER, version=0) == other_order
                assert await products(refreshed, sort="default", version=1) == moved

                # A SKU listed in more than one category appears once in the
                # brand-wide view, which keeps its own independent sequence.
                brand_scope = {"brand_id": BRAND}
                brand_cards = await products(owner, category=None, version=0)
                assert len(brand_cards) == len(set(brand_cards)) == 6
                brand_order = list(reversed(brand_cards))
                assert (await save(viewer, brand_order, 0, brand_scope)).status_code == 403
                assert (await save(owner, brand_order, 0, brand_scope)).status_code == 200
                assert await products(refreshed, sort="default", category=None, version=1) == brand_order
                assert await products(refreshed, sort="default", version=1) == moved
                assert await products(refreshed, category=LEVER, version=0) == other_order

                global_cards = await products(owner, brand=None, category=None, version=0)
                assert set(global_cards) == {*brand_cards, "other-one", "other-two"}
                global_order = list(reversed(global_cards))
                assert (await save(owner, global_order, 0, {})).status_code == 200
                assert await products(refreshed, sort="default", brand=None, category=None, version=1) == global_order
                for actor, scope, saved in [
                    (owner, params, moved), (delegate, brand_scope, brand_order), (catalog_manager, {}, global_order),
                ]:
                    snapshot = await editor(actor, scope)
                    assert snapshot["version"] == 1
                    assert [card["id"] for card in snapshot["products"]] == saved
                assert await products(refreshed, sort="default", category=None, version=1) == brand_order
                assert (await save(delegate, ["other-two", "other-one"], 0, {"brand_id": "other"})).status_code == 200
                assert await products(refreshed, sort="default", brand="other", category=None, version=1) == ["other-two", "other-one"]
                assert await products(refreshed, sort="default", brand=None, category=None, version=1) == global_order

                # A less expensive finish must not move the family ahead of
                # cards whose displayed representative price is lower.
                await database.products.update_one({"id": "tempesta-100"}, {"$set": {"catalog_entries.0.mrp": 450}})
                await catalog_service.refresh_catalog_snapshot()
                assert await products(refreshed, sort="price_asc") == [*first[1:4], first[0], first[4]]
                await database.products.update_one({"id": "tempesta-variant"}, {"$set": {"catalog_entries.0.mrp": 10}})
                await catalog_service.refresh_catalog_snapshot()
                assert await products(refreshed, sort="price_asc") == [*first[1:4], first[0], first[4]]

                response_a, response_b = await asyncio.gather(save(owner, first, 1), save(catalog_manager, list(reversed(first)), 1))
                assert sorted([response_a.status_code, response_b.status_code]) == [200, 409]
                committed = first if response_a.status_code == 200 else list(reversed(first))
                assert await products(refreshed, version=2) == committed
                await database.users.update_one({"id": "delegate"}, {"$pull": {"delegation_grants": {"resource": "catalog_product_reorder"}}})
                assert (await save(delegate, moved, 2)).status_code == 403

                await database.products.update_one({"id": "tempesta-100"}, {"$set": {"active": False}})
                await database.products.insert_one(_product("new", "New catalog product", 0))
                await catalog_service.refresh_catalog_snapshot()
                # Removing the old representative leaves the surviving family
                # in place. A new, unranked item follows every saved position.
                after = ["tempesta-variant" if product_id == "tempesta-100" else product_id for product_id in committed]
                assert await products(refreshed, version=2) == [*after, "new"]
                assert (await save(owner, committed, 2)).status_code == 409
                assert (await api.get(PRODUCT_ORDER, params=params, headers=await identity("owner", "ground-floor"))).status_code == 404
                assert await database.quotations.find_one({"id": quotation["id"]}) == quotation
                assert await database.catalog_product_orders.count_documents({}) == 4

                # Match the deployed All Brands card count in both catalog modes.
                await database.products.insert_many([
                    {**_product(f"large-{index}", f"Showroom Product {index}", index + 200), "brand_id": "other"}
                    for index in range(1609)
                ])
                await catalog_service.refresh_catalog_snapshot()
                snapshot = await editor(owner, {})
                ids = [card["id"] for card in snapshot["products"]]
                assert len(ids) == len(set(ids)) == 1618
                assert ids[:3] == global_order[:3]
                assert (await products(owner, sort="default", brand=None, category=None, limit=50)) == ids[:50]
        finally:
            await client.drop_database(database.name)
            client.close()

    asyncio.run(exercise())


def test_cold_catalog_uses_the_same_tile_price_groups_as_warm_catalog(mongo_url):
    async def exercise():
        client = AsyncIOMotorClient(mongo_url)
        database = client[f"catalog_order_units_{uuid4().hex}"]
        try:
            specs = [{}, {"rate_per_sqft": None}, {"rate_unit": "per tile"}, {"price_unit": "tiles"},
                     {"price_unit": "per tiles"}, {"price_unit": "square foot"}, {"price_unit": "Per_Square.Foot"},
                     {"price_unit": " box-"}, {"price_unit": " Per-box "}, {"price_unit": " ", "rate_per_sqft": 3},
                     {"price_unit": False, "rate_unit": " per sq ft"}]
            rows = [{"id": index, "floor_id": "ground-floor", "specs": value} for index, value in enumerate(specs)]
            await database.products.insert_many(rows)
            cold = await database.products.aggregate([
                {"$project": {"id": 1, "kind": catalog_database._tile_price_kind_expression()}},
                {"$sort": {"id": 1}},
            ]).to_list(len(rows))
            assert [row["kind"] for row in cold] == [catalog_service._tile_price_kind(row) for row in rows]
        finally:
            await client.drop_database(database.name)
            client.close()

    asyncio.run(exercise())
