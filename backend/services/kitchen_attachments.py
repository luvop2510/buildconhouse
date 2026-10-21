"""Private attachment preparation; finalization must be a project CAS command.

No public URL or arbitrary object key is accepted. Only approved formats pass.
"""
from __future__ import annotations

import hashlib
import asyncio
import io
from pathlib import PurePath

from fastapi import HTTPException

from services import kitchen_access as access

MAX_FILE_BYTES = 768 * 1024  # ordinary single request stays bounded
MAX_TRANSFER_BYTES = 25_000_000  # approved 21 October; chunked transport only
MAGIC = {"application/pdf": (b"%PDF-",), "image/jpeg": (b"\xff\xd8\xff",),
         "image/png": (b"\x89PNG\r\n\x1a\n",)}


MIME_ALIASES = {
    "application/acad": "image/vnd.dwg", "application/x-acad": "image/vnd.dwg",
    "application/x-dwg": "image/vnd.dwg", "application/dwg": "image/vnd.dwg", "image/x-dwg": "image/vnd.dwg",
    "application/dxf": "image/vnd.dxf", "application/x-dxf": "image/vnd.dxf", "image/x-dxf": "image/vnd.dxf",
}
FILE_EXTENSIONS = {"application/pdf": {".pdf"}, "image/jpeg": {".jpg", ".jpeg"}, "image/png": {".png"},
    "image/vnd.dwg": {".dwg"}, "image/vnd.dxf": {".dxf"},
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {".docx"},
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {".xlsx"}}


def canonical_type(content_type):
    return MIME_ALIASES.get(content_type, content_type)


def validate_printer_settings(data):
    """Recognize a single DEVMODEA/W envelope, never interpret driver bytes.

    https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/1cdc4cb9-836d-41d6-a5b5-9ac0428f491c
    https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-devmodew
    """
    for size_offset, minimum in ((36, 44), (68, 76)):
        if len(data) >= minimum:
            public_size = int.from_bytes(data[size_offset:size_offset + 2], "little")
            driver_size = int.from_bytes(data[size_offset + 2:size_offset + 4], "little")
            if public_size >= minimum and public_size + driver_size == len(data):
                return
    raise ValueError("Invalid printer settings structure")


def validate_office(data, extension):
    import io
    import re
    import zipfile
    import zlib
    import xml.etree.ElementTree as ET
    try:
        if not data.startswith(b"PK\x03\x04"):
            raise ValueError("Executable or invalid package prefix")
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            entries = package.infolist()
            if not entries or len(entries) > 256 or sum(e.file_size for e in entries) > 16 * 1024 * 1024:
                raise ValueError("Package expansion exceeds its bound")
            names = set()
            binary_parts = set()
            content_defaults, content_overrides = {}, {}
            for entry in entries:
                name = entry.filename
                if name in names or name.startswith("/") or "\\" in name or ":" in name or ".." in name.split("/"):
                    raise ValueError("Unsafe package path")
                names.add(name)
                if entry.flag_bits & 1 or entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                    raise ValueError("Encrypted/unsupported package")
                if entry.file_size > 4 * 1024 * 1024 or entry.file_size > max(entry.compress_size * 200, 65536):
                    raise ValueError("Unsafe package expansion")
                lower = name.lower()
                if lower.endswith(".bin"):
                    binary_parts.add(name)
                if lower.endswith((".exe", ".dll", ".com", ".bat", ".cmd", ".js", ".vbs", ".ps1")) or "/embeddings/" in lower or "vbaproject" in lower:
                    raise ValueError("Executable or embedded package content")
            required = "word/document.xml" if extension == ".docx" else "xl/workbook.xml"
            if not {"[Content_Types].xml", "_rels/.rels", required}.issubset(names):
                raise ValueError("Missing Office package structure")
            for name in names:
                if name.endswith((".xml", ".rels")):
                    content = package.read(name)
                    markup = content.replace(b"\x00", b"").upper()
                    if b"<!DOCTYPE" in markup or b"<!ENTITY" in markup:
                        raise ValueError("Unsafe XML declaration")
                    root = ET.fromstring(content)
                    if name == "[Content_Types].xml":
                        ns = "{http://schemas.openxmlformats.org/package/2006/content-types}"
                        if root.tag != ns + "Types":
                            raise ValueError("Invalid content type declarations")
                        for child in root:
                            if child.tag == ns + "Default":
                                key = child.attrib.get("Extension", "").lower()
                                if not key or key in content_defaults:
                                    raise ValueError("Duplicate or invalid content type default")
                                content_defaults[key] = child.attrib.get("ContentType")
                            elif child.tag == ns + "Override":
                                key = child.attrib.get("PartName", "")
                                if not key.startswith("/") or key in content_overrides:
                                    raise ValueError("Duplicate or invalid part content type")
                                content_overrides[key] = child.attrib.get("ContentType")
                        expected = ("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" if extension == ".docx"
                                    else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml")
                        if content_overrides.get("/" + required) != expected:
                            raise ValueError("Office package type mismatch")
                    if name == required and root.tag != ("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}document" if extension == ".docx" else "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}workbook"):
                        raise ValueError("Office root type mismatch")
            for name in binary_parts:
                # Printer settings are legitimate XLSX binary parts. All other
                # binary parts, including macros and OLE, remain unsupported.
                if extension != ".xlsx" or not re.fullmatch(r"xl/printerSettings/printerSettings(?:[1-9][0-9]*)?\.bin", name):
                    raise ValueError("Unsupported binary Office part")
                kind = content_overrides.get("/" + name, content_defaults.get("bin"))
                if kind != "application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings":
                    raise ValueError("Invalid printer settings content type")
                validate_printer_settings(package.read(name))
    except (ValueError, KeyError, OSError, RuntimeError, zipfile.BadZipFile, zlib.error, ET.ParseError) as exc:
        raise HTTPException(415, "Invalid, unsafe, encrypted or oversized Office package") from exc


BINARY_DXF_SENTINEL = b"AutoCAD Binary DXF\r\n\x1a\x00"


def dxf_value_kind(code):
    """Autodesk DXF group storage types, without interpreting drawing objects.

    https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-DXF/files/GUID-FC1C3C69-DBC2-49E4-893A-000D6538C0FE.htm
    https://help.autodesk.com/cloudhelp/2019/ENU/AutoCAD-DXF/files/GUID-2553CF98-44F6-4828-82DD-FE3BC7448113.htm
    """
    if 0 <= code <= 9 or code in {100, 101, 102, 105, 999} or any(a <= code <= b for a, b in
        ((300, 309), (320, 369), (390, 399), (410, 419), (430, 439), (470, 481), (1000, 1003), (1005, 1009))):
        return "string"
    if 310 <= code <= 319 or code == 1004:
        return "chunk"
    if any(a <= code <= b for a, b in ((10, 59), (110, 149), (210, 239), (460, 469), (1010, 1059))):
        return 8
    if any(a <= code <= b for a, b in ((60, 79), (170, 179), (270, 289), (370, 389), (400, 409), (1060, 1070))):
        return 2
    if code == 1071 or any(a <= code <= b for a, b in ((90, 99), (420, 429), (440, 459))):
        return 4
    if 160 <= code <= 169:
        return 8
    if 290 <= code <= 299:
        return "bool"
    raise ValueError("Unsupported DXF group code")


def dxf_framed(pairs):
    """Require complete nonnested section envelopes and one terminal EOF."""
    section = need_name = saw_section = ended = False
    for code, value in pairs:
        if ended:
            return False
        if isinstance(value, bytes):
            value = value.decode("ascii", errors="replace")
        if need_name:
            if code != 2 or not isinstance(value, str) or not value.strip():
                return False
            need_name = False
        elif code == 0 and value == "SECTION":
            if section:
                return False
            section = need_name = saw_section = True
        elif code == 0 and value == "ENDSEC":
            if not section:
                return False
            section = False
        elif code == 0 and value == "EOF":
            if section or not saw_section:
                return False
            ended = True
        elif not section:
            return False
    return ended and not section and not need_name


def binary_dxf_pairs(data):
    """Bounded record scanner; this is neither a CAD interpreter nor malware scan."""
    offset = len(BINARY_DXF_SENTINEL)
    # A complete file starts with group 0/SECTION, identifying the group width.
    width = 1 if data[offset:].startswith(b"\x00SECTION\x00") else 2
    while offset < len(data):
        if offset + width > len(data):
            raise ValueError("Truncated group code")
        code = int.from_bytes(data[offset:offset + width], "little")
        offset += width
        if width == 1 and code == 255:
            if offset + 2 > len(data):
                raise ValueError("Truncated extended group code")
            code = int.from_bytes(data[offset:offset + 2], "little")
            offset += 2
            if code < 1000:
                raise ValueError("Invalid extended group escape")
        if code == 999:
            raise ValueError("Binary DXF does not store comment groups")
        kind = dxf_value_kind(code)
        value = None
        if kind == "string":
            end = data.find(b"\x00", offset)
            if end < 0 or end - offset > 16384:
                raise ValueError("Truncated or oversized string group")
            value = data[offset:end]
            offset = end + 1
        elif kind == "chunk":
            if offset >= len(data):
                raise ValueError("Truncated binary chunk length")
            size = data[offset]
            offset += 1
            if offset + size > len(data):
                raise ValueError("Truncated binary chunk")
            offset += size
        else:
            size = 1 if kind == "bool" else kind
            if offset + size > len(data):
                raise ValueError("Truncated numeric group")
            if kind == "bool" and data[offset] not in {0, 1}:
                raise ValueError("Invalid boolean group")
            offset += size
        yield code, value


def valid_dxf(data):
    try:
        if data.startswith(BINARY_DXF_SENTINEL):
            return dxf_framed(binary_dxf_pairs(data))
        text = data.decode("utf-8-sig")
        if "\x00" in text:
            return False
        def pairs():
            lines = iter(io.StringIO(text, newline=None))
            while True:
                first = next(lines, None)
                if first is None:
                    break
                code_text = first.strip()
                if not code_text:
                    if any(line.strip() for line in lines):
                        raise ValueError("Blank group before end of DXF")
                    break
                value = next(lines, None)
                if value is None or len(value) > 16384 or not code_text.isascii() or not code_text.isdigit() or len(code_text) > 4:
                    raise ValueError("Invalid text group code or value")
                code = int(code_text)
                dxf_value_kind(code)
                yield code, value.strip()
        return dxf_framed(pairs())
    except (UnicodeDecodeError, ValueError):
        return False

def validate_file_metadata(content_type, filename, policy):
    files = policy.get("files")
    if not isinstance(files, dict) or not files.get("allowed_types") or not isinstance(files.get("max_bytes"), int):
        raise HTTPException(422, "Attachment policy requires owner adoption")
    if not filename or len(filename) > 200 or PurePath(filename).name != filename or any(ord(c) < 32 for c in filename) or "\\" in filename or ":" in filename:
        raise HTTPException(422, "Invalid attachment filename")
    extension = PurePath(filename).suffix.lower()
    kind = canonical_type(content_type)
    if kind in {None, "", "application/octet-stream"} and extension in {".dwg", ".dxf"}:
        kind = "image/vnd.dwg" if extension == ".dwg" else "image/vnd.dxf"
    if kind not in FILE_EXTENSIONS or kind not in files["allowed_types"] or extension not in FILE_EXTENSIONS[kind]:
        raise HTTPException(415, "Attachment extension and declared type must match an approved format")
    return kind


def validate_file(data, content_type, filename, policy, max_file_bytes=MAX_FILE_BYTES):
    kind = validate_file_metadata(content_type, filename, policy)
    maximum = min(policy["files"]["max_bytes"], max_file_bytes)
    if not data or len(data) > maximum:
        raise HTTPException(413, f"Attachment is empty or exceeds the configured upload limit ({maximum} bytes)")
    extension = PurePath(filename).suffix.lower()
    if kind in MAGIC:
        valid = any(data.startswith(prefix) for prefix in MAGIC[kind])
    elif kind == "image/vnd.dwg":
        valid = len(data) >= 32 and data[:6] in {b"AC1009", b"AC1012", b"AC1014", b"AC1015", b"AC1018", b"AC1021", b"AC1024", b"AC1027", b"AC1032"}
    elif kind == "image/vnd.dxf":
        valid = valid_dxf(data)
    else:
        validate_office(data, extension)
        valid = True
    if not valid:
        raise HTTPException(415, "Attachment content does not match its declared type")
    return hashlib.sha256(data).hexdigest()


async def prepare_private_upload(database, storage, *, user, project, policy, data, content_type, filename, bucket, max_file_bytes=MAX_FILE_BYTES):
    await access.require_project(database, user, project, policy, "update")
    await access.require_current_task(database, user, project, policy)
    digest = await asyncio.to_thread(validate_file, data, content_type, filename, policy, max_file_bytes)
    content_type = canonical_type(content_type)
    if content_type in {None, "", "application/octet-stream"} and PurePath(filename).suffix.lower() in {".dwg", ".dxf"}:
        content_type = "image/vnd.dwg" if PurePath(filename).suffix.lower() == ".dwg" else "image/vnd.dxf"
    await storage.require_private_bucket(bucket)
    key = f"kitchen/{access.KITCHEN_FLOOR}/{project['id']}/{digest}"
    if await storage.exists(bucket=bucket, key=key):
        existing = await storage.download(bucket=bucket, key=key)
        if hashlib.sha256(existing).hexdigest() != digest:
            raise HTTPException(409, "Stored attachment failed immutable-content verification")
    else:
        await storage.upload(bucket=bucket, key=key, data=data, content_type=content_type,
                             upsert=False, cache_control="private, no-store")
    return {"id": digest, "storage_key": key, "bucket": bucket, "sha256": digest,
            "size_bytes": len(data), "content_type": content_type, "filename": filename,
            "uploaded_by": user.id}

