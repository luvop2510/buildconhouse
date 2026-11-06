"""Legacy square-foot supplier rows retain their pricing basis everywhere."""
from __future__ import annotations

import io

import pytest
from openpyxl import Workbook

from catalog_pipeline.adapters.dimore import DimoreAdapter
from catalog_pipeline.adapters.donato import DonatoAdapter
from catalog_pipeline.adapters.modulo import ModuloAdapter
from catalog_pipeline.adapters.nexion import NexionAdapter
from catalog_pipeline.adapters.qutone import QutoneAdapter
from catalog_pipeline.adapters.renite import ReniteAdapter
from services import catalog_service as catalog


def _product(identity, specs, floor="ground-floor"):
    return {
        "id": identity, "sku": identity, "name": "Carrara", "floor_id": floor,
        "brand_id": "supplier", "category_id": "tiles", "family_key": "supplier:carrara",
        "size": "600x1200", "price": 110, "mrp": 110, "specs": specs,
    }


@pytest.mark.parametrize("specs", [
    {"sqft_per_box": 15.5, "source_file": "NEXION 2026.xlsx"},
    {"rate_per_sqft": 110, "sqft_per_box": 15.5},
    {"rate_per_sqft": 0, "sqft_per_box": None, "needs_pricing": True},
])
def test_legacy_sqft_rows_are_distinct_from_piece_families_and_hydrate_with_unit(specs):
    sqft = _product("sqft", specs)
    piece = _product("piece", {})
    snapshot = catalog._build_snapshot([sqft, piece], [], [], [], [])

    assert catalog._tile_price_kind(sqft) == "sqft"
    assert catalog._family_card_key(sqft) != catalog._family_card_key(piece)
    assert snapshot.product_by_id["sqft"]["specs"]["price_unit"] == "sqft"
    hydrated = catalog.hydrate_product(sqft, snapshot)
    assert hydrated["specs"]["price_unit"] == "sqft"
    assert [row["id"] for row in hydrated["family_variants"]] == ["sqft"]
    assert hydrated["family_variants"][0]["specs"]["price_unit"] == "sqft"
    assert hydrated["price"] == 110
    assert "price_unit" not in sqft["specs"]


@pytest.mark.parametrize("explicit", [{"price_unit": "per piece"}, {"rate_unit": "pcs"}, {"price_unit": "box"}])
def test_explicit_supplier_or_customer_unit_overrides_legacy_sqft_metadata(explicit):
    specs = {"sqft_per_box": 15.5, "rate_per_sqft": 110, **explicit}
    product = _product("override", specs)
    snapshot = catalog._build_snapshot([product], [], [], [], [])

    assert catalog.hydrate_product(product, snapshot)["specs"] == specs
    assert catalog._tile_price_kind(product) == ("box" if explicit.get("price_unit") == "box" else "piece")


def test_unbranded_missing_units_and_other_floors_keep_existing_specs():
    unknown = _product("unknown", {})
    unknown["brand_id"] = None
    sanitary = _product("sanitary", {"sqft_per_box": 15.5}, floor="first-floor")
    snapshot = catalog._build_snapshot([unknown, sanitary], [], [], [], [])

    assert catalog._tile_price_kind(unknown) == "piece"
    assert catalog.hydrate_product(unknown, snapshot)["specs"] == {}
    assert catalog.hydrate_product(sanitary, snapshot)["specs"] == {"sqft_per_box": 15.5}


@pytest.mark.parametrize("adapter", [DimoreAdapter, DonatoAdapter, ModuloAdapter, NexionAdapter, QutoneAdapter, ReniteAdapter])
def test_sqft_supplier_imports_persist_explicit_price_unit(adapter):
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.append(["SR.", "PRODUCT NAME", "IMAGE", "PRODUCT SIZE", "SERIES NAME", "FINISHES", "BOX IN PIS", "BOX SQFT", "RATE"])
    worksheet.append([1, "Carrara", None, "600X1200", "GVT", "MATT", 2, 15.5, "110 PER SQFT"])
    data = io.BytesIO()
    workbook.save(data)

    rows, _ = adapter().extract(data.getvalue(), "supplier.xlsx")

    assert len(rows) == 1
    assert rows[0].specs["price_unit"] == "sqft"
    assert rows[0].dealer_price == 110
