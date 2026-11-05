"""Tile pricing normalization stays in the backend pricing boundary."""

from models import QuotationLineItem
from services.pricing import normalize_tile_line_item, recalc_quotation_totals


def _line(**overrides):
    values = {
        "id": "line-1", "product_id": "tile-1", "sku": "T-1", "name": "Tile",
        "qty": 2, "unit_price": 999,
    }
    values.update(overrides)
    return QuotationLineItem(**values)


def test_rate_per_sqft_conversion_is_backend_owned():
    line = normalize_tile_line_item(_line(rate_sqft=360, box_sqft=31))

    assert line.unit_price == 11160
    assert line.offer_rate == 360


def test_existing_offer_rate_is_preserved():
    line = normalize_tile_line_item(_line(rate_sqft=360, box_sqft=31, offer_rate=10800))

    assert line.unit_price == 334800
    assert line.offer_rate == 10800


def test_offer_rate_drives_box_and_line_price_over_rate_per_sqft():
    line = normalize_tile_line_item(_line(rate_sqft=130, box_sqft=35, offer_rate=80, rate_box=4550))

    assert line.rate_box == 2800
    assert line.unit_price == 2800


def test_missing_box_coverage_does_not_invent_a_conversion():
    line = normalize_tile_line_item(_line(rate_sqft=360, box_sqft=None))

    assert line.unit_price == 999
    assert line.offer_rate == 360


def test_per_piece_lines_use_the_per_piece_price_not_the_box_conversion():
    box = normalize_tile_line_item(_line(rate_sqft=100, box_sqft=10, pcs_per_box="5", quantity_unit="Box"))
    piece = normalize_tile_line_item(_line(rate_sqft=100, box_sqft=10, pcs_per_box="5", quantity_unit="Pieces", offer_rate=200, rate_box=0, unit_price=0))

    assert box.rate_box == box.unit_price == 1000
    assert piece.rate_box == piece.unit_price == 200


def test_per_piece_quantity_addition_subtraction_and_multiplication_are_linear():
    line = normalize_tile_line_item(_line(qty=10, quantity_unit="Pieces", offer_rate=200, rate_box=0, unit_price=0))

    assert line.qty * line.unit_price == 2000
    line.qty += 2
    assert line.qty * line.unit_price == 2400
    line.qty -= 5
    assert line.qty * line.unit_price == 1400


def test_boxed_tile_quantity_addition_subtraction_and_multiplication_are_linear():
    line = normalize_tile_line_item(_line(qty=10, rate_sqft=50, box_sqft=4, quantity_unit="Box"))

    assert line.unit_price == 200
    assert recalc_quotation_totals([line])["subtotal"] == 2000
    line.qty += 2
    assert recalc_quotation_totals([line])["subtotal"] == 2400
    line.qty -= 5
    assert recalc_quotation_totals([line])["subtotal"] == 1400


def test_line_quantity_unit_is_an_explicit_user_choice():
    """The API preserves the Box/Pieces setting selected for each quote line."""
    box = normalize_tile_line_item(_line(quantity_unit="Box", rate_sqft=50, box_sqft=4))
    piece = normalize_tile_line_item(_line(quantity_unit="Pieces", offer_rate=50, rate_box=0, unit_price=0))

    assert box.quantity_unit == "Box"
    assert piece.quantity_unit == "Pieces"


def test_line_quantity_unit_canonicalizes_legacy_piece_and_box_spellings():
    assert _line(quantity_unit="piece").quantity_unit == "Pieces"
    assert _line(quantity_unit="boxes").quantity_unit == "Box"


def test_explicit_box_price_is_not_multiplied_by_coverage():
    line = normalize_tile_line_item(_line(quantity_unit="Box", price_basis="box", rate_box=160, offer_rate=160, box_sqft=10))
    assert line.unit_price == 160
    assert line.rate_box == 160
