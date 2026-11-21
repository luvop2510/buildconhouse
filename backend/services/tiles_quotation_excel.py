"""Render the saved Ground Floor Tiles quotation as an Excel workbook."""
from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from services.pricing import saved_tile_unit_price
from services.product_display import tile_product_name
from services.tile_transportation import transportation_details


_RUPEES = '"₹"#,##0.00'
_HEADERS = (
    "SR. NO.", "AREA", "PRODUCT DETAIL", "SIZE", "FINISH", "SQ. FT. / BOX",
    "BASE RATE / SQ. FT.", "OFFER RATE", "RATE / BOX", "QUANTITY", "UNIT", "AMOUNT",
)
_WIDTHS = (9, 20, 34, 17, 18, 14, 17, 22, 17, 12, 10, 19)


def _write_row(sheet, index, values):
    row = []
    for column, value in enumerate(values, 1):
        cell = sheet.cell(index, column, value)
        # Preserve saved text as a literal, even when it starts with '='.
        if isinstance(value, str):
            cell.data_type = "s"
        row.append(cell)
    return row


def build_tiles_quotation_excel(doc: dict, customer: dict) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Tiles Quotation"

    sheet["A1"] = "TILES QUOTATION"
    sheet["A1"].font = Font(size=16, bold=True)
    _write_row(sheet, 2, (
        "Customer", doc.get("customer_name") or customer.get("name"),
        "Quotation", doc.get("doc_number") or doc.get("number"),
        "Date", doc.get("doc_date") or doc.get("created_at"),
    ))
    _write_row(sheet, 3, ("Address", doc.get("address_snapshot"), None, "Phone", doc.get("phone_snapshot")))
    sheet.merge_cells("B3:C3")
    sheet.row_dimensions[3].height = 30
    sheet["B3"].alignment = Alignment(wrap_text=True, vertical="center")

    header_row = 4
    header = _write_row(sheet, header_row, _HEADERS)
    for index, (cell, width) in enumerate(zip(header, _WIDTHS, strict=True), 1):
        sheet.column_dimensions[get_column_letter(index)].width = width
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="28323C")
        cell.alignment = Alignment(wrap_text=True, vertical="center")
    sheet.row_dimensions[header_row].height = 30
    sheet.freeze_panes = f"A{header_row + 1}"
    sheet.print_title_rows = f"{header_row}:{header_row}"

    items = doc.get("items") or []
    for index, item in enumerate(items, 1):
        piece = str(item.get("quantity_unit") or "").strip().lower() in {"piece", "pieces", "pc", "pcs"}
        size = item.get("size")
        per_sqft = not piece and item.get("price_basis") != "box"
        base = item.get("rate_sqft") if per_sqft else None
        unit_price = saved_tile_unit_price(item, per_piece=piece)
        offer = item.get("offer_rate")
        if per_sqft:
            offer = offer if offer is not None else base
        else:
            offer = unit_price
        amount = item.get("net_amount")
        if amount is None and unit_price is not None and item.get("qty") is not None:
            amount = round(float(item["qty"]) * unit_price * (1 - float(item.get("discount_pct") or 0) / 100), 2)
        row = _write_row(sheet, header_row + index, (
            index, item.get("room") or item.get("area"), tile_product_name(item.get("name"), size),
            size, item.get("finish"), None if piece else item.get("box_sqft"),
            base, offer, None if piece else unit_price, item.get("qty"), "Piece" if piece else "Box",
            amount,
        ))
        for column in (1, 2, 3, 4):
            row[column].alignment = Alignment(wrap_text=True, vertical="center")
        for column in (6, 7, 8, 11):
            row[column].number_format = _RUPEES
        if piece:
            row[7].number_format += '" / piece"'
        elif item.get("price_basis") == "box":
            row[7].number_format += '" / box"'
        else:
            row[7].number_format += '" / sq. ft."'

    # These document totals already reflect the saved pricing and transportation.
    summary_row = header_row + len(items) + 1
    transport_status, transport_amount, transport_note = transportation_details(doc)
    if transport_status or transport_note:
        row = _write_row(sheet, summary_row, (
            "Transportation", None, transport_status, None, transport_note or None, *(None,) * 6, transport_amount,
        ))
        for start, end in (("A", "B"), ("C", "D"), ("E", "K")):
            sheet.merge_cells(f"{start}{summary_row}:{end}{summary_row}")
        for index in (0, 2, 4, 11):
            row[index].alignment = Alignment(wrap_text=True, vertical="center")
        row[0].font = Font(bold=True)
        row[11].number_format = _RUPEES
        note_lines = sum(max(1, (len(line) + 99) // 100) for line in transport_note.splitlines())
        sheet.row_dimensions[summary_row].height = min(400, 15 * max(2, note_lines + 1))
        summary_row += 1
        transport_amount = None
    for label, amount in (
        ("Transportation", transport_amount),
        ("Subtotal", doc.get("subtotal")),
        ("Discount", doc.get("discount_total") or None),
        ("Grand Total", doc.get("grand_total")),
    ):
        if amount is None:
            continue
        row = _write_row(sheet, summary_row, (None,) * 9 + (label, None, amount))
        sheet.merge_cells(f"J{summary_row}:K{summary_row}")
        row[9].font = Font(bold=True)
        row[11].font = Font(bold=True)
        row[11].number_format = _RUPEES
        summary_row += 1

    sheet.sheet_properties.pageSetUpPr.fitToPage = True
    sheet.page_setup.orientation = sheet.ORIENTATION_LANDSCAPE
    sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0

    with BytesIO() as output:
        workbook.save(output)
        return output.getvalue()
