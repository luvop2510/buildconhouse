"""Visible catalog sections and fallback choices stay reachable."""
import asyncio
from unittest.mock import AsyncMock

import pytest

from services import catalog_service as catalog
from routes import catalog_routes
from models import UserPublic


def source_products():
    common = {"floor_id": "first-floor", "brand_id": "grohe", "category_id": "showers",
              "active": True, "price": 100, "mrp": 100, "images": [], "stock": 0}
    return [
        {**common, "id": "rough-in", "sku": "1049819990", "name": "Rough-in",
         "family_key": "rough-in", "family_name": "Rough-in", "series": None,
         "catalog_entries": [
             {"entry_id": f"row-{index}", "category_id": "showers", "subcategory": section,
              "name": "Rough-in", "mrp": 100, "source_order": index}
             for index, section in enumerate(["SHOWER PLATE 1", "SHOWER PLATE 2", "SHOWER PLATE 3", "SHOWER PLATE 3"])
         ]},
        {**common, "id": "legacy", "sku": "LEGACY", "name": "Legacy shower", "subcategory": None,
         "series": "", "family_key": "legacy"},
        {**common, "id": "other", "sku": "OTHER", "name": "Other shower", "subcategory": "Other",
         "series": "Named", "family_key": "other"},
        {**common, "id": "foreign", "sku": "FOREIGN", "name": "Foreign shower", "subcategory": None,
         "series": None, "family_key": "foreign", "floor_id": "ground-floor"},
    ]


def make_snapshot():
    return catalog._build_snapshot(source_products(), [], [{"id": "grohe", "name": "Grohe", "floor_id": "first-floor"}],
                                   [{"id": "showers", "name": "Showers", "floor_id": "first-floor"}], [])


@pytest.fixture
def snapshot(monkeypatch):
    snap = make_snapshot()
    monkeypatch.setattr(catalog, "get_catalog_snapshot", AsyncMock(return_value=snap))
    return snap


def test_each_workbook_section_is_exposed_once_in_hierarchy(snapshot):
    rows, brands, _ = asyncio.run(catalog.hierarchy_rows(["first-floor"]))
    sections = {r["_id"]["subcategory"]: r["product_count"] for r in rows}
    assert sections == {"SHOWER PLATE 1": 1, "SHOWER PLATE 2": 1, "SHOWER PLATE 3": 1, None: 1, "Other": 1}
    assert brands["grohe"]["product_count"] == 3
    assert {r["category_product_count"] for r in rows} == {3}


def test_hierarchy_api_category_counts_distinct_skus_across_overlapping_sections(snapshot):
    user = UserPublic(id="owner", email="owner@example.test", full_name="Owner", role="owner", active_floor_id="first-floor")
    tree = asyncio.run(catalog_routes.catalog_hierarchy(user))["tree"]
    assert tree[0]["product_count"] == 3
    category = tree[0]["categories"][0]
    assert category["product_count"] == 3
    assert sum(s["product_count"] for s in category["subcategories"]) == 5


def test_all_section_facets_survive_and_later_section_can_be_filtered(snapshot):
    args = dict(brand_id="grohe", category_id="showers", subcategory=None, series=None, floor_ids=["first-floor"])
    facets = asyncio.run(catalog.facet_buckets(**args))
    assert {r["value"]: r["count"] for r in facets["subcategories"]} == {
        "SHOWER PLATE 1": 1, "SHOWER PLATE 2": 1, "SHOWER PLATE 3": 1, "Other": 1}
    selected = asyncio.run(catalog.facet_buckets(**{**args, "subcategory": "SHOWER PLATE 3"}))
    assert selected["brands"] == [{"value": "grohe", "count": 1}]


@pytest.mark.parametrize("filters,expected", [
    ({"subcategory": "General"}, {"legacy"}),
    ({"series": "Uncategorised"}, {"rough-in", "legacy"}),
    ({"subcategory": ["General", "SHOWER PLATE 3"], "series": ["Uncategorised"]}, {"rough-in", "legacy"}),
    ({"series": ""}, {"legacy"}),
    ({"series": [""]}, {"legacy"}),
])
def test_visible_missing_metadata_choices_filter_family_pages(snapshot, filters, expected):
    response = asyncio.run(catalog.list_family_groups(**{
        "brand_id": "grohe", "category_id": "showers", "subcategory": None, "series": None,
        "q": None, "limit": 60, "skip": 0, "floor_ids": ["first-floor"], **filters}))
    assert response["total"] == len(expected)
    assert {p["sample_product_id"] for p in response["items"]} == expected


def test_missing_and_empty_source_sections_are_one_display_branch(monkeypatch):
    source = source_products()[0]
    source["catalog_entries"] = [
        {"entry_id": "missing", "category_id": "showers", "subcategory": None, "mrp": 100},
        {"entry_id": "empty", "category_id": "showers", "subcategory": "", "mrp": 200},
        {"entry_id": "named-fallback", "category_id": "showers", "subcategory": "General", "mrp": 300},
    ]
    snap = catalog._build_snapshot([source], [], [], [], [])
    monkeypatch.setattr(catalog, "get_catalog_snapshot", AsyncMock(return_value=snap))
    rows, _, _ = asyncio.run(catalog.hierarchy_rows(["first-floor"]))
    assert sum(r["product_count"] for r in rows) == 1
    assert rows[0]["category_product_count"] == 1
