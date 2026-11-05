"""Size-aware catalog variants resolve to real, floor-safe SKU records."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

import routes.catalog_routes as catalog_routes
import services.catalog_service as catalog_service
from models import UserPublic
from services.catalog_service import _build_snapshot, hydrate_product


def _product(
    product_id: str, sku: str, size: str, *, floor_id: str = "ground-floor",
    finish: str = "Matt", price: float = 100, specs: dict | None = None,
) -> dict:
    return {
        "id": product_id, "sku": sku, "name": "Carrara Gold", "family_key": "qutone:carrara-gold",
        "family_name": "Carrara Gold", "floor_id": floor_id, "brand_id": "qutone",
        "category_id": "tiles", "size": size, "finish": finish, "price": price,
        "mrp": price + 25, "stock": 9, "specs": specs or {}, "images": [], "variants": [],
    }


def test_hydrated_tile_exposes_all_same_floor_family_variants_and_sizes():
    selected = _product("p-600", "Z-600", "600 x 600", price=80)
    matching_target = _product("p-1200-matt", "Z-1200", "600×1200", price=125)
    glossy_target = _product("p-1200-gloss", "A-1200", "600x1200", finish="Glossy", price=140)
    foreign_floor = _product("p-foreign", "A-FOREIGN", "800x1600", floor_id="first-floor", price=999)
    snapshot = _build_snapshot([selected, matching_target, glossy_target, foreign_floor], [], [], [], [])

    hydrated = hydrate_product(selected, snapshot)

    assert hydrated["available_sizes"] == ["600 x 600", "600×1200"]
    assert hydrated["size_count"] == 2
    assert hydrated["size_switchable"] is True
    assert [variant["id"] for variant in hydrated["family_variants"]] == [
        "p-1200-gloss", "p-1200-matt", "p-600",
    ]
    assert {variant["size"] for variant in hydrated["family_variants"]} == {
        "600 x 600", "600×1200", "600x1200",
    }


def test_size_resolution_prefers_matching_finish_and_returns_real_sku_attributes(monkeypatch):
    selected = _product("p-600", "Z-600", "600x600", price=80, specs={"coverage": "4 sq ft"})
    matching_target = _product(
        "p-1200-matt", "Z-1200", "600x1200", price=125,
        specs={"coverage": "8 sq ft", "rectified": "yes"},
    )
    glossy_target = _product("p-1200-gloss", "A-1200", "600x1200", finish="Glossy", price=140)
    foreign_floor = _product("p-foreign", "B-FOREIGN", "600x1200", floor_id="first-floor", price=999)
    snapshot = _build_snapshot([selected, matching_target, glossy_target, foreign_floor], [], [], [], [])

    async def fake_snapshot():
        return snapshot

    monkeypatch.setattr(catalog_service, "get_catalog_snapshot", fake_snapshot)
    result = asyncio.run(catalog_service.resolve_size_variant("p-600", "600 X 1200", ["ground-floor"]))

    assert result["resolved_product_id"] == "p-1200-matt"
    assert result["product"]["sku"] == "Z-1200"
    assert result["product"]["price"] == 125
    assert result["product"]["specs"] == {"coverage": "8 sq ft", "rectified": "yes"}
    assert result["product"]["size"] == "600x1200"
    assert result["size_count"] == 2


def test_size_variant_discovery_returns_the_source_product_when_size_is_omitted(monkeypatch):
    selected = _product("p-600", "Z-600", "600x600", price=80)
    sibling = _product("p-1200", "Z-1200", "600x1200", price=125)
    snapshot = _build_snapshot([selected, sibling], [], [], [], [])

    async def fake_snapshot():
        return snapshot

    monkeypatch.setattr(catalog_service, "get_catalog_snapshot", fake_snapshot)
    result = asyncio.run(catalog_service.resolve_size_variant("p-600", floor_ids=["ground-floor"]))

    assert result["requested_size"] is None
    assert result["resolved_product_id"] == "p-600"
    assert result["product"]["price"] == 80
    assert result["available_sizes"] == ["600x600", "600x1200"]


def test_size_resolution_route_scopes_to_the_source_product_floor(monkeypatch):
    user = UserPublic(
        email="sales@forge.app", full_name="Sales", role="sales",
        floor_ids=["ground-floor", "first-floor"], active_floor_id="first-floor",
    )
    source = {"id": "p-600", "floor_id": "ground-floor"}
    monkeypatch.setattr(catalog_routes, "get_floor_scoped_or_404", AsyncMock(return_value=source))
    service = AsyncMock(return_value={
        "source_product_id": "p-600", "requested_size": "600x1200",
        "resolved_product_id": "p-1200", "available_sizes": ["600x600", "600x1200"],
        "size_count": 2, "size_switchable": True, "product": {"id": "p-1200"},
    })
    monkeypatch.setattr(catalog_routes.catalog_service, "resolve_size_variant", service)

    result = asyncio.run(catalog_routes.resolve_product_size_variant("p-600", "600x1200", user=user))

    assert result["resolved_product_id"] == "p-1200"
    service.assert_awaited_once_with("p-600", "600x1200", floor_ids=["ground-floor"])


def test_size_resolution_route_allows_discovery_without_a_size(monkeypatch):
    user = UserPublic(email="sales@forge.app", full_name="Sales", role="sales", floor_ids=["ground-floor"])
    monkeypatch.setattr(catalog_routes, "get_floor_scoped_or_404", AsyncMock(return_value={"id": "p-600", "floor_id": "ground-floor"}))
    service = AsyncMock(return_value={
        "source_product_id": "p-600", "requested_size": None, "resolved_product_id": "p-600",
        "available_sizes": ["600x600"], "size_count": 1, "size_switchable": False,
        "product": {"id": "p-600"},
    })
    monkeypatch.setattr(catalog_routes.catalog_service, "resolve_size_variant", service)

    asyncio.run(catalog_routes.resolve_product_size_variant("p-600", user=user))

    service.assert_awaited_once_with("p-600", None, floor_ids=["ground-floor"])


def test_size_resolution_route_returns_404_when_size_is_not_a_sibling(monkeypatch):
    user = UserPublic(email="sales@forge.app", full_name="Sales", role="sales", floor_ids=["ground-floor"])
    monkeypatch.setattr(catalog_routes, "get_floor_scoped_or_404", AsyncMock(return_value={"id": "p-600", "floor_id": "ground-floor"}))
    monkeypatch.setattr(catalog_routes.catalog_service, "resolve_size_variant", AsyncMock(return_value=None))

    with pytest.raises(HTTPException, match="Size variant not found") as error:
        asyncio.run(catalog_routes.resolve_product_size_variant("p-600", "800x1600", user=user))

    assert error.value.status_code == 404


def test_tile_price_units_do_not_mix_family_variants(monkeypatch):
    box = _product("box", "BOX", "600x600", specs={"price_unit": "sqft"})
    piece = _product("piece", "PIECE", "600x1200", specs={"price_unit": "pcs"})
    snapshot = _build_snapshot([box, piece], [], [], [], [])
    monkeypatch.setattr(catalog_service, "get_catalog_snapshot", AsyncMock(return_value=snapshot))
    assert catalog_service._family_card_key(box) != catalog_service._family_card_key(piece)
    assert asyncio.run(catalog_service.resolve_size_variant("box", "600x1200", ["ground-floor"])) is None
    assert hydrate_product(box, snapshot)["available_sizes"] == ["600x600"]


def test_rate_unit_from_existing_imports_stays_separate_from_sqft():
    piece = _product('piece', 'P', '600x600', specs={'rate_unit': 'pcs'})
    sqft = _product('sqft', 'S', '600x600', specs={'price_unit': 'sqft'})
    assert catalog_service._tile_price_kind(piece) == 'piece'
    assert catalog_service._family_card_key(piece) != catalog_service._family_card_key(sqft)


def test_missing_tile_price_unit_defaults_to_piece_without_changing_explicit_units():
    assert catalog_service._tile_price_kind(_product('missing', 'M', '600x600', specs={})) == 'piece'
    assert catalog_service._tile_price_kind(_product('sqft', 'S', '600x600', specs={'price_unit': 'sqft'})) == 'sqft'
    assert catalog_service._tile_price_kind(_product('box', 'B', '600x600', specs={'price_unit': 'box'})) == 'box'
