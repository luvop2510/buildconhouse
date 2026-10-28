"""Export visual data, currency, limits and user text remain faithful."""
from io import BytesIO

import pytest
from fastapi import HTTPException
from openpyxl import load_workbook
from pypdf import PdfReader

from services.analytics.unified_exports import export_bytes, report_sections, trend_drawing


def test_profile_record_only_export_never_silently_truncates():
    with pytest.raises(HTTPException) as failure:
        report_sections({"tables": {"orders": {"items": [{"id": "one"}], "total": 2}}}, view="profile", scope="records")
    assert failure.value.status_code == 422


def test_profile_full_export_includes_charts_and_source_tables():
    report = {"identity": {"id": "selected-brand", "name": "Selected"}, "kpis": {"sales": 123456.78},
              "trend": [{"id": "day-one", "label": "01 Oct", "sales": 123456.78, "sales_rnb": 0}],
              "tables": {"orders": {"items": [{"id": "source-order", "currency": "INR", "sales": 123456.78}], "total": 1}}}
    sections = report_sections(report, view="profile")
    assert "Trend" in [name for name, _ in sections]
    data = export_bytes(report, sections, "pdf", {"Selected entity ID": "selected-brand"})
    text = "\n".join(page.extract_text() for page in PdfReader(BytesIO(data)).pages)
    assert "INR 1,23,456.78" in text
    assert "selected-brand" in text and "source-order" in text and "INR sales trend" in text


def test_workbook_preserves_numeric_money_and_percentage_units():
    sections = [("Summary", [{"metric": "sales rnb", "value": 1234.56}, {"metric": "change pct", "value": 12.5}]),
                ("Lines", [{"id": "line", "currency": "INR", "sales": 123456.78, "discount_pct": 10, "name": "=not-a-formula"}])]
    book = load_workbook(BytesIO(export_bytes({}, sections, "xlsx", {})))
    assert book["Summary"]["B2"].value == 1234.56
    assert '"RNB "' in book["Summary"]["B2"].number_format
    assert '%' in book["Summary"]["B3"].number_format
    assert book["Lines"]["E2"].data_type == "s"
    assert book["Lines"]["E2"].value.startswith("'=")
    assert '"INR "' in book["Lines"]["C2"].number_format


def test_missing_chart_amounts_break_lines_instead_of_becoming_zero():
    rows = [{"label": "One", "sales": 100}, {"label": "Unknown", "sales": None}, {"label": "Three", "sales": 200}, {"label": "Four", "sales": 300}]
    drawing = trend_drawing(rows, "INR")
    runs = [item for item in drawing.contents if item.__class__.__name__ == "PolyLine"]
    assert len(runs) == 1 and len(runs[0].points) == 4
    assert trend_drawing([{"label": "Unknown", "sales": None}], "INR") is None


def test_long_untrusted_values_are_printable_without_markup_or_lost_rows():
    data = export_bytes({"title": "Customer <script> & history"}, [("History", [{"id": "long-text-row", "notes": "<b>literal</b> " * 600}])], "pdf", {})
    text = "\n".join(page.extract_text() for page in PdfReader(BytesIO(data)).pages)
    assert "Customer <script> & history" in text and "long-text-row" in text
    assert "<b>literal</b>" in text
