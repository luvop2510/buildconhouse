from io import BytesIO

from openpyxl import load_workbook

from services.tiles_quotation_excel import build_tiles_quotation_excel


def workbook_rows(doc):
    workbook = load_workbook(BytesIO(build_tiles_quotation_excel(doc, {})))
    sheet = workbook["Tiles Quotation"]
    header = [cell.value for cell in sheet[4]]
    products = [
        dict(zip(header, row, strict=True))
        for row in sheet.iter_rows(min_row=5, max_row=4 + len(doc["items"]), values_only=True)
    ] if doc["items"] else []
    return sheet, products


def test_excel_reads_saved_offer_rate_box_coverage_and_amounts():
    sheet, products = workbook_rows({
        "customer_name": "=HYPERLINK(1)",
        "doc_number": "T-20",
        "subtotal": 9900,
        "discount_total": 960,
        "transportation_fee": 250,
        "grand_total": 9190,
        "items": [
            {"name": "Porcelain (600×600)", "size": "600 x 600", "finish": "Matt", "room": "Living",
             "rate_sqft": 140, "offer_rate": 120, "box_sqft": 16, "rate_box": 1920,
             "unit_price": 1920, "qty": 5, "net_amount": 8640, "catalog_price": 500},
            {"name": "Stone 300 x 600", "size": "300 x 600", "finish": "Glossy",
             "rate_sqft": 80, "box_sqft": 3.75, "rate_box": 300, "qty": 1, "net_amount": 300},
        ],
    })

    assert sheet["B2"].value == "=HYPERLINK(1)" and sheet["B2"].data_type == "s"
    assert products[0] == {
        "SR. NO.": 1, "AREA": "Living", "PRODUCT DETAIL": "Porcelain", "SIZE": "600 x 600",
        "FINISH": "Matt", "SQ. FT. / BOX": 16, "BASE RATE / SQ. FT.": 140, "OFFER RATE": 120,
        "RATE / BOX": 1920, "QUANTITY": 5, "UNIT": "Box", "AMOUNT": 8640,
    }
    assert products[1]["RATE / BOX"] == 300
    assert products[1]["OFFER RATE"] == 80
    assert sheet["I5"].data_type == "n" and "₹" in sheet["I5"].number_format
    assert list(sheet.iter_rows(min_row=7, min_col=10, values_only=True)) == [
        ("Transportation", None, 250),
        ("Subtotal", None, 9900),
        ("Discount", None, 960),
        ("Grand Total", None, 9190),
    ]


def test_excel_preserves_historical_and_explicit_box_rates_and_zero_totals():
    sheet, products = workbook_rows({
        "subtotal": 0, "transportation_fee": 0, "grand_total": 0,
        "items": [
            {"name": "Historical", "rate_sqft": 140, "offer_rate": 120, "box_sqft": 16,
             "unit_price": 1800, "qty": 3, "net_amount": 0},
            {"name": "Legacy coverage only", "rate_sqft": 120, "offer_rate": 90,
             "box_sqft": 6.25, "qty": 2, "discount_pct": 10},
            {"name": "Saved zero", "rate_sqft": 120, "offer_rate": 0,
             "box_sqft": 6.25, "unit_price": 0, "qty": 2, "net_amount": 0},
            {"name": "Box-priced", "price_basis": "box", "rate_sqft": 120, "box_sqft": 16,
             "unit_price": 1250, "qty": 2, "net_amount": 2500},
            {"name": "Piece-priced", "quantity_unit": "pcs", "rate_sqft": 50, "box_sqft": 16,
             "unit_price": 200, "qty": 2, "net_amount": 400},
        ],
    })

    assert [line["RATE / BOX"] for line in products] == [1800, 562.5, 0, 1250, None]
    assert products[0]["AMOUNT"] == 0
    assert products[1]["AMOUNT"] == 1012.5
    assert products[2]["OFFER RATE"] == 0
    assert products[3]["BASE RATE / SQ. FT."] is None
    assert products[4]["UNIT"] == "Piece"
    assert products[4]["OFFER RATE"] == 200
    assert products[4]["SQ. FT. / BOX"] is None
    assert list(sheet.iter_rows(min_row=10, min_col=10, values_only=True)) == [
        ("Subtotal", None, 0),
        ("Grand Total", None, 0),
    ]


def test_excel_does_not_invent_missing_amounts():
    sheet, products = workbook_rows({"items": [{"name": "Historical", "qty": 1, "rate_sqft": 50}]})
    assert products[0]["RATE / BOX"] is None
    assert products[0]["AMOUNT"] is None
    assert sheet.max_row == 5
