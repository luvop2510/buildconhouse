"""Image-led customer product presentation, using the supplied 16:9 layout."""
from __future__ import annotations

from collections import OrderedDict
from datetime import datetime
from zoneinfo import ZoneInfo
from io import BytesIO
from math import ceil, sqrt
import re
import logging
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

from services.pdf_image_loader import prefetch_urls, remote_image_bytes


DEFAULT_AREA = "Other Area"
logger = logging.getLogger("forge.quotation_ppt")
SLIDE_W = 13.333
SLIDE_H = 7.5
ASSET_DIR = Path(__file__).resolve().parents[1]
PARTNER_LOGOS = (
    ("grohe", 7.75, 3.46, 0.94, 0.43),
    ("hansgrohe", 9.00, 3.48, 1.35, 0.34),
    ("vitra", 7.73, 4.20, 0.92, 0.39),
    ("geberit", 8.93, 4.22, 1.46, 0.33),
    ("oyster", 10.93, 4.20, 1.02, 0.46),
    ("nexion", 7.62, 5.06, 1.22, 0.43),
    ("dimore", 9.05, 5.06, 1.35, 0.43),
    ("qutone", 10.93, 5.13, 1.43, 0.38),
    ("ncl_ittimi", 9.24, 6.02, 1.38, 0.61),
)


def presentation_filename(customer_name: str, date: str | None = None) -> str:
    name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "", customer_name or "Customer").strip()
    name = re.sub(r"\s+", " ", name) or "Customer"
    stamp = date or datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%d-%m-%Y")
    return f"{name} PPT {stamp}.pptx"


def _text(slide, value: str, x: float, y: float, w: float, h: float, size: float, bold: bool = False) -> None:
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    frame = box.text_frame
    frame.word_wrap = True
    frame.margin_left = frame.margin_right = 0
    frame.margin_top = frame.margin_bottom = 0
    p = frame.paragraphs[0]
    p.alignment = PP_ALIGN.LEFT
    run = p.add_run()
    run.text = value
    run.font.name = "Arial"
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = RGBColor(20, 20, 20)


def _image(data: bytes) -> tuple[BytesIO, float]:
    """Keep the full product visible; normalize EXIF and unsupported formats."""
    with Image.open(BytesIO(data)) as source:
        image = ImageOps.exif_transpose(source)
        image.load()
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        # The largest product frame is a full slide. Retaining an 8,000px
        # catalog original makes both deck generation and tablet viewing slow.
        image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        ratio = image.width / image.height
        output = BytesIO()
        image.save(output, format="PNG")
        output.seek(0)
        return output, ratio


def _picture(slide, prepared: tuple[BytesIO, float], x: float, y: float, w: float, h: float) -> None:
    stream, ratio = prepared
    inset = min(0.08, w * 0.08, h * 0.08)
    w -= 2 * inset
    h -= 2 * inset
    target_w = min(w, h * ratio)
    target_h = target_w / ratio
    slide.shapes.add_picture(
        stream,
        Inches(x + inset + (w - target_w) / 2),
        Inches(y + inset + (h - target_h) / 2),
        width=Inches(target_w), height=Inches(target_h),
    )


def _cover(slide, doc: dict) -> None:
    """Reproduce the supplied 16:9 customer cover with editable names."""
    # The reference has a soft grey right panel and a white information area.
    panel = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(6.6), 0, Inches(6.733), Inches(SLIDE_H))
    panel.fill.solid()
    panel.fill.fore_color.rgb = RGBColor(248, 248, 248)
    panel.line.fill.background()
    # The default PowerPoint theme adds an unwanted drop shadow to rectangles.
    for style in panel._element.xpath("./p:style"):
        panel._element.remove(style)

    customer = str(doc.get("customer_name") or "Customer").strip() or "Customer"
    referrer = str(doc.get("referrer_name") or "").strip()
    referrer_label = "ARCH" if doc.get("referrer_type") == "architect" else "INT"
    _text(slide, f"CLIENT NAME: {customer.upper()}", 0.19, 0.32, 7.30, 0.35, 17)
    _text(slide, f"{referrer_label}: {referrer.upper()}", 0.19, 0.77, 7.30, 0.35, 17)
    _text(slide, "•  Before Gujarat housing,Nr.katariya\nmotors, 2nd 150ft ring road Rajkot-360005", 1.01, 2.92, 5.12, 0.60, 18, True)
    _text(slide, "•  MO:-9909906652", 1.01, 3.55, 5.12, 0.34, 18, True)

    house = ASSET_DIR / "buildcon_cover_logo.png"
    slide.shapes.add_picture(str(house), Inches(7.72), Inches(1.31), width=Inches(4.92), height=Inches(1.65))
    for name, x, y, w, h in PARTNER_LOGOS:
        path = ASSET_DIR / "brand_logos" / f"{name}.png"
        slide.shapes.add_picture(str(path), Inches(x), Inches(y), width=Inches(w), height=Inches(h))


def _area_rows(items: list[dict]) -> list[tuple[str, list[dict]]]:
    grouped: OrderedDict[str, list[dict]] = OrderedDict()
    for item in items:
        area = str(item.get("area") or "").strip() or suggested_area(item.get("name"))
        grouped.setdefault(area, []).append(item)
    return list(grouped.items())


def _room_name(value: str | None) -> str:
    return str(value or "").strip() or "Other Room"


def _grid(count: int, w: float, h: float) -> tuple[int, int]:
    """Choose the largest uniform image frames that fit the available region."""
    columns = max(range(1, count + 1), key=lambda cols: (
        min(w / cols, (h / ceil(count / cols)) * 4 / 3),
        -cols * ceil(count / cols),
    ))
    return columns, ceil(count / columns)


def _product_urls(product: dict) -> list[str]:
    # Concealed parts remain ordinary selected lines. Seat-cover photos may
    # also belong to a WC itself, and must not disappear from its presentation.
    urls = [product.get("image"), *(product.get("seat_cover_image_urls") or [])]
    return list(dict.fromkeys(str(url).strip() for url in urls if str(url or "").strip())) or [""]


def _sort_order(item: dict) -> float:
    try:
        return float(item.get("sort_order") or 0)
    except (TypeError, ValueError):
        return 0


def _room_slide(slide, room: str, items: list[dict], pictures: dict[str, tuple[BytesIO, float]]) -> None:
    """Fit every selection into a single room slide, preserving area groups."""
    _text(slide, room.upper(), 0.36, 0.20, 12.5, 0.5, 21)
    areas = _area_rows(sorted(items, key=_sort_order))
    # Most bathrooms have Basin/WC/Shower columns. Extra custom areas use
    # additional rows, rather than causing another page for the same room.
    area_columns = min(3, len(areas))
    area_rows = ceil(len(areas) / area_columns)
    band_h = 6.12 / area_rows
    for band in range(area_rows):
        visible = areas[band * area_columns:(band + 1) * area_columns]
        weights = [sqrt(len(products)) for _, products in visible]
        available_w = 12.55 - 0.32 * (len(visible) - 1)
        x = 0.39
        y = 0.89 + band * band_h
        heading_h = min(0.42, band_h * 0.20)
        for (area, products), weight in zip(visible, weights, strict=True):
            col_w = available_w * weight / sum(weights)
            font_size = min(17, max(7, 17 * min(col_w / 2.8, heading_h / 0.42)))
            _text(slide, area, x + 0.05, y, col_w - 0.1, heading_h, font_size, True)
            image_y = y + heading_h + min(0.07, band_h * 0.02)
            image_h = band_h - heading_h - 0.10
            cols, rows = _grid(len(products), col_w, image_h)
            cell_w, cell_h = col_w / cols, image_h / rows
            for index, product in enumerate(products):
                px = x + (index % cols) * cell_w
                py = image_y + (index // cols) * cell_h
                urls = _product_urls(product)
                photo_cols, photo_rows = _grid(len(urls), cell_w, cell_h)
                for photo_index, url in enumerate(urls):
                    _picture(slide, pictures[url],
                             px + (photo_index % photo_cols) * cell_w / photo_cols,
                             py + (photo_index // photo_cols) * cell_h / photo_rows,
                             cell_w / photo_cols, cell_h / photo_rows)
            x += col_w + 0.32


def _missing_image() -> bytes:
    """Keep a missing catalog photo visible without aborting the whole deck."""
    image = Image.new("RGB", (1200, 900), "#f3f4f6")
    draw = ImageDraw.Draw(image)
    draw.text((470, 440), "Photo pending", fill="#4b5563")
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def suggested_area(name: str | None) -> str:
    """Fallback for quotations created before area labels were introduced."""
    text = (name or "").lower()
    for pattern, area in (
        (r"\b(shower|rainshower|handshower|overhead|body jet|thermostat|diverter|bath tub|bathtub)\b", "Shower Area"),
        (r"\b(wc|toilet|commode|water closet|cistern|flush|urinal|bidet|seat cover|health faucet)\b", "WC Area"),
        (r"\b(basin|washbasin|wash basin|lavatory|vessel|countertop|counter top|pillar tap|mixer tap)\b", "Basin Area"),
    ):
        if re.search(pattern, text):
            return area
    return DEFAULT_AREA


def build_product_ppt(doc: dict) -> bytes:
    """One cover and exactly one slide per nonempty room/bathroom.

    Unavailable catalog photos get an explicit placeholder so the remaining
    selected products can still be shared with the customer.
    """
    items = doc.get("items") or []
    if not items:
        raise ValueError("Add products before generating the PPT")
    urls = list(dict.fromkeys(url for item in items for url in _product_urls(item)))
    prefetch_urls(url for url in urls if url)
    pictures: dict[str, tuple[BytesIO, float]] = {}
    placeholder = None
    for url in urls:
        data = remote_image_bytes(url) if url else None
        if data:
            pictures[url] = _image(data)
        else:
            logger.warning("Product image unavailable in PPT")
            if placeholder is None:
                placeholder = _image(_missing_image())
            pictures[url] = placeholder

    presentation = Presentation()
    presentation.slide_width = Inches(SLIDE_W)
    presentation.slide_height = Inches(SLIDE_H)
    blank = presentation.slide_layouts[6]
    cover = presentation.slides.add_slide(blank)
    _cover(cover, doc)

    rooms = list(dict.fromkeys(_room_name(room) for room in doc.get("rooms") or []))
    grouped: OrderedDict[str, list[dict]] = OrderedDict()
    for item in items:
        room = _room_name(item.get("room"))
        grouped.setdefault(room, []).append(item)
        if room not in rooms:
            rooms.append(room)
    for room in rooms:
        room_items = grouped.get(room, [])
        if not room_items:
            continue
        _room_slide(presentation.slides.add_slide(blank), room, room_items, pictures)
    stream = BytesIO()
    presentation.save(stream)
    return stream.getvalue()
