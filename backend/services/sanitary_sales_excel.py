"""Excel workbook built from the same ledger and report order as the page."""
from __future__ import annotations

from datetime import date
from io import BytesIO

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

from services.export import spreadsheet_cell
from services.sanitary_sales import (
    INTERIOR_REPORTS, REPORT_TITLES, coverage_notes, line_row, ordered_documents, report_groups, sorted_groups,
)

_CURRENCY = '[$₹-4009]#,##,##0.00'
_METRICS = (
    ("customer_count", "Customers", 14), ("document_count", "Documents", 14),
    ("value", "Selected value (INR)", 24), ("mrp_value", "MRP value (INR)", 22),
    ("offer_value", "Offer value (INR)", 22), ("missing_value_lines", "Lines missing selected price", 30),
    ("missing_mrp_lines", "Lines missing MRP", 23), ("missing_offer_lines", "Lines missing offer", 23),
)
_PRODUCT = (
    ("brand", "Brand", 22), ("sku", "Article number", 22), ("size", "Size", 20),
    ("finish", "Finish", 22), ("unit", "Unit", 16), ("quantity", "Quantity", 14),
)
_DETAIL = (
    ("document_id", "Document ID", 29), ("number", "Quotation number", 23),
    ("date", "Report date", 17), ("quotation_date", "Quotation date", 17),
    ("customer_id", "Customer ID", 29), ("customer_name", "Customer", 31),
    ("contact", "Contact", 20), ("interior", "Interior / architect", 29),
    ("interior_id", "Interior / architect ID", 27), ("status", "Status", 19),
    ("id", "Line ID", 23), ("name", "Product", 40), *_PRODUCT,
    ("value", "Selected value (INR)", 24), ("mrp_value", "MRP value (INR)", 22),
    ("offer_value", "Offer value (INR)", 22),
)
_PRICE_KEYS = {"value", "mrp_value", "offer_value"}


def _cell(sheet, value, *, number_format=None, heading=False):
    if isinstance(value, str):
        value = spreadsheet_cell(ILLEGAL_CHARACTERS_RE.sub("", value))[:32767]
    cell = WriteOnlyCell(sheet, value=value)
    if heading:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="0066CC")
    if number_format:
        cell.number_format = number_format
    return cell


def _sheet(workbook, name, columns):
    sheet = workbook.create_sheet(name)
    sheet.freeze_panes = "A2"
    for index, (_, _, width) in enumerate(columns, 1):
        sheet.column_dimensions[get_column_letter(index)].width = width
    sheet.append([_cell(sheet, label, heading=True) for _, label, _ in columns])
    return sheet


def _append(sheet, row, columns):
    cells = []
    for key, _, _ in columns:
        value = row.get(key)
        number_format = _CURRENCY if key in _PRICE_KEYS else None
        if key in {"date", "quotation_date"} and value:
            value = date.fromisoformat(value)
            number_format = "dd mmm yyyy"
        cells.append(_cell(sheet, value, number_format=number_format))
    sheet.append(cells)


def _details(document, basis):
    common = {
        "document_id": document["id"], "number": document["number"], "date": document["date"],
        "quotation_date": document["quotation_date"], "customer_name": document["customer_name"],
        "customer_id": document["customer_id"] if document["customer_identity_known"] else None,
        "interior": document["interior_name"] or "Unassigned",
        "interior_id": document["interior_id"], "contact": document["phone"], "status": document["status"],
    }
    if not document["lines"]:
        yield common
    for line in document["lines"]:
        yield {**common, **line_row(line, basis)}


def workbook_bytes(ledger, report, basis, sort, window, brand, preset) -> bytes:
    workbook = Workbook(write_only=True)
    dimension, groups = report_groups(ledger, report)
    if report == "products":
        identity = ("name", "Product", 40)
        attributes = _PRODUCT
    else:
        identity = ("name", "Interior / architect" if report in INTERIOR_REPORTS else "Customer", 36)
        attributes = (("brands", "Companies", 36), ("statuses", "Statuses", 22))
    count_label = "Quotations" if report.startswith("pending") else "Placed orders"
    metrics = tuple((key, count_label if key == "document_count" else label, width) for key, label, width in _METRICS)
    summary_columns = (identity, *attributes, *metrics, ("id", "Report group ID", 33))
    summary = _sheet(workbook, "Summary", summary_columns)
    detail_columns = (("group_id", "Report group ID", 33), *_DETAIL)
    details = _sheet(workbook, "Details", detail_columns)
    filters = _sheet(workbook, "Filters", (("key", "Filter or total", 34), ("label", "Value", 65)))
    rows = sorted_groups(groups, dimension, basis, sort)
    detail_count = 0
    for row in rows:
        _append(summary, {**row, "brands": ", ".join(row["brands"]), "statuses": ", ".join(row["statuses"])}, summary_columns)
        for document in ordered_documents(groups[row["id"]]):
            for detail in _details(document, basis):
                _append(details, {"group_id": row["id"], **detail}, detail_columns)
                detail_count += 1
    summary.auto_filter.ref = f"A1:{get_column_letter(len(summary_columns))}{len(rows) + 1}"
    details.auto_filter.ref = f"A1:{get_column_letter(len(detail_columns))}{detail_count + 1}"
    price_label = "MRP" if basis == "mrp" else "Offer Price"
    filter_rows = (
        ("Report", REPORT_TITLES[report]), ("Floor", "The Sanitary Bathroom"), ("Company", brand),
        ("Date filter", preset.replace("_", " ").capitalize()), ("Start date", window.first), ("End date", window.last),
        ("Date basis", "Quotation date" if report.startswith("pending") else "Order placement date"),
        ("Business timezone", "Asia/Kolkata"), ("Value basis", price_label), ("Sorted by", sort.title()),
    )
    for label, value in filter_rows:
        filters.append([_cell(filters, label), _cell(filters, value, number_format="dd mmm yyyy" if isinstance(value, date) else None)])
    totals = ledger.metrics(basis)
    for key, label, _ in metrics:
        filters.append([_cell(filters, "Total " + label.lower()), _cell(filters, totals[key], number_format=_CURRENCY if key in _PRICE_KEYS else None)])
    for note in coverage_notes(ledger, basis, totals, both_prices=True):
        filters.append([_cell(filters, "Data coverage"), _cell(filters, note)])
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()
