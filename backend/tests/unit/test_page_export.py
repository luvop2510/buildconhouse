from io import BytesIO

import openpyxl
import pytest

from routes.page_export_routes import ExportSection, PageWorkbook, export_page_workbook


@pytest.mark.asyncio
async def test_page_workbook_keeps_sections_and_escapes_spreadsheet_formulas():
    payload = PageWorkbook(page="Catalog", sections=[
        ExportSection(name="Brand A", rows=[["SKU", "Price"], ["=HYPERLINK(\"bad\")", "1200"]]),
        ExportSection(name="Brand B", rows=[["SKU", "Price"], ["B2", "900"]]),
    ])

    response = await export_page_workbook(payload, user=object())
    data = b"".join([chunk async for chunk in response.body_iterator])
    workbook = openpyxl.load_workbook(BytesIO(data))

    assert workbook.sheetnames == ["Brand A", "Brand B 2"]
    assert workbook["Brand A"]["A4"].value.startswith("'=HYPERLINK")
    assert workbook["Brand B 2"]["A4"].value == "B2"
