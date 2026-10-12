"""Family browse remains complete under child matches and database pagination."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from fastapi import HTTPException
from models import ProductPatch
from services import catalog_service as catalog
from services import catalog_database as mongo
from routes import catalog_routes


def product(id, **values):
    return {"id": id, "sku": f"SKU-{id}", "name": f"Basin {id}", "family_key": "basin",
            "family_name": "Basin", "floor_id": "first-floor", "brand_id": "brand",
            "category_id": "basins", "price": 100, "mrp": 120, "stock": 3,
            "finish": "Chrome", "colour": "Silver", "size": "30 cm", "active": True,
            **values}


@pytest.fixture
def snapshot(monkeypatch):
    rows = [product("silver"), product("black", finish="Black", colour="Black", price=150),
            product("other", family_key="other"), product("other-brand", brand_id="other-brand"),
            product("other-category", category_id="other-category"), product("private", floor_id="ground-floor")]
    snap = catalog._build_snapshot(rows, [], [], [], [])
    monkeypatch.setattr(catalog, "get_catalog_snapshot", AsyncMock(return_value=snap))
    return snap


def families(**values):
    return asyncio.run(catalog.list_family_groups(**{"brand_id": None, "category_id": None,
        "subcategory": None, "series": None, "q": None, "limit": 100, "skip": 0,
        "floor_ids": ["first-floor"], **values}))


def test_child_search_and_color_filter_keep_all_family_choices(snapshot):
    for filters in [{"q": "SKU-black"}, {"finish": ["Black"]}, {"colour": ["Black"]}]:
        response = families(**filters)
        assert response["total"] == 1
        card = response["items"][0]
        assert card["sample_product_id"] == "black"
        assert [v["id"] for v in card["variants"]] == ["black", "silver"]
        assert (card["min_price"], card["max_price"], card["product_count"]) == (100, 150, 2)
        assert {v["id"]: v["price"] for v in card["variants"]} == {"silver": 100, "black": 150}


def test_multiple_values_are_or_within_dimension_and_and_across_dimensions(snapshot):
    response = families(brand_id=["brand", "other-brand"], category_id=["basins"], size=["30 cm", "50 cm"])
    assert response["total"] == 3
    assert {v["id"] for row in response["items"] for v in row["variants"]} == {"silver", "black", "other", "other-brand"}
    assert families(size=["does not exist"])["total"] == 0


def test_product_pages_count_and_page_families_in_authorized_namespace(snapshot):
    async def run(skip):
        return await catalog.list_products_page(user_id="staff", q=None, brand_id="brand", category_id="basins",
            subcategory=None, series=None, family_key=None, finish=None, colour=None,
            sort="name", limit=1, skip=skip, floor_ids=["first-floor"])
    first, second = asyncio.run(run(0)), asyncio.run(run(1))
    assert first["total"] == second["total"] == 2
    assert first["items"][0]["family_key"] != second["items"][0]["family_key"]
    assert families()["total"] == 4  # namespace collisions stay separate


@pytest.mark.parametrize("recent", [True, False])
def test_usage_shelves_group_families_before_limit_with_full_variants(snapshot, recent):
    snapshot.usage_by_user["staff"] = {
        id: {"product_id": id, "count": 10 - index, "last_used_at": f"2026-10-{20-index:02}T00:00:00Z"}
        for index, id in enumerate(["black", "silver", "other", "private"])
    }
    rows = asyncio.run(catalog.recent_or_frequent_products("staff", limit=2, recent=recent, floor_ids=["first-floor"]))
    assert [row["id"] for row in rows] == ["black", "other"]
    assert {row["id"] for row in rows[0]["family_variants"]} == {"black", "silver"}


def test_grouped_search_is_not_starved_by_more_than_three_pages_of_siblings(monkeypatch):
    rows = [product(f"a-{index}", name="Family A") for index in range(20)] + [product("z", name="Family Z", family_key="z")]
    snap = catalog._build_snapshot(rows, [], [], [], [])
    monkeypatch.setattr(catalog, "get_catalog_snapshot", AsyncMock(return_value=snap))
    response = asyncio.run(catalog.search_catalog(q="", brand_id=None, category_id=None, subcategory=None,
        series=None, limit=2, group=True, floor_ids=["first-floor"]))
    assert response["total"] == 2
    assert len(response["items"]) == 2
    assert len(response["items"][0]["variants"]) == 20


def test_mongo_family_key_ignores_source_occurrences_and_multiselect_uses_in():
    key = mongo.family_group_key()
    assert "listing_id" not in str(key)
    assert key["floor"] == "$floor_id"
    pipeline = mongo.listing_pipeline({"brand_id": ["a", "b"], "colour": ["Gold", "Black"], "size": ["30 cm"]}, floor_ids=["first-floor"])
    assert pipeline[0]["$match"] == {"active": True, "floor_id": {"$in": ["first-floor"]},
        "brand_id": {"$in": ["a", "b"]}, "colour": {"$in": ["Gold", "Black"]}}
    assert {"$match": {"brand_id": {"$in": ["a", "b"]}, "colour": {"$in": ["Gold", "Black"]}, "size": {"$in": ["30 cm"]}}} in pipeline


@pytest.mark.parametrize("label", ["", "   ", "x" * 81])
def test_invalid_color_name_rejected_before_database_write(monkeypatch, label):
    monkeypatch.setattr(catalog_routes, "db", SimpleNamespace())
    with pytest.raises(HTTPException) as raised:
        asyncio.run(catalog_routes._apply_product_updates("silver", ProductPatch(variant_label=label),
            SimpleNamespace(id="staff"), product("silver")))
    assert raised.value.status_code == 422


def test_color_name_edit_persists_exact_sku_and_immediately_updates_family_cache(monkeypatch, snapshot):
    from models import UserPublic
    write = AsyncMock()
    monkeypatch.setattr(catalog_routes, "db", SimpleNamespace(products=SimpleNamespace(update_one=write)))
    monkeypatch.setattr(catalog_routes, "log_event", AsyncMock())
    monkeypatch.setattr(catalog, "_snapshot", snapshot)
    async def current_snapshot():
        return catalog._snapshot
    monkeypatch.setattr(catalog, "get_catalog_snapshot", current_snapshot)
    monkeypatch.setattr(catalog, "schedule_catalog_refresh", lambda: None)
    user = UserPublic(id="owner", email="owner@example.com", full_name="Owner", role="owner", active_floor_id="first-floor")
    historical_line = {"sku": "SKU-black", "name": "Basin black", "finish": "Black", "unit_price": 150}
    updated = asyncio.run(catalog_routes._apply_product_updates("black", ProductPatch(variant_label=" Midnight Black "), user, snapshot.product_by_id["black"]))
    assert updated.variant_label == "Midnight Black"
    assert updated.id == "black" and updated.sku == "SKU-black" and updated.price == 150
    query, mutation = write.call_args.args
    assert query == {"$and": [{"floor_id": {"$in": ["first-floor"]}}, {"id": "black"}]}
    assert mutation["$set"]["variant_label"] == "Midnight Black"
    assert "sku" not in mutation["$set"] and "price" not in mutation["$set"]
    variants = families(q="SKU-black")["items"][0]["variants"]
    assert next(v for v in variants if v["id"] == "black")["variant_label"] == "Midnight Black"
    assert next(v for v in variants if v["id"] == "silver")["variant_label"] is None
    assert historical_line == {"sku": "SKU-black", "name": "Basin black", "finish": "Black", "unit_price": 150}
