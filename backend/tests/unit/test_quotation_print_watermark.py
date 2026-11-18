"""Printer-compatible ink and every-page quotation watermark contracts."""

from io import BytesIO
import shutil
import subprocess

from PIL import Image, ImageChops
from pypdf import PdfReader
from pypdf.generic import ContentStream
import pytest

import pdf_generator
import pdf_tiles


@pytest.fixture(params=[
    ("first-floor", pdf_generator.build_quotation_pdf),
    ("second-floor", pdf_generator.build_quotation_pdf),
    ("ground-floor", pdf_tiles.build_tiles_quotation_pdf),
    ("ground-floor", pdf_tiles.build_tiles_selection_pdf),
], ids=["sanitary", "second-floor", "tiles-quotation", "tiles-selection"])
def document(request):
    floor, builder = request.param
    items = [{
        "sku": f"PRINT-{index}", "name": "Sample product", "room": "Sample room",
        "qty": 1, "unit_price": 1000, "rate_sqft": 100,
        "quantity_unit": "Box", "size": "600x600",
    } for index in range(18)]
    quotation = {
        "number": "PRINT-SAMPLE", "floor_id": floor, "customer_name": "Sample Customer",
        "items": items, "subtotal": 18000, "grand_total": 18000,
    }
    return builder, quotation, {"name": "Sample Customer"}


def _watermark_refs(page):
    # The header uses the RGBA logo; the watermark must have its own RGB image
    # with no soft mask. Other partner images have different native dimensions.
    return [name for name, ref in page["/Resources"].get("/XObject", {}).items()
            if ref.get_object().get("/Width") == 1414
            and ref.get_object().get("/Height") == 412
            and ref.get_object().get("/ColorSpace") == "/DeviceRGB"
            and "/SMask" not in ref.get_object()]


def test_cover_is_clean_and_every_detail_page_contains_printable_watermark(document):
    builder, quotation, customer = document
    reader = PdfReader(BytesIO(builder(quotation, customer)))
    assert len(reader.pages) >= 3
    assert not _watermark_refs(reader.pages[0])
    for page in reader.pages[1:]:
        refs = _watermark_refs(page)
        assert len(refs) == 1
        image = page["/Resources"]["/XObject"][refs[0]].get_object()
        assert "/Mask" not in image
        # A printer sees actual nonwhite ink, even without alpha support.
        assert min(image.get_data()) < 225
        assert min(image.get_data()) > 180
        operations = ContentStream(page.get_contents(), reader).operations
        assert sum(op == b"Do" and operands[0] == refs[0] for operands, op in operations) == 1
        assert not any(op == b"gs" for _, op in operations)
        draw_index = next(index for index, (operands, op) in enumerate(operations)
                          if op == b"Do" and operands[0] == refs[0])
        transforms = [list(map(float, values)) for values, op in operations[:draw_index] if op == b"cm"]
        rotation, scale = transforms[-2:]
        page_width, page_height = float(page.mediabox.width), float(page.mediabox.height)
        # Inspect the emitted PDF matrices, including the shorter cover size,
        # rather than inferring placement from the presence of an image alone.
        assert rotation[1] / rotation[0] == pytest.approx(page_height / page_width, rel=1e-5)
        assert rotation[4:] == pytest.approx([page_width / 2, page_height / 2], abs=0.001)
        assert scale[0] / scale[3] == pytest.approx(pdf_generator.LOGO_RATIO, rel=1e-5)
        rotated_width = scale[0] * rotation[0] + scale[3] * rotation[1]
        rotated_height = scale[0] * rotation[1] + scale[3] * rotation[0]
        available_width = page_width - 2 * pdf_generator.WATERMARK_PAGE_INSET
        available_height = page_height - 2 * pdf_generator.WATERMARK_PAGE_INSET
        assert rotated_width <= available_width + 0.001
        assert rotated_height <= available_height + 0.001
        assert max(rotated_width / available_width, rotated_height / available_height) == pytest.approx(1, abs=1e-5)


def test_watermark_setting_is_honored_on_all_pages(document):
    builder, quotation, customer = document
    pages = PdfReader(BytesIO(builder(quotation, customer, {"show_watermark": False}))).pages
    assert all(not _watermark_refs(page) for page in pages)


@pytest.mark.skipif(shutil.which("pdftoppm") is None, reason="Poppler is needed to verify printed pixels")
def test_diagonal_ink_remains_visible_in_rendered_summary_and_continuations(document, tmp_path):
    builder, quotation, customer = document
    rendered = {}
    for enabled in (False, True):
        source = tmp_path / f"watermark-{enabled}.pdf"
        prefix = tmp_path / f"page-{enabled}"
        source.write_bytes(builder(quotation, customer, {"show_watermark": enabled}))
        subprocess.run(["pdftoppm", "-gray", "-r", "72", str(source), str(prefix)],
                       check=True, capture_output=True)
        rendered[enabled] = sorted(tmp_path.glob(f"page-{enabled}-*.pgm"))
    assert len(rendered[True]) == len(rendered[False]) >= 3
    with Image.open(rendered[True][0]) as marked, Image.open(rendered[False][0]) as plain:
        assert ImageChops.difference(marked, plain).getbbox() is None
    for marked, plain in zip(rendered[True][1:], rendered[False][1:]):
        with Image.open(marked) as actual, Image.open(plain) as baseline:
            diff = ImageChops.difference(actual, baseline)
            visible = diff.point(lambda level: 255 if level > 12 else 0)
            bounds = visible.getbbox()
            assert bounds is not None
            left, top, right, bottom = bounds
            # Table shading/photos may cover a background watermark. Its
            # placement is checked separately; the remaining ink must still
            # span substantial page area on every continuation.
            assert right - left > actual.width * 0.50
            assert bottom - top > actual.height * 0.45
            # Distinct pale ink must survive page rasterization, rather than
            # merely existing as an unused/invisible PDF image resource.
            assert visible.histogram()[255] > actual.width * actual.height * 0.01


@pytest.mark.parametrize("floor,remove_attribution", [
    ("ground-floor", True),
    ("first-floor", True),
    ("second-floor", False),
])
def test_standard_quotation_staff_fields_follow_department(floor, remove_attribution):
    quote = {
        "floor_id": floor, "doc_type": "standard", "number": "FQ-PROOF-001",
        "created_at": "2026-11-18T10:00:00Z",
        "attended_by": "Sales Attendant Sample", "prepared_by": "Sales Preparer Sample",
        "address_snapshot": "Sample Road, Rajkot", "reference_source": "Showroom reference",
        "phone_snapshot": "990-995-57-55",
        "items": [{"name": "Basin mixer", "sku": "BASIN-1", "room": "Master", "qty": 2, "unit_price": 1000}],
    }
    pages = PdfReader(BytesIO(pdf_generator.build_quotation_pdf(quote, {"name": "Sample Customer"}))).pages
    cover = pages[0].extract_text()
    for text in ("ATTENDED BY", "PREPARED BY", "Sales Attendant Sample", "Sales Preparer Sample"):
        assert (text not in cover) is remove_attribution
    for text in ("Sample Customer", "Showroom reference", "Sample Road, Rajkot", "FQ-PROOF-001", "18 Nov 2026", "PRICE SUMMARY"):
        assert text in cover
    assert ("990-995-57-55" if floor == "second-floor" else "9909955755") in cover
    assert "BASIN-1" in pages[1].extract_text()


@pytest.mark.parametrize("builder, floor, doc_type", [
    (pdf_generator.build_quotation_pdf, "first-floor", None),
    (pdf_generator.build_quotation_pdf, "ground-floor", "standard"),
    (pdf_tiles.build_tiles_quotation_pdf, "ground-floor", "tiles_quotation"),
], ids=["sanitary-legacy", "ground-standard", "ground-tiles"])
def test_product_quotation_wraps_reference_and_address_in_wide_columns(builder, floor, doc_type):
    reference = "ReferenceStart Design & Build Studio, " + "Riverside Projects and Partners " * 5 + "ReferenceEnd"
    address = "AddressStart Building 14, " + "Near the Riverside Commercial Complex, " * 3 + "AddressEnd"
    quotation = {
        "number": "FQ-WRAP", "floor_id": floor, "doc_type": doc_type,
        "attended_by": "Attendance Fixture", "prepared_by": "Preparation Fixture",
        "reference_source": reference, "address_snapshot": address,
        "subtotal": 1250, "grand_total": 1250,
        "items": [{"name": "Fixture Product", "qty": 1, "unit_price": 1250, "net_amount": 1250}],
    }
    pages = PdfReader(BytesIO(builder(quotation, {"name": "Wrap Customer"}))).pages
    cover = pages[0].extract_text()
    assert " ".join(reference.split()) in " ".join(cover.split())
    assert " ".join(address.split()) in " ".join(cover.split())
    assert all(text not in cover for text in ("ATTENDED BY", "PREPARED BY", "Attendance Fixture", "Preparation Fixture"))
    assert all(text in cover for text in ("Wrap Customer", "1,250.00", "TERMS & CONDITIONS", "CUSTOMER SIGNATURE"))
    assert len(pages) == 2
    assert "Fixture Product" in pages[1].extract_text()


@pytest.mark.parametrize("floor,builder,font_size,gray", [
    ("ground-floor", pdf_generator.build_quotation_pdf, 9, 89 / 255),
    ("first-floor", pdf_generator.build_quotation_pdf, 9, 89 / 255),
    ("ground-floor", pdf_tiles.build_tiles_quotation_pdf, 10, 89 / 255),
    ("second-floor", pdf_generator.build_quotation_pdf, 8, 17 / 255),
], ids=["ground-sanitary", "sanitary", "tiles", "kitchen"])
def test_quotation_prints_uniform_serial_numbers(floor, builder, font_size, gray):
    serials = ["1", "2", "3", "4"]
    quotation = {
        "number": "SERIAL-PROOF", "floor_id": floor,
        "items": [{"name": "Sample fitting", "sku": f"QA-{number}", "qty": 1.25,
                   "unit_price": 100, "room": "Master Bathroom", "rate_sqft": 113,
                   "size": "600x600", "quantity_unit": "Box"} for number in serials],
    }
    reader = PdfReader(BytesIO(builder(quotation, {"name": "Sample Client"})))
    emitted = []
    for page in reader.pages[1:]:
        operations = ContentStream(page.get_contents(), reader).operations
        for index, (values, operator) in enumerate(operations):
            if operator != b"Tj" or str(values[0]) not in serials:
                continue
            # Each isolated table cell sets its fill and font immediately
            # before drawing its label. The tiles page indicator shares its
            # text block with other strings and is not a table serial.
            cell = operations[max(0, index - 6):index]
            if [opcode for _, opcode in cell] == [b"rg", b"BT", b"Tm", b"Tf", b"TL", b"Td"]:
                emitted.append((str(values[0]), list(map(float, cell[0][0])), float(cell[3][0][1])))
    assert [serial for serial, _, _ in emitted] == serials
    for _, color, point_size in emitted:
        assert color == pytest.approx([gray] * 3, abs=1e-6)
        assert point_size == font_size
