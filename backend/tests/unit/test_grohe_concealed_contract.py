"""Regression contracts for GROHE concealed-installation requirements."""
from __future__ import annotations

from catalog_pipeline.base import ProductRow
from models import Product


def test_product_row_exposes_structured_concealed_requirement():
    row = ProductRow(
        sku="24428000", name="Grohtherm Cube", mrp=99950, category="Faucets",
        must_buy_concealed=True, concealed_sku="35600000", concealed_skus=["35600000"],
    )
    public = row.to_public()
    assert public["must_buy_concealed"] is True
    assert public["concealed_sku"] == "35600000"
    assert public["concealed_skus"] == ["35600000"]


def test_product_model_preserves_multiple_concealed_requirements():
    product = Product(
        floor_id="first-floor", name="Rainshower", sku="26483000",
        brand_id="grohe", category_id="showers", mrp=1, price=1,
        must_buy_concealed=True,
        concealed_skus=["26483000", "26484000"],
    )
    assert product.must_buy_concealed is True
    assert product.concealed_skus == ["26483000", "26484000"]
