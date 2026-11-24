"""Deterministic source extraction and offline worksheets for catalogue imports."""
from __future__ import annotations

import base64
import binascii
import csv
from dataclasses import dataclass, field
from decimal import Decimal
import hashlib
import io
import math
from pathlib import Path
import re
from typing import Iterable

from .base import MISSING
from .resource_limits import MAX_PDF_PAGES, MAX_ROWS, MAX_SOURCE_BYTES, MAX_WORKSHEET_COLUMNS, validate_source

FLOORS = {
    "ground-floor": "Ground Floor — Tiles",
    "first-floor": "Sanitary / Bathroom Floor",
    "second-floor": "Kitchen Floor",
    "third-floor": "Furniture Floor",
}
OPERATIONS = {"add", "prices", "update", "sync", "images"}
PRODUCT_COLUMNS = {
    "sku": "Article No.", "name": "Product Name", "brand": "Brand", "department": "Department",
    "category": "Category", "subcategory": "Subcategory", "series": "Series", "collection": "Collection",
    "description": "Description", "size": "Size", "finish": "Finish", "finish_code": "Finish Code",
    "colour": "Colour", "material": "Material", "dimensions": "Dimensions", "variant_label": "Variant",
    "family_key": "Family Key", "family_name": "Family Name", "unit": "Unit of Measurement",
    "mrp": "MRP", "price": "Offer Price", "tax_percent": "Tax %", "availability": "Availability",
    "accessory_skus": "Accessory Article Nos.", "concealed_skus": "Concealed Article Nos.",
    "image": "Product Image", "dimension_image": "Dimension Diagram",
}
TILE_COLUMNS = {
    "price_unit": "Price Unit", "pcs_per_box": "Pieces per Box", "sqft_per_box": "Square Feet per Box",
    "rate_per_sqft": "Rate per Square Foot",
}
PRICE_COLUMNS = {
    "sku": "Article No.", "name": "Product Name", "current_mrp": "Current MRP", "new_mrp": "New MRP",
}
IMAGE_COLUMNS = {"sku": "Article No.", "name": "Product Name", "image": "Product Image", "dimension_image": "Dimension Diagram"}
NUMERIC_COLUMNS = {"mrp", "price", "current_mrp", "new_mrp", "tax_percent", "sqft_per_box", "rate_per_sqft"}
TEXT_LIMITS = {"sku": 200, "name": 200, "description": 4_000}
SPEC_FIELDS = {*TILE_COLUMNS, "tax_percent", "unit", "availability"}
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 100 * 1024 * 1024
PRICE_NUMBER = re.compile(
    r"(?:(?:₹|Rs\.?|INR)\s*)?(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,2}(?:,[0-9]{2})+,[0-9]{3})(?:\.[0-9]+)?\Z",
    re.IGNORECASE,
)
PRINTED_NUMBER = re.compile(r"(?:page\s+)?([0-9]{1,5})(?:\s+(?:of\s+|/\s*)[0-9]{1,5})?\Z", re.IGNORECASE)
PDF_PRICE = re.compile(r"(?P<sku>[A-Za-z0-9][A-Za-z0-9./_+-]{1,199})\s+(?P<price>.+)\Z")


@dataclass(frozen=True)
class SourceImage:
    data: bytes
    mime: str
    width: int
    height: int
    quality: str


@dataclass
class CatalogueExtraction:
    rows: list[dict] = field(default_factory=list)
    images: dict[str, SourceImage] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def _header(value) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().casefold()).strip("_")


ALIASES = {
    _header(label): key
    for key, label in {**PRODUCT_COLUMNS, **TILE_COLUMNS, **PRICE_COLUMNS}.items()
}
ALIASES.update({key: key for key in PRODUCT_COLUMNS.keys() | TILE_COLUMNS.keys() | PRICE_COLUMNS.keys()})
ALIASES.update({
    "article": "sku", "article_number": "sku", "art_no": "sku", "article_code": "sku", "product_code": "sku",
    "product_description": "description", "product_discription": "description",
    "item_code": "sku", "item_no": "sku", "code": "sku", "product": "name", "floor": "department",
    "floor_id": "department", "brand_name": "brand", "category_name": "category", "color": "colour",
    "variant_label": "variant_label", "dealer_price": "price", "selling_price": "price", "trade_price": "price",
    "list_price": "mrp", "mrp_inr": "mrp", "new_price": "new_mrp", "old_mrp": "current_mrp",
    "image": "image", "photo": "image", "product_photo": "image", "picture": "image",
    "box_sqft": "sqft_per_box", "sq_ft_per_box": "sqft_per_box", "rate_per_sq_ft": "rate_per_sqft",
    "pcs_box": "pcs_per_box", "pcs_per_box": "pcs_per_box", "box_pieces": "pcs_per_box",
    "rate_unit": "price_unit", "gst": "tax_percent", "gst_percent": "tax_percent",
    # The percent symbol is removed in header normalization.
    "tax": "tax_percent", "uom": "unit", "dimensions_diagram": "dimension_image",
    "dimension_diagram": "dimension_image", "dimension_image": "dimension_image",
})
FLOOR_ALIASES = {
    "ground-floor": {"ground", "tiles", "ground_floor_tiles"},
    "first-floor": {"first", "sanitary", "bathroom", "sanitary_floor", "the_sanitary_bathroom"},
    "second-floor": {"second", "kitchen"},
    "third-floor": {"third", "furniture"},
}


def _check_scope(floor_id: str, operation: str) -> None:
    if floor_id not in FLOORS:
        raise ValueError("Select a supported department.")
    if operation not in OPERATIONS:
        raise ValueError("Select a supported catalogue operation.")


def _blank(value) -> bool:
    return value is None or isinstance(value, str) and not value.strip()


def _text(value, key: str) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError("Must be text.")
    value = str(value).strip()
    if len(value) > TEXT_LIMITS.get(key, 300) or "\x00" in value:
        raise ValueError("Text is too long or contains invalid characters.")
    return value


def _article(value, fmt: str) -> str:
    if _blank(value):
        raise ValueError("Article No. is required.")
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        if not math.isfinite(value) or value != int(value) or value < 0 or value >= 10**15:
            raise ValueError("Numeric article is imprecise. Enter the full article as text.")
        # Excel custom zero masks are meaningful part numbers, not styling.
        width = len(fmt) if re.fullmatch(r"0{2,64}", fmt or "") else 0
        return str(int(value)).zfill(width)
    value = _text(value, "sku")
    if any(ord(character) < 32 for character in value):
        raise ValueError("Article No. contains invalid characters.")
    return value


def _number(value, *, percent: bool = False) -> float:
    if isinstance(value, str):
        value = value.strip()
        if percent:
            value = value.removesuffix("%").strip()
        if not PRICE_NUMBER.fullmatch(value):
            raise ValueError("Enter a valid non-negative number.")
        value = re.sub(r"^(?:₹|Rs\.?|INR)\s*", "", value, flags=re.IGNORECASE).replace(",", "")
    elif isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise ValueError("Enter a valid non-negative number.")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Enter a valid non-negative number.")
    result = float(value)
    if not math.isfinite(result) or result < 0 or percent and result > 100:
        raise ValueError("Enter a number from 0 to 100." if percent else "Enter a valid non-negative number.")
    return result


def _identity(value: str) -> str:
    return " ".join(value.split()).casefold()


def _normalized_unit(value) -> str:
    units = {
        "piece": "piece", "pieces": "piece", "per_piece": "piece", "pcs": "piece", "tile": "piece",
        "box": "box", "per_box": "box", "sqft": "sqft", "sq_ft": "sqft", "square_foot": "sqft",
        "per_sqft": "sqft", "per_sq_ft": "sqft", "per_square_foot": "sqft",
    }
    unit = units.get(_header(value))
    if unit is None:
        raise ValueError("Choose Piece, Box or Sqft.")
    return unit


def new_product_issues(fields: dict, floor_id: str) -> list[str]:
    """Check fields required for a new SKU, including in an otherwise partial sync."""
    absent = [PRODUCT_COLUMNS[key] for key in ("name", "category", "mrp") if key not in fields]
    if floor_id == "ground-floor":
        if not fields.get("size"):
            absent.append("Size")
        specs = fields.get("specs", {})
        unit = specs.get("price_unit")
        if not unit:
            absent.append("Price Unit")
        elif unit in {"box", "sqft"}:
            for key in ("pcs_per_box", "sqft_per_box") if unit == "sqft" else ("pcs_per_box",):
                if not specs.get(key):
                    absent.append(TILE_COLUMNS[key])
    return [f"{label} is required for a new product." for label in absent]


def _parse_row(row: int, sheet: str, cells: list[tuple[str, str, object, str, str]], floor_id: str, operation: str, brand: str | None) -> dict:
    output = {"row": row, "sheet": sheet, "sku": "", "fields": {}, "errors": [], "image_hashes": []}
    fields, errors = output["fields"], output["errors"]
    specs = {}
    for key, label, value, fmt, cell_type in cells:
        if _blank(value) and key != "sku":
            continue
        if operation == "prices" and key not in {"sku", "department", "brand", "current_mrp", "new_mrp"}:
            continue
        try:
            if cell_type in {"f", "e"}:
                raise ValueError("Paste a value in place of a formula or spreadsheet error.")
            if not key:
                raise ValueError("Unsupported catalogue column.")
            if key == "sku":
                output["sku"] = _article(value, fmt)
            elif key == "department":
                accepted = {_header(floor_id), _header(FLOORS[floor_id]), *FLOOR_ALIASES[floor_id]}
                if _header(_text(value, key)) not in accepted:
                    raise ValueError("Does not match the selected department.")
            elif key == "brand":
                if brand and _identity(_text(value, key)) != _identity(brand):
                    raise ValueError("Does not match the selected brand.")
            elif operation == "prices":
                if key in {"current_mrp", "new_mrp"}:
                    fields[key] = _number(value)
            elif operation == "images" and key not in {"image", "dimension_image"}:
                continue
            elif key in {"image", "dimension_image"}:
                raise ValueError("Insert the product picture as an embedded image and leave the cell text empty.")
            elif key in TILE_COLUMNS and floor_id != "ground-floor":
                raise ValueError("This field is available on the Tiles template only.")
            elif key in {"current_mrp", "new_mrp"}:
                raise ValueError("Use a price update for this column.")
            elif key in NUMERIC_COLUMNS:
                if key == "tax_percent" and fmt.endswith("%") and isinstance(value, (int, float)) and not isinstance(value, bool):
                    value *= 100
                number = _number(value, percent=key == "tax_percent")
                if key == "sqft_per_box" and number <= 0:
                    raise ValueError("Enter coverage greater than zero.")
                (specs if key in SPEC_FIELDS else fields)[key] = number
            elif key == "price_unit":
                specs[key] = _normalized_unit(value)
            elif key == "pcs_per_box":
                number = _number(value)
                if number <= 0 or not number.is_integer():
                    raise ValueError("Enter a positive whole number.")
                specs[key] = str(int(number))
            elif key in {"accessory_skus", "concealed_skus"}:
                fields[key] = [_article(item, "") for item in re.split(r"[,;\n]", _text(value, key)) if item.strip()]
            elif key == "availability":
                statuses = {"in_stock": "In Stock", "on_order": "On Order", "unavailable": "Unavailable"}
                status = statuses.get(_header(value))
                if status is None:
                    raise ValueError("Choose In Stock, On Order or Unavailable.")
                specs[key] = status
            else:
                (specs if key in SPEC_FIELDS else fields)[key] = _text(value, key)
        except (ValueError, OverflowError) as exc:
            errors.append(f"{label}: {exc}")
    if specs:
        fields["specs"] = specs
    if operation == "add":
        errors.extend(new_product_issues(fields, floor_id))
    return output


def _column_mapping(headers, operation: str) -> list[tuple[str, str]]:
    mapping = []
    seen = set()
    for header in headers:
        label = str(header).strip() if header is not None else ""
        key = ALIASES.get(_header(label), "")
        if operation == "prices" and key == "mrp":
            key = "new_mrp"
        if key and key in seen:
            raise ValueError(f"Multiple columns map to {label}. Keep only one.")
        seen.add(key)
        mapping.append((key, label))
    if "sku" not in seen:
        raise ValueError("The worksheet must contain an Article No. column in the first row.")
    if operation == "prices" and "new_mrp" not in seen:
        raise ValueError("The worksheet must contain a New MRP or MRP column.")
    return mapping


def _tabular_rows(records, sheet: str, floor_id: str, operation: str, brand: str | None) -> tuple[list[dict], int | None, int | None]:
    records = iter(records)
    headers = next(records, ())
    mapping = _column_mapping((value for value, _, _ in headers), operation)
    rows = []
    for row_number, record in enumerate(records, start=2):
        if not any(not _blank(value) for value, _, _ in record):
            continue
        if len(rows) >= MAX_ROWS:
            raise ValueError("Catalogue row limit exceeded. Split the source file.")
        cells = [
            (*(mapping[index] if index < len(mapping) and mapping[index][1] else ("", f"Column {index + 1}")), value, fmt, cell_type)
            for index, (value, fmt, cell_type) in enumerate(record)
        ]
        rows.append(_parse_row(row_number, sheet, cells, floor_id, operation, brand))
    image_column = next((i for i, (key, _) in enumerate(mapping) if key == "image"), None)
    dimension_column = next((i for i, (key, _) in enumerate(mapping) if key == "dimension_image"), None)
    return rows, image_column, dimension_column


def _stage_image(result: CatalogueExtraction, row: dict, url: str, *, role: str = "hero", image_bytes: list[int]) -> str | None:
    from PIL import Image, UnidentifiedImageError
    from .image_extractor import classify_quality

    try:
        header, encoded = url.split(",", 1)
        if not re.fullmatch(r"data:image/(?:png|jpe?g|webp);base64", header, re.IGNORECASE):
            raise ValueError("Image must be PNG, JPEG or WebP.")
        if len(encoded) > 4 * math.ceil(MAX_IMAGE_BYTES / 3):
            raise ValueError("Image exceeds the 12 MiB limit.")
        data = base64.b64decode(encoded, validate=True)
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise ValueError("Image is empty or exceeds the 12 MiB limit.")
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError("Image is not PNG, JPEG or WebP.")
            media_type = Image.MIME[image.format]
            width, height = image.size
            image.verify()
    except (ValueError, binascii.Error, UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError) as exc:
        row["errors"].append(f"Invalid embedded image ({type(exc).__name__}).")
        return None
    digest = hashlib.sha256(data).hexdigest()
    if digest not in result.images:
        image_bytes[0] += len(data)
        if image_bytes[0] > MAX_TOTAL_IMAGE_BYTES:
            raise ValueError("Decoded images exceed the import limit. Split the workbook into smaller files.")
        result.images[digest] = SourceImage(data, media_type, width, height, classify_quality(max(width, height), "raster"))
    if digest not in row["image_hashes"]:
        row["image_hashes"].append(digest)
    elif role == "dimension":
        row["errors"].append("The same image is marked as both a product photo and a dimension diagram.")
        return None
    if role == "dimension":
        row.setdefault("image_roles", {})[digest] = role
    return digest


def _reviewed_workbook(path, data, *, floor_id, brand, operation, worksheet, headers, include_images):
    """Use the existing reviewed BIANA and MCM source geometry."""
    recognized = _identity(brand or "")
    if recognized == "biana" and floor_id == "first-floor" and worksheet == "Table 1" and headers == (
        "SR.", None, "IMAGES", "SIZE", None, None,
    ):
        from .biana_source import extract_rows

        records = extract_rows(path)
        source = "biana"
    elif recognized == "mcm" and floor_id == "ground-floor" and headers == (
        "SR.", "PRODUCT NAME", "IMAGE", "PRODUCT SIZE", "FINISHES", "BOX IN PIS", "BOX SQFT", "RATE SQFT",
    ):
        if operation == "prices":
            raise ValueError("This MCM sheet has no supplier article numbers. Export a price workbook for a price-only update.")
        from .adapters.tile_catalog_2026 import MCMAdapter

        extracted, report = MCMAdapter().extract(data, path.name, sheet=worksheet, include_images=include_images)
        if not extracted or report.warnings:
            raise ValueError("The selected MCM worksheet could not be mapped reliably.")
        records = [{**item.to_public(), "variant": item.variant, "specs": item.specs} for item in extracted]
        source = "mcm"
    else:
        return None

    result = CatalogueExtraction()
    total = [0]
    for item in records:
        sku = item["sku"]
        row = {"sku": sku, "row": item["specs"]["source_row"], "sheet": worksheet,
               "fields": {}, "errors": [], "image_hashes": []}
        if operation == "prices":
            row["fields"]["new_mrp"] = item["mrp"]
        elif operation != "images":
            row["fields"] = {
                key: item[key] for key in ("name", "category", "size", "dimensions", "description", "family_key",
                    "family_name", "finish", "finish_code", "mrp")
                if item.get(key) not in (None, MISSING, "")
            }
            if item.get("variant") not in (None, MISSING, ""):
                row["fields"]["variant_label"] = item["variant"]
            if source == "mcm":
                specs = item["specs"]
                if specs.get("needs_pricing") or str(specs.get("source_rate") or "").strip() == "":
                    row["errors"].append("A valid supplier rate is required.")
                row["fields"]["specs"] = {key: specs[key] for key in (
                    "price_unit", "pcs_per_box", "sqft_per_box",
                ) if specs.get(key)}
                try:
                    for key in ("pcs_per_box", "sqft_per_box"):
                        if key in row["fields"]["specs"]:
                            value = _number(row["fields"]["specs"][key])
                            if not value or key == "pcs_per_box" and not value.is_integer():
                                raise ValueError("Packaging measurements must be positive.")
                            row["fields"]["specs"][key] = str(int(value)) if key == "pcs_per_box" else value
                except ValueError:
                    row["errors"].append("Invalid pieces or square feet per box.")
        if source == "mcm":
            if not item["specs"].get("source_serial"):
                row["errors"].append("The MCM source serial is required for reviewed identity matching.")
            row["legacy_identity"] = {key: item.get(key) for key in ("name", "size", "finish")}
        if operation == "add":
            row["errors"].extend(new_product_issues(row["fields"], floor_id))
        if include_images and operation != "prices":
            for url in item.get("images") or []:
                _stage_image(result, row, url, image_bytes=total)
        result.rows.append(row)
    return result


def _xlsx(path: Path, floor_id: str, operation: str, brand: str | None, sheet: str | None, include_images: bool) -> CatalogueExtraction:
    from openpyxl import load_workbook
    from .image_extractor import extract_images_from_xlsx_ex

    # Reuse the supplier archive/expansion checks before invoking a workbook decoder.
    data = path.read_bytes()
    validate_source(data, path.name)
    try:
        with path.open("rb") as source:
            workbook = load_workbook(source, read_only=True, keep_links=False)
            try:
                if sheet and sheet not in workbook.sheetnames:
                    raise ValueError(f"Worksheet {sheet!r} was not found.")
                default = "Price Updates" if operation == "prices" else "Products"
                worksheet = workbook[sheet or default] if sheet or default in workbook.sheetnames else workbook.active
                if worksheet is None:
                    raise ValueError("The workbook has no worksheet.")
                headers = tuple(next(worksheet.values, ()))
                reviewed = _reviewed_workbook(path, data, floor_id=floor_id, brand=brand, operation=operation,
                    worksheet=worksheet.title, headers=headers, include_images=include_images)
                if reviewed is not None:
                    return reviewed
                records = (
                    tuple((cell.value, cell.number_format, cell.data_type) for cell in record)
                    for record in worksheet.iter_rows()
                )
                rows, image_column, dimension_column = _tabular_rows(records, worksheet.title, floor_id, operation, brand)
                sheet = worksheet.title
            finally:
                workbook.close()
    except (KeyError, OSError, TypeError) as exc:
        raise ValueError("This workbook could not be read.") from exc
    result = CatalogueExtraction(rows=rows)
    if not include_images or operation == "prices" or not rows:
        return result
    targets = {row["row"]: row for row in rows}
    total = [0]
    invalid: set[int] = set()
    for column, role in ((image_column, "hero"), (dimension_column, "dimension")):
        if column is None and (role == "dimension" or dimension_column is not None):
            continue
        by_row: dict[int, str] = {}
        for _, row_number, _, image in extract_images_from_xlsx_ex(
            data, selected_sheet=sheet, selected_rows=set(targets), selected_column=column, invalid_rows=invalid,
        ):
            row = targets[row_number]
            previous = by_row.get(row_number)
            if previous is not None:
                _, encoded = image.data_url.split(",", 1)
                digest = hashlib.sha256(base64.b64decode(encoded)).hexdigest()
                if digest == previous:
                    continue
                row["errors"].append("Multiple different images have the same role on this row. Keep one exact image per role.")
            else:
                digest = _stage_image(result, row, image.data_url, role=role, image_bytes=total)
                if digest:
                    by_row[row_number] = digest
    for row_number in invalid:
        targets[row_number]["errors"].append("The embedded image could not be decoded.")
    return result


def _csv(path: Path, floor_id: str, operation: str, brand: str | None) -> CatalogueExtraction:
    try:
        with path.open(encoding="utf-8-sig", newline="") as handle:
            def records():
                for row in csv.reader(handle, strict=True):
                    if len(row) > MAX_WORKSHEET_COLUMNS:
                        raise ValueError("CSV contains too many columns.")
                    yield tuple((value, "", "s") for value in row)
            rows, _, _ = _tabular_rows(records(), "CSV", floor_id, operation, brand)
    except (UnicodeError, csv.Error) as exc:
        raise ValueError("Use a valid, comma-separated UTF-8 CSV file.") from exc
    return CatalogueExtraction(rows=rows)


def _select_pdf_pages(document, physical_pages: tuple[int, int] | None, printed_pages: tuple[int, int] | None) -> list[int]:
    if not physical_pages and not printed_pages:
        return list(range(len(document)))
    start, end = physical_pages or printed_pages
    minimum = 1 if physical_pages else 0
    if start < minimum or end < start or end - start + 1 > MAX_PDF_PAGES:
        raise ValueError("Enter a valid inclusive PDF page range.")
    if physical_pages:
        if end > len(document):
            raise ValueError("The requested physical PDF pages do not exist.")
        return list(range(start - 1, end))
    wanted = set(range(start, end + 1))
    by_number: dict[int, list[int]] = {}
    labels = bool(document.get_page_labels())
    for index, page in enumerate(document):
        if labels:
            candidates = [page.get_label()]
        else:
            rectangle = page.rect
            clip = (rectangle.x0, rectangle.y0 + rectangle.height * 0.9, rectangle.x1, rectangle.y1)
            candidates = page.get_text(clip=clip).splitlines()
        numbers = {int(match[1]) for value in candidates if (match := PRINTED_NUMBER.fullmatch(value.strip()))}
        if len(numbers) == 1:
            number = numbers.pop()
            if number in wanted:
                by_number.setdefault(number, []).append(index)
    selected = [by_number.get(number, []) for number in range(start, end + 1)]
    if any(len(matches) != 1 for matches in selected):
        raise ValueError("The printed PDF range could not be mapped uniquely. Supply the confirmed physical PDF page indexes.")
    return [matches[0] for matches in selected]


def _plain_pdf_prices(document) -> list[tuple[int, str, float]]:
    rows = []
    for page in document:
        in_price_table = False
        for line in page.get_text("text", sort=True).splitlines():
            line = line.strip()
            if re.fullmatch(r"(?:ARTICLE(?:\s+(?:NO\.?|NUMBER))?|SKU|PRODUCT CODE)\s+(?:NEW\s+)?(?:MRP|LIST PRICE)(?:\s+\(?(?:INR|₹)\)?)?", line, re.IGNORECASE):
                in_price_table = True
                continue
            if not in_price_table or not line:
                continue
            match = PDF_PRICE.fullmatch(line)
            if match is None or not PRICE_NUMBER.fullmatch(match["price"]):
                in_price_table = False
                continue
            rows.append((page.number, match["sku"], _number(match["price"])))
    return rows


def _reviewed_grohe_pdf(path: Path, floor_id: str, operation: str, brand: str | None,
                        physical_pages, printed_pages, include_images: bool) -> CatalogueExtraction | None:
    """Reuse the verified per-card map for the original two-up ceramics section."""
    if (brand or "").casefold() != "grohe" or floor_id != "first-floor" or not (printed_pages or physical_pages):
        return None
    from .grohe_ceramics import extract_images, load_manifest

    manifest = load_manifest()
    with path.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != manifest["pdf_sha256"]:
            return None
    key = "printed_page" if printed_pages else "pdf_page"
    reviewed_start, reviewed_end = (
        manifest["printed_page_range"] if printed_pages else
        (min(row[key] for row in manifest["products"]), max(row[key] for row in manifest["products"]))
    )
    start, end = printed_pages or physical_pages
    if not reviewed_start <= start <= end <= reviewed_end:
        raise ValueError(
            f"The reviewed GROHE section covers {reviewed_start}–{reviewed_end} in this page numbering. "
            "Select a range fully inside the reviewed section or supply a verified worksheet for the other pages."
        )
    chosen = [row for row in manifest["products"] if start <= row[key] <= end]
    if not chosen:
        raise ValueError("No priced GROHE product cards exist in the selected range.")
    assets = extract_images(path.read_bytes(), {**manifest, "products": chosen}) if include_images and operation != "prices" else {}
    result = CatalogueExtraction()
    total = [0]
    for card in chosen:
        fields = {}
        if operation == "prices":
            fields["new_mrp"] = card["mrp"]
        elif operation != "images":
            fields = {key: card[key] for key in ("name", "category", "series", "mrp", "finish", "colour", "dimensions")
                      if card.get(key)}
            fields.update(
                subcategory=card["product_type"],
                description="\n".join((card["name"], *card.get("notes", []))),
                family_key=f"grohe:ceramics:{card['sku'].lower()}",
                family_name=card["name"],
                specs={"source_page": card["pdf_page"], "printed_source_page": card["printed_page"],
                       "source_article": card["article_label"]},
            )
            if card.get("dimensions"):
                fields["size"] = card["dimensions"]
            if card.get("finish"):
                fields["variant_label"] = card["finish"]
            if card.get("seat_cover_sku"):
                fields["specs"]["grohe_seat_cover_sku"] = card["seat_cover_sku"]
        row = {"row": card["printed_page"], "sheet": f"PDF page {card['pdf_page']}", "sku": card["sku"],
               "fields": fields, "errors": [], "image_hashes": []}
        if assets:
            image, mime = assets[card["image_xref"]]
            _stage_image(result, row, f"data:{mime};base64,{base64.b64encode(image).decode('ascii')}", image_bytes=total)
        result.rows.append(row)
    return result


def _pdf(path: Path, floor_id: str, operation: str, brand: str | None, physical_pages, printed_pages, include_images: bool) -> CatalogueExtraction:
    import fitz
    from .adapters import get_adapter

    reviewed = _reviewed_grohe_pdf(path, floor_id, operation, brand, physical_pages, printed_pages, include_images)
    if reviewed is not None:
        return reviewed
    try:
        with fitz.open(path) as original:
            if original.needs_pass or not original.is_pdf or len(original) > MAX_PDF_PAGES:
                raise ValueError("PDF is encrypted, invalid or exceeds the page limit.")
            page_indexes = _select_pdf_pages(original, physical_pages, printed_pages)
            with fitz.open() as selected:
                for index in page_indexes:
                    selected.insert_pdf(original, from_page=index, to_page=index, links=False, annots=False, widgets=False)
                simple = _plain_pdf_prices(selected) if operation == "prices" else []
                if simple:
                    rows = [
                        _parse_row(page_indexes[index] + 1, "PDF", [
                            ("sku", "Article No.", sku, "", "s"), ("new_mrp", "New MRP", price, "", "n"),
                        ], floor_id, operation, brand)
                        for index, sku, price in simple
                    ]
                    return CatalogueExtraction(rows=rows)
                if not any(page.get_text().strip() for page in selected):
                    raise ValueError("Selected PDF pages have no text. Upload a verified text extraction or workbook.")
                data = selected.tobytes(garbage=4, deflate=True)
    except (RuntimeError, OSError) as exc:
        raise ValueError("This PDF could not be read.") from exc

    adapter = get_adapter(brand or "")
    if ".pdf" not in adapter.supported_extensions:
        raise ValueError("This PDF layout has no verified supplier parser. Supply a workbook or UTF-8 CSV with confirmed article numbers.")
    validate_source(data, path.name)
    extracted, report = adapter.extract(data, path.name)
    if not extracted or len(extracted) > MAX_ROWS:
        raise ValueError("No reliable product rows were found in the requested PDF pages, or the row limit was exceeded.")
    result = CatalogueExtraction(warnings=report.warnings)
    total = [0]
    for index, item in enumerate(extracted, 1):
        page = item.image_page
        source_row = page_indexes[page - 1] + 1 if page and 1 <= page <= len(page_indexes) else index
        raw = item.to_public()
        raw.update(price=item.dealer_price, variant_label=item.variant)
        raw["accessory_skus"] = ", ".join(item.accessories or [])
        raw["concealed_skus"] = ", ".join(item.concealed_skus or [])
        if operation == "prices":
            raw["new_mrp"] = item.mrp
        keys = ("sku", "new_mrp") if operation == "prices" else tuple(key for key in PRODUCT_COLUMNS if key not in {"image", "brand", "department"})
        cells = [(key, PRODUCT_COLUMNS.get(key, PRICE_COLUMNS.get(key, key)), raw.get(key), "", "s")
                 for key in keys if raw.get(key) not in (None, MISSING, [], "")]
        if not any(cell[0] == "sku" for cell in cells):
            cells.insert(0, ("sku", "Article No.", None, "", "s"))
        row = _parse_row(source_row, "PDF", cells, floor_id, operation, brand)
        result.rows.append(row)
        if floor_id == "ground-floor" and item.specs and operation in {"add", "sync", "update"}:
            row["fields"].setdefault("specs", {}).update({key: item.specs[key] for key in TILE_COLUMNS if key in item.specs})
            row["errors"] = [error for error in row["errors"] if not error.endswith("is required for a new product.")]
            if operation == "add":
                row["errors"].extend(new_product_issues(row["fields"], floor_id))
        if include_images and operation != "prices":
            for url in item.images:
                _stage_image(result, row, url, image_bytes=total)
    return result


def read_catalogue(
    source: Path, *, floor_id: str, operation: str, sheet: str | None = None, brand: str | None = None,
    physical_pages: tuple[int, int] | None = None, printed_pages: tuple[int, int] | None = None, include_images: bool = True,
) -> CatalogueExtraction:
    """Return row-level validation and deduplicated source media without database access."""
    _check_scope(floor_id, operation)
    if not 0 < source.stat().st_size <= MAX_SOURCE_BYTES:
        raise ValueError("Upload a nonempty source file up to 80 MiB.")
    suffix = source.suffix.casefold()
    if physical_pages and printed_pages or (physical_pages or printed_pages) and suffix != ".pdf":
        raise ValueError("Choose either physical or printed PDF pages for a PDF source.")
    if sheet and suffix != ".xlsx":
        raise ValueError("A worksheet selection requires an XLSX workbook.")
    if suffix == ".xlsx":
        result = _xlsx(source, floor_id, operation, brand, sheet, include_images)
    elif suffix == ".csv":
        result = _csv(source, floor_id, operation, brand)
    elif suffix == ".pdf":
        result = _pdf(source, floor_id, operation, brand, physical_pages, printed_pages, include_images)
    else:
        raise ValueError("Use an XLSX, UTF-8 CSV or supported text PDF catalogue.")
    if not result.rows:
        raise ValueError("The selected source has no product rows below the headers.")
    if operation == "images" and include_images:
        for row in result.rows:
            if not row["image_hashes"]:
                row["errors"].append("No verified embedded image was found for this article.")
    return result


def write_template(floor_id: str, operation: str, rows: Iterable[dict] = ()) -> bytes:
    """Return an editable workbook or a prefilled export using the same import headers."""
    from openpyxl import Workbook
    from openpyxl.cell import WriteOnlyCell
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.datavalidation import DataValidation

    _check_scope(floor_id, operation)
    if operation == "prices":
        columns = PRICE_COLUMNS
    elif operation == "images":
        columns = IMAGE_COLUMNS
    else:
        columns = {**PRODUCT_COLUMNS, **(TILE_COLUMNS if floor_id == "ground-floor" else {})}
    workbook = Workbook(write_only=True)
    data = workbook.create_sheet("Price Updates" if operation == "prices" else "Products")
    data.freeze_panes = "B2"
    headers = []
    for offset, (key, label) in enumerate(columns.items(), 1):
        cell = WriteOnlyCell(data, value=label)
        cell.font = Font(color="FFFFFF", bold=True)
        cell.fill = PatternFill("solid", fgColor="24515A")
        letter = get_column_letter(offset)
        dimension = data.column_dimensions[letter]
        dimension.width = max(len(label) + 3, 18 if key in NUMERIC_COLUMNS else 23)
        if key == "sku":
            dimension.number_format = "@"
        elif key in NUMERIC_COLUMNS:
            dimension.number_format = "#,##0.00"
        if key in {"price_unit", "availability"}:
            choices = "Piece,Box,Sqft" if key == "price_unit" else "In Stock,On Order,Unavailable"
            validation = DataValidation(type="list", formula1=f'"{choices}"', allow_blank=True, showErrorMessage=True)
            validation.errorTitle = "Choose a listed value"
            validation.error = "Use the dropdown to select a value."
            data.data_validations.append(validation)
            validation.add(f"{letter}2:{letter}{MAX_ROWS + 1}")
        headers.append(cell)
    data.append(headers)

    last_row = 1
    for last_row, row in enumerate(rows, 2):
        fields = {**row, **(row.get("fields") or {})}
        output = []
        for key in columns:
            value = fields.get(key)
            if key == "current_mrp" and key not in fields:
                value = fields.get("mrp")
            if key in SPEC_FIELDS and value is None:
                value = (fields.get("specs") or {}).get(key)
            if isinstance(value, list):
                value = ", ".join(map(str, value))
            cell = WriteOnlyCell(data, value=value)
            if isinstance(value, str) or key == "sku" and value is not None:
                # Force literal text instead of prefixing an apostrophe that
                # would change the article number on re-import.
                cell.value = str(value)
                cell.data_type = "s"
            if key == "sku":
                cell.number_format = "@"
            elif key in NUMERIC_COLUMNS:
                cell.number_format = "#,##0.00"
            output.append(cell)
        data.append(output)
    data.auto_filter.ref = f"A1:{get_column_letter(len(columns))}{last_row}"

    instructions = workbook.create_sheet("Instructions")
    instructions.column_dimensions["A"].width = 108
    title = WriteOnlyCell(instructions, value=FLOORS[floor_id])
    title.font = Font(color="24515A", size=15, bold=True)
    instructions.append([title])
    notes = ["Write one product per row. Keep the headers and enter the supplier article as text, including leading zeros."]
    if operation == "prices":
        notes.extend((
            "Required for a price change: Article No. and New MRP. Blank New MRP leaves the product unchanged.",
            "Keep exported Current MRP as shown. It is used to detect a price change made while the workbook was offline.",
            "Example: Article No. 00125A · Current MRP 11350 · New MRP 12500.",
        ))
    elif operation == "images":
        notes.append("Anchor exact product images and optional dimension diagrams in their named columns on the article's row.")
    else:
        notes.extend((
            "Required for new products: Article No., Product Name, Category and MRP. Enter Offer Price only when supplied.",
            "Optional fields can stay blank. Keep an embedded product picture anchored in that product's Product Image cell.",
            "Example: Article No. 00125A · Product Name Basin Mixer · Category Basin Mixer · Finish Chrome · MRP 12500.",
        ))
        if floor_id == "ground-floor":
            notes.extend((
                "For new Tiles products, include Size and Price Unit. For Box and Sqft pricing, enter Pieces per Box.",
                "Sqft pricing also requires Square Feet per Box. MRP and Offer Price use the selected Price Unit.",
            ))
    for index, note in enumerate(notes, 2):
        cell = WriteOnlyCell(instructions, value=note)
        cell.alignment = Alignment(wrap_text=True, vertical="center")
        instructions.row_dimensions[index].height = 34
        instructions.append([cell])
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()
