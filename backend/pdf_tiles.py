"""Ground Floor → Tiles document PDFs — faithful replicas of the two official
printed forms supplied by the business (Selection / Tile Quotation):

* Page 1 — logo + title, a 4x2 CUSTOMER NAME/CONTACT NO./.../ADDRESS form
  grid, an intro line, (Quotation only) a PRICE SUMMARY box, the OUR BRAND
  PARTNERS grid, 12 Terms & Conditions, a contact line and a customer
  signature box.
* Page 2+ — PRODUCT DETAILS: a single flowing product grid (SR NO / PRODUCT
  IMAGE / AREA / PRODUCT DETAIL / SIZE / RATE-SQFT [+ OFFER RATE / RATE-BOX /
  TOTAL BOX / PCS-BOX / TOTAL for the Quotation]) that paginates on its own
  via reportlab's normal Table-splitting (repeatRows repeats the column
  header on every continuation page) — no manual per-page chunking, so any
  number of products just flows across as many pages as it needs.

Both reuse the shared image fetch/placeholder/escaping/footer helpers from
pdf_generator so there is exactly one implementation of those in the codebase.
"""
from __future__ import annotations
from services.phone_format import format_phone
from services.referrer_identity import referrer_label

import functools
from datetime import datetime
from io import BytesIO
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Flowable, HRFlowable, Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

from pdf_generator import (
    LOGO_PATH, LOGO_RATIO, _draw_footer, _draw_room_watermark, _escape, _img, _money, _currency_symbol, _SingleLineParagraph,
    PORTRAIT_A4, quotation_pdf_filename, _po_final_payment_table, brand_partners_table, prefetch_product_images,
)

INK = colors.HexColor("#111111")
RED = colors.HexColor("#FF0000")
GREEN = colors.HexColor("#1D7A3C")
GRID = colors.HexColor("#8A8A8A")
HEADER_GREY = colors.HexColor("#C8C8C8")
ZEBRA = colors.HexColor("#F0F0F0")
# Portrait A4 minus the shared 8 mm side margins.
PAGE_W_MM = 194.0

# ---------------------------------------------------------------------------
# Optional unicode fonts — needed only for the ₹ / ☺ / ☎ glyphs the reference
# documents use. Helvetica/Times (the PDF core fonts) don't carry them, and no
# single macOS font has all three (Arial Unicode MS predates the 2010 rupee
# sign), so each glyph registers the first candidate whose cmap actually maps
# it. When none exists (bare containers) the templates degrade gracefully to
# "Rs." / no dingbat.
# ---------------------------------------------------------------------------
def _register_glyph_font(name: str, codepoint: int, candidates: tuple[str, ...]) -> str | None:
    from reportlab.pdfbase.ttfonts import TTFontFile
    for candidate in candidates:
        if not Path(candidate).exists():
            continue
        try:
            if TTFontFile(candidate).charToGlyph.get(codepoint, 0) == 0:
                continue
            pdfmetrics.registerFont(TTFont(name, candidate))
            return name
        except Exception:
            continue
    return None


_DEJAVU = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",            # Debian/Ubuntu
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",                     # Fedora/Alpine
)
_RUPEE_FONT = _register_glyph_font("BCRupee", 0x20B9, _DEJAVU + ("/System/Library/Fonts/Supplemental/Georgia.ttf",))
_DINGS_FONT = _register_glyph_font("BCDings", 0x263A, _DEJAVU + ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf",))


def _ding(char: str) -> str:
    """☺ / ☎ in the dingbat-capable font — empty string when unavailable."""
    return f"<font name='{_DINGS_FONT}'>{char}</font>" if _DINGS_FONT else ""


def _rupee(value: float) -> str:
    # `_money` is the shared PDF formatter: it carries a real ₹ glyph and
    # Indian (lakh/crore) grouping for every document family.
    return _money(value)


def _draw_tiles_page_chrome(cv, doc, branding: dict | None = None) -> None:
    """Keep the cover clean and watermark the product-details pages."""
    if doc.page > 1:
        _draw_room_watermark(cv, doc, branding)
    if doc.page == 1:
        _draw_footer(cv, doc, branding)


DEFAULT_ADDRESS = "Nr. Gujarat Housing Board, Kataria Motors, 2nd 150ft Ring Road, Rajkot-360005"
DEFAULT_EMAIL = "buildconhouse10@gmail.com"
DEFAULT_MOBILE = "+91 99099 06652"

TILES_TERMS = [
    "Prices quoted are based on the current NET prices at the time of selection.",
    "Prices are subject to revision by any brand without prior notice.",
    "100% advance payment is required to confirm orders.",
    "Freight and unloading charges will be applicable as per actuals.",
    "Delivery timelines are subject to the manufacturer&rsquo;s schedule.",
    "Rates are valid for 5 days, unless stated otherwise in writing.",
    "Above rates are inclusive of GST @18%, unless stated otherwise.",
    "All orders and deliveries are subject to material availability.",
    "Prices are subject to change in case of changes in government levy.",
    "Cheques should be written in favour of Buildcon House.",
    "On confirmation of purchase order, material will be delivered within 15 days.",
    "Labour cost is extra and not included in this quotation.",
]


def _parse_doc_date(doc: dict) -> datetime:
    """Best-effort parse of the editable printed date; falls back to created_at,
    then to today — used for the `<Customer> <DD-MM-YYYY>.pdf` filename."""
    raw = (doc.get("doc_date") or "").strip()
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%d-%b-%y", "%d-%b-%Y", "%d %b %Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    created = (doc.get("created_at") or "").replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(created)
    except ValueError:
        return datetime.now()


def tiles_pdf_filename(doc: dict) -> str:
    return quotation_pdf_filename(
        doc.get("customer_name"), doc, selection=doc.get("doc_type") == "tiles_selection",
    )


def _logo_flowable(width_mm: float) -> Flowable:
    if LOGO_PATH.exists():
        image = Image(str(LOGO_PATH), width=width_mm * mm, height=width_mm * mm / LOGO_RATIO, kind="proportional")
        image.hAlign = "CENTER"
        return image
    return Paragraph(
        "<b>BUILDCON HOUSE</b><br/><font size='7'>Let you live better</font>",
        ParagraphStyle("logoFallback", fontName="Helvetica-Bold", fontSize=13, leading=15, alignment=1),
    )


def _fmt_rate_sqft(value, suffix: str = "") -> str:
    """300.0 → "300", 132.5 → "132.5" — the reference sheets never print
    trailing zeros on the per-sqft rate."""
    if value in (None, ""):
        return ""
    try:
        num = float(value)
    except (TypeError, ValueError):
        return _escape(value)
    text = f"{num:g}"
    return f"{text}{suffix}"



def _quantity_unit(value: object) -> str:
    """Return one display unit for current and legacy tile line items.

    Older quotations contain variants such as ``piece``, ``PC`` and lowercase
    values.  Treating only the exact string ``Pieces`` as pieces made those
    rows print as boxes and put the wrong value in the unit column.
    """
    normalized = str(value or "Box").strip().lower()
    return "Pieces" if normalized in {"piece", "pieces", "pc", "pcs"} else "Box"


def _quantity_label(quantity: float, unit: str) -> str:
    singular = "PIECE" if unit == "Pieces" else "BOX"
    plural = "PIECES" if unit == "Pieces" else "BOXES"
    return f"{quantity:g} {singular if quantity == 1 else plural}"


def _tiles_styles() -> dict:
    """Style set shared by both Selection and Quotation — one dict of
    consistently-named keys so the shared page-1 building blocks below
    (_header_block / _meta_grid / _brand_terms_signature_block) work
    identically for either document."""
    base = getSampleStyleSheet()["Normal"]
    return {
        "titleMain": ParagraphStyle("titleMain", parent=base, fontName="Helvetica-Bold", fontSize=16, leading=17.5, textColor=INK, alignment=2),
        "titleSub": ParagraphStyle("titleSub", parent=base, fontName="Helvetica", fontSize=8, leading=9, textColor=colors.HexColor("#444444"), alignment=2),
        "metaLabel": ParagraphStyle("metaLabel", parent=base, fontName="Helvetica-Bold", fontSize=9.5, leading=11.5, textColor=INK, alignment=1),
        "metaValue": ParagraphStyle("metaValue", parent=base, fontName="Helvetica", fontSize=11.5, leading=14, textColor=INK, alignment=1),
        "intro": ParagraphStyle("intro", parent=base, fontName="Helvetica", fontSize=9, leading=11, textColor=INK, alignment=1),
        "sectionTitle": ParagraphStyle("sectionTitle", parent=base, fontName="Helvetica-Bold", fontSize=9.2, leading=10.5, textColor=INK, alignment=1),
        "term": ParagraphStyle("term", parent=base, fontName="Helvetica", fontSize=8, leading=10, textColor=colors.HexColor("#3A3A3A"), alignment=0),
        "contact": ParagraphStyle("contact", parent=base, fontName="Helvetica", fontSize=9, leading=11, textColor=INK, alignment=1),
        "sigNote": ParagraphStyle("sigNote", parent=base, fontName="Helvetica", fontSize=8, leading=10, textColor=INK, alignment=1),
        "sigLabel": ParagraphStyle("sigLabel", parent=base, fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=INK, alignment=2),
        "sumLabel": ParagraphStyle("sumLabel", parent=base, fontName="Helvetica-Bold", fontSize=8.6, leading=10.5, textColor=INK, alignment=1),
        "sumValue": ParagraphStyle("sumValue", parent=base, fontName="Helvetica", fontSize=8.6, leading=10.5, textColor=INK, alignment=1),
        "sumRed": ParagraphStyle("sumRed", parent=base, fontName="Helvetica-Bold", fontSize=9.2, leading=11, textColor=RED, alignment=1),
        "colHead": ParagraphStyle("colHead", parent=base, fontName="Helvetica-Bold", fontSize=7.8, leading=9.2, textColor=INK, alignment=1),
        "colHeadRed": ParagraphStyle("colHeadRed", parent=base, fontName="Helvetica-Bold", fontSize=7.8, leading=9.2, textColor=RED, alignment=1),
        "cell": ParagraphStyle("cell", parent=base, fontName="Helvetica", fontSize=9, leading=11, textColor=INK, alignment=1),
        "cellBold": ParagraphStyle("cellBold", parent=base, fontName="Helvetica-Bold", fontSize=9, leading=11, textColor=INK, alignment=1),
        "cellRed": ParagraphStyle("cellRed", parent=base, fontName="Helvetica-Bold", fontSize=9, leading=11, textColor=RED, alignment=1),
        "cellOffer": ParagraphStyle("cellOffer", parent=base, fontName="Helvetica-Bold", fontSize=9, leading=11, textColor=GREEN, alignment=1),
        "sqftCaption": ParagraphStyle("sqftCaption", parent=base, fontName="Helvetica", fontSize=6, leading=7.2, textColor=colors.HexColor("#666666"), alignment=1),
    }


def _header_block(main_title: str, subtitle: str, styles: dict) -> Table:
    """Logo (left) + title/subtitle (right), used identically for the page 1
    masthead and the page 2+ "PRODUCT DETAILS" section header."""
    table = Table(
        [["", _logo_flowable(46), [Paragraph(main_title, styles["titleMain"]), Paragraph(subtitle, styles["titleSub"])]]],
        colWidths=[0, PAGE_W_MM / 2 * mm, PAGE_W_MM / 2 * mm],
    )
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return table


def _meta_grid(quotation: dict, customer: dict, styles: dict) -> Table:
    """The 4x2 CUSTOMER NAME / CONTACT NO. / SELECTION-QUOTATION DATE /
    QUOTATION NO. + REFERENCE / ATTENDED BY / PREPARED BY / ADDRESS form
    grid — identical on both documents' page 1."""
    created = _parse_doc_date(quotation).strftime("%d-%b-%y")
    row1_labels = ["CUSTOMER NAME", "CONTACT NO.", "SELECTION / QUOTATION DATE", "QUOTATION NO."]
    row1_values = [
        quotation.get("customer_name") or customer.get("name") or "",
        format_phone(quotation.get("phone_snapshot") or customer.get("phone") or ""),
        quotation.get("doc_date") or created,
        quotation.get("doc_number") or quotation.get("number") or "",
    ]
    row2_labels = ["REFERENCE", "ATTENDED BY", "PREPARED BY", "ADDRESS"]
    row2_values = [
        " · ".join(filter(None, [quotation.get("reference_source"), referrer_label(quotation)])),
        quotation.get("attended_by") or "",
        quotation.get("prepared_by") or "",
        quotation.get("address_snapshot") or "",
    ]
    data = [
        [Paragraph(label, styles["metaLabel"]) for label in row1_labels],
        [Paragraph(_escape(value) or "&nbsp;", styles["metaValue"]) for value in row1_values],
        [Paragraph(label, styles["metaLabel"]) for label in row2_labels],
        [Paragraph(_escape(value) or "&nbsp;", styles["metaValue"]) for value in row2_values],
    ]
    table = Table(data, colWidths=[PAGE_W_MM / 4 * mm] * 4, minRowHeights=[7 * mm, 8 * mm, 7 * mm, 8 * mm])
    table.setStyle(TableStyle([
        # A single explicit grid avoids the disconnected, partial form rules
        # seen in printed selections. ReportLab draws continuous straight
        # horizontal and vertical strokes around every field.
        ("BOX", (0, 0), (-1, -1), 0.7, INK),
        ("INNERGRID", (0, 0), (-1, -1), 0.7, INK),
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 1), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
    ]))
    return table


def _brand_terms_signature_block(styles: dict, branding: dict, *, density: str = "standard") -> list:
    """Terms, contact line and customer signature box.

    Selection covers have room to breathe, while quotation covers also carry
    a price summary.  A single fixed vertical rhythm made the latter taller
    than the printable frame and ReportLab consequently clipped its masthead.
    Keep every required cover section, but use a compact quotation rhythm.
    """
    compact = density == "compact"
    airy = density == "airy"
    partner_gap = 0.8 if compact else 1.5
    after_partner_gap = 2.0 if compact else (6.0 if airy else 4.0)
    before_terms_gap = 0.5 if compact else 1.0
    after_terms_gap = 0.6 if compact else (2.0 if airy else 1.3)
    before_signature_gap = 0.8 if compact else (2.5 if airy else 1.5)
    term_style = (
        ParagraphStyle("termCompact", parent=styles["term"], fontSize=8, leading=10)
        if compact else styles["term"]
    )
    email = branding.get("footer_email") or DEFAULT_EMAIL
    mobile = format_phone(branding.get("footer_phone") or DEFAULT_MOBILE)
    flow: list = [
        Paragraph("OUR BRAND PARTNERS", styles["sectionTitle"]),
        Spacer(1, partner_gap * mm),
        brand_partners_table(styles["cell"], col_width_mm=PAGE_W_MM / 6),
        # Keep the partner, terms and signature groups visually distinct while
        # preserving the fixed two-page printed form.
        Spacer(1, after_partner_gap * mm),
        Paragraph("TERMS &amp; CONDITIONS", styles["sectionTitle"]),
        Spacer(1, before_terms_gap * mm),
    ]
    term_rows = [
        [Paragraph(f"{left}. {TILES_TERMS[left - 1]}", term_style), Paragraph(f"{right}. {TILES_TERMS[right - 1]}", term_style)]
        for left, right in zip(range(1, 7), range(7, 13))
    ]
    terms = Table(term_rows, colWidths=[PAGE_W_MM / 2 * mm] * 2)
    terms.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0 if compact else 0.7),
    ]))
    flow.append(terms)
    flow.append(Spacer(1, after_terms_gap * mm))
    flow.append(Paragraph(
        f"For general enquiries: <b>M: {_escape(mobile)}</b> &nbsp;|&nbsp; <b>Email: {_escape(email)}</b>",
        styles["contact"],
    ))
    flow.append(Spacer(1, before_signature_gap * mm))
    signature = Table(
        [[
            Paragraph("I/We have reviewed and agree to the terms and conditions mentioned in this quotation.", styles["sigNote"]),
            Paragraph("CUSTOMER SIGNATURE &amp; DATE", styles["sigLabel"]),
        ]],
        colWidths=[128 * mm, 66 * mm], minRowHeights=[11 * mm],
    )
    signature.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, GRID),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    flow.append(signature)
    return flow


def _price_summary_table(total_quantity: str, subtotal: float, transportation_fee: float, total_quote: float, styles: dict) -> Table:
    """Quotation-only PRICE SUMMARY box on page 1 — TOTAL QUANTITY / SUBTOTAL /
    TRANSPORTATION / TOTAL QUOTE."""
    rows = [
        [Paragraph("TOTAL QUANTITY", styles["sumLabel"]), Paragraph(total_quantity, styles["sumValue"])],
        [Paragraph(f"SUBTOTAL ({_currency_symbol()})", styles["sumLabel"]), _SingleLineParagraph(_rupee(subtotal), styles["sumValue"])],
        [Paragraph("TRANSPORTATION", styles["sumLabel"]), _SingleLineParagraph(_rupee(transportation_fee), styles["sumValue"])],
        [Paragraph(f"TOTAL QUOTE ({_currency_symbol()})", styles["sumRed"]), _SingleLineParagraph(_rupee(total_quote), styles["sumRed"])],
    ]
    table = Table(rows, colWidths=[130 * mm, 64 * mm], rowHeights=[5.5 * mm] * 4, hAlign="CENTER")
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.6, GRID),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("BACKGROUND", (0, 0), (-1, -2), HEADER_GREY),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#DADADA")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


# ===========================================================================
# TILES SELECTION
# ===========================================================================
_SEL_COLS = [10 * mm, 44 * mm, 24 * mm, 54 * mm, 26 * mm, 36 * mm]
# Image column width less the table's 2 mm padding on each side.
SELECTION_PRODUCT_IMAGE_WIDTH_MM = 40.0
SELECTION_PRODUCT_IMAGE_HEIGHT_MM = SELECTION_PRODUCT_IMAGE_WIDTH_MM / (16 / 10)


def build_tiles_selection_pdf(quotation: dict, customer: dict, branding: dict | None = None) -> bytes:
    b = branding or {}
    image_bytes = prefetch_product_images(quotation.get("items") or []) or {}
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=PORTRAIT_A4, leftMargin=8 * mm, rightMargin=8 * mm,
        topMargin=10 * mm, bottomMargin=16 * mm,
        title=f"Selection — {quotation.get('customer_name') or ''}",
        author=b.get("footer_company_name") or "Buildcon House",
    )
    styles = _tiles_styles()
    items = quotation.get("items") or []

    story: list = [
        _header_block("PRODUCT SELECTION", "Tiles &amp; Sanitaryware Solutions", styles),
        Spacer(1, 2 * mm),
        HRFlowable(width="100%", thickness=1.1, color=INK, spaceAfter=2.5 * mm),
        _meta_grid(quotation, customer, styles),
        Spacer(1, 2.5 * mm),
        Paragraph(
            "Dear Sir/Madam, thank you for your interest in our products. Please find below the products shortlisted "
            "as per your selection, for your review and confirmation.",
            styles["intro"],
        ),
        Spacer(1, 2.5 * mm),
    ]
    # The selection cover has no price summary, so the standard rhythm gives
    # every group breathing room while still keeping the masthead inside the
    # printable first-page frame.
    story.extend(_brand_terms_signature_block(styles, b))

    # --- PRODUCT DETAILS (page 2+) — one flowing table, auto-paginates ------
    story.append(PageBreak())
    story.append(_header_block("PRODUCT DETAILS", f"Items 1&ndash;{len(items)}" if items else "No items yet", styles))
    story.extend([Spacer(1, 2.5 * mm), HRFlowable(width="100%", thickness=1.1, color=INK, spaceAfter=3 * mm)])

    head = [
        Paragraph("SR.<br/>NO.", styles["colHead"]), Paragraph("PRODUCT IMAGE", styles["colHead"]),
        Paragraph("AREA", styles["colHead"]), Paragraph("PRODUCT DETAIL", styles["colHead"]),
        Paragraph("SIZE", styles["colHead"]), Paragraph("RATE/<br/>SQ.FT", styles["colHeadRed"]),
    ]
    rows: list[list[object]] = [head]
    for index, item in enumerate(items, 1):
        rows.append([
            Paragraph(str(index), styles["cell"]),
            _img(
                item.get("image"), image_bytes=image_bytes, force_landscape=True,
                width_mm=SELECTION_PRODUCT_IMAGE_WIDTH_MM,
                height_mm=SELECTION_PRODUCT_IMAGE_HEIGHT_MM,
                cover=True,
            ),
            Paragraph(_escape(item.get("room") or ""), styles["cell"]),
            Paragraph(_escape(item.get("name") or ""), styles["cellBold"]),
            Paragraph(_escape(item.get("size") or ""), styles["cell"]),
            Paragraph(_fmt_rate_sqft(item.get("rate_sqft")), styles["cellRed"]),
        ])
    style_cmds = [
        ("GRID", (0, 0), (-1, -1), 0.7, GRID),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("BACKGROUND", (0, 0), (-1, 0), HEADER_GREY),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]
    # Alternate serial cells for scanning while leaving the diagonal visible
    # behind the product details; full-width row fills concealed the logo.
    for r in range(2, len(rows), 2):
        style_cmds.append(("BACKGROUND", (0, r), (0, r), ZEBRA))
    table = Table(rows, colWidths=_SEL_COLS, minRowHeights=[10 * mm] + [32 * mm] * (len(rows) - 1), repeatRows=1)
    table.setStyle(TableStyle(style_cmds))
    story.append(table)

    doc.build(
        story,
        onFirstPage=functools.partial(_draw_tiles_page_chrome, branding=b),
        onLaterPages=functools.partial(_draw_tiles_page_chrome, branding=b),
    )
    return buf.getvalue()


# ===========================================================================
# TILES QUOTATION
# ===========================================================================
# Preserve all original product-detail columns and their order on portrait A4.
_QUO_COLS = [width * mm for width in (7, 32, 18, 32, 16, 13, 13, 15, 10, 10, 28)]
QUOTATION_PRODUCT_IMAGE_WIDTH_MM = 28.0
QUOTATION_PRODUCT_IMAGE_HEIGHT_MM = QUOTATION_PRODUCT_IMAGE_WIDTH_MM / (16 / 10)


def build_tiles_quotation_pdf(quotation: dict, customer: dict, branding: dict | None = None) -> bytes:
    b = branding or {}
    image_bytes = prefetch_product_images(quotation.get("items") or []) or {}
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=PORTRAIT_A4, leftMargin=8 * mm, rightMargin=8 * mm,
        topMargin=10 * mm, bottomMargin=16 * mm,
        title=f"Quotation — {quotation.get('customer_name') or ''}",
        author=b.get("footer_company_name") or "Buildcon House",
    )
    styles = _tiles_styles()
    items = quotation.get("items") or []

    quantity_totals = {
        "Box": sum(float(item.get("qty") or 0) for item in items if _quantity_unit(item.get("quantity_unit")) == "Box"),
        "Pieces": sum(float(item.get("qty") or 0) for item in items if _quantity_unit(item.get("quantity_unit")) == "Pieces"),
    }
    total_quantity = " · ".join(
        _quantity_label(value, unit)
        for unit, value in quantity_totals.items() if value
    )
    item_subtotal = float(quotation.get("subtotal") or sum(float(item.get("net_amount") or 0) for item in items))
    transportation_fee = float(quotation.get("transportation_fee") or 0)
    subtotal = item_subtotal
    total_quote = float(quotation.get("grand_total") or (item_subtotal + transportation_fee))

    if quotation.get("_po_final") is not None:
        story: list = [
            _header_block("PRODUCT QUOTATION", "Tiles &amp; Sanitaryware Solutions", styles),
            Spacer(1, 2 * mm),
            HRFlowable(width="100%", thickness=1.1, color=INK, spaceAfter=2.5 * mm),
            Paragraph(f"<b>Customer:</b> {_escape(customer.get('name') or quotation.get('customer_name'))}", styles["cell"]),
            Paragraph(f"<b>Quotation:</b> {_escape(quotation.get('number'))}", styles["cell"]),
            Spacer(1, 4 * mm),
            Paragraph("PRICE &amp; PAYMENT SUMMARY", styles["sectionTitle"]),
            Spacer(1, 2 * mm),
            _price_summary_table(total_quantity, subtotal, transportation_fee, total_quote, styles),
            Spacer(1, 3 * mm),
            _po_final_payment_table(quotation, styles["cell"], PAGE_W_MM),
        ]
    else:
        story: list = [
            _header_block("PRODUCT QUOTATION", "Tiles &amp; Sanitaryware Solutions", styles),
            Spacer(1, 2 * mm),
            HRFlowable(width="100%", thickness=1.1, color=INK, spaceAfter=2.5 * mm),
            _meta_grid(quotation, customer, styles),
            Spacer(1, 2.5 * mm),
            Paragraph(
                "Dear Sir/Madam, thank you for your interest in our products. We are pleased to offer our most competitive "
                "rates for premium tiles and sanitaryware, prepared as per your selection.",
                styles["intro"],
            ),
            Spacer(1, 2.5 * mm),
            Paragraph("PRICE SUMMARY", styles["sectionTitle"]),
            Spacer(1, 1 * mm),
            _price_summary_table(total_quantity, subtotal, transportation_fee, total_quote, styles),
            Spacer(1, 2.5 * mm),
        ]
        story.extend(_brand_terms_signature_block(styles, b, density="compact"))

    # --- PRODUCT DETAILS (page 2+) — one flowing table, auto-paginates ------
    story.append(PageBreak())
    story.append(_header_block("PRODUCT DETAILS", f"Items 1&ndash;{len(items)}" if items else "No items yet", styles))
    story.extend([Spacer(1, 2.5 * mm), HRFlowable(width="100%", thickness=1.1, color=INK, spaceAfter=3 * mm)])

    head = [
        Paragraph("SR.<br/>NO.", styles["colHead"]), Paragraph("PRODUCT IMAGE", styles["colHead"]),
        Paragraph("AREA", styles["colHead"]), Paragraph("PRODUCT DETAIL", styles["colHead"]),
        Paragraph("SIZE", styles["colHead"]), Paragraph("RATE/<br/>SQ.FT", styles["colHeadRed"]),
        Paragraph("OFFER<br/>RATE", styles["colHead"]), Paragraph("RATE/<br/>UNIT", styles["colHead"]),
        _SingleLineParagraph("QUANTITY", styles["colHead"]), Paragraph("UNIT", styles["colHead"]),
        _SingleLineParagraph(f"TOTAL ({_currency_symbol()})", styles["colHead"]),
    ]
    rows: list[list[object]] = [head]
    for index, item in enumerate(items, 1):
        qty = float(item.get("qty") or 0)
        rate_box = float(item.get("rate_box") if item.get("rate_box") is not None else (item.get("unit_price") or 0))
        offer_rate = float(item.get("offer_rate") if item.get("offer_rate") is not None else (item.get("rate_sqft") if item.get("rate_sqft") is not None else item.get("unit_price") or 0))
        line_total = float(item.get("net_amount") if item.get("net_amount") is not None else qty * float(item.get("unit_price") or 0))
        rate_sqft_text = _fmt_rate_sqft(item.get("rate_sqft"))
        quantity_unit = _quantity_unit(item.get("quantity_unit"))
        rows.append([
            Paragraph(str(index), styles["cell"]),
            _img(
                item.get("image"), image_bytes=image_bytes, force_landscape=True,
                width_mm=QUOTATION_PRODUCT_IMAGE_WIDTH_MM,
                height_mm=QUOTATION_PRODUCT_IMAGE_HEIGHT_MM,
                cover=True,
            ),
            Paragraph(_escape(item.get("room") or ""), styles["cell"]),
            Paragraph(_escape(item.get("name") or ""), styles["cellBold"]),
            Paragraph(_escape(item.get("size") or ""), styles["cell"]),
            Paragraph(rate_sqft_text, styles["cellRed"]),
            _SingleLineParagraph(_money(offer_rate) if offer_rate else "", styles["cellOffer"]),
            _SingleLineParagraph(_money(rate_box) if rate_box else "", styles["cell"]),
            # The detail table separates the count from its fulfillment unit:
            # quantity stays numeric while the adjacent column says box/piece.
            # Keep _quantity_label for the summary, where the combined unit is
            # useful, but do not duplicate it in each product row.
            Paragraph(f"{qty:g}" if qty else "", styles["cellBold"]),
            Paragraph("piece" if quantity_unit == "Pieces" else "box", styles["cellBold"]),
            _SingleLineParagraph(_money(line_total) if line_total else "", styles["cell"]),
        ])
    # Keep the grand total out of the flowing product table.  When a table
    # splits immediately before its final row, ReportLab repeats the column
    # header on the new page even though that page contains only the total.
    # Rendering the total as its own table leaves an overflow page clean.
    total_row = ["" for _ in head]
    total_row[3] = Paragraph("<b>TOTAL</b>", styles["cell"])
    total_row[-1] = _SingleLineParagraph(f"<b>{_money(item_subtotal)}</b>", styles["cell"])
    style_cmds = [
        ("GRID", (0, 0), (-1, -1), 0.7, GRID),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("BACKGROUND", (0, 0), (-1, 0), HEADER_GREY),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    for r in range(2, len(rows), 2):
        style_cmds.append(("BACKGROUND", (0, r), (0, r), ZEBRA))
    table = Table(
        rows,
        colWidths=_QUO_COLS,
        minRowHeights=[12 * mm] + [32 * mm] * len(items),
        repeatRows=1,
    )
    table.setStyle(TableStyle(style_cmds))
    story.append(table)

    total_table = Table([total_row], colWidths=_QUO_COLS, rowHeights=[8 * mm])
    total_table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.7, GRID),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("BACKGROUND", (0, 0), (-1, -1), HEADER_GREY),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(total_table)

    doc.build(
        story,
        onFirstPage=functools.partial(_draw_tiles_page_chrome, branding=b),
        onLaterPages=functools.partial(_draw_tiles_page_chrome, branding=b),
    )
    return buf.getvalue()
