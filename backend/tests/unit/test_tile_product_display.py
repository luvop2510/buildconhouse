"""Only the table presentation changes; saved supplier names remain intact."""
from copy import deepcopy
from io import BytesIO

import pytest
from pypdf import PdfReader

from services.product_display import tile_product_name
from pdf_tiles import build_tiles_selection_pdf, build_tiles_quotation_pdf


@pytest.mark.parametrize("name,size,expected", [
    ("21836 (218X52)", "218X52", "21836"),
    ("DELICATO GREY - Matt (1200X1800)", "1200X1800", "DELICATO GREY - Matt"),
    ("SQ 10 (60 × 300)", "60X300", "SQ 10"),
    ("Model (Outdoor) [600x600] - Matt", "600X600", "Model (Outdoor) - Matt"),
    ("Model 600x600", "600 X 600", "Model"),
    ("Code218X52", "218X52", "Code218X52"),
    ("Model (Series 218X52)", "218X52", "Model (Series 218X52)"),
    ("Model (600X1200)", "600X600", "Model (600X1200)"),
    ("Model (600X600)", "", "Model (600X600)"),
    ("Model (Matt)", "Matt", "Model (Matt)"),
])
def test_only_matching_separate_size_is_removed(name, size, expected):
    assert tile_product_name(name, size) == expected


@pytest.mark.parametrize("builder", [build_tiles_selection_pdf, build_tiles_quotation_pdf])
def test_exported_product_details_print_size_once_and_preserve_stored_rows(builder):
    doc = {"customer_name": "Display acceptance", "doc_date": "2026-11-16", "doc_type": "tiles_quotation", "items": [
        {"name": "21836 (218X52)", "size": "218X52", "qty": 1, "unit_price": 180},
        {"name": "DELICATO GREY - Matt (1200X1800)", "size": "1200X1800", "qty": 1, "unit_price": 200},
    ], "grand_total": 380}
    before = deepcopy(doc)
    pages = PdfReader(BytesIO(builder(doc, {"name": "Display acceptance"}))).pages
    text = " ".join((page.extract_text() or "") for page in pages[1:])
    compact = "".join(text.split())
    assert compact.count("218X52") == 1 and compact.count("1200X1800") == 1
    assert "21836" in text and "DELICATOGREY-Matt" in compact
    assert "(218X52)" not in text and "(1200X1800)" not in text
    assert doc == before
