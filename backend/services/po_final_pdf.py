"""Printable final quotation with the current lines and change record."""
from __future__ import annotations

from html import escape
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from pdf_generator import RUPEE_FONT


def _p(value) -> str:
    return escape(str(value or ""))


def _money(value) -> str:
    return f"₹{float(value or 0):,.2f}" if RUPEE_FONT else f"INR {float(value or 0):,.2f}"


def build_po_final_pdf(data: dict, branding: dict | None = None) -> bytes:
    branding = branding or {}
    output = BytesIO()
    doc = SimpleDocTemplate(output, pagesize=A4, rightMargin=16 * mm, leftMargin=16 * mm,
                            topMargin=15 * mm, bottomMargin=15 * mm)
    styles = getSampleStyleSheet()
    face = RUPEE_FONT or "Helvetica"
    title = ParagraphStyle("FinalTitle", parent=styles["Title"], fontName=face, fontSize=16, leading=20,
                           textColor=colors.HexColor("#174C75"), spaceAfter=9)
    body = ParagraphStyle("FinalBody", parent=styles["BodyText"], fontName=face, fontSize=8.2, leading=11)
    small = ParagraphStyle("FinalSmall", parent=body, fontSize=7.2, leading=9)
    heading = ParagraphStyle("FinalHeading", parent=styles["Heading2"], fontName=face, fontSize=10,
                             leading=13, spaceBefore=13, spaceAfter=6)
    story = [Paragraph(_p(branding.get("footer_company_name") or "Buildcon House"), title),
             Paragraph("PO FINAL · Final Customer Quotation", heading)]
    customer = data["customer"]
    address = ", ".join(str(customer.get(k)) for k in ("address", "city", "state", "pincode") if customer.get(k))
    story.extend([
        Paragraph(f"<b>Customer:</b> {_p(customer.get('name'))} {_p(customer.get('company'))}", body),
        Paragraph(f"<b>Quotation:</b> {_p(data.get('quotation_number'))} &nbsp;&nbsp; <b>Status:</b> {_p(data.get('status'))}", body),
        Paragraph(f"<b>Generated:</b> {_p(str(data.get('generated_at') or '')[:10])}", body),
    ])
    if address:
        story.append(Paragraph(f"<b>Address:</b> {_p(address)}", body))
    story.append(Paragraph("Final products and amounts", heading))
    rows = [[Paragraph("#", small), Paragraph("Product / source", small), Paragraph("Qty", small),
             Paragraph("Offer rate", small), Paragraph("Line total", small)]]
    for index, item in enumerate(data.get("items") or [], 1):
        detail = f"<b>{_p(item.get('name'))}</b>"
        if item.get("sku"):
            detail += f"<br/>SKU: {_p(item['sku'])}"
        detail += f"<br/>Source: {_p(str(item.get('source') or 'purchase').replace('_', ' ').title())}"
        if item.get("godown_transferred_qty"):
            detail += f"<br/>Originally {float(item.get('original_qty') or 0):g}; moved {float(item['godown_transferred_qty']):g} to godown"
        if item.get("godown_source_customer_name"):
            detail += f" · from {_p(item['godown_source_customer_name'])}"
        rows.append([Paragraph(str(index), small), Paragraph(detail, small),
                     Paragraph(f"{float(item.get('qty') or 0):g}", small),
                     Paragraph(_money(item.get("unit_price")), small),
                     Paragraph(_money(item.get("total")), small)])
    table = Table(rows, colWidths=[10 * mm, 90 * mm, 15 * mm, 31 * mm, 32 * mm], repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8F0F7")),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor("#174C75")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFC")]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.extend([table, Spacer(1, 8 * mm)])
    if data.get("godown_credit_amount"):
        story.extend([Paragraph(f"<b>Original quotation total:</b> {_money(data.get('original_total'))}", body),
                      Paragraph(f"<b>Moved to godown:</b> -{_money(data.get('godown_credit_amount'))}", body)])
    if data.get("transportation_fee"):
        story.append(Paragraph(f"<b>Products:</b> {_money(data.get('items_total'))}", body))
        story.append(Paragraph(f"<b>Transportation fee:</b> {_money(data.get('transportation_fee'))}", body))
    story.append(Paragraph(f"<b>Final quotation total:</b> {_money(data.get('total'))}", body))
    if data.get("payment_extra_amount"):
        story.extend([Paragraph(f"<b>Additional costs:</b> {_money(data.get('payment_extra_amount'))}", body),
                      Paragraph(f"<b>Total payable:</b> {_money(data.get('payable_total'))}", body)])
    story.append(Paragraph("Changes and movements", heading))
    changes = data.get("changes") or []
    if changes:
        for event in changes:
            date = str(event.get("at") or "")[:16].replace("T", " ")
            amount = f" · {_money(event['amount'])}" if event.get("amount") is not None else ""
            story.append(Paragraph(f"<b>{_p(date)}</b> · {_p(event.get('description'))}{amount}", small))
            story.append(Spacer(1, 2 * mm))
    else:
        story.append(Paragraph("No recorded changes after the original quotation.", small))
    story.append(Spacer(1, 5 * mm))
    story.append(Paragraph("Amounts shown are customer selling amounts from the current quotation, including its latest edits and recorded additional costs.", small))
    doc.build(story)
    return output.getvalue()
