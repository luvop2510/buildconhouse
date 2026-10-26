"""Fill the supplied quotation workbook without round-tripping its Excel layout.

The checked-in template is a sanitised copy of the customer's reference: styles,
column widths, hidden offer columns, logos, print settings and room rows remain
original. ZIP parts outside the changing worksheets are copied byte for byte.
"""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
from datetime import datetime
from io import BytesIO
import math
import logging
from pathlib import Path
import re
from threading import RLock
import xml.etree.ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile
from zoneinfo import ZoneInfo

from PIL import Image, ImageOps

from models import QuotationLineItem, RoomDiscountCfg
from services.pdf_image_loader import prefetch_urls, remote_image_bytes
from services.pricing import _resolve_line_rows

TEMPLATE = Path(__file__).with_name("quotation_template.xlsx")
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
P = "http://schemas.openxmlformats.org/package/2006/relationships"
X = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
C = "http://schemas.openxmlformats.org/package/2006/content-types"
_XML_LOCK = RLock()
logger = logging.getLogger("forge.quotation_excel")


def _xml(root: ET.Element, original: bytes = b"") -> bytes:
    # Namespace registration is process-global; renderers run concurrently.
    with _XML_LOCK:
        return _serialize_xml(root, original)


def _serialize_xml(root: ET.Element, original: bytes) -> bytes:
    # ElementTree drops unused namespace declarations, including prefixes named
    # by Excel's mc:Ignorable. Retain those declarations to avoid repair dialogs.
    namespaces = dict(value for _, value in ET.iterparse(BytesIO(original), events=("start-ns",))) if original else {}
    for prefix, namespace in namespaces.items():
        if not re.fullmatch(r"ns\d+", prefix):
            ET.register_namespace(prefix, namespace)
    rendered = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    end = rendered.index(b">", rendered.index(b"?>") + 2)
    opening = rendered[:end]
    for prefix, namespace in namespaces.items():
        key = f"xmlns:{prefix}" if prefix else "xmlns"
        if not re.search(rb"\s" + key.encode() + rb"=", opening):
            rendered = rendered[:end] + f' {key}="{namespace}"'.encode() + rendered[end:]
            end = rendered.index(b">", rendered.index(b"?>") + 2)
    return rendered


def _cell(root: ET.Element, reference: str) -> ET.Element:
    sheet = root.find(f"{{{S}}}sheetData")
    number = re.search(r"\d+", reference).group()
    row = sheet.find(f"{{{S}}}row[@r='{number}']")
    if row is None:
        row = ET.SubElement(sheet, f"{{{S}}}row", {"r": number})
    cell = row.find(f"{{{S}}}c[@r='{reference}']")
    if cell is None:
        cell = ET.SubElement(row, f"{{{S}}}c", {"r": reference})
    return cell


def _set(root: ET.Element, reference: str, value=None, formula: str | None = None) -> None:
    cell = _cell(root, reference)
    for child in list(cell):
        cell.remove(child)
    cell.attrib.pop("t", None)
    if formula is not None:
        ET.SubElement(cell, f"{{{S}}}f").text = formula
    if isinstance(value, str):
        value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", "", value)
        cell.set("t", "str" if formula else "inlineStr")
        if formula:
            ET.SubElement(cell, f"{{{S}}}v").text = value
        else:
            text = ET.SubElement(ET.SubElement(cell, f"{{{S}}}is"), f"{{{S}}}t", {"{http://www.w3.org/XML/1998/namespace}space": "preserve"})
            text.text = value
    elif value is not None:
        if not math.isfinite(float(value)):
            raise ValueError("Quotation contains a non-finite amount")
        ET.SubElement(cell, f"{{{S}}}v").text = repr(value)


def _move_row(row: ET.Element, number: int) -> ET.Element:
    row = deepcopy(row)
    row.set("r", str(number))
    for cell in row:
        cell.set("r", re.sub(r"\d+", str(number), cell.get("r", "")))
    return row


def quotation_excel_filename(customer_name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", customer_name or "Customer").strip(" .") or "Customer"
    return f"{name[:150]} Quotation.xlsx"


def _picture(drawing: ET.Element, row: int, relationship: str, image_id: int, ratio: float) -> None:
    width = min(205, 100 * ratio)
    height = width / ratio
    anchor = ET.SubElement(drawing, f"{{{X}}}oneCellAnchor")
    origin = ET.SubElement(anchor, f"{{{X}}}from")
    for key, value in (("col", 3), ("colOff", int((232 - width) / 2 * 9525)), ("row", row - 1), ("rowOff", int((110 - height) / 2 * 9525))):
        ET.SubElement(origin, f"{{{X}}}{key}").text = str(value)
    ET.SubElement(anchor, f"{{{X}}}ext", {"cx": str(int(width * 9525)), "cy": str(int(height * 9525))})
    pic = ET.SubElement(anchor, f"{{{X}}}pic")
    props = ET.SubElement(pic, f"{{{X}}}nvPicPr")
    ET.SubElement(props, f"{{{X}}}cNvPr", {"id": str(image_id), "name": f"Product {image_id}"})
    ET.SubElement(props, f"{{{X}}}cNvPicPr")
    fill = ET.SubElement(pic, f"{{{X}}}blipFill")
    ET.SubElement(fill, f"{{{A}}}blip", {f"{{{R}}}embed": relationship})
    ET.SubElement(ET.SubElement(fill, f"{{{A}}}stretch"), f"{{{A}}}fillRect")
    shape = ET.SubElement(pic, f"{{{X}}}spPr")
    ET.SubElement(ET.SubElement(shape, f"{{{A}}}prstGeom", {"prst": "rect"}), f"{{{A}}}avLst")
    ET.SubElement(anchor, f"{{{X}}}clientData")


def build_quotation_excel(doc: dict, customer: dict) -> bytes:
    """Render current or final quotation rows using the exact reference layout."""
    if (doc.get("doc_type") or "standard") != "standard":
        raise ValueError("Quotation Excel is available for sanitary quotations")
    raw_items = list(doc.get("items") or [])
    final = doc.get("_po_final") or {}
    if final:
        costs = [(str(cost.get("name") or "Additional cost"), float(cost.get("amount") or 0)) for cost in final.get("additional_costs") or []]
        transportation = float(doc.get("transportation_fee") or 0)
        if transportation:
            costs.insert(0, ("Transportation", transportation))
        residual = float(final.get("payable_total") or 0) - float(final.get("total") or 0) - sum(amount for _, amount in costs) + transportation
        if abs(residual) > .005:
            costs.append(("Additional costs", residual))
        if any(amount < 0 for _, amount in costs):
            raise ValueError("PO Final contains an invalid additional cost")
        raw_items.extend({"id": f"final-cost-{index}", "product_id": f"final-cost-{index}", "sku": "", "name": name,
            "room": "Additional costs", "qty": 1, "unit_price": amount, "mrp": amount, "discount_pct": 0}
            for index, (name, amount) in enumerate(costs) if amount)
    if len(raw_items) > 1000:
        raise ValueError("Quotation Excel supports up to 1,000 products")
    items = [QuotationLineItem(**raw) for raw in raw_items]
    prices = _resolve_line_rows(items, doc.get("project_discount_pct") or 0, doc.get("category_discounts") or {},
        {key: RoomDiscountCfg(**value) for key, value in (doc.get("room_discounts") or {}).items()})
    rooms: OrderedDict[str, list[tuple[dict, dict]]] = OrderedDict()
    for raw, price in zip(raw_items, prices, strict=True):
        rooms.setdefault(str(raw.get("room") or "Other"), []).append((raw, price))
    if len(rooms) > 100:
        raise ValueError("Quotation Excel supports up to 100 rooms")
    if not rooms:
        rooms["BATHROOM 1"] = []
    urls = [str(raw.get("image")) for raw in raw_items if raw.get("image")]
    fetched_images: dict[str, bytes | None] = {}

    def fetch_image(url: str) -> bytes | None:
        image = remote_image_bytes(url)
        fetched_images[url] = image
        return image

    prefetch_urls(urls, fetch_image, workers=6, timeout=8.0)
    images = dict(fetched_images)
    with ZipFile(TEMPLATE) as source:
        parts = {name: source.read(name) for name in source.namelist()}
    workbook = ET.fromstring(parts["xl/workbook.xml"])
    sheets = workbook.find(f"{{{S}}}sheets")
    relationships = ET.fromstring(parts["xl/_rels/workbook.xml.rels"])
    types = ET.fromstring(parts["[Content_Types].xml"])
    summary = ET.fromstring(parts["xl/worksheets/sheet1.xml"])
    extra_rooms = max(0, len(rooms) - 8)
    total_summary_row = 21 + extra_rooms
    # Preserve the existing eight room slots; extend only when the quotation
    # requires more, using the same summary row and bathroom sheet format.
    summary_data = summary.find(f"{{{S}}}sheetData")
    for row in list(summary_data):
        if int(row.get("r")) >= 21:
            moved = _move_row(row, int(row.get("r")) + extra_rooms)
            summary_data.remove(row)
            summary_data.append(moved)
    for i in range(extra_rooms):
        summary_data.insert(20 + i, _move_row(summary_data.find(f"{{{S}}}row[@r='20']"), 21 + i))
    for merge in summary.findall(f"{{{S}}}mergeCells/{{{S}}}mergeCell"):
        merge.set("ref", re.sub(r"\d+", lambda m: str(int(m.group()) + extra_rooms) if int(m.group()) >= 21 else m.group(), merge.get("ref")))
    summary.find(f"{{{S}}}dimension").set("ref", f"A1:R{41 + extra_rooms}")
    for i in range(extra_rooms):
        for ref in (f"A{21+i}:C{21+i}", f"D{21+i}:J{21+i}", f"K{21+i}:M{21+i}"):
            ET.SubElement(summary.find(f"{{{S}}}mergeCells"), f"{{{S}}}mergeCell", {"ref": ref})
    summary.find(f"{{{S}}}mergeCells").set("count", str(len(summary.find(f"{{{S}}}mergeCells"))))
    for name in workbook.findall(f"{{{S}}}definedNames/{{{S}}}definedName"):
        if name.get("name") == "_xlnm.Print_Area":
            name.text = f"'Sheet1 (3)'!$A$1:$M${41 + extra_rooms}"
    _set(summary, "D7", str(doc.get("customer_name") or customer.get("name") or ""))
    stamp = str(doc.get("created_at") or "")
    date = datetime.fromisoformat(stamp.replace("Z", "+00:00")) if stamp else datetime.now(ZoneInfo("Asia/Kolkata"))
    if date.tzinfo:
        date = date.astimezone(ZoneInfo("Asia/Kolkata"))
    _set(summary, "D8", (date.date() - datetime(1899, 12, 30).date()).days)
    phone = doc.get("phone_snapshot") if doc.get("phone_snapshot") is not None else customer.get("phone")
    _set(summary, "D9", str(phone or ""))
    _set(summary, "D10", str(doc.get("referrer_name") or customer.get("referrer_name") or ""))
    brands = list(dict.fromkeys(str(raw.get("brand_name")) for raw in raw_items if raw.get("brand_name")))
    _set(summary, "A11", ", ".join(brands) or "Quotation")
    gross_total = net_total = 0.0
    room_entries = list(rooms.items())
    base_room = parts["xl/worksheets/sheet2.xml"]
    for i in range(max(8, len(rooms))):
        room_name, room_items = room_entries[i] if i < len(room_entries) else (f"BATHROOM {i+1}", [])
        sheet_number = i + 2
        sheet_name = f"BATHROOM {i+1}"
        part = f"xl/worksheets/sheet{sheet_number}.xml"
        original = parts.get(part, base_room)
        root = ET.fromstring(original)
        count = max(21, len(room_items))
        total_row = count + 3
        data = root.find(f"{{{S}}}sheetData")
        if count > 21:
            last = data.find(f"{{{S}}}row[@r='23']")
            total = data.find(f"{{{S}}}row[@r='24']")
            data.remove(total)
            for row_number in range(24, total_row):
                data.append(_move_row(last, row_number))
            data.append(_move_row(total, total_row))
            root.find(f"{{{S}}}dimension").set("ref", f"A1:K{total_row}")
            root.find(f"{{{S}}}mergeCells/{{{S}}}mergeCell[@ref='A24:E24']").set("ref", f"A{total_row}:E{total_row}")
        _set(root, "A1", room_name)
        drawing = ET.Element(f"{{{X}}}wsDr")
        drawing_rels = ET.Element(f"{{{P}}}Relationships")
        room_gross = room_net = quantity = 0.0
        for index in range(count):
            number = index + 3
            raw, price = room_items[index] if index < len(room_items) else ({}, {"gross": 0, "disc": 0})
            qty = float(raw.get("qty") or 0)
            mrp = float(raw.get("mrp") or raw.get("unit_price") or 0)
            net = price["gross"] - price["disc"]
            effective_pct = 100 * (1 - net / (mrp * qty)) if mrp and qty else 0
            values = {"A": index+1, "B": str(raw.get("sku") or ""), "C": str(raw.get("description") or raw.get("name") or ""),
                "D": None, "E": mrp if raw else None, "F": qty if raw else None, "H": effective_pct if raw else None}
            for column, value in values.items():
                _set(root, f"{column}{number}", value)
            for column, formula, cached in (("G", f"E{number}*F{number}", mrp*qty), ("I", f"E{number}*H{number}/100", mrp*effective_pct/100),
                ("J", f"E{number}-I{number}", net/qty if qty else 0), ("K", f"F{number}*J{number}", net)):
                _set(root, f"{column}{number}", cached, formula)
            room_gross += mrp*qty
            room_net += net
            quantity += qty
            image = images.get(str(raw.get("image")))
            if image:
                try:
                    with Image.open(BytesIO(image)) as loaded:
                        prepared = ImageOps.exif_transpose(loaded)
                        prepared.thumbnail((480, 480))
                        stream = BytesIO()
                        prepared.convert("RGBA").save(stream, format="PNG")
                        image_name = f"quotation_{sheet_number}_{number}.png"
                        parts[f"xl/media/{image_name}"] = stream.getvalue()
                        image_id = index + 1
                        rel = f"rId{image_id}"
                        ET.SubElement(drawing_rels, f"{{{P}}}Relationship", {"Id": rel, "Type": f"{R}/image", "Target": f"../media/{image_name}"})
                        _picture(drawing, number, rel, image_id, prepared.width / prepared.height)
                except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
                    logger.warning("Quotation Excel omitted an unreadable product photo")
        for column, cached in (("F", quantity), ("G", room_gross), ("K", room_net)):
            last_row = 18 if column == "F" and len(room_items) <= 16 else total_row-1
            _set(root, f"{column}{total_row}", cached, f"SUM({column}3:{column}{last_row})")
        row_number = 13 + i
        summary_row = summary_data.find(f"{{{S}}}row[@r='{row_number}']")
        if i < len(room_entries):
            summary_row.attrib.pop("hidden", None)
        else:
            summary_row.set("hidden", "1")
        _set(summary, f"A{row_number}", i+1)
        for column, target, cached in (("D", "A1", room_name), ("K", f"G{total_row}", room_gross), ("P", f"K{total_row}", room_net)):
            _set(summary, f"{column}{row_number}", cached, f"+'{sheet_name}'!{target}")
        _set(summary, f"Q{row_number}", room_name, f"+D{row_number}")
        _set(summary, f"R{row_number}", None)
        gross_total += room_gross
        net_total += room_net
        rel_part = f"xl/worksheets/_rels/sheet{sheet_number}.xml.rels"
        rel_original = parts.get(rel_part, parts["xl/worksheets/_rels/sheet2.xml.rels"])
        rel_root = ET.fromstring(rel_original)
        for relation in list(rel_root):
            if relation.get("Type").endswith("/drawing"):
                rel_root.remove(relation)
        for old_drawing in root.findall(f"{{{S}}}drawing"):
            root.remove(old_drawing)
        if len(drawing):
            drawing_name = f"quotation{sheet_number}.xml"
            ET.SubElement(root, f"{{{S}}}drawing", {f"{{{R}}}id": "quotationDrawing"})
            ET.SubElement(rel_root, f"{{{P}}}Relationship", {"Id": "quotationDrawing", "Type": f"{R}/drawing", "Target": f"../drawings/{drawing_name}"})
            parts[f"xl/drawings/{drawing_name}"] = _xml(drawing)
            parts[f"xl/drawings/_rels/{drawing_name}.rels"] = _xml(drawing_rels)
            ET.SubElement(types, f"{{{C}}}Override", {"PartName": f"/xl/drawings/{drawing_name}", "ContentType": "application/vnd.openxmlformats-officedocument.drawing+xml"})
        parts[part] = _xml(root, original)
        parts[rel_part] = _xml(rel_root, rel_original)
        if sheet_number > 9:
            rel_id = f"quotationSheet{sheet_number}"
            ET.SubElement(sheets, f"{{{S}}}sheet", {"name": sheet_name, "sheetId": str(100+sheet_number), f"{{{R}}}id": rel_id})
            ET.SubElement(relationships, f"{{{P}}}Relationship", {"Id": rel_id, "Type": f"{R}/worksheet", "Target": f"worksheets/sheet{sheet_number}.xml"})
            ET.SubElement(types, f"{{{C}}}Override", {"PartName": f"/{part}", "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"})
    _set(summary, f"K{total_summary_row}", gross_total, f"SUM(K13:M{total_summary_row-1})")
    offer_total = round(net_total, 2)
    offer_formula = f"ROUND(SUM(P13:P{total_summary_row-1}),2)"
    if final:
        payable = float(final.get("payable_total") or 0)
        rounding = round(payable - offer_total, 2)
        if not math.isfinite(payable) or abs(rounding) > .005 * (len(raw_items) + 1) + 1e-8:
            raise ValueError("PO Final product amounts do not reconcile with its payable total")
        # Final rows are individually rounded; the aggregate remains authoritative.
        if rounding:
            offer_formula += f"{rounding:+.2f}"
        offer_total = round(payable, 2)
    _set(summary, f"K{total_summary_row+1}", offer_total, offer_formula)
    # R11:R12 are reference worksheet scratch labels, not customer data.
    _set(summary, "R11", None)
    _set(summary, "R12", None)
    calc = workbook.find(f"{{{S}}}calcPr")
    calc.set("fullCalcOnLoad", "1")
    calc.set("forceFullCalc", "1")
    for name, root in (("xl/workbook.xml", workbook), ("xl/_rels/workbook.xml.rels", relationships), ("[Content_Types].xml", types), ("xl/worksheets/sheet1.xml", summary)):
        parts[name] = _xml(root, parts[name])
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as result:
        for name, content in parts.items():
            result.writestr(name, content)
    return output.getvalue()
