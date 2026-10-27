"""Artifact-level contracts for the Ground Floor Tiles quotation PDF."""

from io import BytesIO

from PIL import Image
from pypdf import PdfReader

import pdf_generator
import pdf_tiles
from pdf_tiles import build_tiles_quotation_pdf


def _pdf_text(quotation: dict) -> str:
    pdf = build_tiles_quotation_pdf(quotation, {"name": quotation["customer_name"]})
    return " ".join(
        " ".join((page.extract_text() or "").split())
        for page in PdfReader(BytesIO(pdf)).pages
    )


def test_tiles_pdf_uses_rate_per_sqft_offer_rate_and_quantity_unit():
    text = _pdf_text({
        "customer_name": "PDF Contract",
        "doc_date": "06-08-2026",
        "items": [{
            "qty": 2,
            "unit_price": 2170,
            "rate_sqft": 70,
            "offer_rate": None,
            "quantity_unit": "Box",
            "pcs_per_box": "3",
            "name": "Tile",
            "room": "Living",
            "size": "600x600",
        }],
        "subtotal": 4340,
        "transportation_fee": 100,
        "grand_total": 4440,
    })

    assert "70 ₹ 70.00" in text
    assert "QUANTITY UNIT" in text
    assert "PIECES/ BOX" not in text
    assert "2 box ₹ 4,340.00" in text
    assert "2 BOX 3" not in text
    assert "TOTAL QUANTITY 2 BOX" in text
    assert "₹ 4,340.00" in text
    assert "₹ 100.00" in text
    assert "₹ 4,440.00" in text


def test_tiles_pdf_keeps_large_amounts_and_currency_header_on_single_lines():
    pdf = build_tiles_quotation_pdf({
        "customer_name": "Large Amount Contract",
        "items": [{"name": "Tile", "room": "Living", "qty": 2, "unit_price": 12345678.9,
                   "rate_box": 12345678.9, "offer_rate": 123456.7, "quantity_unit": "Box"}],
        "subtotal": 24691357.8, "grand_total": 24691357.8,
    }, {"name": "Large Amount Contract"})
    pages = PdfReader(BytesIO(pdf)).pages
    detail_lines = [line.strip() for line in (pages[1].extract_text() or "").splitlines()]
    symbol = "₹" if pdf_generator.RUPEE_FONT else "Rs."
    assert f"TOTAL ({symbol})" in detail_lines
    assert f"{symbol} 1,23,45,678.90" in detail_lines
    assert f"{symbol} 2,46,91,357.80" in detail_lines
    assert f"{symbol} 1,23,456.70" in detail_lines


def test_tiles_pdf_renders_piece_as_the_quantity_unit():
    text = _pdf_text({
        "customer_name": "PDF Piece Contract",
        "items": [{
            "qty": 1,
            "unit_price": 900,
            "rate_sqft": 30,
            "offer_rate": 30,
            "quantity_unit": "Pieces",
            "pcs_per_box": "1",
            "name": "Basin",
            "room": "Bath",
        }],
        "subtotal": 900,
        "transportation_fee": 0,
        "grand_total": 900,
    })

    assert "1 piece ₹ 900.00" in text
    assert "N/A" not in text


def test_tiles_pdf_renders_box_as_the_quantity_unit_and_preserves_box_metadata():
    text = _pdf_text({
        "customer_name": "PDF Box Contract",
        "items": [{
            "qty": 2,
            "unit_price": 1200,
            "quantity_unit": "Box",
            "pcs_per_box": "4",
            "name": "Wall Tile",
            "room": "Bath",
        }],
        "subtotal": 2400,
        "grand_total": 2400,
    })

    assert "2 box ₹ 2,400.00" in text
    assert "2 BOXES 4" not in text


def test_tiles_pdf_normalizes_legacy_lowercase_piece_unit():
    text = _pdf_text({
        "customer_name": "Legacy Piece Contract",
        "items": [{
            "qty": 2,
            "unit_price": 900,
            "quantity_unit": "piece",
            "pcs_per_box": "4",
            "name": "Basin",
            "room": "Bath",
        }],
        "subtotal": 1800,
        "grand_total": 1800,
    })

    assert "TOTAL QUANTITY 2 PIECES" in text
    assert "2 piece ₹ 1,800.00" in text


def test_tiles_quotation_detail_rows_separate_numeric_quantity_from_unit():
    text = _pdf_text({
        "customer_name": "Mixed Units Contract",
        "items": [
            {"qty": 15, "unit_price": 100, "quantity_unit": "Box", "name": "Box tile"},
            {"qty": 120, "unit_price": 100, "quantity_unit": "Box", "name": "More box tiles"},
            {"qty": 15, "unit_price": 100, "quantity_unit": "Pieces", "name": "Piece tile"},
        ],
        "subtotal": 15000,
        "grand_total": 15000,
    })

    assert "15 box ₹ 1,500.00" in text
    assert "120 box ₹ 12,000.00" in text
    assert "15 piece ₹ 1,500.00" in text


def test_tiles_quotation_portrait_media_uses_a_landscape_image_canvas(monkeypatch):
    portrait = BytesIO()
    Image.new("RGB", (60, 120), "#306090").save(portrait, format="PNG")
    monkeypatch.setattr(pdf_generator, "_remote_image_bytes", lambda _url: portrait.getvalue())
    original_img = pdf_tiles._img
    rendered_sources: list[tuple[int, int]] = []

    def capture_img(*args, **kwargs):
        image = original_img(*args, **kwargs)
        rendered_sources.append((image.source_width, image.source_height))
        return image

    monkeypatch.setattr(pdf_tiles, "_img", capture_img)
    pdf = build_tiles_quotation_pdf({
        "customer_name": "Portrait Tile Contract",
        "items": [{"image": "https://example.test/portrait.png", "name": "Tile", "size": "600x600", "qty": 1, "unit_price": 100}],
        "subtotal": 100,
    }, {"name": "Portrait Tile Contract"})

    assert pdf.startswith(b"%PDF-")
    assert rendered_sources == [(120, 60)]


def test_tiles_quotation_rotates_portrait_media_inside_an_old_white_canvas():
    padded = Image.new("RGB", (192, 120), "white")
    padded.paste(Image.new("RGB", (60, 120), "#306090"), (66, 0))
    source = BytesIO()
    padded.save(source, format="PNG")

    with Image.open(BytesIO(pdf_generator._rotate_portrait_for_tiles_pdf(source.getvalue()))) as rendered:
        assert rendered.width > rendered.height
        assert rendered.width / rendered.height > 1.5
        assert rendered.getpixel((rendered.width // 2, rendered.height // 2)) == (48, 96, 144)


def test_tiles_quotation_keeps_the_cover_on_page_one_and_starts_details_on_page_two():
    quotation = {
        "customer_name": "Two Page Contract",
        "doc_date": "22-08-2026",
        "items": [{
            "qty": 1,
            "unit_price": 6277.5,
            "rate_sqft": 135,
            "offer_rate": 135,
            "rate_box": 6277.5,
            "quantity_unit": "Box",
            "name": "Aemilia Grigio Dove (1200X1800)",
            "room": "Bathroom",
            "size": "1200X1800",
        }],
        "subtotal": 6277.5,
        "grand_total": 6277.5,
    }

    pages = PdfReader(BytesIO(build_tiles_quotation_pdf(quotation, {"name": "Two Page Contract"}))).pages

    assert len(pages) == 2
    assert "CUSTOMER SIGNATURE" in (pages[0].extract_text() or "")
    assert "PRODUCT DETAILS" in (pages[1].extract_text() or "")
    assert sum(width / pdf_tiles.mm for width in pdf_tiles._QUO_COLS) == 281
    assert pdf_tiles.QUOTATION_PRODUCT_IMAGE_WIDTH_MM == 46


def test_tiles_quotation_does_not_repeat_detail_columns_before_an_overflow_total():
    """A page containing only the trailing total must not show product columns."""
    items = [
        {
            "qty": 10,
            "unit_price": 11160,
            "rate_sqft": 360,
            "offer_rate": 360,
            "rate_box": 11160,
            "quantity_unit": "Box",
            "pcs_per_box": "3",
            "name": f"Tile {index}",
            "room": "Living",
            "size": "1200X2400",
        }
        for index in range(1, 5)
    ]
    total = sum(item["qty"] * item["unit_price"] for item in items)
    pages = PdfReader(BytesIO(build_tiles_quotation_pdf({
        "customer_name": "Overflow Contract",
        "items": items,
        "subtotal": total,
        "grand_total": total,
    }, {"name": "Overflow Contract"}))).pages

    final_page = pages[-1].extract_text() or ""
    assert "TOTAL" in final_page
    assert "PRODUCT IMAGE" not in final_page


def test_both_tile_documents_paginate_many_products_on_a4_without_stretching(monkeypatch):
    from reportlab.lib.pagesizes import landscape, A4
    monkeypatch.setattr(pdf_tiles, "prefetch_product_images", lambda _items: None)
    for builder in (pdf_tiles.build_tiles_selection_pdf, pdf_tiles.build_tiles_quotation_pdf):
        document = {"customer_name": "Pagination Customer", "address_snapshot": "Site address",
                    "items": [{"name": f"Tile {index}", "qty": 1, "unit_price": 100} for index in range(1, 41)]}
        pages = PdfReader(BytesIO(builder(document, {"name": "Pagination Customer"}))).pages
        assert len(pages) > 3
        for page in pages:
            assert abs(float(page.mediabox.width) - landscape(A4)[0]) < 0.01
            assert abs(float(page.mediabox.height) - landscape(A4)[1]) < 0.01
        text = " ".join(page.extract_text() or "" for page in pages)
        assert "Tile 1" in text and "Tile 40" in text


def test_tile_customer_and_reference_cells_grow_to_fit_wrapped_values():
    from reportlab.lib.units import mm
    styles = pdf_tiles._tiles_styles()
    short = pdf_tiles._meta_grid({"customer_name": "Name"}, {}, styles)
    long = pdf_tiles._meta_grid({"customer_name": "Long customer name " * 12,
                                 "address_snapshot": "Long site address " * 12,
                                 "reference_source": "Architect and interior studio reference " * 12}, {}, styles)
    short.wrap(281 * mm, 300 * mm)
    long.wrap(281 * mm, 300 * mm)
    assert long._rowHeights[1] > short._rowHeights[1]
    assert long._rowHeights[3] > short._rowHeights[3]
    assert all(height >= 7 * mm for height in (long._rowHeights[1], long._rowHeights[3]))
