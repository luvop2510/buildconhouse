"""Budgets for untrusted supplier documents, checked before adapter parsing."""
from __future__ import annotations

from io import BytesIO
from pathlib import PurePosixPath
import re
import zipfile
from xml.etree import ElementTree as ET

MAX_SOURCE_BYTES = 80 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 10_000
MAX_MEMBER_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_COMPRESSION_RATIO = 1_000
MAX_WORKSHEET_ROWS = 100_000
MAX_WORKSHEET_COLUMNS = 512
MAX_WORKSHEET_RECTANGLE = 2_000_000
MAX_WORKBOOK_CELLS = 4_000_000
MAX_XML_ELEMENTS = 2_000_000
MAX_XML_DEPTH = 64
MAX_PDF_PAGES = 1_000
MAX_IMAGES = 5_000
MAX_ROWS = 50_000
MAX_RESULT_BYTES = 256 * 1024 * 1024
_CELL_REF = re.compile(r"^([A-Za-z]{1,3})([1-9][0-9]{0,6})$")


class ImportResourceLimitError(ValueError):
    """Supplier input exceeds a documented parsing budget or is malformed."""


def _coordinate(value: str) -> tuple[int, int]:
    match = _CELL_REF.fullmatch(value)
    if not match:
        raise ImportResourceLimitError("Invalid worksheet cell coordinate")
    col = 0
    for char in match.group(1).upper():
        col = col * 26 + ord(char) - ord("A") + 1
    row = int(match.group(2))
    if row > MAX_WORKSHEET_ROWS or col > MAX_WORKSHEET_COLUMNS:
        raise ImportResourceLimitError("Worksheet row or column limit exceeded")
    return row, col


def _validate_xml(raw: bytes, *, worksheet: bool) -> tuple[int, int]:
    # The package never needs DTDs/entities. Reject them before any XML parser.
    declaration_bytes = raw.replace(b"\x00", b"").upper()
    if b"<!DOCTYPE" in declaration_bytes or b"<!ENTITY" in declaration_bytes:
        raise ImportResourceLimitError("XML document types and entities are not supported")
    del declaration_bytes
    depth = elements = cells = max_row = max_col = 0
    declared_area = 0
    try:
        for event, element in ET.iterparse(BytesIO(raw), events=("start", "end")):
            if event == "start":
                depth += 1
                elements += 1
                if depth > MAX_XML_DEPTH or elements > MAX_XML_ELEMENTS:
                    raise ImportResourceLimitError("XML structural limit exceeded")
                if worksheet:
                    tag = element.tag.rsplit("}", 1)[-1]
                    if tag == "dimension" and element.get("ref"):
                        for coordinate in element.attrib["ref"].split(":"):
                            row, col = _coordinate(coordinate)
                            declared_area = max(declared_area, row * col)
                            if row * col > MAX_WORKSHEET_RECTANGLE:
                                raise ImportResourceLimitError("Worksheet area limit exceeded")
                    if tag == "c":
                        cells += 1
                        row, col = _coordinate(element.get("r", ""))
                        max_row, max_col = max(max_row, row), max(max_col, col)
                        if cells > MAX_WORKBOOK_CELLS or max_row * max_col > MAX_WORKSHEET_RECTANGLE:
                            raise ImportResourceLimitError("Worksheet cell or area limit exceeded")
            else:
                depth -= 1
                element.clear()
    except ET.ParseError as exc:
        raise ImportResourceLimitError("Invalid supplier XML") from exc
    return cells, max(declared_area, max_row * max_col)


def validate_xlsx(data: bytes) -> None:
    """Bound expansion, XML and sparse sheet rectangles before openpyxl sees them."""
    try:
        with zipfile.ZipFile(BytesIO(data)) as archive:
            members = archive.infolist()
            if len(members) > MAX_ARCHIVE_MEMBERS:
                raise ImportResourceLimitError("Workbook contains too many archive entries")
            names: set[str] = set()
            expanded = images = sheets = cells = rectangles = 0
            for member in members:
                name = member.filename
                if name in names or member.flag_bits & 1:
                    raise ImportResourceLimitError("Duplicate or encrypted workbook entry")
                names.add(name)
                path = PurePosixPath(name)
                if path.is_absolute() or ".." in path.parts or "\\" in name:
                    raise ImportResourceLimitError("Invalid workbook archive path")
                expanded += member.file_size
                if member.file_size > MAX_MEMBER_BYTES or expanded > MAX_EXPANDED_BYTES:
                    raise ImportResourceLimitError("Workbook expanded size limit exceeded")
                if member.file_size > max(member.compress_size, 1) * MAX_COMPRESSION_RATIO:
                    raise ImportResourceLimitError("Workbook compression ratio limit exceeded")
                if name.startswith("xl/media/"):
                    images += 1
                    if images > MAX_IMAGES:
                        raise ImportResourceLimitError("Workbook contains too many images")
            if "xl/workbook.xml" not in names or "[Content_Types].xml" not in names:
                raise ImportResourceLimitError("Not an XLSX workbook")
            for member in members:
                if member.filename.endswith((".xml", ".rels")):
                    worksheet = bool(re.fullmatch(r"xl/worksheets/[^/]+\.xml", member.filename))
                    with archive.open(member) as stream:
                        raw = stream.read(MAX_MEMBER_BYTES + 1)
                    if len(raw) > MAX_MEMBER_BYTES:
                        raise ImportResourceLimitError("Workbook XML size limit exceeded")
                    count, area = _validate_xml(raw, worksheet=worksheet)
                    cells += count
                    rectangles += area
                    if cells > MAX_WORKBOOK_CELLS or rectangles > MAX_WORKBOOK_CELLS:
                        raise ImportResourceLimitError("Workbook cell limit exceeded")
                    if worksheet:
                        # Budget separately for each sheet even when dimensions
                        # omit cells; actual rectangular checks occur above.
                        sheets += 1
                        if sheets > 256:
                            raise ImportResourceLimitError("Workbook contains too many sheets")
    except (zipfile.BadZipFile, RuntimeError, OSError, EOFError) as exc:
        raise ImportResourceLimitError("Invalid XLSX archive") from exc


def validate_source(data: bytes, filename: str) -> None:
    if not data or len(data) > MAX_SOURCE_BYTES:
        raise ImportResourceLimitError("Supplier file is empty or exceeds the 80MB limit")
    extension = PurePosixPath(filename).suffix.lower()
    if extension == ".xlsx":
        validate_xlsx(data)
    elif extension == ".pdf":
        from pypdf import PdfReader
        try:
            document = PdfReader(BytesIO(data))
            if document.is_encrypted or len(document.pages) > MAX_PDF_PAGES:
                raise ImportResourceLimitError("PDF is encrypted or exceeds the page limit")
            images = 0
            for page in document.pages:
                resources = page.get("/Resources", {})
                resources = resources.get_object() if hasattr(resources, "get_object") else resources
                objects = resources.get("/XObject", {})
                objects = objects.get_object() if hasattr(objects, "get_object") else objects
                images += len(objects)
                if images > MAX_IMAGES:
                    raise ImportResourceLimitError("PDF contains too many image or form objects")
        except ImportResourceLimitError:
            raise
        except Exception as exc:
            raise ImportResourceLimitError("Invalid supplier PDF") from exc
    elif extension != ".csv":
        raise ImportResourceLimitError("Unsupported supplier file type")
