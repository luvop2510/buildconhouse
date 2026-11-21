"""Ground Floor → Tiles document PDFs — faithful replicas of the two official
printed forms supplied by the business (Selection / Tile Quotation):

* Page 1 — logo + title, a customer information grid, an intro line,
  (Quotation only) a PRICE SUMMARY box, the OUR BRAND
  PARTNERS grid, 12 Terms & Conditions, a contact line and a customer
  signature box.
* Page 2+ — PRODUCT DETAILS: a flowing product grid with repeating headers.
  Quotations show the saved offer and box rates, followed by the saved
  transportation details and quotation totals.

Both reuse the shared image fetch/placeholder/escaping/footer helpers from
pdf_generator so there is exactly one implementation of those in the codebase.
"""
from __future__ import annotations
from services.product_display import tile_product_name
from services.phone_format import format_department_phone
from services.pricing import saved_tile_unit_price
from services.referrer_identity import pdf_reference_label
from services.tile_transportation import transportation_details

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
    LOGO_PATH, LOGO_RATIO, _draw_footer, _draw_room_watermark, _escape, _item_img, _money, _currency_symbol, _SingleLineParagraph,
    PORTRAIT_A4, QUOTATION_SERIAL_GREY, QUOTATION_WATERMARK_INK_STRENGTH, WATERMARK_INK_STRENGTH,
    quotation_pdf_filename, _po_final_payment_table, brand_partners_table, prefetch_product_images,
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


def _draw_tiles_page_chrome(cv, doc, branding: dict | None = None, *, product_quotation: bool = False) -> None:
    """Keep the cover clean and watermark the product-details pages."""
    if doc.page > 1:
        strength = QUOTATION_WATERMARK_INK_STRENGTH if product_quotation else WATERMARK_INK_STRENGTH
        _draw_room_watermark(cv, doc, branding, ink_strength=strength)
    if doc.page == 1:
        _draw_footer(cv, doc, branding, floor_id="ground-floor")


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
QUOTED_FREIGHT_TERMS = "Freight follows the quoted transportation terms. Unloading charges are as per actuals."


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


def _fmt_rate_sqft(value) -> str:
    """300.0 → "300", 132.5 → "132.5" — the reference sheets never print
    trailing zeros on the per-sqft rate."""
    if value in (None, ""):
        return ""
    try:
        num = float(value)
    except (TypeError, ValueError):
        return _escape(value)
    return f"{num:g}"



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


def _meta_grid(quotation: dict, customer: dict, styles: dict, *, include_staff: bool = True) -> Table:
    """Customer and document details shared by the two tile documents."""
    created = _parse_doc_date(quotation).strftime("%d-%b-%y")
    row1_labels = ["CUSTOMER NAME", "CONTACT NO.", "SELECTION / QUOTATION DATE", "QUOTATION NO."]
    row1_values = [
        quotation.get("customer_name") or customer.get("name") or "",
        format_department_phone(quotation.get("phone_snapshot") or customer.get("phone"), "ground-floor"),
        quotation.get("doc_date") or created,
        quotation.get("doc_number") or quotation.get("number") or "",
    ]
    reference = pdf_reference_label(quotation)
    address = quotation.get("address_snapshot") or customer.get("address") or ""
    if include_staff:
        row2_labels = ["REFERENCE", "ATTENDED BY", "PREPARED BY", "ADDRESS"]
        row2_values = [reference, quotation.get("attended_by") or "", quotation.get("prepared_by") or "", address]
    else:
        row2_labels = ["REFERENCE", "", "ADDRESS", ""]
        row2_values = [reference, "", address, ""]
    data = [
        [Paragraph(label, styles["metaLabel"]) for label in row1_labels],
        [Paragraph(_escape(value) or "&nbsp;", styles["metaValue"]) for value in row1_values],
        [Paragraph(label, styles["metaLabel"]) for label in row2_labels],
        [Paragraph(_escape(value) or "&nbsp;", styles["metaValue"]) for value in row2_values],
    ]
    grid_style = [
        # A single explicit grid avoids the disconnected, partial form rules
        # seen in printed selections. ReportLab draws continuous straight
        # horizontal and vertical strokes around every field.
        ("BOX", (0, 0), (-1, -1), 0.7, INK),
        ("INNERGRID", (0, 0), (-1, -1), 0.7, INK),
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 1), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
    ]
    if not include_staff:
        for row in (2, 3):
            grid_style.extend([("SPAN", (0, row), (1, row)), ("SPAN", (2, row), (3, row))])
        grid_style.extend([("VALIGN", (0, 3), (-1, 3), "TOP"),
                           ("TOPPADDING", (0, 3), (-1, 3), 4), ("BOTTOMPADDING", (0, 3), (-1, 3), 4)])
    table = Table(data, colWidths=[PAGE_W_MM / 4 * mm] * 4,
                  minRowHeights=[7 * mm, 8 * mm, 7 * mm, 8 * mm], splitInRow=int(not include_staff))
    table.setStyle(TableStyle(grid_style))
    return table


def _brand_terms_signature_block(styles: dict, branding: dict, *, density: str = "standard", has_transport_terms: bool = False) -> list:
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
    mobile = format_department_phone(branding.get("footer_phone") or DEFAULT_MOBILE, "ground-floor")
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
    term_texts = TILES_TERMS.copy()
    if has_transport_terms:
        term_texts[3] = QUOTED_FREIGHT_TERMS
    term_rows = [
        [Paragraph(f"{left}. {term_texts[left - 1]}", term_style), Paragraph(f"{right}. {term_texts[right - 1]}", term_style)]
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


def _price_summary_table(total_quantity: str, subtotal: float, transportation_fee: float | None, total_quote: float, styles: dict) -> Table:
    """Cover summary. PO Final retains its Transportation row here."""
    rows = [
        [Paragraph("TOTAL QUANTITY", styles["sumLabel"]), Paragraph(total_quantity, styles["sumValue"])],
        [Paragraph(f"SUBTOTAL ({_currency_symbol()})", styles["sumLabel"]), _SingleLineParagraph(_rupee(subtotal), styles["sumValue"])],
    ]
    if transportation_fee is not None:
        rows.append([Paragraph("TRANSPORTATION", styles["sumLabel"]), _SingleLineParagraph(_rupee(transportation_fee), styles["sumValue"])])
    rows.append([Paragraph(f"TOTAL QUOTE ({_currency_symbol()})", styles["sumRed"]), _SingleLineParagraph(_rupee(total_quote), styles["sumRed"])])
    table = Table(rows, colWidths=[130 * mm, 64 * mm], rowHeights=[5.5 * mm] * len(rows), hAlign="CENTER")
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
    cover_body_start = len(story)
    story.extend(_brand_terms_signature_block(styles, b, density="airy"))

    # Fill the cover down to the footer without forcing Product Details onto it.
    # Measure the actual wrapped customer/reference content: long values use
    # the space themselves, while short covers get breathing room between
    # sections. ReportLab frames reserve six points on each vertical edge.
    content_height = sum(flowable.wrap(doc.width - 12, doc.height)[1]
                         + flowable.getSpaceBefore() + flowable.getSpaceAfter()
                         for flowable in story)
    remaining = max(0, doc.height - 24 - content_height)
    if remaining:
        for offset in (10, 7, 3):
            story.insert(cover_body_start + offset, Spacer(1, remaining / 3))

    # Product selection is a standalone cover; details begin on the next page.
    story.append(PageBreak())
    story.append(_header_block("PRODUCT DETAILS", f"Items 1&ndash;{len(items)}" if items else "No items yet", styles))
    story.extend([Spacer(1, 2.5 * mm), HRFlowable(width="100%", thickness=1.1, color=INK, spaceAfter=3 * mm)])

    head = [
        Paragraph("SR.<br/>NO.", styles["colHead"]), Paragraph("PRODUCT IMAGE", styles["colHead"]),
        Paragraph("AREA", styles["colHead"]), Paragraph("PRODUCT DETAIL", styles["colHead"]),
        Paragraph("SIZE", styles["colHead"]), Paragraph("RATE", styles["colHeadRed"]),
    ]
    rows: list[list[object]] = [head]
    for index, item in enumerate(items, 1):
        rows.append([
            Paragraph(str(index), styles["cell"]),
            _item_img(
                item, image_bytes=image_bytes, force_landscape=True,
                width_mm=SELECTION_PRODUCT_IMAGE_WIDTH_MM,
                height_mm=SELECTION_PRODUCT_IMAGE_HEIGHT_MM,
                cover=True,
            ),
            Paragraph(_escape(item.get("room") or ""), styles["cell"]),
            Paragraph(_escape(tile_product_name(item.get("name"), item.get("size"))), styles["cellBold"]),
            Paragraph(_escape(item.get("size") or ""), styles["cell"]),
            Paragraph(_money(item.get("offer_rate") if item.get("offer_rate") is not None else (item.get("rate_sqft") if item.get("rate_sqft") is not None else item.get("unit_price") or 0)), styles["cellRed"]),
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
# Keep the original photo frame and fit the additional rate on portrait A4.
_QUO_COLS = [width * mm for width in (7, 32, 14, 27, 15, 12, 15, 22, 14, 10, 26)]
_PO_FINAL_COLS = [width * mm for width in (7, 32, 18, 34, 16, 15, 19, 14, 11, 28)]
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
    product_quotation = quotation.get("_po_final") is None
    columns = _QUO_COLS if product_quotation else _PO_FINAL_COLS
    serial_style = styles["cell"]
    if product_quotation:
        serial_style = ParagraphStyle("quoteSerial", parent=serial_style, fontSize=10, textColor=QUOTATION_SERIAL_GREY)
    area_style = (
        ParagraphStyle("quoteArea", parent=styles["cell"], fontSize=8, leading=10)
        if product_quotation else styles["cell"]
    )
    items = quotation.get("items") or []

    quantity_totals = {
        "Box": sum(float(item.get("qty") or 0) for item in items if _quantity_unit(item.get("quantity_unit")) == "Box"),
        "Pieces": sum(float(item.get("qty") or 0) for item in items if _quantity_unit(item.get("quantity_unit")) == "Pieces"),
    }
    total_quantity = " · ".join(
        _quantity_label(value, unit)
        for unit, value in quantity_totals.items() if value
    )
    unit_prices = [saved_tile_unit_price(item, per_piece=_quantity_unit(item.get("quantity_unit")) == "Pieces") for item in items]
    gross_amounts = [
        float(item.get("qty") or 0) * (rate or 0)
        for item, rate in zip(items, unit_prices, strict=True)
    ]
    line_totals = [
        float(item["net_amount"]) if item.get("net_amount") is not None
        else round(gross * (1 - float(item.get("discount_pct") or 0) / 100), 2)
        for item, gross in zip(items, gross_amounts, strict=True)
    ]
    item_subtotal = quotation.get("subtotal")
    if item_subtotal is None:
        item_subtotal = round(sum(gross_amounts), 2)
    transportation_fee = float(quotation.get("transportation_fee") or 0)
    transport_status, transport_amount, transport_note = transportation_details(quotation)
    discount_total = quotation.get("discount_total")
    if discount_total is None:
        discount_total = round(sum(gross_amounts) - sum(line_totals), 2)
    total_quote = quotation.get("grand_total")
    if total_quote is None:
        total_quote = round(float(item_subtotal) - float(discount_total) + transportation_fee, 2)

    if quotation.get("_po_final") is not None:
        item_subtotal = float(quotation.get("subtotal") or sum(float(item.get("net_amount") or 0) for item in items))
        total_quote = float(quotation.get("grand_total") or (item_subtotal + transportation_fee))
        unit_prices = [float(item.get("unit_price") or 0) for item in items]
        line_totals = [float(item.get("net_amount") if item.get("net_amount") is not None else float(item.get("qty") or 0) * rate)
                       for item, rate in zip(items, unit_prices, strict=True)]
        story: list = [
            _header_block("PRODUCT QUOTATION", "Tiles &amp; Sanitaryware Solutions", styles),
            Spacer(1, 2 * mm),
            HRFlowable(width="100%", thickness=1.1, color=INK, spaceAfter=2.5 * mm),
            Paragraph(f"<b>Customer:</b> {_escape(customer.get('name') or quotation.get('customer_name'))}", styles["cell"]),
            Paragraph(f"<b>Quotation:</b> {_escape(quotation.get('number'))}", styles["cell"]),
            Spacer(1, 4 * mm),
            Paragraph("PRICE &amp; PAYMENT SUMMARY", styles["sectionTitle"]),
            Spacer(1, 2 * mm),
            _price_summary_table(total_quantity, item_subtotal, transportation_fee, total_quote, styles),
            Spacer(1, 3 * mm),
            _po_final_payment_table(quotation, styles["cell"], PAGE_W_MM),
        ]
    else:
        story: list = [
            _header_block("PRODUCT QUOTATION", "Tiles &amp; Sanitaryware Solutions", styles),
            Spacer(1, 2 * mm),
            HRFlowable(width="100%", thickness=1.1, color=INK, spaceAfter=2.5 * mm),
            _meta_grid(quotation, customer, styles, include_staff=False),
            Spacer(1, 2.5 * mm),
            Paragraph(
                "Dear Sir/Madam, thank you for your interest in our products. We are pleased to offer our most competitive "
                "rates for premium tiles and sanitaryware, prepared as per your selection.",
                styles["intro"],
            ),
            Spacer(1, 2.5 * mm),
            Paragraph("PRICE SUMMARY", styles["sectionTitle"]),
            Spacer(1, 1 * mm),
            _price_summary_table(total_quantity, item_subtotal, None, total_quote, styles),
            Spacer(1, 2.5 * mm),
        ]
        story.extend(_brand_terms_signature_block(styles, b, density="compact", has_transport_terms=bool(transport_status or transport_note)))

    # --- PRODUCT DETAILS (page 2+) — one flowing table, auto-paginates ------
    story.append(PageBreak())
    story.append(_header_block("PRODUCT DETAILS", f"Items 1&ndash;{len(items)}" if items else "No items yet", styles))
    story.extend([Spacer(1, 2.5 * mm), HRFlowable(width="100%", thickness=1.1, color=INK, spaceAfter=3 * mm)])

    head = [
        Paragraph("SR.<br/>NO.", styles["colHead"]), Paragraph("PRODUCT IMAGE", styles["colHead"]),
        Paragraph("AREA", styles["colHead"]), Paragraph("PRODUCT DETAIL", styles["colHead"]),
        Paragraph("SIZE", styles["colHead"]), Paragraph("RATE/<br/>SQ.FT", styles["colHeadRed"]),
        Paragraph("OFFER<br/>RATE", styles["colHead"]),
        _SingleLineParagraph("QUANTITY", styles["colHead"]), Paragraph("UNIT", styles["colHead"]),
        _SingleLineParagraph(f"TOTAL ({_currency_symbol()})", styles["colHead"]),
    ]
    if product_quotation:
        head.insert(7, Paragraph("RATE / BOX", styles["colHead"]))
    rows: list[list[object]] = [head]
    for index, (item, unit_price, line_total) in enumerate(zip(items, unit_prices, line_totals, strict=True), 1):
        qty = float(item.get("qty") or 0)
        quantity_unit = _quantity_unit(item.get("quantity_unit"))
        per_sqft = quantity_unit == "Box" and item.get("price_basis") != "box"
        offer_rate = item.get("offer_rate")
        if product_quotation and not per_sqft and unit_price is not None:
            offer_rate = unit_price
        if offer_rate is None:
            offer_rate = item.get("rate_sqft") if item.get("rate_sqft") is not None else unit_price
        rate_sqft_text = _fmt_rate_sqft(item.get("rate_sqft")) if per_sqft else ""
        detail = Paragraph(_escape(tile_product_name(item.get("name"), item.get("size"))), styles["cellBold"])
        size = Paragraph(_escape(item.get("size") or ""), styles["cell"])
        row = [
            Paragraph(str(index), serial_style),
            _item_img(
                item, image_bytes=image_bytes, force_landscape=True,
                width_mm=QUOTATION_PRODUCT_IMAGE_WIDTH_MM,
                height_mm=QUOTATION_PRODUCT_IMAGE_HEIGHT_MM,
                cover=True,
            ),
            Paragraph(_escape(item.get("room") or ""), area_style),
            detail,
            size,
            Paragraph(rate_sqft_text, styles["cellRed"]),
            _SingleLineParagraph(_money(offer_rate) if offer_rate is not None and (product_quotation or offer_rate) else "", styles["cellOffer"]),
            # The detail table separates the count from its fulfillment unit:
            # quantity stays numeric while the adjacent column says box/piece.
            # Keep _quantity_label for the summary, where the combined unit is
            # useful, but do not duplicate it in each product row.
            Paragraph(f"{qty:g}" if qty else "", styles["cellBold"]),
            Paragraph("piece" if quantity_unit == "Pieces" else "box", styles["cellBold"]),
            _SingleLineParagraph(_money(line_total), styles["cell"]),
        ]
        if product_quotation:
            if item.get("finish"):
                row[3] = [detail, Paragraph(_escape(item["finish"]), styles["cell"])]
            row[4] = _SingleLineParagraph(_escape(item.get("size")), styles["cell"])
            rate_box = _money(unit_price) if quantity_unit == "Box" and unit_price is not None else ""
            row.insert(7, _SingleLineParagraph(rate_box, styles["cell"]))
        rows.append(row)

    grid_style = [
        ("GRID", (0, 0), (-1, -1), 0.7, GRID),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    style_cmds = [*grid_style, ("BACKGROUND", (0, 0), (-1, 0), HEADER_GREY)]
    if not product_quotation:
        for r in range(2, len(rows), 2):
            style_cmds.append(("BACKGROUND", (0, r), (0, r), ZEBRA))
    row_heights = [12 * mm] + [32 * mm] * len(items)
    if product_quotation:
        summary_start = len(rows)
        if transport_status or transport_amount is not None or transport_note:
            label = "TRANSPORTATION"
            if transport_status:
                label += f"<br/>{_escape(transport_status)}"
            detail = Paragraph(label, styles["sumLabel"])
            if transport_note:
                detail = [detail, Paragraph(_escape(transport_note), styles["cell"])]
            amount = _SingleLineParagraph(_money(transport_amount), styles["sumValue"]) if transport_amount is not None else ""
            rows.append([detail, *([""] * (len(head) - 2)), amount])
            row_heights.append(8 * mm)
        summary = []
        summary.append(("SUBTOTAL", item_subtotal))
        if discount_total:
            summary.append(("DISCOUNT", discount_total))
        summary.append(("TOTAL QUOTE", total_quote))
        for label, value in summary:
            rows.append([
                Paragraph(label, styles["sumLabel"]), *([""] * (len(head) - 2)),
                _SingleLineParagraph(_money(value), styles["sumValue"]),
            ])
            row_heights.append(8 * mm)
        # Keep the final product and the totals on the same page.
        style_cmds.extend([
            ("NOSPLIT", (0, max(1, summary_start - 1)), (-1, -1)),
            ("BACKGROUND", (0, summary_start), (-1, -1), HEADER_GREY),
        ])
        for row_index in range(summary_start, len(rows)):
            style_cmds.append(("SPAN", (0, row_index), (-2, row_index)))
    table = Table(
        rows,
        colWidths=columns,
        minRowHeights=row_heights,
        repeatRows=1,
    )
    table.setStyle(TableStyle(style_cmds))
    story.append(table)

    if not product_quotation:
        total_row = ["" for _ in head]
        total_row[3] = Paragraph("<b>TOTAL</b>", styles["cell"])
        total_row[-1] = _SingleLineParagraph(f"<b>{_money(item_subtotal)}</b>", styles["cell"])
        total_table = Table([total_row], colWidths=columns, rowHeights=[8 * mm])
        total_table.setStyle(TableStyle([*grid_style, ("BACKGROUND", (0, 0), (-1, -1), HEADER_GREY)]))
        story.append(total_table)

    doc.build(
        story,
        onFirstPage=functools.partial(_draw_tiles_page_chrome, branding=b, product_quotation=product_quotation),
        onLaterPages=functools.partial(_draw_tiles_page_chrome, branding=b, product_quotation=product_quotation),
    )
    return buf.getvalue()
