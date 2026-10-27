"""Chalan (Delivery Release Receipt) PDF — proof that ordered tile material
has been released from the supplier's factory. Generated fresh on every
request from a PurchaseOrder's embedded Chalan subdocument, the same way
quotation PDFs are generated on demand with nothing persisted to storage
(see routes/quotation_routes.py::quotation_pdf).
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Flowable, HRFlowable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from services.money import format_indian_money

from pdf_generator import LANDSCAPE_A4, LOGO_PATH, _escape, brand_partners_table  # noqa: F401 — LOGO_PATH kept for parity with pdf_tiles imports
from pdf_tiles import DEFAULT_ADDRESS, DEFAULT_EMAIL, DEFAULT_MOBILE, _logo_flowable, _rupee

INK = colors.HexColor("#111111")
GRID_BLACK = colors.HexColor("#000000")
HEADER_GREY = colors.HexColor("#D3D3D3")


def _first_value(*values: object, default: object = "—") -> object:
    """Return the first populated snapshot without discarding numeric zero."""
    return next((value for value in values if value is not None and value != ""), default)


def _decimal(value: object) -> Decimal | None:
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return number if number.is_finite() else None


def _quantity(value: object) -> str:
    number = _decimal(value)
    if number is None:
        return "—"
    return f"{number:,.3f}".rstrip("0").rstrip(".")


def _quantity_unit_label(value: object) -> str:
    """Use the customer-facing singular label for the chalan quantity unit."""
    return "Piece" if str(value or "").strip().lower() in {"pcs", "pc", "piece", "pieces"} else "Box"


def _money(value: object) -> str:
    number = _decimal(value)
    return format_indian_money(number) if number is not None else "—"


def _display_date(*values: object) -> str:
    for value in values:
        if value is None or value == "":
            continue
        raw = str(value)
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).strftime("%d-%m-%Y")
        except ValueError:
            return raw[:10] or "—"
    return "—"


def chalan_pdf_filename(chalan: dict, customer_name: str) -> str:
    """`CH-1052 Nileshbhai Pokiya 22-07-2026.pdf`."""
    created = (chalan.get("created_at") or "").replace("Z", "+00:00")
    try:
        stamp = datetime.fromisoformat(created).strftime("%d-%m-%Y")
    except ValueError:
        stamp = datetime.now().strftime("%d-%m-%Y")
    name = " ".join((customer_name or "Customer").split())
    safe = "".join(ch for ch in f"{chalan.get('number', 'CH')} {name} {stamp}" if ch not in '\\/:*?"<>|')
    return f"{safe}.pdf"


def build_chalan_pdf(chalan: dict, po: dict, customer: dict, branding: dict | None = None) -> bytes:
    b = branding or {}
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=LANDSCAPE_A4, leftMargin=12 * mm, rightMargin=12 * mm,
        topMargin=10 * mm, bottomMargin=12 * mm,
        title=f"Chalan {chalan.get('number', '')}",
        author=b.get("footer_company_name") or "Buildcon House",
    )
    base = getSampleStyleSheet()
    styles = {
        "title": ParagraphStyle("chalanTitle", parent=base["Title"], fontName="Helvetica-Bold", fontSize=16, leading=19, textColor=INK, alignment=1),
        "label": ParagraphStyle("label", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=9.5, leading=13, textColor=INK),
        "value": ParagraphStyle("value", parent=base["Normal"], fontName="Helvetica", fontSize=9.5, leading=13, textColor=INK),
        "section": ParagraphStyle("chalanSection", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=9.5, leading=12, textColor=INK, spaceAfter=2),
        "tableHead": ParagraphStyle("tableHead", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=6.7, leading=8, textColor=INK, alignment=1),
        "cell": ParagraphStyle("cell", parent=base["Normal"], fontName="Helvetica", fontSize=7.2, leading=8.6, textColor=INK, alignment=1),
        "cellLeft": ParagraphStyle("cellLeft", parent=base["Normal"], fontName="Helvetica", fontSize=7.2, leading=8.6, textColor=INK),
        "cellRight": ParagraphStyle("cellRight", parent=base["Normal"], fontName="Helvetica", fontSize=7.2, leading=8.6, textColor=INK, alignment=2),
        "tableTotal": ParagraphStyle("tableTotal", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=7.5, leading=9, textColor=INK, alignment=2),
        "footerLabel": ParagraphStyle("footerLabel", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=9, leading=12, textColor=INK),
        "signature": ParagraphStyle("chalanSignature", parent=base["Normal"], fontName="Helvetica", fontSize=8.5, leading=13, textColor=INK),
        "footerNote": ParagraphStyle("footerNote", parent=base["Normal"], fontName="Helvetica", fontSize=7.6, leading=10, textColor=colors.HexColor("#555555"), alignment=1),
    }

    story: list[Flowable] = []
    story.append(_logo_flowable(60))
    story.append(Spacer(1, 2 * mm))
    story.append(Paragraph("CHALAN", styles["title"]))
    story.append(HRFlowable(width="100%", thickness=1.2, color=INK, spaceBefore=1 * mm, spaceAfter=3 * mm))
    story.append(brand_partners_table(styles["cell"], col_width_mm=doc.width / mm / 6, row_height_mm=8))
    story.append(Spacer(1, 2 * mm))

    customer_name = _first_value(
        po.get("customer_name"), customer.get("company"), customer.get("name"), default="Customer",
    )
    customer_address = ", ".join(
        str(value).strip()
        for value in (
            customer.get("address"), customer.get("city"), customer.get("state"), customer.get("pincode"),
        )
        if value is not None and str(value).strip()
    ) or str(_first_value(po.get("customer_address"), po.get("address_snapshot"), default="—"))
    dispatch_date = _display_date(chalan.get("dispatched_at"), chalan.get("dispatch_date"), chalan.get("created_at"))

    header_rows = [
        [Paragraph("CHALAN NO.", styles["label"]), Paragraph(_escape(_first_value(chalan.get("number"))), styles["value"]),
         Paragraph("DISPATCH DATE", styles["label"]), Paragraph(_escape(dispatch_date), styles["value"])],
        [Paragraph("ORDER NO.", styles["label"]), Paragraph(_escape(_first_value(po.get("number"), po.get("order_number"))), styles["value"]),
         Paragraph("REFERENCE", styles["label"]), Paragraph(_escape(_first_value(chalan.get("reference_number"))), styles["value"])],
        [Paragraph("CUSTOMER", styles["label"]), Paragraph(_escape(customer_name), styles["value"]),
         Paragraph("SUPPLIER", styles["label"]), Paragraph(_escape(_first_value(po.get("supplier_name"))), styles["value"])],
        [Paragraph("ADDRESS", styles["label"]), Paragraph(_escape(customer_address), styles["value"]), "", ""],
        [Paragraph("PHONE", styles["label"]), Paragraph(_escape(_first_value(customer.get("phone"), po.get("customer_phone"))), styles["value"]), "", ""],
    ]
    header = Table(header_rows, colWidths=[28 * mm, 65 * mm, 28 * mm, 65 * mm])
    header.setStyle(TableStyle([
        ("SPAN", (1, 3), (3, 3)), ("SPAN", (1, 4), (3, 4)),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.35, colors.HexColor("#BBBBBB")),
        ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.extend([header, Spacer(1, 5 * mm)])

    head = [
        Paragraph("SR", styles["tableHead"]), Paragraph("BRAND", styles["tableHead"]),
        Paragraph("PRODUCT", styles["tableHead"]), Paragraph("SIZE", styles["tableHead"]),
        Paragraph("FINISH", styles["tableHead"]), Paragraph("QTY", styles["tableHead"]),
        Paragraph("BOX / PIECES", styles["tableHead"]), Paragraph("RATE", styles["tableHead"]),
        Paragraph("TOTAL", styles["tableHead"]),
    ]
    rows: list[list[object]] = [head]
    po_items = {item.get("id"): item for item in (po.get("items") or []) if item.get("id")}
    grand_total: Decimal | None = None
    has_incomplete_pricing = False
    for index, item in enumerate(chalan.get("items") or [], 1):
        source = po_items.get(item.get("po_item_id"), {})
        qty_value = _first_value(item.get("qty"), item.get("quantity"), default=None)
        qty = _decimal(qty_value)
        rate = _decimal(_first_value(
            item.get("rate"), item.get("unit_rate"), item.get("unit_cost"),
            source.get("rate"), source.get("unit_rate"), source.get("unit_cost"), default=None,
        ))
        explicit_total = _decimal(_first_value(item.get("total"), item.get("line_total"), default=None))
        line_total = explicit_total if explicit_total is not None else (qty * rate if qty is not None and rate is not None else None)
        if rate is None or line_total is None:
            has_incomplete_pricing = True
        if line_total is not None:
            grand_total = (grand_total or Decimal("0")) + line_total
        rows.append([
            Paragraph(str(index), styles["cell"]),
            Paragraph(_escape(_first_value(item.get("brand"), item.get("brand_name"), source.get("brand"), source.get("brand_name"), po.get("brand_name"))), styles["cellLeft"]),
            Paragraph(_escape(_first_value(item.get("name"), item.get("product_name"), source.get("name"), source.get("product_name"))), styles["cellLeft"]),
            Paragraph(_escape(_first_value(item.get("size"), source.get("size"))), styles["cell"]),
            Paragraph(_escape(_first_value(item.get("finish"), source.get("finish"))), styles["cell"]),
            Paragraph(_escape(_quantity(qty_value)), styles["cellRight"]),
            Paragraph(_quantity_unit_label(_first_value(item.get("unit"), source.get("unit"), source.get("quantity_unit"), default="Box")), styles["cell"]),
            Paragraph(_rupee(rate) if rate is not None else "—", styles["cellRight"]),
            Paragraph(_rupee(line_total) if line_total is not None else "—", styles["cellRight"]),
        ])
    if len(rows) == 1:
        rows.append([Paragraph("No products listed", styles["cellLeft"]), "", "", "", "", "", "", "", ""])
    grand_total_label = "GRAND TOTAL (INCOMPLETE)" if has_incomplete_pricing else "GRAND TOTAL"
    grand_total_value = None if has_incomplete_pricing else grand_total
    rows.append(["", "", "", "", "", "", "", Paragraph(grand_total_label, styles["tableTotal"]), Paragraph(_rupee(grand_total_value) if grand_total_value is not None else "—", styles["tableTotal"])])
    table = Table(
        rows,
        colWidths=[8 * mm, 18 * mm, 40 * mm, 18 * mm, 18 * mm, 13 * mm, 16 * mm, 25 * mm, 30 * mm],
        repeatRows=1,
    )
    table_commands = [
        ("GRID", (0, 0), (-1, -1), 0.9, GRID_BLACK),
        ("BACKGROUND", (0, 0), (-1, 0), HEADER_GREY),
        ("SPAN", (0, -1), (6, -1)),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#EEEEEE")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    if not (chalan.get("items") or []):
        table_commands.append(("SPAN", (0, 1), (8, 1)))
    table.setStyle(TableStyle(table_commands))
    story.extend([table, Spacer(1, 5 * mm)])

    vehicle = chalan.get("vehicle_number") or po.get("vehicle_number")
    driver = chalan.get("driver_name") or po.get("driver_name")
    vehicle_details = " · ".join(
        part for part in (
            f"Vehicle: {vehicle}" if vehicle else "",
            f"Driver: {driver}" if driver else "",
        ) if part
    )
    transport = _first_value(
        chalan.get("transport"), chalan.get("transport_details"), chalan.get("transportation"),
        po.get("transport"), po.get("transport_details"), po.get("transportation"),
        vehicle_details, default="—",
    )
    remarks = _first_value(chalan.get("remarks"), chalan.get("notes"), chalan.get("dispatch_note"), po.get("internal_notes"))
    details = Table([
        [Paragraph("TRANSPORT", styles["footerLabel"]), Paragraph(_escape(transport), styles["value"])],
        [Paragraph("REMARKS", styles["footerLabel"]), Paragraph(_escape(remarks), styles["value"])],
    ], colWidths=[28 * mm, 158 * mm])
    details.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, GRID_BLACK), ("INNERGRID", (0, 0), (-1, -1), 0.35, GRID_BLACK),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.extend([details, Spacer(1, 6 * mm)])

    signatures = Table([[
        Paragraph(
            f"<b>RECEIVER NAME / SIGNATURE</b><br/>{_escape(_first_value(chalan.get('receiver_name'), chalan.get('receiver_signature_name')))}<br/><br/>Signature: ____________________",
            styles["signature"],
        ),
        Paragraph(
            f"<b>SUPPLIER REPRESENTATIVE / SIGNATURE</b><br/>{_escape(_first_value(chalan.get('sender_name'), chalan.get('sender_signature_name')))}<br/><br/>Signature: ____________________",
            styles["signature"],
        ),
    ]], colWidths=[93 * mm, 93 * mm])
    signatures.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.7, GRID_BLACK), ("INNERGRID", (0, 0), (-1, -1), 0.5, GRID_BLACK),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.extend([signatures, Spacer(1, 5 * mm)])

    story.append(HRFlowable(width="100%", thickness=0.9, color=INK, spaceAfter=2 * mm))
    address_line = b.get("company_address") or DEFAULT_ADDRESS
    email = b.get("footer_email") or DEFAULT_EMAIL
    mobile = b.get("footer_phone") or DEFAULT_MOBILE
    company_name = b.get("footer_company_name") or "Buildcon House"
    story.append(Paragraph("COMPANY DETAILS", styles["section"]))
    story.append(Paragraph(
        f"{_escape(company_name)} &middot; {_escape(address_line)} &middot; {_escape(email)} &middot; {_escape(mobile)}",
        styles["footerNote"],
    ))
    if b.get("signature_name") or b.get("signature_title"):
        signature_line = ", ".join(
            _escape(value) for value in (b.get("signature_name"), b.get("signature_title")) if value
        )
        story.append(Paragraph(f"For {_escape(company_name)} — {signature_line}", styles["footerNote"]))

    doc.build(story)
    return buf.getvalue()


def tile_chalan_pdf_filename(chalan: dict, customer_name: str) -> str:
    """Derive date from the chalan's immutable generated_at field, following
    the pattern of chalan_pdf_filename which uses created_at (with fallback)."""
    generated = (chalan.get("generated_at") or "").replace("Z", "+00:00")
    try:
        stamp = datetime.fromisoformat(generated).strftime("%d-%m-%Y")
    except ValueError:
        stamp = datetime.now(timezone.utc).strftime("%d-%m-%Y")
    return f"{chalan['number']} {customer_name} {stamp}.pdf"


def build_tile_chalan_pdf(chalan: dict, branding: dict | None = None) -> bytes:
    """Renders the immutable TileChalan document — only ever called with a
    fully-formed, never-edited chalan dict (see models_tile_orders.TileChalan)."""
    branding = branding or {}
    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=LANDSCAPE_A4, topMargin=14 * mm, bottomMargin=14 * mm, leftMargin=16 * mm, rightMargin=16 * mm)
    styles = getSampleStyleSheet()
    body = ParagraphStyle("tcBody", parent=styles["Normal"], fontSize=9, leading=13)
    heading = ParagraphStyle("tcHeading", parent=styles["Normal"], fontSize=11, leading=14, fontName="Helvetica-Bold")
    small = ParagraphStyle("tcSmall", parent=styles["Normal"], fontSize=7.5, leading=10, textColor=colors.grey)

    flow: list = [_logo_flowable(45), Spacer(1, 3 * mm)]
    flow.append(brand_partners_table(body, col_width_mm=doc.width / mm / 6, row_height_mm=8))
    flow.append(Spacer(1, 3 * mm))
    flow.append(Paragraph(f"<b>Chalan No:</b> {_escape(chalan['number'])} &nbsp;&nbsp; <b>Date:</b> {chalan['generated_at'][:10]} &nbsp;&nbsp; <b>Time:</b> {chalan['generated_at'][11:16]}", body))
    flow.append(HRFlowable(width="100%", thickness=0.5, color=colors.grey, spaceBefore=4, spaceAfter=6))

    flow.append(Paragraph("<b>Customer</b>", heading))
    flow.append(Paragraph(
        f"{_escape(chalan.get('customer_name', ''))} &nbsp;·&nbsp; {_escape(chalan.get('customer_phone') or '')}<br/>"
        f"{_escape(chalan.get('delivery_address', ''))}, {_escape(chalan.get('delivery_city', ''))}<br/>"
        f"Reference: {_escape(chalan.get('reference_number') or '—')}", body,
    ))
    flow.append(Spacer(1, 4 * mm))

    flow.append(Paragraph("<b>Supplier</b>", heading))
    flow.append(Paragraph(
        f"{_escape(chalan.get('supplier_name', ''))} &nbsp;·&nbsp; {_escape(chalan.get('supplier_contact') or '—')}<br/>"
        f"{_escape(chalan.get('supplier_address') or '—')}", body,
    ))
    flow.append(Spacer(1, 5 * mm))

    # Text columns must be Paragraphs, not bare strings: ReportLab does not
    # wrap a plain string inside a Table cell, it lets it run straight over
    # the neighbouring column. Real tile names are long enough to need that
    # protection in the compact printed grid.
    cell = ParagraphStyle("tcCell", parent=styles["Normal"], fontSize=8, leading=9.5)
    cell_right = ParagraphStyle("tcCellRight", parent=cell, alignment=2)

    # Keep one clear quantity-type column for warehouse staff.  The previous
    # "Box" label was misleading whenever a line was dispatched as pieces.
    header_row = ["Sr", "Tile Name", "Series", "Finish", "Size", "Box / Pieces", "Qty"]
    table_data = [header_row]
    for i, item in enumerate(chalan.get("items", []), start=1):
        table_data.append([
            str(i),
            Paragraph(_escape(item.get("tile_name", "")), cell),
            Paragraph(_escape(item.get("series") or "—"), cell),
            Paragraph(_escape(item.get("finish") or "—"), cell),
            Paragraph(_escape(item.get("size") or "—"), cell),
            Paragraph(_quantity_unit_label(item.get("quantity_unit")), cell_right),
            Paragraph(f"{item.get('quantity', 0):g}", cell_right),
        ])
    # Use the full printable width. This gives long product names and the
    # explicit Box / Pieces heading room to wrap cleanly rather than making
    # the operational grid look compressed in a landscape document.
    product_table = Table(table_data, colWidths=[8 * mm, 74 * mm, 32 * mm, 27 * mm, 29 * mm, 38 * mm, 25 * mm])
    product_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F2F2F2")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    flow.append(product_table)
    flow.append(Spacer(1, 8 * mm))

    signature_table = Table([
        ["Receiver", "Sender"],
        [_escape(chalan.get("receiver_name") or ""), _escape(chalan.get("sender_name") or "")],
        ["Signature: ____________________", "Signature: ____________________"],
    ], colWidths=[85 * mm, 85 * mm])
    signature_table.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 9), ("TOPPADDING", (0, 0), (-1, -1), 6)]))
    flow.append(signature_table)
    flow.append(Spacer(1, 5 * mm))

    vehicle = chalan.get("vehicle_number") or "—"
    driver = chalan.get("driver_name") or "—"
    flow.append(Paragraph(f"<b>Transport:</b> Vehicle {_escape(vehicle)} &nbsp;·&nbsp; Driver {_escape(driver)}", small))
    flow.append(Spacer(1, 3 * mm))
    flow.append(Paragraph(
        f"Generated on {chalan['generated_at'][:16].replace('T', ' ')} by {_escape(chalan.get('generated_by_name', ''))} "
        f"&nbsp;·&nbsp; {_escape(chalan.get('system_version', 'BuildCon ERP'))}", small,
    ))
    flow.append(Paragraph(
        branding.get("footer_company_name", "Buildcon House") + " · " + branding.get("footer_phone", DEFAULT_MOBILE), small,
    ))

    doc.build(flow)
    return buffer.getvalue()
