"""Private attachment preparation; finalization must be a project CAS command.

No public URL or arbitrary object key is accepted. Only approved formats pass.
"""
from __future__ import annotations

import hashlib
import asyncio
from pathlib import PurePath

from fastapi import HTTPException

from services import kitchen_access as access

MAX_FILE_BYTES = 768 * 1024  # ordinary single request stays bounded
MAX_TRANSFER_BYTES = 25_000_000  # approved 21 October; chunked transport only
MAGIC = {"application/pdf": (b"%PDF-",), "image/jpeg": (b"\xff\xd8\xff",),
         "image/png": (b"\x89PNG\r\n\x1a\n",)}


FILE_EXTENSIONS = {"application/pdf": {".pdf"}, "image/jpeg": {".jpg", ".jpeg"}, "image/png": {".png"},
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {".docx"},
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {".xlsx"}}


def canonical_type(content_type):
    return content_type


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


def validate_file_metadata(content_type, filename, policy):
    files = policy.get("files")
    if not isinstance(files, dict) or not files.get("allowed_types") or not isinstance(files.get("max_bytes"), int):
        raise HTTPException(422, "Attachment policy requires owner adoption")
    if not filename or len(filename) > 200 or PurePath(filename).name != filename or any(ord(c) < 32 for c in filename) or "\\" in filename or ":" in filename:
        raise HTTPException(422, "Invalid attachment filename")
    extension = PurePath(filename).suffix.lower()
    kind = canonical_type(content_type)
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

