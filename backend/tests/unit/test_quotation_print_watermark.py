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


def test_every_summary_and_continuation_page_contains_printable_watermark(document):
    builder, quotation, customer = document
    reader = PdfReader(BytesIO(builder(quotation, customer)))
    assert len(reader.pages) >= 3
    for page in reader.pages:
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
    for marked, plain in zip(rendered[True], rendered[False]):
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
