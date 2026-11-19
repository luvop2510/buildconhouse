from datetime import datetime, timezone
from decimal import Decimal

from services.sanitary_sales_source import _calendar_date, _indexed_dates, _line_fact, _offers, _quotation_stamp, _stamp


def test_legacy_offer_uses_full_discount_cascade_and_keeps_persisted_zero():
    first = {"id": "first", "name": "Basin", "sku": "B1", "product_id": "basin",
             "qty": 2, "unit_price": 500, "room": "Bathroom"}
    second = {"id": "second", "name": "Mixer", "sku": "M1", "product_id": "mixer",
              "qty": 1, "unit_price": 500, "room": "Bathroom", "net_amount": 0}
    doc = {
        "project_discount_pct": 10,
        "room_discounts": {"Bathroom": {"type": "amount", "value": 300}},
    }
    assert _offers(doc, [first, second]) == [Decimal("800"), Decimal("0")]
    assert _offers(doc, [{**first, "unit_price": None}, second]) == [None, Decimal("0")]


def test_order_line_brand_and_prices_prefer_historical_provenance():
    doc = {"id": "placed"}
    line = {"id": "line", "product_id": "basin", "qty": "2.5", "catalog_mrp": "15.20",
            "variant_id": "basin-ivory", "quantity_unit": "Box"}
    products = {"basin": {"name": "Basin", "mrp": 800, "brand_id": "current", "size": "600 mm"}}
    brands = {"current": "Current brand", "previous": "Previous brand"}
    purchase_brand = {("placed", "line", "basin"): "previous"}
    normalized = _line_fact(doc, line, 3, Decimal("10.20"), products, brands, purchase_brand)
    assert normalized["id"] == "placed:3"
    assert normalized["brand_id"] == "previous"
    assert normalized["mrp"] == Decimal("38")
    assert normalized["offer"] == Decimal("10.20")
    assert normalized["unit"] == "Pieces"
    assert normalized["quantity"] == Decimal("2.5")
    assert normalized["variant_id"] == "basin-ivory"
    assert normalized["size"] == "600 mm"
    colour_line = {**line, "colour": "Ivory"}
    assert _line_fact(doc, colour_line, 4, None, products, brands, purchase_brand)["finish"] == "Ivory"
    assert _line_fact(doc, {**line, "unit": "boxes"}, 4, None, products, brands, purchase_brand)["unit"] == "Box"
    assert _line_fact(doc, {**line, "catalog_mrp": None}, 4, None, products, brands, purchase_brand)["mrp"] is None


def test_imported_documents_do_not_use_catalogue_mrp_captured_at_import_time():
    line = {"qty": 2, "catalog_mrp": 199}
    imported = {"id": "archived-quote", "historical_import": {"batch_id": "sample"}}
    assert _line_fact(imported, line, 0, Decimal("20"), {}, {}, {})["mrp"] is None
    assert _line_fact(imported, {**line, "mrp": 55}, 0, Decimal("20"), {}, {}, {})["mrp"] == Decimal("110")


def test_coarse_index_bounds_and_exact_india_calendar_dates():
    utc = timezone.utc
    initial = datetime(1, 1, 1, 18, 30, tzinfo=utc)
    final = datetime(9999, 12, 30, 18, 30, tzinfo=utc)
    assert _indexed_dates("created_at", initial, final) == {"$or": [
        {"created_at": {"$gte": "0001-01-01"}},
        {"created_at": {"$gte": initial, "$lt": final}},
    ]}
    assert _calendar_date(_stamp("2026-11-11T18:30:00Z")) == "2026-11-12"
    assert _calendar_date(_stamp("2026-11-11T18:29:59.999+00:00")) == "2026-11-11"
    assert _calendar_date(_stamp("2026-11-12")) == "2026-11-12"


def test_quotation_date_uses_recorded_printed_day_for_imports():
    created_at = "2026-11-12T05:00:00+00:00"
    assert _calendar_date(_quotation_stamp({"doc_date": "19/02/2025", "created_at": created_at})) == "2025-02-19"
    assert _calendar_date(_quotation_stamp({"doc_date": "unknown", "created_at": created_at})) == "2026-11-12"
