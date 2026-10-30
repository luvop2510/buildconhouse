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


def test_large_workbook_formats_without_scanning_all_existing_cells_per_cell(monkeypatch):
    """Formatting work must stay linear as the permitted export grows."""
    from openpyxl.worksheet.worksheet import Worksheet
    original = Worksheet.max_row.fget
    calls = 0
    def counted_max_row(sheet):
        nonlocal calls
        calls += 1
        return original(sheet)
    monkeypatch.setattr(Worksheet, "max_row", property(counted_max_row))
    rows = [{"id": f"order-{index}", "name": "Recorded product", "sales": index + 100.25, "currency": "INR", "orders": 1, "customers": 1,
             "quantity": 1.2345, "unit": "Pieces", "date": "2026-10-28", "company_id": "brand1", "customer_id": "customer1", "discount_pct": 10} for index in range(3000)]
    blob = export_bytes({"title": "Large profile"}, [("Products", rows)], "xlsx", {"Date basis": "confirmation"})
    # Serialization may inspect dimensions; formatting may not scan the entire
    # worksheet for every one of the 36,000 cells.
    assert calls < 50
    book = load_workbook(BytesIO(blob))
    sheet = book["Products"]
    assert sheet.max_row == 3001 and sheet.max_column == 12
    assert sheet["A2"].value == "order-0" and sheet["A3001"].value == "order-2999"
    assert sheet["C3001"].value == 3099.25 and '"INR "' in sheet["C3001"].number_format
    assert sheet["L3001"].value == 10 and sheet["L3001"].number_format == '0.00"%"'
    assert sheet.freeze_panes == "A2" and sheet.auto_filter.ref == "A1:L3001"


def test_pdf_is_portrait_a4_and_keeps_every_continuation_row():
    from reportlab.lib.pagesizes import A4
    rows = [{"id": f"order-{index}", "name": "Recorded customer", "sales": 1000 + index, "currency": "INR", "orders": 1} for index in range(55)]
    reader = PdfReader(BytesIO(export_bytes({"title": "Selected sales"}, [("Orders", rows)], "pdf", {"Period": "October 2026"})))
    assert len(reader.pages) > 1
    for page in reader.pages:
        assert float(page.mediabox.width) == pytest.approx(A4[0], abs=.01)
        assert float(page.mediabox.height) == pytest.approx(A4[1], abs=.01)
        assert "INR / RNB shown separately" in page.extract_text()
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert all(f"order-{index}" in text for index in range(55))
    assert "Largest recorded values" in text


def test_comparison_charts_never_duplicate_inr_as_rnb():
    from services.analytics.unified_exports import _comparison
    rows = [{"id": "catalog", "sales": 100}, {"id": "furniture", "sales": 90000, "currency": "RNB"}]
    inr = _comparison(rows, "sales", "INR")
    rnb = _comparison(rows, "sales", "RNB")
    inr_text = [shape.text for shape in inr.contents if hasattr(shape, "text")]
    rnb_text = [shape.text for shape in rnb.contents if hasattr(shape, "text")]
    assert "catalog" in inr_text and "furniture" not in inr_text
    assert "furniture" in rnb_text and "catalog" not in rnb_text
    assert _comparison(rows[:1], "sales", "RNB") is None


def test_records_only_pdf_does_not_add_unselected_dashboard_totals():
    report = {"kpis": {"sales": 987654321}, "trend": [{"label": "Hidden month", "sales": 987654321}],
              "tables": {"orders": {"items": [{"id": "selected-record", "sales": None}], "total": 1}}}
    sections = report_sections(report, view="profile", scope="records")
    text = "\n".join(page.extract_text() for page in PdfReader(BytesIO(export_bytes(report, sections, "pdf", {}))).pages)
    assert "selected-record" in text and "Unavailable" in text
    assert "98,76,54,321" not in text and "Hidden month" not in text


def test_single_point_trend_is_visible_and_prior_comparison_is_distinct():
    from reportlab.graphics.shapes import Circle, PolyLine
    drawing = trend_drawing([{"label": "October", "sales": 100}], "INR")
    assert any(isinstance(shape, Circle) for shape in drawing.contents)
    drawing = trend_drawing([{"label": "Sep", "sales": 100, "previous_sales": 80}, {"label": "Oct", "sales": 200, "previous_sales": 120}], "INR")
    lines = [shape for shape in drawing.contents if isinstance(shape, PolyLine)]
    assert len(lines) == 2 and lines[0].strokeDashArray == [3, 3] and not lines[1].strokeDashArray


def test_summary_bars_only_compare_complete_balances_in_their_own_currency():
    from services.analytics.unified_exports import _summary_scale, PDF_BAR_FIELDS
    summary = {"collected": 75, "outstanding": 25, "collected_rnb": 20, "outstanding_rnb": 30}
    assert _summary_scale(summary, "collected") == (0, 100)
    assert _summary_scale(summary, "outstanding_rnb") == (0, 50)
    for key in ("sales", "orders", "customers", "average_order_value", "change_pct", "change_pct_rnb"):
        assert _summary_scale(summary, key) is None
    for invalid in ({"collected": None, "outstanding": 25}, {"collected": 0, "outstanding": 0}, {"collected": -1, "outstanding": 25}, {"collected": 1e308, "outstanding": 1e308}):
        assert _summary_scale(invalid, "collected") is None
    assert "quantity" not in PDF_BAR_FIELDS and "unit_price" not in PDF_BAR_FIELDS
