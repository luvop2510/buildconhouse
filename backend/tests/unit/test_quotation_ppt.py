"""The exported deck must preserve grouping and contain product imagery only."""
from io import BytesIO

from PIL import Image
from pptx import Presentation

from models import QuotationLineItem
from services import quotation_ppt


def _image_bytes() -> bytes:
    stream = BytesIO()
    Image.new("RGB", (1200, 1200), "white").save(stream, format="PNG")
    return stream.getvalue()


def test_area_is_a_persisted_quotation_line_field():
    line = QuotationLineItem(product_id="p1", sku="S-1", name="Basin", room="Powder Room", area="Basin Area")
    assert line.model_dump()["area"] == "Basin Area"


def test_dimension_options_survive_quotation_line_validation():
    line = QuotationLineItem(product_id="p1", sku="S-1", name="Basin", dimension="600 × 400 mm", exclude_dimension=True)
    assert line.model_dump()["dimension"] == "600 × 400 mm"
    assert line.model_dump()["exclude_dimension"] is True


def test_ppt_groups_products_by_room_and_area_without_catalog_text(monkeypatch):
    data = _image_bytes()
    monkeypatch.setattr(quotation_ppt, "prefetch_urls", lambda _urls: None)
    monkeypatch.setattr(quotation_ppt, "remote_image_bytes", lambda _url: data)
    doc = {
        "customer_name": "Dineshbhai Amrutiya",
        "rooms": ["Powder Room", "Utility"],
        "items": [
            {"room": "Powder Room", "area": "Basin Area", "name": "Basin", "sku": "SECRET-1", "image": "https://example.test/1.png"},
            {"room": "Powder Room", "area": "Basin Area", "name": "Tap", "sku": "SECRET-2", "image": "https://example.test/2.png"},
            {"room": "Powder Room", "area": "WC Area", "name": "WC", "sku": "SECRET-3", "image": "https://example.test/3.png"},
            {"room": "Utility", "area": "Shower Area", "name": "Shower", "sku": "SECRET-4", "image": "https://example.test/4.png"},
        ],
    }
    ppt = Presentation(BytesIO(quotation_ppt.build_product_ppt(doc)))
    assert len(ppt.slides) == 3
    assert round(ppt.slide_width / ppt.slide_height, 2) == round(16 / 9, 2)
    texts = [" ".join(shape.text for shape in slide.shapes if shape.has_text_frame) for slide in ppt.slides]
    assert "DINESHBHAI AMRUTIYA" in texts[0]
    assert "POWDER ROOM" in texts[1] and "Basin Area" in texts[1] and "WC Area" in texts[1]
    assert "UTILITY" in texts[2] and "Shower Area" in texts[2]
    assert all("SECRET" not in text and "Tap" not in text for text in texts)
    assert [sum(shape.shape_type == 13 for shape in slide.shapes) for slide in ppt.slides] == [0, 3, 1]


def test_ppt_keeps_product_with_missing_image():
    ppt = Presentation(BytesIO(quotation_ppt.build_product_ppt({"items": [{"name": "Basin", "room": "Bath"}]})))
    assert len(ppt.slides) == 2
    assert sum(shape.shape_type == 13 for shape in ppt.slides[1].shapes) == 1


def test_filename_contains_only_safe_customer_name_ppt_and_date():
    assert quotation_ppt.presentation_filename('A/B: Customer', "25-09-2026") == "AB Customer PPT 25-09-2026.pptx"


def test_unassigned_legacy_products_get_sensible_areas():
    assert quotation_ppt.suggested_area("Wall hung WC with bidet") == "WC Area"
    assert quotation_ppt.suggested_area("Rainshower 300") == "Shower Area"
    assert quotation_ppt.suggested_area("Countertop basin") == "Basin Area"
    assert quotation_ppt.suggested_area("Towel rail") == "Other Area"
