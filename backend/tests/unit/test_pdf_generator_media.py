"""Regression tests for upright quotation product images and fit geometry."""

from io import BytesIO
from math import ceil
from pathlib import Path
import shutil
import subprocess

from PIL import Image as PILImage
from pypdf import PdfReader
import pytest

import pdf_generator
import pdf_tiles


def _png_bytes(width: int, height: int) -> bytes:
    image = PILImage.new("RGB", (width, height), "red")
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def _jpeg_with_orientation(width: int, height: int, orientation: int) -> bytes:
    image = PILImage.new("RGB", (width, height), "blue")
    exif = PILImage.Exif()
    exif[274] = orientation
    out = BytesIO()
    image.save(out, format="JPEG", exif=exif)
    return out.getvalue()


def _render_pdf_pages(pdf: bytes, output_dir: Path) -> list[Path]:
    """Rasterize a generated PDF so layout regressions are tested as pixels."""
    source = output_dir / "quotation.pdf"
    source.write_bytes(pdf)
    subprocess.run(
        ["pdftoppm", "-png", "-r", "96", str(source), str(output_dir / "page")],
        check=True,
        capture_output=True,
    )
    return sorted(output_dir.glob("page-*.png"))


def test_contain_box_centers_a_horizontal_product_image():
    assert callable(getattr(pdf_generator, "contain_box", None))
    x, y, width, height = pdf_generator.contain_box(1200, 600, 180, 90, 6)

    assert width == 156
    assert height == 78
    assert x == 12
    assert y == 6


def test_sanitary_pdf_filename_uses_the_customer_name():
    assert pdf_generator.quotation_pdf_filename("myrubai") == "myrubai.pdf"
    assert pdf_generator.quotation_pdf_filename('  Myruba / Sons  ') == "Myruba Sons.pdf"


def test_pdf_money_uses_a_portable_indian_currency_prefix_and_digit_grouping():
    assert pdf_generator.format_indian_money(12345678.9) == "1,23,45,678.90"
    assert pdf_generator.format_indian_money(-1000) == "-1,000.00"
    assert pdf_generator._money(12345678.9) == "Rs. 1,23,45,678.90"


def test_standard_pdf_prints_indian_currency_for_large_amounts():
    pdf = pdf_generator.build_quotation_pdf(
        {
            "customer_name": "Indian Currency Contract",
            "items": [{"sku": "INR-1", "name": "Premium Fixture", "room": "Bath", "qty": 1, "unit_price": 12345678.9}],
            "subtotal": 12345678.9,
            "grand_total": 12345678.9,
        },
        {"name": "Indian Currency Contract"},
    )
    text = " ".join(page.extract_text() or "" for page in PdfReader(BytesIO(pdf)).pages)
    assert "Rs. 1,23,45,678.90" in text


def test_standard_item_tables_scale_into_portrait_printable_width():
    source = Path(pdf_generator.__file__).read_text()

    assert "PORTRAIT_SCALE" in source
    assert "item_widths = [_pw(v) * mm" in source


def test_sanitary_item_text_columns_are_center_aligned():
    """Article, description, rate and total must share the table's center axis."""
    source = Path(pdf_generator.__file__).read_text()

    assert '"itemDescription", parent=base["Normal"], fontName="Helvetica", fontSize=MIN_DETAIL_FONT_SIZE_PT, leading=8.5, textColor=INK, alignment=1' in source
    assert '"itemSku", parent=base["Normal"], fontName="Helvetica", fontSize=MIN_DETAIL_FONT_SIZE_PT, leading=8.2, textColor=INK, alignment=1' in source
    assert '"itemMoney", parent=base["Normal"], fontName="Helvetica", fontSize=MIN_DETAIL_FONT_SIZE_PT, leading=8.2, textColor=INK, alignment=1' in source


def test_standard_pdf_keeps_supplied_terms_enquiries_and_signature_on_page_one():
    quotation = {
        "customer_name": "Page One Contract",
        "items": [{"sku": "ART-100", "name": "Wall Mixer", "room": "Master Bath", "qty": 1, "unit_price": 1000}],
        "rooms": ["Master Bath"], "subtotal": 1000, "grand_total": 1000,
        "address_snapshot": "Rajkot, Gujarat - detailed delivery address",
    }

    pages = PdfReader(BytesIO(pdf_generator.build_quotation_pdf(quotation, {"name": "Page One Contract"}))).pages
    first_page_text = pages[0].extract_text()

    assert "TERMS & CONDITIONS" in first_page_text
    assert "For general enquiries" in first_page_text
    assert "CUSTOMER SIGNATURE & DATE" in first_page_text
    assert len(pages) == 2


def test_three_products_in_one_room_share_a_single_detail_page():
    """The compact image frame keeps a typical three-item room together."""
    items = [
        {"sku": f"MB-{index}", "name": f"Master Bathroom Product {index}", "room": "Master Bathroom", "qty": 1, "unit_price": 1000}
        for index in range(1, 4)
    ]
    quotation = {"customer_name": "Master Bath", "items": items, "rooms": ["Master Bathroom"], "subtotal": 3000, "grand_total": 3000}

    pages = PdfReader(BytesIO(pdf_generator.build_quotation_pdf(quotation, {"name": "Master Bath"}))).pages

    assert len(pages) == 2  # cover + one room-detail page
    detail_text = pages[1].extract_text() or ""
    assert all(item["sku"] in detail_text for item in items)
    assert pdf_generator._max_item_rows_per_page() == 10


def test_sanitary_pdf_uses_persisted_tile_order_within_each_area():
    """PDF rows must reflect the staff canvas order, not incidental API order."""
    items = [
        {"sku": "LAST", "name": "Last", "room": "Master", "sort_order": 30, "qty": 1, "unit_price": 1000},
        {"sku": "FIRST", "name": "First", "room": "Master", "sort_order": 10, "qty": 1, "unit_price": 1000},
        {"sku": "MIDDLE", "name": "Middle", "room": "Master", "sort_order": 20, "qty": 1, "unit_price": 1000},
    ]
    pages = PdfReader(BytesIO(pdf_generator.build_quotation_pdf(
        {"customer_name": "Ordered", "items": items, "subtotal": 3000, "grand_total": 3000},
        {"name": "Ordered"},
    ))).pages
    detail = pages[1].extract_text() or ""

    assert detail.index("FIRST") < detail.index("MIDDLE") < detail.index("LAST")


def test_sanitary_detail_pages_continue_after_six_products_and_start_each_area_fresh():
    """A room continuation consumes its own pages; a new area never shares one."""
    primary_area = [
        {"sku": f"BATH-1-{index:02}", "name": f"Bathroom One Product {index}", "room": "Bathroom One", "qty": 1, "unit_price": 1000}
        for index in range(1, 21)
    ]
    next_area = [{"sku": "BATH-2-01", "name": "Bathroom Two Product", "room": "Bathroom Two", "qty": 1, "unit_price": 1000}]
    quotation = {
        "customer_name": "Seventeen Per Page", "items": primary_area + next_area,
        "rooms": ["Bathroom One", "Bathroom Two"], "subtotal": 21000, "grand_total": 21000,
    }

    pages = PdfReader(BytesIO(pdf_generator.build_quotation_pdf(quotation, {"name": "Seventeen Per Page"}))).pages
    page_text = [page.extract_text() or "" for page in pages]

    assert len(pages) == 4  # portrait cover + two Bathroom One pages + Bathroom Two
    assert all(item["sku"] in page_text[1] for item in primary_area[:10])
    assert all(item["sku"] not in page_text[1] for item in primary_area[10:])
    assert all(item["sku"] in page_text[2] for item in primary_area[10:20])
    assert "AREA 1: Bathroom One" in page_text[2]
    assert "(continued)" in page_text[2]
    assert "AREA 2: Bathroom Two" in page_text[3]
    assert "BATH-2-01" in page_text[3]


def test_seventeen_long_products_continue_without_clipping_or_blank_pages():
    items = [
        {
            "sku": f"LONG-{index}-" + "SKU" * 40,
            "name": "Premium wall-mounted sanitary fitting " * 30,
            "description": "Long description " * 50,
            "finish": "Brushed nickel with a deliberately verbose factory colour name " * 8,
            "room": "Master suite bathroom with a deliberately verbose room name " * 6,
            "qty": 1,
            "unit_price": 1000,
        }
        for index in range(17)
    ]
    quotation = {"customer_name": "Long detail rows", "items": items, "subtotal": 17000, "grand_total": 17000}

    pages = PdfReader(BytesIO(pdf_generator.build_quotation_pdf(quotation, {"name": "Long detail rows"}))).pages

    # A readable six-row frame makes the seventeenth product a continuation,
    # rather than squeezing 17 rows into one unsafe page.
    assert len(pages) >= 3
    text = "\n".join(page.extract_text() or "" for page in pages[1:])
    assert "LONG-0" in text and "LONG-16" in text
    assert "…" in text


def test_watermark_geometry_fits_the_complete_original_logo_on_landscape_page():
    page_width, page_height = pdf_generator.LANDSCAPE_A4
    x, y, width, height = pdf_generator.watermark_geometry(page_width, page_height)

    assert width == page_width * pdf_generator.WATERMARK_MAX_PAGE_WIDTH
    assert height == pytest.approx(width / pdf_generator.LOGO_RATIO)
    assert x > 0 and x + width < page_width
    assert y > 0 and y + height < page_height


def test_watermark_is_drawn_on_the_first_and_detail_pages():
    quotation = {
        "customer_name": "Watermark contract",
        "items": [{"sku": "WM-1", "name": "Mixer", "room": "Bath", "qty": 1, "unit_price": 1000}],
        "subtotal": 1000,
        "grand_total": 1000,
    }
    pages = PdfReader(BytesIO(pdf_generator.build_quotation_pdf(quotation, {"name": "Watermark contract"}))).pages

    # The logo XObject is reused, but each page must invoke it in its stream.
    assert all(b"/FormXob" in page.get_contents().get_data() for page in pages)


@pytest.mark.parametrize("count", [1, 3, 7, 9, 17, 18])
def test_sanitary_detail_pagination_covers_required_product_counts(count):
    """A readable fixed frame paginates predictably without filler rows."""
    items = [
        {"sku": f"FILL-{count}-{index}", "name": "Bathroom Product", "room": "Bath", "qty": 1, "unit_price": 1000}
        for index in range(count)
    ]
    pages = PdfReader(BytesIO(pdf_generator.build_quotation_pdf(
        {"customer_name": "Adaptive layout", "items": items, "rooms": ["Bath"], "subtotal": count * 1000, "grand_total": count * 1000},
        {"name": "Adaptive layout"},
    ))).pages
    assert len(pages) == 1 + ceil(count / pdf_generator._max_item_rows_per_page())
    assert all(item["sku"] in "\n".join(page.extract_text() or "" for page in pages) for item in items)


def test_two_product_sanitary_page_uses_compact_rows_not_a_full_page_layout():
    row_height = pdf_generator._item_row_height_mm(2)
    usable = (
        pdf_generator.PAGE_H_MM - pdf_generator.TOP_MARGIN_MM
        - pdf_generator.BOTTOM_MARGIN_MM - pdf_generator.DETAIL_BOTTOM_SAFETY_MM
        - pdf_generator.AREA_HEADER_BLOCK_MM
        - pdf_generator.ITEM_HEADER_ROW_MM - pdf_generator.ITEM_TOTAL_ROW_MM
    )

    assert row_height == pdf_generator.COMPACT_SPARSE_ITEM_ROW_MM
    assert 2 * row_height < usable


@pytest.mark.skipif(shutil.which("pdftoppm") is None, reason="Poppler pdftoppm is required for PDF raster regression testing")
@pytest.mark.parametrize("count,discounted,expected_pages", [
    (1, False, 2), (3, False, 2), (7, True, 2), (9, True, 2), (17, True, 3), (18, False, 3),
])
def test_sanitary_pdf_raster_regressions_cover_counts_discount_and_image_orientations(
    monkeypatch, tmp_path, count, discounted, expected_pages,
):
    """Rendered pixels retain all rows with no unexpected blank PDF page."""
    monkeypatch.setattr(pdf_generator, "_remote_image_bytes", lambda url: _png_bytes(80, 140) if "portrait" in url else _png_bytes(140, 80))
    items = [
        {
            "sku": f"RASTER-{index}", "name": "Long product name " * 8,
            "description": "Detailed description " * 12, "finish": "Brushed nickel " * 6,
            "room": "Main Bathroom", "qty": 1, "unit_price": 1000,
            "discount_pct": 10 if discounted else 0,
            "image": f"https://cdn.example.test/{'portrait' if index % 2 else 'landscape'}.png",
        }
        for index in range(count)
    ]
    quotation = {"customer_name": "Raster regression", "items": items, "subtotal": count * 1000, "grand_total": count * (900 if discounted else 1000)}
    pages = _render_pdf_pages(pdf_generator.build_quotation_pdf(quotation, {"name": "Raster regression"}), tmp_path)

    assert len(pages) == expected_pages
    for page in pages:
        with PILImage.open(page) as image:
            assert image.height > image.width
            # An all-white page indicates an unwanted blank rendering page.
            assert image.getbbox() is not None


def _text_positions(page, tokens: set[str]) -> dict[str, list[float]]:
    """Return PDF-space y coordinates for important detail-page text."""
    positions = {token: [] for token in tokens}

    def capture(text, cm, tm, _font_dict, _font_size):
        for token in tokens:
            if token in text:
                # Table cells use a local text matrix; the graphics-state
                # translation carries its page-relative position.
                positions[token].append(float(cm[5] + tm[5]))

    page.extract_text(visitor_text=capture)
    return positions


@pytest.mark.skipif(shutil.which("pdftoppm") is None, reason="Poppler pdftoppm is required for PDF raster regression testing")
def test_detail_pages_repeat_chrome_keep_content_inside_safe_bounds_and_preserve_totals(monkeypatch, tmp_path):
    """Rendered multi-room PDF has no blank, clipped, or footer-colliding detail page."""
    monkeypatch.setattr(
        pdf_generator, "_remote_image_bytes",
        lambda url: _png_bytes(80, 150) if "portrait" in url else _png_bytes(150, 80),
    )
    ensuite = [
        {
            "sku": f"ENS-{index:02}", "name": "Thermostatic shower mixer with handset",
            "description": "Premium thermostatic shower mixer with exposed control and handset.",
            "room": "Ensuite Bathroom", "qty": 2, "unit_price": 1234.5,
            "image": f"https://cdn.example.test/{'portrait' if index % 2 else 'landscape'}.png",
        }
        for index in range(7)
    ]
    guest = [
        {"sku": f"GUEST-{index}", "name": "Wall mounted basin mixer", "room": "Guest Bathroom", "qty": 1,
         "unit_price": 999, "image": "https://cdn.example.test/landscape.png"}
        for index in range(3)
    ]
    quotation = {
        "customer_name": "Boundary QA", "items": ensuite + guest,
        "rooms": ["Ensuite Bathroom", "Guest Bathroom"],
        "subtotal": 20280, "grand_total": 20280,
    }
    pdf = pdf_generator.build_quotation_pdf(quotation, {"name": "Boundary QA"})
    pages = PdfReader(BytesIO(pdf)).pages
    rendered = _render_pdf_pages(pdf, tmp_path)

    assert len(pages) == len(rendered) == 3  # portrait cover + Ensuite + Guest Bathroom
    detail_text = [page.extract_text() or "" for page in pages[1:]]
    assert "AREA 1: Ensuite Bathroom" in " ".join(detail_text[0].split())
    assert "AREA 2: Guest Bathroom" in " ".join(detail_text[1].split())
    assert all("PRODUCT IMAGE" in " ".join(text.split()) and "Buildcon House" in text and "TOTAL" in text for text in detail_text)
    assert "20,280.00" in pages[0].extract_text()
    assert all((page.extract_text() or "").strip() for page in pages)

    footer_ceiling = 20 * pdf_generator.mm
    content_ceiling = pdf_generator.PORTRAIT_A4[1] - (pdf_generator.TOP_MARGIN_MM * pdf_generator.mm)
    expected = [{f"ENS-{index:02}" for index in range(7)}, {"GUEST-0", "GUEST-1", "GUEST-2"}]
    for page, tokens in zip(pages[1:], expected, strict=True):
        positions = _text_positions(page, tokens | {"TOTAL"})
        for token in tokens | {"TOTAL"}:
            assert positions[token], f"{token} was not rendered on its expected page"
            assert all(footer_ceiling < y < content_ceiling for y in positions[token]), f"{token} crossed a safe boundary: {positions[token]}"


def test_detail_copy_is_never_below_the_print_minimum_and_full_fitting_skus_survive():
    source = Path(pdf_generator.__file__).read_text()
    assert pdf_generator.MIN_DETAIL_FONT_SIZE_PT == 7.5
    assert "fontSize=5" not in source
    assert "size='5" not in source

    sku = "FIT-ARTICLE-2026-ABCD-123456"
    pdf = pdf_generator.build_quotation_pdf(
        {"customer_name": "SKU QA", "items": [{"sku": sku, "name": "Compact mixer", "room": "Bath", "qty": 1, "unit_price": 1000}], "subtotal": 1000, "grand_total": 1000},
        {"name": "SKU QA"},
    )
    normalized = "".join((PdfReader(BytesIO(pdf)).pages[1].extract_text() or "").split()).replace("-", "")
    assert sku.replace("-", "") in normalized


def test_missing_and_corrupt_product_images_use_a_clean_matching_placeholder(monkeypatch):
    monkeypatch.setattr(pdf_generator, "_remote_image_bytes", lambda url: b"not an image" if url else None)
    unavailable = pdf_generator._img(None)
    corrupt = pdf_generator._img("https://cdn.example.test/corrupt.png")
    assert isinstance(unavailable, pdf_generator._ImageUnavailableFrame)
    assert isinstance(corrupt, pdf_generator._ImageUnavailableFrame)
    assert (unavailable.drawWidth, unavailable.drawHeight) == (corrupt.drawWidth, corrupt.drawHeight)

    pdf = pdf_generator.build_quotation_pdf(
        {"customer_name": "Missing media", "items": [
            {"sku": "NO-IMAGE", "name": "Basin mixer", "room": "Bath", "qty": 1, "unit_price": 1000},
            {"sku": "BAD-IMAGE", "name": "Shower mixer", "room": "Bath", "qty": 1, "unit_price": 1000, "image": "https://cdn.example.test/corrupt.png"},
        ], "subtotal": 2000, "grand_total": 2000},
        {"name": "Missing media"},
    )
    assert (PdfReader(BytesIO(pdf)).pages[1].extract_text() or "").count("Image unavailable") == 2


def test_pdf_image_bytes_preserve_portrait_sources_for_contain_fit():
    source = _png_bytes(60, 120)

    assert callable(getattr(pdf_generator, "_prepare_image_bytes", None))
    prepared = pdf_generator._prepare_image_bytes(source)

    with PILImage.open(BytesIO(prepared)) as image:
        assert image.size == (60, 120)


def test_pdf_image_bytes_force_landscape_flag_does_not_rotate_source_pixels():
    source = _png_bytes(192, 120)

    prepared = pdf_generator._prepare_image_bytes(source, force_landscape=True)

    with PILImage.open(BytesIO(prepared)) as image:
        assert image.size == (192, 120)


def test_pdf_img_contains_a_portrait_source_inside_a_landscape_frame(monkeypatch):
    monkeypatch.setattr(pdf_generator, "_remote_image_bytes", lambda _url: _png_bytes(60, 120))

    image = pdf_generator._img("https://example.test/product.png")

    assert image.drawWidth == pdf_generator.STANDARD_PRODUCT_IMAGE_WIDTH_MM * pdf_generator.mm
    assert image.drawHeight == pdf_generator.STANDARD_PRODUCT_IMAGE_HEIGHT_MM * pdf_generator.mm
    prepared = pdf_generator._prepare_image_bytes(_png_bytes(60, 120))
    with PILImage.open(BytesIO(prepared)) as normalized:
        assert normalized.size == (60, 120)


def test_exif_orientation_six_is_honored_once():
    source = _jpeg_with_orientation(60, 120, 6)

    prepared = pdf_generator._prepare_image_bytes(source)

    with PILImage.open(BytesIO(prepared)) as image:
        assert image.size == (120, 60)


def test_exif_orientation_eight_is_honored_once():
    source = _jpeg_with_orientation(60, 120, 8)

    prepared = pdf_generator._prepare_image_bytes(source)

    with PILImage.open(BytesIO(prepared)) as image:
        assert image.size == (120, 60)


def test_all_quotation_pdfs_use_forced_landscape_image_frames(monkeypatch):
    """All document types share the required horizontal product-image policy."""
    monkeypatch.setattr(pdf_generator, "_remote_image_bytes", lambda _url: _png_bytes(60, 120))
    original_img = pdf_generator._img
    rendered_sizes: list[tuple[float, float]] = []
    requested_boxes: list[tuple[float, float]] = []
    cover_values: list[bool] = []

    def capture_img(*args, **kwargs):
        requested_boxes.append((
            kwargs.get("width_mm", pdf_generator.STANDARD_PRODUCT_IMAGE_WIDTH_MM),
            kwargs.get("height_mm", pdf_generator.STANDARD_PRODUCT_IMAGE_HEIGHT_MM),
        ))
        cover_values.append(bool(kwargs.get("cover", False)))
        image = original_img(*args, **kwargs)
        rendered_sizes.append((image.drawWidth, image.drawHeight))
        return image

    monkeypatch.setattr(pdf_generator, "_img", capture_img)
    monkeypatch.setattr(pdf_tiles, "_img", capture_img)
    item = {
        "image": "https://example.test/portrait.png", "sku": "UPRIGHT-1",
        "name": "Upright Product", "room": "Living", "qty": 1,
        "unit_price": 1000, "rate_sqft": 100, "rate_box": 1000,
        "offer_rate": 100, "net_amount": 1000, "quantity_unit": "Box",
    }
    standard = {"customer_name": "PDF Test", "items": [item], "subtotal": 1000, "grand_total": 1000}
    tiles = {**standard, "doc_date": "12-08-2026"}

    assert pdf_generator.build_quotation_pdf(standard, {"name": "PDF Test"}).startswith(b"%PDF-")
    assert pdf_tiles.build_tiles_selection_pdf(tiles, {"name": "PDF Test"}).startswith(b"%PDF-")
    assert pdf_tiles.build_tiles_quotation_pdf(tiles, {"name": "PDF Test"}).startswith(b"%PDF-")
    assert len(rendered_sizes) == 3
    assert requested_boxes == [
        (pdf_generator._pw(pdf_generator.PRODUCT_IMAGE_FRAME_WIDTH_MM), pdf_generator._pw(pdf_generator.PRODUCT_IMAGE_FRAME_HEIGHT_MM)),
        (pdf_tiles.SELECTION_PRODUCT_IMAGE_WIDTH_MM, pdf_tiles.SELECTION_PRODUCT_IMAGE_HEIGHT_MM),
        (pdf_tiles.QUOTATION_PRODUCT_IMAGE_WIDTH_MM, pdf_tiles.QUOTATION_PRODUCT_IMAGE_HEIGHT_MM),
    ]
    assert all(width > 0 and height > 0 for width, height in rendered_sizes)
    assert cover_values == [False, True, True]
    assert all(
        (width, height) == (box_width * pdf_generator.mm, box_height * pdf_generator.mm)
        for (width, height), (box_width, box_height) in zip(rendered_sizes, requested_boxes, strict=True)
    )


@pytest.mark.parametrize("count", [1, 3, 6, 7, 17])
def test_sanitary_pages_use_one_large_contained_image_frame(monkeypatch, count):
    """Image geometry is stable across sparse rooms and continuations."""
    monkeypatch.setattr(pdf_generator, "_remote_image_bytes", lambda _url: _png_bytes(140, 80))
    images = []
    original_img = pdf_generator._img

    def capture_img(*args, **kwargs):
        image = original_img(*args, **kwargs)
        images.append((image, kwargs))
        return image

    monkeypatch.setattr(pdf_generator, "_img", capture_img)
    items = [
        {"image": f"https://example.test/{index}.png", "sku": f"SPARSE-{index}", "name": "Mixer", "room": "Bath", "qty": 1, "unit_price": 1000}
        for index in range(count)
    ]
    pdf_generator.build_quotation_pdf(
        {"customer_name": "Sparse", "items": items, "subtotal": count * 1000, "grand_total": count * 1000},
        {"name": "Sparse"},
    )

    assert len(images) == count
    for image, kwargs in images:
        assert kwargs["cover"] is False
        assert kwargs["width_mm"] == pdf_generator._pw(pdf_generator.PRODUCT_IMAGE_FRAME_WIDTH_MM)
        assert kwargs["height_mm"] == pdf_generator._pw(pdf_generator.PRODUCT_IMAGE_FRAME_HEIGHT_MM)
        assert image.drawWidth == pdf_generator._pw(pdf_generator.PRODUCT_IMAGE_FRAME_WIDTH_MM) * pdf_generator.mm
        assert image.drawHeight == pdf_generator._pw(pdf_generator.PRODUCT_IMAGE_FRAME_HEIGHT_MM) * pdf_generator.mm


def test_portrait_product_frame_fits_inside_its_scaled_table_column():
    """A product image must never intrude into article/rate cells."""
    image_frame = pdf_generator._pw(pdf_generator.PRODUCT_IMAGE_FRAME_WIDTH_MM)
    image_column = pdf_generator._pw(25)
    # More than one millimetre remains for ReportLab's 1 pt side paddings.
    assert image_frame + 1 <= image_column


def test_every_quotation_pdf_is_portrait_a4(monkeypatch):
    monkeypatch.setattr(pdf_generator, "_remote_image_bytes", lambda _url: _png_bytes(60, 120))
    item = {
        "image": "https://example.test/portrait.png", "sku": "LANDSCAPE-1",
        "name": "Portrait Source", "room": "Living", "qty": 1,
        "unit_price": 1000, "rate_sqft": 100, "rate_box": 1000,
        "offer_rate": 100, "net_amount": 1000, "quantity_unit": "Box",
    }
    quotation = {"customer_name": "Landscape Contract", "items": [item], "subtotal": 1000, "grand_total": 1000}
    pdf = pdf_generator.build_quotation_pdf(quotation, {"name": "Portrait Contract"})
    page = PdfReader(BytesIO(pdf)).pages[0]
    assert float(page.mediabox.height) > float(page.mediabox.width)


def test_product_images_are_prefetched_concurrently(monkeypatch):
    import threading
    import time

    active = 0
    peak = 0
    lock = threading.Lock()

    def fetch(_url):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.03)
        with lock:
            active -= 1
        return None

    monkeypatch.setattr(pdf_generator, "_remote_image_bytes", fetch)
    pdf_generator.prefetch_product_images(
        [{"image": f"https://example.test/{index}.png"} for index in range(8)],
        workers=4,
        timeout=1,
    )

    assert peak == 4
