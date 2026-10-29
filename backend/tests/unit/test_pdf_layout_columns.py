"""Preserve the business's original product-detail columns on portrait A4."""
from io import BytesIO
from pypdf import PdfReader
import pdf_tiles


def test_portrait_quotation_keeps_all_eleven_original_columns_and_landscape_image_frame():
    pdf = pdf_tiles.build_tiles_quotation_pdf({'customer_name':'Column contract','items':[{'name':'Tile','qty':1,'unit_price':100}]}, {'name':'Column contract'})
    page = PdfReader(BytesIO(pdf)).pages[1]
    text = ''.join((page.extract_text() or '').split())
    headers = ['SR.NO.', 'PRODUCTIMAGE', 'AREA', 'PRODUCTDETAIL', 'SIZE', 'RATE/SQ.FT', 'OFFERRATE', 'RATE/UNIT', 'QUANTITY', 'UNIT', 'TOTAL']
    at = 0
    for header in headers:
        at = text.index(header, at) + len(header)
    assert len(pdf_tiles._QUO_COLS) == 11
    assert sum(pdf_tiles._QUO_COLS) <= 194 * pdf_tiles.mm + .01
    assert pdf_tiles.QUOTATION_PRODUCT_IMAGE_WIDTH_MM > pdf_tiles.QUOTATION_PRODUCT_IMAGE_HEIGHT_MM
    assert pdf_tiles.SELECTION_PRODUCT_IMAGE_WIDTH_MM > pdf_tiles.SELECTION_PRODUCT_IMAGE_HEIGHT_MM
    assert float(page.mediabox.height) > float(page.mediabox.width)
