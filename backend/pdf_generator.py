"""Official BuildCon House quotation PDF — faithful A4 print template."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from decimal import Decimal, InvalidOperation
import functools
from io import BytesIO
import logging
from pathlib import Path
from time import monotonic
from typing import Iterable

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont, TTFontFile
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import (
    Flowable, HRFlowable, Image, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate,
    Spacer, Table, TableStyle,
)
from services.pdf_image_loader import image_loader_metrics, prefetch_urls, remote_image_bytes

logger = logging.getLogger("forge.pdf")

BLUE = colors.HexColor("#1D5D98")
INK = colors.HexColor("#111111")
GREY = colors.HexColor("#6F6F6F")
LINE = colors.HexColor("#8E8E8E")
GRID = colors.HexColor("#9C9C9C")
HEADER_GREY = colors.HexColor("#C8C8C8")
ZEBRA = colors.HexColor("#F0F0F0")
WHITE = colors.white
PDF_DIR = Path(__file__).resolve().parent
LOGO_PATH = PDF_DIR / "buildcon_logo.png"
LOGO_RATIO = 1414 / 412  # native W/H of buildcon_logo.png — size by one edge only
# A single page contract for every customer-facing quotation artifact.  Keep
# this shared instead of allowing individual generators to silently fall back
# to portrait A4.
# Other document generators import this established landscape contract. The
# standard sanitary quotation alone opts into the portrait page below.
LANDSCAPE_A4 = landscape(A4)
PORTRAIT_A4 = A4
PORTRAIT_SCALE = 0.70


def _pw(value_mm: float) -> float:
    return value_mm * PORTRAIT_SCALE


def _register_rupee_font() -> str | None:
    """Register a font that contains U+20B9 in every supported runtime.

    The production Docker image installs DejaVu.  The project-owned Inter
    font keeps local development and non-container rendering just as reliable.
    ReportLab's core Helvetica font does not include the Indian rupee glyph.
    """
    candidates = (
        PDF_DIR.parent / "assets" / "fonts" / "Inter-Regular.ttf",
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/usr/share/fonts/dejavu/DejaVuSans.ttf"),
        Path("/System/Library/Fonts/Supplemental/Georgia.ttf"),
    )
    for candidate in candidates:
        try:
            if not candidate.is_file() or TTFontFile(str(candidate)).charToGlyph.get(0x20B9, 0) == 0:
                continue
            pdfmetrics.registerFont(TTFont("BuildconRupee", str(candidate)))
            return "BuildconRupee"
        except Exception:
            continue
    return None


RUPEE_FONT = _register_rupee_font()

# Original page-1 partner layout from the supplied quotation template.
BRAND_PARTNERS = [
    [("GROHE", "Pure Freude an Wasser"), ("hansgrohe", "Life is Waterful"), ("AXOR", "Form Follows Perfection"), ("VitrA", "Design Meets Life"), ("NEXION", "The Surface Experience"), ("QUTONE", "Let's Build Together")],
    [("DIMORE", "Reflection of Your Style"), ("Oyster", "Indulge in Luxury"), ("GEBERIT", "Engineered for Hygiene"), ("MCM ITTIMI", "Innovation into Inspiration"), ("VERANTES LIVING", "Kitchens &amp; Wardrobes"), ("IMPORTED<br/>FURNITURE", "Crafted Beyond Borders")],
]


def brand_partners_table(base_cell_style: ParagraphStyle, col_width_mm: float = 44.5, grid_color=None) -> Table:
    """The original 2x6 partner grid used on quotation page 1."""
    partner_style = ParagraphStyle("partner", parent=base_cell_style, fontSize=6.6, leading=8, alignment=1)
    rows = [[Paragraph(f"<b>{name}</b><br/><font size='6.5'><i>{tagline}</i></font>", partner_style) for name, tagline in row] for row in BRAND_PARTNERS]
    table = Table(rows, colWidths=[_pw(col_width_mm) * mm] * 6, rowHeights=[12 * mm, 12 * mm])
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.35, grid_color or GRID),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 2),
    ]))
    return table

# --- Dynamic pagination geometry (item/product table, pages 2+) -----------
# Page size + margins are unchanged (preserving the exact print template).
# Detail pages deliberately favour a legible catalogue over an artificially
# high row count: the previous 17-row layout left just 5.2 pt for product
# copy and consumed the whole frame.  Every page below reserves a physical
# buffer above the footer and leaves spare white space for small selections.
PAGE_H_MM = 297.0  # A4 portrait
TOP_MARGIN_MM = 12.0
BOTTOM_MARGIN_MM = 20.0
AREA_HEADER_BLOCK_MM = 25.75    # brand/area title block + rule + spacers above the table
ITEM_HEADER_ROW_MM = 10.0
ITEM_TOTAL_ROW_MM = 8.0
DETAIL_BOTTOM_SAFETY_MM = 8.0
# Six items keeps a clear, consistent product frame and at least 7.5 pt
# wrapped copy. Seven, seventeen and eighteen products intentionally exercise the
# continuation-page path instead of shrinking into an unreadable grid.
# Ten compact rows fit inside the measured printable frame while preserving
# the minimum type size below.  Keeping this as a capacity rather than a
# visual guess prevents needlessly spilling an otherwise ordinary room onto a
# continuation page.
MAX_ITEM_ROWS_PER_PAGE = 10
PRODUCT_IMAGE_ASPECT_RATIO = 16 / 10
PRODUCT_IMAGE_FRAME_WIDTH_MM = 23.0
PRODUCT_IMAGE_FRAME_HEIGHT_MM = 18.0
STANDARD_PRODUCT_IMAGE_WIDTH_MM = PRODUCT_IMAGE_FRAME_WIDTH_MM
STANDARD_PRODUCT_IMAGE_HEIGHT_MM = PRODUCT_IMAGE_FRAME_HEIGHT_MM
# Sparse rooms retain the same generous identification frame. They are not
# inflated to fill the page, so product photography remains consistent across
# one-product and six-product rooms.
MAX_SPARSE_PAGE_IMAGE_HEIGHT_MM = PRODUCT_IMAGE_FRAME_HEIGHT_MM
COMPACT_SPARSE_ITEM_LIMIT = 5
COMPACT_SPARSE_ITEM_ROW_MM = 25.0
# This is a print-safety lower bound.  Actual rows use the space available
# after the footer buffer but are never allowed below it.
ITEM_ROW_MM = 20.0
# Sanitary quotations are frequently printed, carried around a site, and
# reviewed from arm's length.  Keep every product-table value at a readable
# print size; pagination already protects that floor by using six rows.
MIN_DETAIL_FONT_SIZE_PT = 7.5
SUMMARY_HEADER_ROW_MM = 7.0
SUMMARY_ROW_MM = 5.6
SUMMARY_TOTAL_ROW_MM = 6.2


def _max_item_rows_per_page() -> int:
    # Row height is allocated dynamically by `_item_row_height_mm`; capacity
    # is therefore the business/print limit, not a stale minimum-row division.
    return MAX_ITEM_ROWS_PER_PAGE


def _item_row_height_mm(item_count: int) -> float:
    """Height assigned to each real product row on one sanitary detail page."""
    usable = (
        PAGE_H_MM - TOP_MARGIN_MM - BOTTOM_MARGIN_MM - DETAIL_BOTTOM_SAFETY_MM
        - AREA_HEADER_BLOCK_MM - ITEM_HEADER_ROW_MM - ITEM_TOTAL_ROW_MM
    )
    if item_count <= COMPACT_SPARSE_ITEM_LIMIT:
        return COMPACT_SPARSE_ITEM_ROW_MM
    return max(ITEM_ROW_MM, usable / item_count)


def format_indian_money(value: object) -> str:
    """Format a numeric value using Indian digit grouping, without currency."""
    try:
        amount = Decimal(str(value if value is not None else 0)).quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError, ValueError):
        amount = Decimal("0.00")
    sign = "-" if amount < 0 else ""
    whole, fraction = f"{abs(amount):.2f}".split(".")
    if len(whole) > 3:
        tail, head = whole[-3:], whole[:-3]
        groups: list[str] = []
        while head:
            groups.append(head[-2:])
            head = head[:-2]
        whole = ",".join(reversed(groups)) + "," + tail
    return f"{sign}{whole}.{fraction}"


def _money(value: object) -> str:
    """One unbreakable, PDF-safe Indian currency amount.

    ReportLab may split an ordinary space at a narrow table-cell boundary,
    leaving the rupee glyph above its number.  The non-breaking space keeps
    the sign and amount together in every rate/total column.
    """
    symbol = f"<font name='{RUPEE_FONT}'>₹</font>" if RUPEE_FONT else "Rs."
    return f"{symbol}&nbsp;{format_indian_money(value)}"


def _standard_money(value: object) -> str:
    """PDF-safe Indian currency amount for sanitary quotation cells."""
    return _money(value)


def _escape(value: object) -> str:
    return str(value or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _ellipsize(value: object, limit: int) -> str:
    """Escape a bounded, table-safe representation of user-provided text.

    Detail rows have an intentionally fixed maximum height so a full 17-row
    page remains printable.  Paragraphs otherwise overflow the row for a
    very long SKU/name/finish; ellipsizing preserves the useful prefix and
    makes that capacity explicit instead of allowing drawing over grid lines.
    """
    text = " ".join(str(value or "").split())
    if len(text) > limit:
        text = text[: max(0, limit - 1)].rstrip() + "…"
    return _escape(text)


def quotation_pdf_filename(customer_name: object) -> str:
    """Return the sanitary quotation download name, based on the customer.

    Keep this deliberately separate from the document number: customers use
    the PDF as a shareable selection sheet, so its filename should identify
    the customer in the same way the Ground Floor documents do.  Strip only
    characters that are invalid or unsafe in a cross-platform filename.
    """
    name = " ".join(str(customer_name or "Customer").split())
    safe = " ".join("".join(ch for ch in name if ch not in '\\\\/:*?\"<>|').split()).strip(".")
    return f"{safe or 'Customer'}.pdf"


# Kept as a local alias so quotation/PDF callers and existing tests can
# instrument image loading without importing the security implementation.
_remote_image_bytes = remote_image_bytes


def _prepare_image_bytes(data: bytes, *, force_landscape: bool = False) -> bytes:
    """Apply the persisted landscape product-image contract to PDF inputs.

    Quotation snapshots can reference media created before upload
    normalization, so PDFs repeat the shared transform defensively.
    """
    from PIL import Image as PILImage
    from services.product_image_normalizer import normalize_product_image

    try:
        with PILImage.open(BytesIO(data)) as image:
            fmt = (image.format or "").upper()
        mime = {"JPG": "image/jpeg", "JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "GIF": "image/gif"}.get(fmt)
        if not mime:
            return data
        normalized, _ = normalize_product_image(data, mime, force_landscape=force_landscape)
        return normalized
    except Exception:
        return data


def prefetch_product_images(items: Iterable[dict], *, workers: int = 6, timeout: float = 8.0) -> None:
    """Warm the bounded image cache concurrently under one total deadline.

    ReportLab itself remains synchronous, but after this pass every `_img`
    lookup is normally an in-memory cache hit. Missing, corrupt and timed-out
    images retain the existing placeholder behavior.
    """
    urls = list(dict.fromkeys(
        str(item.get("image")) for item in items
        if str(item.get("image") or "").startswith(("https://", "http://"))
    ))
    if not urls:
        return
    prefetch_urls(urls, _remote_image_bytes, workers=workers, timeout=timeout)


def contain_box(
    source_width: float,
    source_height: float,
    box_width: float,
    box_height: float,
    inset: float = 0,
) -> tuple[float, float, float, float]:
    """Return a centered aspect-preserving box inside a target rectangle."""
    inner_width = max(0.0, box_width - (inset * 2))
    inner_height = max(0.0, box_height - (inset * 2))
    if source_width <= 0 or source_height <= 0 or inner_width <= 0 or inner_height <= 0:
        return inset, inset, 0.0, 0.0
    scale = min(inner_width / source_width, inner_height / source_height)
    width = source_width * scale
    height = source_height * scale
    return (
        inset + (inner_width - width) / 2,
        inset + (inner_height - height) / 2,
        width,
        height,
    )


class _ProductImageFrame(Flowable):
    """A fixed, landscape product-image frame with a centred ``contain`` fit.

    Giving ReportLab a frame (rather than a differently-sized ``Image`` for
    every source) makes image placement deterministic inside table cells.  A
    source is never rotated, stretched, or cropped: EXIF orientation is baked
    in by :func:`_prepare_image_bytes`, then the upright source is fitted at
    the largest possible size in the landscape frame.
    """

    def __init__(self, data: bytes, width_mm: float, height_mm: float):
        super().__init__()
        self.reader = ImageReader(BytesIO(data))
        self.width = width_mm * mm
        self.height = height_mm * mm
        # Match ReportLab Image's public geometry attributes so instrumentation
        # and layout checks can inspect every image flowable consistently.
        self.drawWidth = self.width
        self.drawHeight = self.height
        self.source_width, self.source_height = self.reader.getSize()

    def wrap(self, avail_width, avail_height):
        return self.width, self.height

    def draw(self):
        # A white, finely outlined frame makes every cell look consistent
        # even when a supplier asset has a non-white background.  The source
        # pixels remain untouched: this is strictly a contain fit.
        self.canv.saveState()
        self.canv.setFillColor(WHITE)
        self.canv.setStrokeColor(colors.HexColor("#B8C1C9"))
        self.canv.setLineWidth(0.35)
        self.canv.roundRect(0, 0, self.width, self.height, 1.2 * mm, fill=1, stroke=1)
        if self.source_width <= 0 or self.source_height <= 0:
            self.canv.restoreState()
            return
        x, y, drawn_width, drawn_height = contain_box(
            self.source_width, self.source_height, self.width, self.height, inset=1.5 * mm,
        )
        self.canv.drawImage(
            self.reader, x, y,
            width=drawn_width, height=drawn_height, mask="auto",
        )
        self.canv.restoreState()


class _ImageUnavailableFrame(Flowable):
    """A clean, same-size fallback for missing, broken, or blocked media."""

    def __init__(self, width_mm: float, height_mm: float):
        super().__init__()
        self.width = self.drawWidth = width_mm * mm
        self.height = self.drawHeight = height_mm * mm

    def wrap(self, avail_width, avail_height):
        return self.width, self.height

    def draw(self):
        self.canv.saveState()
        self.canv.setFillColor(colors.HexColor("#FAFAFA"))
        self.canv.setStrokeColor(colors.HexColor("#B8C1C9"))
        self.canv.setLineWidth(0.35)
        self.canv.roundRect(0, 0, self.width, self.height, 1.2 * mm, fill=1, stroke=1)
        self.canv.setFillColor(GREY)
        self.canv.setFont("Helvetica-Oblique", MIN_DETAIL_FONT_SIZE_PT)
        self.canv.drawCentredString(self.width / 2, (self.height - MIN_DETAIL_FONT_SIZE_PT) / 2, "Image unavailable")
        self.canv.restoreState()


# Backwards-compatible name for integrations that imported the previous
# private flowable.  Its behaviour is intentionally now non-destructive.
_CoverImage = _ProductImageFrame


def _img(
    url: str | None,
    width_mm: float = STANDARD_PRODUCT_IMAGE_WIDTH_MM,
    height_mm: float = STANDARD_PRODUCT_IMAGE_HEIGHT_MM,
    force_landscape: bool = False,
    cover: bool = False,
) -> Flowable:
    """Render the supplied product image inside the quotation image cell.

    Every successful image receives a fixed landscape frame.  This removes
    table-cell alignment ambiguity and lets portrait and landscape products
    use the largest non-distorted fit without losing product detail.
    """
    if url and str(url).startswith(("https://", "http://")):
        data = _remote_image_bytes(str(url))
        if data:
            try:
                prepared = _prepare_image_bytes(data, force_landscape=force_landscape)
                return _ProductImageFrame(prepared, width_mm, height_mm)
            except Exception:
                pass
    return _ImageUnavailableFrame(width_mm, height_mm)


def _draw_footer(cv, doc, branding: dict | None = None) -> None:
    b = branding or {}
    cv.saveState()
    page_width, _ = doc.pagesize
    cv.setStrokeColor(LINE)
    cv.setLineWidth(0.45)
    cv.line(0, 15 * mm, page_width, 15 * mm)
    cv.setFillColor(INK)
    cv.setFont("Helvetica-Bold", 8)
    cv.drawString(doc.leftMargin, 10.5 * mm, b.get("footer_company_name") or "Buildcon House")
    cv.setFillColor(INK)
    cv.setFont("Helvetica", 7)
    cv.drawString(doc.leftMargin, 6.5 * mm, f"M: {b.get('footer_phone') or '+91 99099 06652'}   |   {b.get('footer_email') or 'buildconhouse10@gmail.com'}")
    right = page_width - doc.rightMargin
    cv.setFont("Helvetica", 7)
    cv.drawRightString(right, 10.5 * mm, f"Page {doc.page}")
    cv.setFillColor(BLUE)
    cv.setFont("Helvetica-Oblique", 7)
    cv.drawRightString(right, 6.5 * mm, b.get("footer_tagline") or "One Destination. Infinite Possibilities.")
    cv.restoreState()


# The approved page-one template uses a compact, diagonal watermark behind the
# commercial content.  A page-wide horizontal logo competed with the summary
# table and made the BuildCon mark look clipped rather than intentional.
WATERMARK_MAX_PAGE_WIDTH = 0.44
WATERMARK_ANGLE_DEGREES = 24


def watermark_geometry(page_width: float, page_height: float) -> tuple[float, float, float, float]:
    """Return a centred, unclipped placement for the original house logo.

    The logo is intentionally a wide lock-up.  Sizing it from page height
    makes it wider than landscape A4 and causes ReportLab to clip its sides,
    so use the available page width as the limiting dimension instead.
    """
    width = page_width * WATERMARK_MAX_PAGE_WIDTH
    height = width / LOGO_RATIO
    return (page_width - width) / 2, (page_height - height) / 2, width, height


def _draw_room_watermark(cv, doc, branding: dict | None = None) -> None:
    b = branding or {}
    if not b.get("show_watermark", True):
        return
    if not LOGO_PATH.exists():
        return
    cv.saveState()
    # Keep the complete original logo inside the landscape sheet.  This is a
    # watermark, not a cover image: clipping any edge changes the logo.
    if hasattr(cv, "setFillAlpha"):
        cv.setFillAlpha(0.075)
    page_width, page_height = doc.pagesize
    watermark_x, watermark_y, watermark_w, watermark_h = watermark_geometry(page_width, page_height)
    watermark_cx = watermark_x + watermark_w / 2
    watermark_cy = watermark_y + watermark_h / 2
    cv.translate(watermark_cx, watermark_cy)
    cv.rotate(WATERMARK_ANGLE_DEGREES)
    cv.drawImage(str(LOGO_PATH), -watermark_w / 2, -watermark_h / 2, width=watermark_w, height=watermark_h, mask="auto")
    cv.restoreState()


def _draw_quotation_page_chrome(cv, doc, branding: dict | None = None) -> None:
    """Shared footer/watermark chrome for the summary and area pages."""
    _draw_room_watermark(cv, doc, branding)
    _draw_footer(cv, doc, branding)


def _brand_header(right_title: str, styles: dict, style_key: str = "titleRight") -> Table:
    logo: Flowable
    if LOGO_PATH.exists():
        logo_width = 43 * mm
        logo = Image(str(LOGO_PATH), width=logo_width, height=logo_width / LOGO_RATIO, kind="proportional")
    else:
        logo = Paragraph("<b>BUILDCON HOUSE</b><br/><font size='8'>Let You Live Better</font>", styles["brandFallback"])
    table = Table([[logo, Paragraph(right_title, styles[style_key])]], colWidths=[_pw(165) * mm, _pw(102) * mm])
    table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6), ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
    return table


def _room_totals(items: Iterable[dict]) -> tuple[float, float, float]:
    """Returns (mrp_total, discount, net). `mrp_total` uses each line's real
    catalog MRP (falling back to unit_price for older quotations saved before
    the mrp field existed) — it is NOT the pre-discount offer subtotal."""
    mrp_total = subtotal = discount = 0.0
    for item in items:
        qty = float(item.get("qty") or 0)
        unit_price = float(item.get("unit_price") or 0)
        mrp = float(item.get("mrp") or unit_price)
        gross = qty * unit_price
        disc = gross * float(item.get("discount_pct") or 0) / 100
        mrp_total += qty * mrp
        subtotal += gross
        discount += disc
    return mrp_total, discount, subtotal - discount


def _format_pdf_date(raw: str | None) -> str:
    """Human-readable "15 Jul 2026" — matches the en-IN date formatting used
    everywhere else in the app (Quotations list, Customer Portal, etc.)
    instead of a raw ISO slice like "2026-07-15" which is what every
    quotation PDF showed before this fix."""
    value = raw or datetime.now().isoformat()
    try:
        # Handles both "...Z" and "+00:00"-style offsets.
        cleaned = value.replace("Z", "+00:00")
        return datetime.fromisoformat(cleaned).strftime("%d %b %Y")
    except (ValueError, TypeError):
        return value[:10] if isinstance(value, str) else datetime.now().strftime("%d %b %Y")


def build_quotation_pdf(quotation: dict, customer: dict, branding: dict | None = None) -> bytes:
    """Render the supplied BuildCon House A4 quotation template.

    Page one is the commercial summary / contractual page, with a dynamic
    per-room summary table (exactly one row per room — never padded, never
    truncated). Each room then starts on its own itemised page(s); item rows
    are fully dynamic (only real products render, no blank filler rows) and
    paginate automatically once a room's item count exceeds one page's real
    capacity (`_max_item_rows_per_page`), repeating the brand/area header and
    column headers on every continuation page while keeping SR NO. counting
    up instead of restarting. Pricing columns switch automatically for the
    whole document depending on whether ANY line item carries a discount —
    MRP/Offer Rate/Offer Total when discounted, plain Rate/Total otherwise —
    never mixing the two within a single PDF.

    `branding` (optional) is the merged Settings > Company + Settings > PDF
    dict — footer text, watermark on/off, an appended "additional terms" line,
    and an appended signatory line. Every key has a fallback identical to what
    was hardcoded here before Settings > PDF existed, so passing None (or a
    partial dict) renders the same document as before.
    """
    started_at = monotonic()
    b = branding or {}
    prefetch_product_images(quotation.get("items") or [])
    if quotation.get("include_dimensions"):
        dimension_urls = [
            url for item in quotation.get("items") or []
            for url in (item.get("dimension_image_urls") or []) + (item.get("seat_cover_image_urls") or [])
            if str(url).startswith(("https://", "http://"))
        ]
        prefetch_urls(dimension_urls, _remote_image_bytes)
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=PORTRAIT_A4, leftMargin=10 * mm, rightMargin=10 * mm,
        topMargin=TOP_MARGIN_MM * mm, bottomMargin=BOTTOM_MARGIN_MM * mm, title=quotation.get("number", "Quotation"),
        author=b.get("footer_company_name") or "Buildcon House",
    )
    base = getSampleStyleSheet()
    styles = {
        "brandFallback": ParagraphStyle("brandFallback", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=14, leading=15, textColor=INK),
        "titleRight": ParagraphStyle("titleRight", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=14, leading=16, textColor=INK, alignment=2),
        "areaTitle": ParagraphStyle("areaTitle", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=15.5, leading=17.5, textColor=INK, alignment=2),
        "label": ParagraphStyle("label", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=7.4, leading=8.6, textColor=INK),
        "body": ParagraphStyle("body", parent=base["Normal"], fontName="Helvetica", fontSize=9.2, leading=11.5, textColor=INK),
        "small": ParagraphStyle("small", parent=base["Normal"], fontName="Helvetica", fontSize=7.5, leading=9, textColor=INK),
        "terms": ParagraphStyle("terms", parent=base["Normal"], fontName="Helvetica", fontSize=7.0, leading=8.1, textColor=INK),
        "tiny": ParagraphStyle("tiny", parent=base["Normal"], fontName="Helvetica", fontSize=7.5, leading=9, textColor=INK, alignment=1),
        "itemDescription": ParagraphStyle("itemDescription", parent=base["Normal"], fontName="Helvetica", fontSize=MIN_DETAIL_FONT_SIZE_PT, leading=8.5, textColor=INK, alignment=1, wordWrap="CJK"),
        "itemSku": ParagraphStyle("itemSku", parent=base["Normal"], fontName="Helvetica", fontSize=MIN_DETAIL_FONT_SIZE_PT, leading=8.2, textColor=INK, alignment=1, wordWrap="CJK"),
        "itemMoney": ParagraphStyle("itemMoney", parent=base["Normal"], fontName="Helvetica", fontSize=MIN_DETAIL_FONT_SIZE_PT, leading=8.2, textColor=INK, alignment=1),
        "itemQty": ParagraphStyle("itemQty", parent=base["Normal"], fontName="Helvetica", fontSize=MIN_DETAIL_FONT_SIZE_PT, leading=8.2, textColor=INK, alignment=1),
        "section": ParagraphStyle("section", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=10, leading=12, textColor=INK),
        "cell": ParagraphStyle("cell", parent=base["Normal"], fontName="Helvetica", fontSize=8.0, leading=9.4, textColor=INK, alignment=1),
        "cellRight": ParagraphStyle("cellRight", parent=base["Normal"], fontName="Helvetica", fontSize=8.0, leading=9.4, textColor=INK, alignment=2),
        "cellCenter": ParagraphStyle("cellCenter", parent=base["Normal"], fontName="Helvetica", fontSize=8.0, leading=9.4, textColor=INK, alignment=1),
        # 7.5 pt is the largest readable header size that keeps "PRODUCT
        # IMAGE" on one line in its fixed 25 mm image column.
        "tableHead": ParagraphStyle("tableHead", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=7.5, leading=9.0, textColor=INK, alignment=1),
        "signature": ParagraphStyle("signature", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=7.5, leading=9, textColor=INK, alignment=2),
    }
    # Discount-aware layout mode — decided ONCE for the whole document so the
    # summary table and every item table switch columns consistently (never
    # mixed within a single PDF). Signal: the quotation's own resolved
    # discount_total, backed up by a direct scan of line-item discount_pct
    # (both should always agree since callers resolve effective pct into
    # each item before invoking this function — see _enriched_items_for_pdf).
    has_discount = float(quotation.get("discount_total") or 0) > 0.005 or any(
        float(item.get("discount_pct") or 0) > 0 for item in quotation.get("items", [])
    )
    story: list[Flowable] = []
    created = _format_pdf_date(quotation.get("created_at"))
    room_order = list(quotation.get("rooms") or [])
    grouped_with_position: dict[str, list[tuple[int, dict]]] = defaultdict(list)
    for source_position, item in enumerate(quotation.get("items", [])):
        grouped_with_position[item.get("room") or "General"].append((source_position, item))

    def _item_sort_key(entry: tuple[int, dict]) -> tuple[int, int]:
        """Respect staff drag/drop order without letting malformed values shuffle a page."""
        source_position, item = entry
        try:
            return int(item.get("sort_order", source_position)), source_position
        except (TypeError, ValueError):
            return source_position, source_position

    # Products always stay with their selected room (mixing bathrooms simply
    # to fill a page made the document harder to read), while order inside the
    # room follows the persisted canvas order rather than incidental API order.
    grouped: dict[str, list[dict]] = {
        room: [item for _, item in sorted(entries, key=_item_sort_key)]
        for room, entries in grouped_with_position.items()
    }
    for room in grouped:
        if room not in room_order:
            room_order.append(room)
    room_order = [r for r in room_order if grouped.get(r)]  # never render a room with 0 items

    # --- PAGE 1: supplied BuildCon House quotation cover ---------------------
    # Keep this cover deliberately close to the approved quotation's first
    # page: the broad header, two four-field information bands, clear price
    # summary and roomy contractual block are the visual system.  Product
    # images belong on the itemised pages, where up to 17 real selections can
    # be read without turning the cover into a cramped catalogue.
    story.append(_brand_header("PRODUCT QUOTATION<br/><font name='Helvetica' size='8'>Tiles &amp; Sanitaryware Solutions</font>", styles))
    story.extend([Spacer(1, 3 * mm), HRFlowable(width="100%", thickness=1.25, color=BLUE), Spacer(1, 2.5 * mm)])
    meta = [
        [Paragraph("CUSTOMER NAME", styles["label"]), Paragraph("CONTACT NO.", styles["label"]), Paragraph("SELECTION / QUOTATION DATE", styles["label"]), Paragraph("QUOTATION NO.", styles["label"])],
        [Paragraph(_escape(customer.get("company") or customer.get("name") or quotation.get("customer_name")), styles["body"]), Paragraph(_escape(quotation.get("phone_snapshot") or customer.get("phone") or ""), styles["body"]), Paragraph(created, styles["body"]), Paragraph(_escape(quotation.get("number")), styles["body"])],
        [Paragraph("REFERENCE", styles["label"]), Paragraph("ATTENDED BY", styles["label"]), Paragraph("PREPARED BY", styles["label"]), Paragraph("ADDRESS", styles["label"])],
        [Paragraph(_escape(quotation.get("reference_source") or ""), styles["body"]), Paragraph(_escape(quotation.get("referrer_name") or ""), styles["body"]), Paragraph(_escape(b.get("footer_company_name") or "Buildcon House"), styles["body"]), Paragraph(_escape(quotation.get("address_snapshot") or customer.get("address") or ""), styles["body"])],
    ]
    meta_row_heights = [5 * mm, 5 * mm, 5 * mm, 6 * mm]
    meta_style = [
        ("LINEBELOW", (0, 1), (-1, 1), 0.4, LINE),
        ("LINEBELOW", (0, 3), (-1, 3), 0.4, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 1), ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]
    meta_table = Table(meta, colWidths=[_pw(66.75) * mm] * 4, rowHeights=meta_row_heights)
    meta_table.setStyle(TableStyle(meta_style))
    story.extend([meta_table, Spacer(1, 2 * mm)])
    story.append(Paragraph("Dear Sir/Madam, thank you for your interest in our products. We are pleased to offer our most competitive rates for premium tiles and sanitaryware, prepared as per your selection.", styles["body"]))
    story.extend([Spacer(1, 3 * mm), Paragraph("PRICE SUMMARY", styles["section"]), Spacer(1, 1.5 * mm)])

    # ---- Dynamic Quotation Summary: exactly one row per room, no filler ----
    n_rooms = len(room_order)
    if has_discount:
        summary_header = ["SL. NO.", "BATHROOM / AREA", "MRP (Rs.)", "OFFER TOTAL (Rs.)"]
        summary_col_widths = [_pw(v) * mm for v in (20, 120, 63, 64)]
    else:
        summary_header = ["SL. NO.", "BATHROOM / AREA", "TOTAL (Rs.)"]
        summary_col_widths = [_pw(v) * mm for v in (20, 135, 112)]
    summary_rows: list[list[object]] = [[Paragraph(h, styles["tableHead"]) for h in summary_header]]
    for index, room in enumerate(room_order):
        gross, _, net = _room_totals(grouped.get(room, []))
        if has_discount:
            summary_rows.append([
                Paragraph(str(index + 1), styles["cellCenter"]), Paragraph(_ellipsize(room, 180), styles["cell"]),
                Paragraph(_standard_money(gross), styles["cellCenter"]), Paragraph(_standard_money(net), styles["cellCenter"]),
            ])
        else:
            summary_rows.append([
                Paragraph(str(index + 1), styles["cellCenter"]), Paragraph(_ellipsize(room, 180), styles["cell"]),
                Paragraph(_standard_money(net), styles["cellCenter"]),
            ])
    if has_discount:
        summary_rows.extend([
            ["", Paragraph("<b>TOTAL</b>", styles["cellCenter"]), Paragraph(f"<b>{_standard_money(quotation.get('subtotal', 0))}</b>", styles["cellCenter"]), Paragraph(f"<b>{_standard_money(quotation.get('grand_total', 0))}</b>", styles["cellCenter"])],
            ["", Paragraph("<b>SPECIAL OFFER TOTAL</b>", styles["cellCenter"]), "", Paragraph(f"<b>{_standard_money(quotation.get('grand_total', 0))}</b>", styles["cellCenter"])],
        ])
    else:
        summary_rows.extend([
            ["", Paragraph("<b>TOTAL</b>", styles["cellCenter"]), Paragraph(f"<b>{_standard_money(quotation.get('subtotal', 0))}</b>", styles["cellCenter"])],
            ["", Paragraph("<b>GRAND TOTAL</b>", styles["cellCenter"]), Paragraph(f"<b>{_standard_money(quotation.get('grand_total', 0))}</b>", styles["cellCenter"])],
        ])
    summary_row_heights = [SUMMARY_HEADER_ROW_MM * mm] + [SUMMARY_ROW_MM * mm] * n_rooms + [SUMMARY_TOTAL_ROW_MM * mm] * 2
    summary_style_cmds = [
        ("GRID", (0, 0), (-1, -1), 0.35, GRID), ("BACKGROUND", (0, 0), (-1, 0), HEADER_GREY),
        ("BACKGROUND", (0, -2), (-1, -1), HEADER_GREY), ("ALIGN", (0, 0), (0, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
    ]
    for r in range(2, n_rooms + 1, 2):  # zebra every 2nd room row (1-indexed data rows)
        summary_style_cmds.append(("BACKGROUND", (0, r), (-1, r), ZEBRA))
    summary = Table(summary_rows, colWidths=summary_col_widths, rowHeights=summary_row_heights, repeatRows=1)
    summary.setStyle(TableStyle(summary_style_cmds))
    story.extend([summary, Spacer(1, 2 * mm), Paragraph("OUR BRAND PARTNERS", styles["section"]), Spacer(1, 0.8 * mm)])
    story.extend([brand_partners_table(styles["cell"]), Spacer(1, 1.2 * mm)])

    terms = [
        "1. Prices quoted are based on the current NET prices at the time of selection.",
        "2. Prices are subject to revision by any brand without prior notice.",
        "3. 100% advance payment is required to confirm orders.",
        "4. Freight and unloading charges will be applicable as per actuals.",
        "5. Delivery timelines are subject to the manufacturer's schedule.",
        "6. Rates are valid for 5 days, unless stated otherwise in writing.",
        "7. Above rates are inclusive of GST @18%, unless stated otherwise.",
        "8. All orders and deliveries are subject to material availability.",
        "9. Prices are subject to change in case of changes in government levy.",
        "10. Cheques should be written in favour of Buildcon House.",
        "11. On confirmation of purchase order, material will be delivered within 15 days.",
        "12. Labour cost is extra and not included in this quotation.",
    ]
    if b.get("terms_text"):
        terms.append(f"Additional terms: {_escape(b['terms_text'])}")
    # Use the full landscape width for contractual copy. The earlier narrow
    # left panel forced terms into cramped lines while the adjacent customer
    # care panel left a conspicuous amount of unused space.
    terms_rows = []
    for index in range(0, len(terms), 2):
        terms_rows.append([
            Paragraph(terms[index], styles["terms"]),
            Paragraph(terms[index + 1], styles["terms"]) if index + 1 < len(terms) else "",
        ])
    terms_table = Table(terms_rows, colWidths=[_pw(133.5) * mm, _pw(133.5) * mm])
    terms_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        # Keep the contractual block together on page one even when an
        # address/reference adds metadata rows. The previous 12 mm of table
        # padding forced only the signature into an otherwise blank page two.
        ("TOPPADDING", (0, 0), (-1, -1), 0.4), ("BOTTOMPADDING", (0, 0), (-1, -1), 0.4),
    ]))
    enquiries = Paragraph(
        f"For general enquiries: M: {_escape(b.get('footer_phone') or '+91 99099 06652')}  |  Email: {_escape(b.get('footer_email') or 'buildconhouse10@gmail.com')}",
        styles["small"],
    )
    signature = Table([[Paragraph("I/We have reviewed and agree to the terms and conditions mentioned in this quotation.", styles["small"]), Paragraph("CUSTOMER SIGNATURE &amp; DATE", styles["signature"])]], colWidths=[_pw(160) * mm, _pw(107) * mm], rowHeights=[8 * mm])
    signature.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.45, GRID), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 1.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5)]))
    story.extend([
        Paragraph("TERMS &amp; CONDITIONS", styles["section"]), Spacer(1, 0.8 * mm), terms_table,
        Spacer(1, 1.5 * mm), enquiries, Spacer(1, 1.5 * mm), signature,
    ])
    if b.get("signature_name"):
        sig_line = _escape(b["signature_name"]) + (f", {_escape(b['signature_title'])}" if b.get("signature_title") else "")
        story.append(Paragraph(f"For {_escape(b.get('footer_company_name') or 'Buildcon House')} — {sig_line}", ParagraphStyle("sigLine", parent=styles["small"], alignment=2, spaceBefore=2)))

    # --- PAGES 2+: dynamic item rows per area page -----------------------------
    # Every room renders only its real item rows, paginated at
    # `_max_item_rows_per_page()` capacity (derived from real print geometry,
    # not a hardcoded count) — no blank filler rows, ever. Continuation pages
    # of the same room repeat the brand/area header + column headers and
    # continue the SR NO sequence rather than restarting at 1.
    if has_discount:
        item_header = [
            Paragraph("SR.<br/>NO.", styles["tableHead"]), Paragraph("PRODUCT IMAGE", styles["tableHead"]),
            Paragraph("ARTICLE<br/>NO.", styles["tableHead"]), Paragraph("DESCRIPTION", styles["tableHead"]),
            Paragraph("MRP<br/>(Rs.)", styles["tableHead"]), Paragraph("QTY", styles["tableHead"]),
            Paragraph("MRP<br/>TOTAL (Rs.)", styles["tableHead"]),
            Paragraph("OFFER<br/>RATE", styles["tableHead"]), Paragraph("OFFER<br/>TOTAL (Rs.)", styles["tableHead"]),
        ]
        # The 43 mm article column holds a full 7.5 pt SKU on one line; its
        # three millimetres come from the still-generous description column.
        item_widths = [_pw(v) * mm for v in (12, 25, 43, 74, 24, 12, 25, 26, 26)]
    else:
        item_header = [
            Paragraph("SR.<br/>NO.", styles["tableHead"]), Paragraph("PRODUCT IMAGE", styles["tableHead"]),
            Paragraph("ARTICLE<br/>NO.", styles["tableHead"]), Paragraph("DESCRIPTION", styles["tableHead"]),
            Paragraph("RATE<br/>(Rs.)", styles["tableHead"]), Paragraph("QTY", styles["tableHead"]),
            Paragraph("TOTAL<br/>(Rs.)", styles["tableHead"]),
        ]
        item_widths = [_pw(v) * mm for v in (12, 25, 43, 107, 28, 12, 40)]
    max_rows = _max_item_rows_per_page()
    for area_index, room in enumerate(room_order, 1):
        room_items = grouped.get(room, [])
        blocks = [room_items[i:i + max_rows] for i in range(0, len(room_items), max_rows)] or [[]]
        sr_offset = 0
        for block_index, block in enumerate(blocks):
            story.append(PageBreak())
            # The large area title has a fixed vertical band above a readable
            # six-row table; one line retains that capacity.
            area_label = f"AREA {area_index}: <u>{_ellipsize(room, 58)}</u>"
            if block_index:
                area_label += " <font size='9'>(continued)</font>"
            story.append(_brand_header(area_label, styles, style_key="areaTitle"))
            story.extend([Spacer(1, 4 * mm), HRFlowable(width="100%", thickness=1.25, color=BLUE), Spacer(1, 3 * mm)])
            n_data_rows = len(block)
            item_row_mm = _item_row_height_mm(n_data_rows)
            # The product image always gets the same explicit frame.  This is
            # intentionally independent of the number of products in a room:
            # a single selected faucet must not look unlike the same faucet in
            # a six-product bathroom.
            # Table columns use the portrait scale; the image frame must use
            # the same coordinate system.  Previously it remained 23×18 mm
            # inside a 17.5 mm-wide column, physically painting across the
            # article number and pricing cells.
            image_width_mm = _pw(PRODUCT_IMAGE_FRAME_WIDTH_MM)
            image_height_mm = _pw(PRODUCT_IMAGE_FRAME_HEIGHT_MM)
            rows: list[list[object]] = [item_header]
            for offset_in_block, item in enumerate(block):
                sr_no = sr_offset + offset_in_block + 1
                qty = float(item.get("qty") or 0)
                base_rate = float(item.get("unit_price") or 0)
                pct = float(item.get("discount_pct") or 0)
                offer_rate = base_rate * (1 - pct / 100)   # discounted per-unit rate
                line_total = qty * offer_rate
                listed_mrp = float(item.get("mrp") or base_rate)
                # Normal selections wrap naturally; caps are deliberately
                # high enough that ellipsis is a true final safeguard against
                # unbounded pasted catalogue copy, not the normal rendering.
                description = _ellipsize(item.get("description") or item.get("name"), 175)
                finish = item.get("finish") or item.get("colour") or ""
                if finish:
                    description = _ellipsize(
                        f"{item.get('description') or item.get('name') or ''} | Finish: {finish}", 210,
                    )
                if has_discount:
                    rows.append([
                        Paragraph(str(sr_no), styles["cellCenter"]), _img(
                            item.get("image"),
                            width_mm=image_width_mm, height_mm=image_height_mm,
                            cover=False,
                        ),
                        Paragraph(_ellipsize(item.get("sku"), 80), styles["itemSku"]), Paragraph(description, styles["itemDescription"]),
                        Paragraph(_standard_money(listed_mrp), styles["itemMoney"]), Paragraph(f"{qty:g}", styles["itemQty"]),
                        Paragraph(_standard_money(qty * listed_mrp), styles["itemMoney"]),
                        Paragraph(_standard_money(offer_rate), styles["itemMoney"]), Paragraph(_standard_money(line_total), styles["itemMoney"]),
                    ])
                else:
                    rows.append([
                        Paragraph(str(sr_no), styles["cellCenter"]), _img(
                            item.get("image"), width_mm=image_width_mm, height_mm=image_height_mm, cover=False,
                        ),
                        Paragraph(_ellipsize(item.get("sku"), 80), styles["itemSku"]), Paragraph(description, styles["itemDescription"]),
                        Paragraph(_standard_money(base_rate), styles["itemMoney"]), Paragraph(f"{qty:g}", styles["itemQty"]),
                        Paragraph(_standard_money(qty * base_rate), styles["itemMoney"]),
                    ])
            block_net = sum(
                float(item.get("qty") or 0) * float(item.get("unit_price") or 0) * (1 - float(item.get("discount_pct") or 0) / 100)
                for item in block
            )
            total_label_col = 3  # DESCRIPTION column — same position in both layouts
            last_col = len(item_header) - 1
            total_row: list[object] = ["" for _ in item_header]
            total_row[total_label_col] = Paragraph("<b>TOTAL</b>", styles["cellCenter"])
            total_row[last_col] = Paragraph(f"<b>{_standard_money(block_net)}</b>", styles["itemMoney"])
            rows.append(total_row)
            # A detail page has no filler product rows. Very sparse pages use
            # compact rows, retaining ordinary image frames and white space
            # below the table; larger selections use the available height
            # while the seventh item starts a continuation.
            row_heights = [ITEM_HEADER_ROW_MM * mm] + [item_row_mm * mm] * n_data_rows + [ITEM_TOTAL_ROW_MM * mm]
            item_style_cmds = [
                ("GRID", (0, 0), (-1, -1), 0.3, GRID), ("BACKGROUND", (0, 0), (-1, 0), HEADER_GREY),
                ("BACKGROUND", (0, -1), (-1, -1), HEADER_GREY), ("ALIGN", (0, 1), (0, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                ("LEFTPADDING", (1, 1), (1, -2), 1), ("RIGHTPADDING", (1, 1), (1, -2), 1),
                ("TOPPADDING", (0, 1), (-1, -2), 0.5 * mm), ("BOTTOMPADDING", (0, 1), (-1, -2), 0.5 * mm),
                ("TOPPADDING", (0, 0), (-1, 0), 2), ("BOTTOMPADDING", (0, 0), (-1, 0), 2),
                ("TOPPADDING", (0, -1), (-1, -1), 2), ("BOTTOMPADDING", (0, -1), (-1, -1), 2),
            ]
            for r in range(2, n_data_rows + 1, 2):  # zebra every 2nd item row
                item_style_cmds.append(("BACKGROUND", (0, r), (-1, r), ZEBRA))
            table = Table(rows, colWidths=item_widths, rowHeights=row_heights, repeatRows=1)
            table.setStyle(TableStyle(item_style_cmds))
            story.append(table)
            sr_offset += n_data_rows

    if quotation.get("include_dimensions"):
        seen: set[tuple[str, str]] = set()
        for item in quotation.get("items") or []:
            for field, label in (("dimension_image_urls", "DIMENSIONS"), ("seat_cover_image_urls", "SEAT COVER")):
                for url in item.get(field) or []:
                    key = (str(item.get("product_id")), str(url))
                    if key in seen or not str(url).startswith(("https://", "http://")):
                        continue
                    seen.add(key)
                    story.append(PageBreak())
                    story.append(_brand_header(label, styles))
                    story.append(Spacer(1, 6 * mm))
                    story.append(Paragraph(_ellipsize(f"{item.get('sku') or ''}  {item.get('name') or ''}", 110), styles["itemDescription"]))
                    if item.get("dimensions") and field == "dimension_image_urls":
                        story.append(Spacer(1, 3 * mm))
                        story.append(Paragraph(_ellipsize(item["dimensions"], 180), styles["itemDescription"]))
                    story.append(Spacer(1, 8 * mm))
                    story.append(_img(url, width_mm=175, height_mm=190))

    doc.build(
        story,
        onFirstPage=functools.partial(_draw_quotation_page_chrome, branding=b),
        onLaterPages=functools.partial(_draw_quotation_page_chrome, branding=b),
    )
    rendered = buf.getvalue()
    logger.info(
        "quotation_pdf_complete duration_ms=%.1f bytes=%d image_loader=%s",
        (monotonic() - started_at) * 1000,
        len(rendered),
        image_loader_metrics(),
    )
    return rendered
