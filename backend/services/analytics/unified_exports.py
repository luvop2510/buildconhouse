"""Server-derived PDF and Excel exports of exactly the authorized report view."""
from __future__ import annotations

from io import BytesIO
from math import ceil
from xml.sax.saxutils import escape

from fastapi import HTTPException
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Font, PatternFill
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.graphics.shapes import Drawing, Line, PolyLine, String
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

from services.export import spreadsheet_cell
from services.money import format_indian_money
from pdf_generator import RUPEE_FONT

MAX_EXPORT_ROWS = 10_000
ACCENT = "0066CC"
MONEY_FIELDS = {"sales", "sales_rnb", "average_order_value", "average_order_value_rnb", "collected", "outstanding", "collected_rnb", "outstanding_rnb", "unit_price", "line_total", "amount", "subtotal", "total", "discount", "tax", "taxes"}


def display(value, key="", currency="INR"):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if key in MONEY_FIELDS:
            return f"{'RNB' if key.endswith('_rnb') or currency == 'RNB' else 'INR'} {format_indian_money(value)}"
        if key.endswith("_pct"):
            return f"{value:g}%"
    return str(cell(value))


def trend_drawing(rows, currency):
    """The chart and its accessible table use the same exported source rows."""
    key = "sales_rnb" if currency == "RNB" else "sales"
    if not rows or not any(isinstance(row.get(key), (int, float)) for row in rows):
        return None
    drawing = Drawing(750, 185)
    face = RUPEE_FONT or "Helvetica"
    left, bottom, width, height = 80, 30, 650, 120
    maximum = max((row.get(key) or 0 for row in rows), default=0)
    upper = max(1, ceil(maximum / max(1, 10 ** max(0, len(str(int(maximum))) - 1))) * max(1, 10 ** max(0, len(str(int(maximum))) - 1)))
    drawing.add(String(0, 170, f"{currency} sales trend", fontName=face, fontSize=10, fillColor=colors.HexColor("#101828")))
    for part in (0, .5, 1):
        y = bottom + height * part
        drawing.add(Line(left, y, left + width, y, strokeColor=colors.HexColor("#E2E6ED"), strokeWidth=.5))
        drawing.add(String(left - 8, y - 3, format_indian_money(upper * part), textAnchor="end", fontName=face, fontSize=8, fillColor=colors.HexColor("#475467")))
    # A missing amount breaks the line instead of drawing a fabricated zero.
    segment = []
    for index, row in enumerate(rows):
        if isinstance(row.get(key), (int, float)):
            segment.extend([left + width * index / max(1, len(rows) - 1), bottom + height * row[key] / upper])
        else:
            if len(segment) >= 4:
                drawing.add(PolyLine(segment, strokeColor=colors.HexColor("#" + ACCENT), strokeWidth=2))
            segment = []
    if len(segment) >= 4:
        drawing.add(PolyLine(segment, strokeColor=colors.HexColor("#" + ACCENT), strokeWidth=2))
    for index in sorted({0, len(rows) // 2, len(rows) - 1}):
        drawing.add(String(left + width * index / max(1, len(rows) - 1), 12, str(rows[index].get("label", "")), textAnchor="middle", fontName=face, fontSize=8, fillColor=colors.HexColor("#475467")))
    return drawing


def cell(value):
    if value is None:
        return "Unavailable"
    if isinstance(value, list):
        return "; ".join(str(item) for item in value)
    if isinstance(value, dict):
        return "; ".join(f"{key}: {item}" for key, item in value.items())
    return value


def report_sections(report, records=None, *, view="dashboard", scope="full", tab=None):
    result = []
    summary = report.get("kpis") or report.get("summary")
    if scope != "records" and summary:
        result.append(("Summary", [{"metric": key.replace("_", " "), "value": value} for key, value in summary.items()]))
    if "identity" in report and scope != "records":
        identity = report["identity"]
        result.append(("Identity", [{"field": "Stable ID", "value": identity["id"]}, {"field": "Name", "value": identity["name"]}, *[{"field": a["label"], "value": a["value"]} for a in identity.get("attributes", [])]]))
    if report.get("tables") and scope == "current" and tab == "overview":
        for name in ("trend", "floors", "companies", "architects", "products", "customers"):
            result.append((name.title(), report.get(name, [])))
    elif report.get("tables"):
        if scope == "records":
            table = report["tables"]["orders"]
            if table["total"] > len(table["items"]):
                raise HTTPException(422, "This export exceeds its row limit; narrow the filters")
            result.append(("Orders", table["items"]))
        else:
            if scope == "full":
                for name in ("trend", "floors", "companies", "architects", "products", "customers"):
                    result.append((name.title(), report.get(name, [])))
                for name, values in report.get("attribute_breakdowns", {}).items():
                    result.append((name.title() + " Analysis", values))
            for name, table in report["tables"].items():
                if scope == "current" and tab and name != tab:
                    continue
                if table["total"] > len(table["items"]):
                    raise HTTPException(422, "This export exceeds its row limit; narrow the filters")
                result.append((name.replace("_", " ").title(), table["items"]))
    elif "lines" in report:
        for name in ("lines", "payments", "timeline", "documents"):
            result.append((name.title(), report.get(name, [])))
    elif view in {"companies", "products", "architects", "customers", "records"}:
        result.append((view.title(), records or []))
    else:
        for name in ("trend", "floors", "companies", "architects", "products", "customers", "customer_segments"):
            result.append((name.replace("_", " ").title(), report.get(name, [])))
        for name, values in report.get("attribute_breakdowns", {}).items():
            result.append((name.title() + " Analysis", values))
        if records is not None:
            result.append(("Source Details", records))
    if sum(len(rows) for _, rows in result) > MAX_EXPORT_ROWS:
        raise HTTPException(422, "Export exceeds 10,000 rows; narrow the period, floor or entity filters")
    return result


def export_bytes(report, sections, fmt, metadata):
    if fmt == "xlsx":
        return workbook(report, sections, metadata)
    return pdf(report, sections, metadata)


def workbook(report, sections, metadata):
    wb = Workbook()
    ws = wb.active
    ws.title = "Report"
    for key, value in metadata.items():
        ws.append([spreadsheet_cell(key), spreadsheet_cell(str(cell(value)))])
    for insight in report.get("insights", []):
        ws.append(["Data brief", spreadsheet_cell(insight)])
    for note in report.get("coverage", {}).get("notes", report.get("notes", [])):
        ws.append(["Coverage", spreadsheet_cell(note)])
    for name, rows in sections:
        sheet = wb.create_sheet(name[:31])
        keys = list(dict.fromkeys(key for row in rows for key in row))
        sheet.append(keys or ["No matching records"])
        for row in rows:
            sheet.append([spreadsheet_cell(cell(row.get(key))) for key in keys])
            for index, key in enumerate(keys, 1):
                value = row.get(key)
                effective_key = row.get("metric", "").replace(" ", "_") if key == "value" else key
                target = sheet.cell(sheet.max_row, index)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    if effective_key in MONEY_FIELDS:
                        currency = "RNB" if effective_key.endswith("_rnb") or row.get("currency") == "RNB" else "INR"
                        target.number_format = f'"{currency} "#,##,##0.00;[Red]-"{currency} "#,##,##0.00'
                    elif effective_key.endswith("_pct"):
                        target.number_format = '0.00"%"'
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
        for header in sheet[1]:
            header.font = Font(bold=True, color="FFFFFF")
            header.fill = PatternFill("solid", fgColor=ACCENT)
        for column in sheet.columns:
            sheet.column_dimensions[column[0].column_letter].width = min(44, max(16, max(len(str(c.value or "")) for c in column[:100]) + 2))
        if name == "Trend" and len(rows) > 1:
            for position, (key, currency) in enumerate((("sales", "INR"), ("sales_rnb", "RNB"))):
                if key not in keys or not any(row.get(key) for row in rows):
                    continue
                chart = BarChart()
                chart.title = report.get("metric_label", "Confirmed sales") + f" ({currency})"
                chart.y_axis.title = currency
                chart.add_data(Reference(sheet, min_col=keys.index(key) + 1, min_row=1, max_row=len(rows) + 1), titles_from_data=True)
                if "label" in keys:
                    chart.set_categories(Reference(sheet, min_col=keys.index("label") + 1, min_row=2, max_row=len(rows) + 1))
                sheet.add_chart(chart, f"S{2 + position * 17}")
    ws.column_dimensions["A"].width = 30
    ws.column_dimensions["B"].width = 100
    data = BytesIO()
    wb.save(data)
    return data.getvalue()


def pdf(report, sections, metadata):
    blob = BytesIO()
    styles = getSampleStyleSheet()
    if RUPEE_FONT:
        for style in styles.byName.values():
            style.fontName = RUPEE_FONT
    small = styles["BodyText"]
    small.fontSize = 8
    small.leading = 11
    title = report.get("title") or "Sales analytics"
    story = [Paragraph(escape(str(title)), styles["Title"])]
    for key, value in metadata.items():
        story.append(Paragraph(f"<b>{escape(str(key))}</b>: {escape(str(cell(value)))}", small))
    story.append(Spacer(1, 12))
    for insight in report.get("insights", []):
        story.append(Paragraph(escape(insight), small))
    for note in report.get("coverage", {}).get("notes", report.get("notes", [])):
        story.append(Paragraph(escape(note), small))
    for name, rows in sections:
        story.extend([Spacer(1, 12), Paragraph(escape(name), styles["Heading2"])])
        if not rows:
            story.append(Paragraph("No matching recorded data.", small))
            continue
        if name == "Trend":
            for currency in ("INR", "RNB"):
                key = "sales_rnb" if currency == "RNB" else "sales"
                if currency == "RNB" and not any(row.get(key) for row in rows):
                    continue
                chart = trend_drawing(rows, currency)
                if chart:
                    story.append(chart)
        keys = list(dict.fromkeys(key for row in rows for key in row))
        # Keep all fields readable by continuing wide tables in labelled bands.
        for offset in range(0, len(keys), 6):
            band = keys[offset:offset + 6]
            if offset and "id" in keys and "id" not in band:
                band = ["id", *band]
            values = [[Paragraph(escape(key.replace("_", " ")), small) for key in band]]
            values.extend([[Paragraph(escape(display(row.get(key), row.get("metric", "").replace(" ", "_") if key == "value" else key, row.get("currency", "INR"))), small) for key in band] for row in rows])
            table = Table(values, repeatRows=1, colWidths=[750 / len(band)] * len(band), hAlign="LEFT", splitInRow=1)
            table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAF2FF")), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, 0), .5, colors.HexColor("#" + ACCENT)), ("BOTTOMPADDING", (0, 0), (-1, -1), 6), ("TOPPADDING", (0, 0), (-1, -1), 6)]))
            story.extend([table, Spacer(1, 8)])
    def footer(canvas, doc):
        canvas.setFont("Helvetica", 8)
        canvas.drawString(40, 20, "Buildcon House | Authorized sales analytics")
        canvas.drawRightString(800, 20, f"Page {doc.page}")
    SimpleDocTemplate(blob, pagesize=landscape(A4), rightMargin=40, leftMargin=40, topMargin=30, bottomMargin=35).build(story, onFirstPage=footer, onLaterPages=footer)
    return blob.getvalue()
