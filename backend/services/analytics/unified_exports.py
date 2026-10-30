"""Server-derived PDF and Excel exports of exactly the authorized report view."""
from __future__ import annotations

from io import BytesIO
from math import ceil, isfinite
from xml.sax.saxutils import escape

from fastapi import HTTPException
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Font, PatternFill
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.graphics.shapes import Circle, Drawing, Group, Line, PolyLine, Rect, String
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

from services.export import spreadsheet_cell
from services.money import format_indian_money
from pdf_generator import RUPEE_FONT

MAX_EXPORT_ROWS = 10_000
ACCENT = "22766D"
MONEY_FIELDS = {"sales", "sales_rnb", "average_order_value", "average_order_value_rnb", "collected", "outstanding", "collected_rnb", "outstanding_rnb", "unit_price", "line_total", "amount", "subtotal", "total", "discount", "tax", "taxes"}

PDF_MONEY_FIELDS = MONEY_FIELDS | {"previous_sales", "previous_sales_rnb"}
PDF_BAR_FIELDS = (PDF_MONEY_FIELDS - {"unit_price"}) | {"orders", "orders_inr", "orders_rnb", "customers", "known_customers", "products", "change_pct", "change_pct_rnb", "discount_pct", "tax_pct"}


def display(value, key="", currency="INR"):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if key in PDF_MONEY_FIELDS:
            return f"{'RNB' if key.endswith('_rnb') or currency == 'RNB' else 'INR'} {format_indian_money(value)}"
        if key.endswith("_pct") or key.endswith("_pct_rnb"):
            return f"{value:g}%"
    return str(cell(value))


# PDF colors follow the app's semantic surface/content/chart roles.
PDF_BLUE = colors.HexColor("#0066CC")
PDF_INK = colors.HexColor("#1D1D1F")
PDF_SECONDARY = colors.HexColor("#545458")
PDF_LINE = colors.HexColor("#E2E2E7")
PDF_WASH = colors.HexColor("#F5F5F7")
PDF_WIDTH = A4[0] - 72


def numeric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value)


def compact(value):
    if abs(value) >= 10_000_000:
        return f"{value / 10_000_000:.2f} Cr"
    if abs(value) >= 100_000:
        return f"{value / 100_000:.2f} L"
    if abs(value) >= 1000:
        return f"{value / 1000:.1f}k"
    return f"{value:g}"


def trend_drawing(rows, currency, width=PDF_WIDTH, metric_label="Sales"):
    """Same source rows as the readable table; gaps never become zeroes."""
    key = "sales_rnb" if currency == "RNB" else "sales"
    prior_key = "previous_sales_rnb" if currency == "RNB" else "previous_sales"
    if not rows or not any(numeric(row.get(key)) for row in rows):
        return None
    drawing = Drawing(width, 175)
    face = RUPEE_FONT or "Helvetica"
    left, bottom, plot_width, height = 48, 28, width - 65, 112
    values = [row[key] for row in rows if numeric(row.get(key))]
    values += [row[prior_key] for row in rows if numeric(row.get(prior_key))]
    maximum = max(0, *values)
    magnitude = 10 ** max(0, len(str(int(maximum))) - 1)
    upper = max(1, ceil(maximum / magnitude) * magnitude)
    lower = min(0, *values)
    span = upper - lower
    drawing.add(String(0, 159, f"{currency} sales trend", fontName=face, fontSize=10, fillColor=PDF_INK))
    drawing.add(String(width, 159, metric_label, textAnchor="end", fontName=face, fontSize=8, fillColor=PDF_SECONDARY))
    for part in (0, .5, 1):
        y = bottom + height * part
        drawing.add(Line(left, y, left + plot_width, y, strokeColor=PDF_LINE, strokeWidth=.5))
        drawing.add(String(left - 8, y - 3, compact(lower + span * part), textAnchor="end", fontName=face, fontSize=8, fillColor=PDF_SECONDARY))
    for field, tone, dashed in ((prior_key, PDF_SECONDARY, True), (key, PDF_BLUE, False)):
        segment = []
        for index, row in enumerate(rows):
            value = row.get(field)
            if numeric(value):
                x = left + plot_width * index / max(1, len(rows) - 1)
                y = bottom + height * (value - lower) / span
                segment.extend([x, y])
                if not dashed:
                    drawing.add(Circle(x, y, 2, fillColor=tone, strokeColor=colors.white, strokeWidth=.5))
            else:
                if len(segment) >= 4:
                    drawing.add(PolyLine(segment, strokeColor=tone, strokeWidth=1 if dashed else 2, strokeDashArray=[3, 3] if dashed else None))
                segment = []
        if len(segment) >= 4:
            drawing.add(PolyLine(segment, strokeColor=tone, strokeWidth=1 if dashed else 2, strokeDashArray=[3, 3] if dashed else None))
    for index in sorted({0, len(rows) // 2, len(rows) - 1}):
        drawing.add(String(left + plot_width * index / max(1, len(rows) - 1), 12, str(rows[index].get("label", ""))[:26], textAnchor="middle", fontName=face, fontSize=8, fillColor=PDF_SECONDARY))
    if any(numeric(row.get(prior_key)) for row in rows):
        drawing.add(String(left, 0, "Solid + dots: selected period   /   Dashed: preceding equal period", fontName=face, fontSize=7.5, fillColor=PDF_SECONDARY))
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
    furniture = report.get("filters", {}).get("floor_id") == "third-floor"
    inr_fields = {"sales", "average_order_value", "collected", "outstanding", "orders_inr", "previous_sales", "change_pct"}
    def visible(key, aggregate=False):
        if key.endswith("_rnb"):
            return furniture
        return not (furniture and aggregate and key in inr_fields)

    summary = report.get("kpis") or report.get("summary")
    if scope != "records" and summary:
        result.append(("Summary", [{"metric": key.replace("_", " "), "value": value} for key, value in summary.items() if visible(key, "sales_rnb" in summary)]))
        if not furniture and any(floor.get("currency") == "RNB" for floor in report.get("floors", [])):
            result.append(("Furniture ledger", [{"metric": key.replace("_", " "), "value": value} for key, value in summary.items() if key.endswith("_rnb")]))
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
    # Aggregate columns follow the visible currency; actual source records keep
    # their explicit currency, including Furniture rows in company-wide reports.
    result = [(name, [{key: value for key, value in row.items() if visible(key, "sales_rnb" in row)} for row in rows]) for name, rows in result]
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
        for row_number, row in enumerate(rows, 2):
            sheet.append([spreadsheet_cell(cell(row.get(key))) for key in keys])
            for index, key in enumerate(keys, 1):
                value = row.get(key)
                effective_key = row.get("metric", "").replace(" ", "_") if key == "value" else key
                target = sheet.cell(row_number, index)
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


def _label(key):
    return key.replace("_rnb", " (RNB)").replace("_", " ").capitalize()


def _fit_label(value, width, size=8):
    from reportlab.pdfbase.pdfmetrics import stringWidth
    value = str(value)
    face = RUPEE_FONT or "Helvetica"
    if stringWidth(value, face, size) <= width:
        return value
    while value and stringWidth(value + "...", face, size) > width:
        value = value[:-1]
    return value + "..."


def _bar(value, lower, upper, width):
    drawing = Drawing(width, 7)
    drawing.add(Rect(0, 1, width, 4, rx=2, ry=2, fillColor=PDF_LINE, strokeColor=None))
    if numeric(value) and upper > lower:
        zero = width * (0 - lower) / (upper - lower)
        point = width * (value - lower) / (upper - lower)
        drawing.add(Rect(min(zero, point), 1, abs(point - zero), 4, rx=2, ry=2, fillColor=PDF_BLUE, strokeColor=None))
        if lower < 0:
            drawing.add(Line(zero, 0, zero, 7, strokeColor=PDF_SECONDARY, strokeWidth=.5))
    return drawing


def _ledger(row, key):
    return "RNB" if key.endswith("_rnb") else row.get("currency", "INR")


def _comparison(rows, key, currency, width=PDF_WIDTH):
    selected = [row for row in rows if numeric(row.get(key)) and (key not in PDF_MONEY_FIELDS or _ledger(row, key) == currency)]
    selected = sorted(selected, key=lambda row: -abs(row[key]))[:6]
    if not selected:
        return None
    face = RUPEE_FONT or "Helvetica"
    drawing = Drawing(width, 36 + len(selected) * 32)
    heading = f"{currency} / {_label(key)}" if key in PDF_MONEY_FIELDS else _label(key)
    drawing.add(String(0, drawing.height - 12, heading, fontName=face, fontSize=10, fillColor=PDF_INK))
    drawing.add(String(width, drawing.height - 12, "Largest recorded values - independent scale", textAnchor="end", fontName=face, fontSize=7.5, fillColor=PDF_SECONDARY))
    lower, upper = min(0, *(row[key] for row in selected)), max(0, *(row[key] for row in selected))
    for index, row in enumerate(selected):
        y = drawing.height - 34 - index * 32
        name = next((row.get(k) for k in ("name", "label", "number", "customer_name", "id") if row.get(k)), "Recorded item")
        drawing.add(String(0, y, _fit_label(name, width - 165), fontName=face, fontSize=8.5, fillColor=PDF_INK))
        drawing.add(String(width, y, display(row[key], key, currency), textAnchor="end", fontName=face, fontSize=8.5, fillColor=PDF_INK))
        rail = _bar(row[key], lower, upper, width)
        group = Group(*rail.contents)
        group.translate(0, y - 11)
        drawing.add(group)
    return drawing


def _treemap(rows, name, currency, width=PDF_WIDTH):
    selected = sorted((row for row in rows if numeric(row.get("sales")) and row["sales"] > 0 and _ledger(row, "sales") == currency), key=lambda row: -row["sales"])[:6]
    if not selected:
        return None
    face = RUPEE_FONT or "Helvetica"
    drawing = Drawing(width, 176)
    drawing.add(String(0, 163, f"{name} / {currency} sales mix", fontName=face, fontSize=10, fillColor=PDF_INK))
    palette = [(PDF_BLUE, colors.white), (colors.HexColor("#EAF2FF"), PDF_INK), (colors.HexColor("#E5E5EA"), PDF_INK), (colors.HexColor("#004F9F"), colors.white), (colors.HexColor("#BED6F7"), PDF_INK), (PDF_WASH, PDF_INK)]
    def split(items, x, y, w, h):
        if len(items) == 1:
            index, row = items[0]
            background, foreground = palette[index % len(palette)]
            drawing.add(Rect(x + 1, y + 1, max(0, w - 2), max(0, h - 2), rx=5, ry=5, fillColor=background, strokeColor=colors.white, strokeWidth=1))
            if w > 30 and h > 28:
                drawing.add(String(x + 8, y + h - 17, _fit_label(row.get("name", row.get("id", "Recorded item")), w - 16), fontName=face, fontSize=8, fillColor=foreground))
                drawing.add(String(x + 8, y + h - 31, _fit_label(compact(row["sales"]), w - 16, 10), fontName=face, fontSize=10, fillColor=foreground))
            return
        total = sum(row["sales"] for _, row in items)
        cut = min(range(1, len(items)), key=lambda n: abs(sum(row["sales"] for _, row in items[:n]) - total / 2))
        ratio = sum(row["sales"] for _, row in items[:cut]) / total
        if w >= h:
            split(items[:cut], x, y, w * ratio, h)
            split(items[cut:], x + w * ratio, y, w * (1 - ratio), h)
        else:
            split(items[:cut], x, y, w, h * ratio)
            split(items[cut:], x, y + h * ratio, w, h * (1 - ratio))
    split(list(enumerate(selected)), 0, 20, width, 130)
    drawing.add(String(0, 5, "Area = positive recorded sales among the top six shown. Unknown and nonpositive amounts are unplotted.", fontName=face, fontSize=7, fillColor=PDF_SECONDARY))
    return drawing


def _ledger_card(summary, currency, width, metric_label):
    face = RUPEE_FONT or "Helvetica"
    suffix = "_rnb" if currency == "RNB" else ""
    drawing = Drawing(width, 154)
    drawing.add(Rect(0, 0, width, 154, rx=12, ry=12, fillColor=PDF_WASH, strokeColor=None))
    drawing.add(String(14, 133, f"{currency} / {metric_label}", fontName=face, fontSize=9, fillColor=PDF_SECONDARY))
    sales = summary.get("sales" + suffix)
    drawing.add(String(14, 105, compact(sales) if numeric(sales) else "Unavailable", fontName=face, fontSize=24, fillColor=PDF_INK))
    if numeric(sales):
        drawing.add(String(14, 89, display(sales, "sales" + suffix), fontName=face, fontSize=8.5, fillColor=PDF_SECONDARY))
    received, balance = summary.get("collected" + suffix), summary.get("outstanding" + suffix)
    valid = numeric(received) and numeric(balance) and min(received, balance) >= 0 and received + balance > 0
    drawing.add(String(14, 69, "Recorded receipts / current balance", fontName=face, fontSize=8, fillColor=PDF_SECONDARY))
    drawing.add(Rect(14, 54, width - 28, 6, rx=3, ry=3, fillColor=PDF_LINE, strokeColor=None))
    if valid:
        drawing.add(Rect(14, 54, (width - 28) * received / (received + balance), 6, rx=3, ry=3, fillColor=PDF_BLUE, strokeColor=None))
    drawing.add(String(14, 37, f"Received: {compact(received) if numeric(received) else 'Unavailable'}", fontName=face, fontSize=8.5, fillColor=PDF_INK))
    drawing.add(String(14, 22, f"Balance: {compact(balance) if numeric(balance) else 'Unavailable'}", fontName=face, fontSize=8.5, fillColor=PDF_INK))
    drawing.add(String(14, 8, "Bar = receipt / (receipt + balance)" if valid else "Mix unavailable for these recorded values", fontName=face, fontSize=6.8, fillColor=PDF_SECONDARY))
    return drawing


def _summary_scale(summary, key):
    if key not in {"collected", "outstanding", "collected_rnb", "outstanding_rnb"}:
        return None
    suffix = "_rnb" if key.endswith("_rnb") else ""
    receipts, balance = summary.get("collected" + suffix), summary.get("outstanding" + suffix)
    if numeric(receipts) and numeric(balance) and min(receipts, balance) >= 0:
        total = receipts + balance
        if numeric(total) and total > 0:
            return 0, total
    return None


def pdf(report, sections, metadata):
    blob = BytesIO()
    styles = getSampleStyleSheet()
    face = RUPEE_FONT or "Helvetica"
    for style in styles.byName.values():
        style.fontName = face
    styles.add(ParagraphStyle("ReportTitle", fontName=face, fontSize=25, leading=30, textColor=PDF_INK, spaceAfter=10))
    styles.add(ParagraphStyle("SectionTitle", fontName=face, fontSize=14, leading=18, textColor=PDF_INK, spaceBefore=15, spaceAfter=8, keepWithNext=True))
    styles.add(ParagraphStyle("SmallReport", fontName=face, fontSize=8, leading=11, textColor=PDF_SECONDARY, spaceAfter=3, wordWrap="CJK"))
    styles.add(ParagraphStyle("DetailCaption", parent=styles["SmallReport"], keepWithNext=True))
    styles.add(ParagraphStyle("CellReport", fontName=face, fontSize=8, leading=11, textColor=PDF_INK, wordWrap="CJK"))
    small, body = styles["SmallReport"], styles["CellReport"]
    para = lambda value, style=body: Paragraph(escape(str(value)), style)
    title = report.get("title") or "Sales analytics"
    summary = {row.get("metric", "").replace(" ", "_"): row.get("value") for name, rows in sections if name in {"Summary", "Furniture ledger"} for row in rows}
    story = [para(title, styles["ReportTitle"])]
    context = [str(metadata[key]) for key in ("Period", "Date basis", "Export view", "Export scope") if metadata.get(key)]
    if context:
        story.extend([para(" / ".join(context), small), Spacer(1, 10)])
    currencies = [currency for currency, key in (("INR", "sales"), ("RNB", "sales_rnb")) if key in summary]
    if currencies:
        gap = 10
        width = (PDF_WIDTH - gap * (len(currencies) - 1)) / len(currencies)
        cards = [_ledger_card(summary, currency, width, report.get("metric_label", "Confirmed sales")) for currency in currencies]
        contents = []
        widths = []
        for card in cards:
            if contents:
                contents.append("")
                widths.append(gap)
            contents.append(card)
            widths.append(width)
        table = Table([contents], colWidths=widths)
        table.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
        story.extend([table, Spacer(1, 10)])
    # The overview uses only sections requested by the caller; record-only and
    # current-tab exports never gain hidden dashboard totals or charts.
    trend_rows = next((rows for name, rows in sections if name == "Trend"), [])
    for currency in currencies or ["INR", "RNB"]:
        key = "sales_rnb" if currency == "RNB" else "sales"
        if currency == "RNB" and not any(numeric(row.get(key)) and row[key] != 0 for row in trend_rows):
            continue
        chart = trend_drawing(trend_rows, currency, metric_label=report.get("metric_label", "Confirmed sales"))
        if chart:
            story.extend([chart, Spacer(1, 12)])
    for name in ("Companies", "Floors", "Products"):
        mix_rows = next((rows for section, rows in sections if section == name), [])
        currency = "RNB" if report.get("filters", {}).get("floor_id") == "third-floor" else "INR"
        mix = _treemap(mix_rows, name, currency)
        if mix:
            story.extend([mix, Spacer(1, 10)])
            break
    for insight in report.get("insights", []):
        story.append(para(insight, small))
    empty_sections = []
    for name, rows in sections:
        if not rows:
            empty_sections.append(name)
            continue
        story.append(para(name, styles["SectionTitle"]))
        if name in {"Summary", "Furniture ledger"}:
            cards = []
            for row in rows:
                key, value = row.get("metric", "").replace(" ", "_"), row.get("value")
                content = [para(_label(key), small), para(display(value, key))]
                scale = _summary_scale(summary, key)
                if scale:
                    content.append(_bar(value, *scale, PDF_WIDTH / 3 - 20))
                cards.append(content)
            grid = [cards[index:index + 3] for index in range(0, len(cards), 3)]
            grid[-1] += [""] * (3 - len(grid[-1]))
            tiles = Table(grid, colWidths=[PDF_WIDTH / 3] * 3, hAlign="LEFT")
            tiles.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), PDF_WASH), ("BOX", (0, 0), (-1, -1), .5, colors.white), ("INNERGRID", (0, 0), (-1, -1), 4, colors.white), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10), ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
            story.append(tiles)
            continue
        keys = list(dict.fromkeys(key for row in rows for key in row))
        if name not in {"Summary", "Furniture ledger", "Identity", "Trend"}:
            measure = next((key for key in ("sales", "line_total", "amount", "total", "orders", "customers") if key in keys), None)
            if measure:
                for currency in ("INR", "RNB") if measure in MONEY_FIELDS else ("INR",):
                    chart = _comparison(rows, measure, currency)
                    if chart:
                        story.append(chart)
                if "sales_rnb" in keys and any(numeric(row.get("sales_rnb")) and row["sales_rnb"] != 0 for row in rows):
                    chart = _comparison(rows, "sales_rnb", "RNB")
                    if chart:
                        story.append(chart)
        identity = next((key for key in ("name", "number", "label", "metric", "field", "id", "review_id") if key in keys), keys[0])
        rest = [key for key in keys if key != identity]
        bands = [[identity, *rest[offset:offset + 3]] for offset in range(0, len(rest), 3)] or [[identity]]
        for index, band in enumerate(bands):
            if len(bands) > 1:
                story.append(para(f"{name} / detail columns {index + 1} of {len(bands)} / {len(rows)} recorded rows", styles["DetailCaption"]))
            widths = [PDF_WIDTH / len(band)] * len(band)
            bounds = {}
            for key in band:
                if key not in PDF_BAR_FIELDS:
                    continue
                for currency in ("INR", "RNB"):
                    amounts = [row[key] for row in rows if numeric(row.get(key)) and (key not in PDF_MONEY_FIELDS or _ledger(row, key) == currency)]
                    if amounts:
                        bounds[key, currency] = (min(0, *amounts), max(0, *amounts))
            values = [[para(_label(key)) for key in band]]
            for row in rows:
                cells = []
                for column, key in enumerate(band):
                    effective = row.get("metric", "").replace(" ", "_") if key == "value" else key
                    value = row.get(key)
                    content = para(display(value, effective, row.get("currency", "INR")))
                    # Embedded bars carry magnitude through continuation pages;
                    # each column is scaled independently, with exact text kept.
                    scale = bounds.get((key, _ledger(row, key)))
                    if key != identity and scale and numeric(value) and key != "value":
                        content = [content, _bar(value, *scale, widths[column] - 14)]
                    cells.append(content)
                values.append(cells)
            table = Table(values, repeatRows=1, colWidths=widths, hAlign="LEFT", splitInRow=1)
            table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), PDF_WASH), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, 0), .6, PDF_LINE), ("LINEBELOW", (0, 1), (-1, -1), .3, PDF_LINE), ("BOTTOMPADDING", (0, 0), (-1, -1), 6), ("TOPPADDING", (0, 0), (-1, -1), 6), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7)]))
            story.extend([table, Spacer(1, 8)])
    if empty_sections:
        story.append(para("No matching recorded data: " + ", ".join(empty_sections) + ".", small))
    notes = report.get("coverage", {}).get("notes", report.get("notes", []))
    story.append(para("Scope and data coverage", styles["SectionTitle"]))
    story.append(para("Bars compare recorded values within each column or chart. INR and Furniture RNB are independent ledgers. Unavailable values are never plotted as zero.", small))
    for note in notes:
        story.append(para(note, small))
    for key, value in metadata.items():
        story.append(para(f"{key}: {cell(value)}", small))
    def page_chrome(canvas, doc):
        canvas.saveState()
        canvas.setTitle(str(title))
        canvas.setAuthor("Buildcon House")
        canvas.setFont(face, 8)
        canvas.setFillColor(PDF_SECONDARY)
        canvas.drawString(36, A4[1] - 25, "BUILDCON HOUSE / SALES INTELLIGENCE")
        canvas.drawRightString(A4[0] - 36, A4[1] - 25, "A4 / Authorized report")
        canvas.setStrokeColor(PDF_LINE)
        canvas.line(36, A4[1] - 34, A4[0] - 36, A4[1] - 34)
        canvas.line(36, 34, A4[0] - 36, 34)
        canvas.setFont(face, 7)
        canvas.drawString(36, 22, "INR / RNB shown separately. Unavailable is not zero.")
        canvas.drawRightString(A4[0] - 36, 22, f"Page {doc.page}")
        canvas.restoreState()
    SimpleDocTemplate(blob, pagesize=A4, rightMargin=36, leftMargin=36, topMargin=48, bottomMargin=46, allowSplitting=True).build(story, onFirstPage=page_chrome, onLaterPages=page_chrome)
    return blob.getvalue()
