"""Every customer document embeds the ten active partner marks from the supplied cover."""

from io import BytesIO

from pypdf import PdfReader

from pdf_chalan import build_chalan_pdf, build_tile_chalan_pdf
from pdf_generator import BRAND_LOGO_DIR, BRAND_PARTNERS, build_quotation_pdf
from pdf_tiles import build_tiles_quotation_pdf, build_tiles_selection_pdf


def _first_page_image_count(blob: bytes) -> int:
    page = PdfReader(BytesIO(blob)).pages[0]
    return sum(
        1 for item in page["/Resources"]["/XObject"].values()
        if item.get_object().get("/Subtype") == "/Image"
    )


def test_supplied_partner_set_is_complete_and_present_on_every_pdf_cover():
    names = [name for row in BRAND_PARTNERS for name in row]
    assert len(names) == len(set(names)) == 10
    assert "hansgrohe" in names
    assert names[names.index("vitra") + 1] == "verantes_living"
    assert "axor" not in names
    assert not (BRAND_LOGO_DIR / "axor.png").exists()
    assert all((BRAND_LOGO_DIR / f"{name}.png").is_file() for name in names)

    quotation = {
        "customer_name": "Logo Check", "items": [{"name": "Tile", "room": "Bath", "qty": 1, "unit_price": 100}],
        "subtotal": 100, "grand_total": 100,
    }
    customer = {"name": "Logo Check"}
    chalan = {"number": "CH-1", "items": [{"name": "Tile", "qty": 1, "rate": 100}]}
    tile_chalan = {"number": "CH-2", "generated_at": "2026-09-26T12:00:00", "customer_name": "Logo Check", "items": []}
    documents = (
        build_quotation_pdf(quotation, customer),
        build_tiles_quotation_pdf(quotation, customer),
        build_tiles_selection_pdf(quotation, customer),
        build_chalan_pdf(chalan, {"number": "PO-1", "customer_name": "Logo Check"}, customer),
        build_tile_chalan_pdf(tile_chalan),
    )
    assert all(_first_page_image_count(document) >= 10 for document in documents)
