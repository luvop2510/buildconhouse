"""Image-led customer product presentation, using the supplied 16:9 layout."""
from __future__ import annotations

from collections import OrderedDict
from datetime import datetime
from zoneinfo import ZoneInfo
from io import BytesIO
import re

from PIL import Image, ImageOps
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

from services.pdf_image_loader import prefetch_urls, remote_image_bytes


DEFAULT_AREA = "Other Area"
SLIDE_W = 13.333
SLIDE_H = 7.5


def presentation_filename(customer_name: str, date: str | None = None) -> str:
    name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "", customer_name or "Customer").strip()
    name = re.sub(r"\s+", " ", name) or "Customer"
    stamp = date or datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%d-%m-%Y")
    return f"{name} PPT {stamp}.pptx"


def _text(slide, value: str, x: float, y: float, w: float, h: float, size: int, bold: bool = False) -> None:
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
        ratio = image.width / image.height
        output = BytesIO()
        image.save(output, format="PNG", optimize=True)
        output.seek(0)
        return output, ratio


def _picture(slide, data: bytes, x: float, y: float, w: float, h: float) -> None:
    stream, ratio = _image(data)
    inset = 0.08
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


def _area_rows(items: list[dict]) -> list[tuple[str, list[dict]]]:
    grouped: OrderedDict[str, list[dict]] = OrderedDict()
    for item in items:
        area = str(item.get("area") or "").strip() or suggested_area(item.get("name"))
        grouped.setdefault(area, []).append(item)
    return list(grouped.items())


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
    """One cover and one or more slides per room, up to three areas per slide.

    Every line requires an image. A missing or inaccessible image fails the
    request instead of producing a deck with blank product positions.
    """
    items = doc.get("items") or []
    if not items:
        raise ValueError("Add products before generating the PPT")
    for item in items:
        if not item.get("image"):
            raise ValueError(f"Product image missing for {item.get('name') or 'a product'}")
    prefetch_urls(item["image"] for item in items)
    pictures: dict[str, bytes] = {}
    for item in items:
        url = item["image"]
        if url not in pictures:
            data = remote_image_bytes(url)
            if not data:
                raise ValueError(f"Product image unavailable for {item.get('name') or 'a product'}")
            pictures[url] = data

    presentation = Presentation()
    presentation.slide_width = Inches(SLIDE_W)
    presentation.slide_height = Inches(SLIDE_H)
    blank = presentation.slide_layouts[6]
    cover = presentation.slides.add_slide(blank)
    customer = str(doc.get("customer_name") or "Customer").strip() or "Customer"
    _text(cover, customer.upper(), 0.55, 0.48, 11.7, 0.85, 29, True)
    stamp = datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%Y-%m-%d")
    try:
        stamp = datetime.fromisoformat(stamp).strftime("%d-%m-%Y")
    except ValueError:
        pass
    _text(cover, stamp, 0.57, 1.42, 10, 0.45, 18)

    rooms = list(doc.get("rooms") or [])
    for item in items:
        room = str(item.get("room") or "Other Room").strip() or "Other Room"
        if room not in rooms:
            rooms.append(room)
    for room in rooms:
        room_items = [item for item in items if (item.get("room") or "Other Room") == room]
        if not room_items:
            continue
        areas = _area_rows(room_items)
        # Large groups continue on another slide, keeping all pictures large.
        segments: list[tuple[str, list[dict]]] = []
        for area, grouped in areas:
            for start in range(0, len(grouped), 4):
                segments.append((area, grouped[start:start + 4]))
        pages: list[list[tuple[str, list[dict]]]] = []
        for segment in segments:
            if not pages or len(pages[-1]) >= 3 or sum(len(items) for _, items in pages[-1]) + len(segment[1]) > 6:
                pages.append([])
            pages[-1].append(segment)
        for visible in pages:
            slide = presentation.slides.add_slide(blank)
            _text(slide, room.upper(), 0.36, 0.20, 12.5, 0.5, 21)
            count = len(visible)
            gap = 0.32
            col_w = (12.55 - gap * (count - 1)) / count
            for col, (area, products) in enumerate(visible):
                x = 0.39 + col * (col_w + gap)
                _text(slide, area, x + 0.05, 0.89, col_w - 0.1, 0.42, 17, True)
                rows = 1 if len(products) <= 2 else 2 if len(products) <= 4 else 3
                cols = 1 if len(products) == 1 else 2
                cell_w = col_w / cols
                cell_h = 5.80 / rows
                for index, product in enumerate(products):
                    px = x + (index % cols) * cell_w
                    py = 1.38 + (index // cols) * cell_h
                    _picture(slide, pictures[product["image"]], px, py, cell_w, cell_h)
    stream = BytesIO()
    presentation.save(stream)
    return stream.getvalue()
