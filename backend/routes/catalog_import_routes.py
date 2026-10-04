"""AI-assisted supplier catalog import (Hansgrohe, Grohe, Vitra, Geberit).

Pipeline (via `catalog_pipeline/`):
  Upload → Adapter Extract → Validate → Certify → Human Review → Import
"""
from __future__ import annotations
import hashlib
import logging
import re
from pathlib import Path

import httpx
from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile

from auth import floor_for_write, floor_query, get_current_user, require_min_role
from catalog_pipeline.adapters import get_adapter
from catalog_pipeline.orchestrator import _offload_row_images, rollback_job, run_pipeline
from db import db
from media_storage import get_media_storage
from media_storage.factory import private_bucket
from models import CatalogImportJob, UserPublic
from settings import settings

from services import catalog_service
from services.catalog_import_jobs import claim_for_processing, enqueue

router = APIRouter(prefix="/catalog/imports", tags=["catalog-import"])
logger = logging.getLogger("forge.catalog_import")

SUPPORTED_BRANDS = ["Hansgrohe", "Grohe", "Vitra", "Geberit", "Oyster", "Qutone", "Dimore", "MCM", "GRANOLAND"]
MISSING = "[MISSING DATA]"

# Security audit (Phase 1, 2026-08): supplier pricelists (PDF/XLSX) legitimately
# run tens of MB with embedded imagery — cap generously but not unbounded.
MAX_IMPORT_BYTES = 80 * 1024 * 1024


async def _read_limited_upload(file: UploadFile) -> bytes:
    """Read a multipart upload incrementally so the limit is enforced before RAM is exhausted."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_IMPORT_BYTES:
            raise HTTPException(status_code=413, detail=f"File exceeds {MAX_IMPORT_BYTES // (1024 * 1024)}MB limit")
        chunks.append(chunk)
    return b"".join(chunks)


def _validate_public_host(url: str) -> None:
    """Block SSRF: a fetched URL must never be allowed to reach
    loopback/private/link-local network ranges (internal services, cloud
    metadata endpoints like 169.254.169.254, etc.). Only plain http(s) to a
    resolvable public hostname is allowed.

    Security note: this MUST be called on every redirect hop, not just the
    original URL — httpx's `follow_redirects=True` does not re-validate
    hostnames, so a DNS-rebinding or malicious-redirect attacker could pass
    the initial check with a public host and then 302 to a private address.
    See `_fetch_public_url`, which is the only caller that should ever
    actually fetch a URL from this module."""
    import ipaddress
    import socket
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Only public http(s) URLs are supported")
    host = parsed.hostname.lower()
    if host in ("localhost", "0.0.0.0") or host.endswith(".local"):
        raise HTTPException(status_code=400, detail="URL host is not allowed")
    # Supplier pricelists are fetched over standard web ports only — this
    # closes off "public IP, unusual/internal-service port" SSRF variants
    # (e.g. a public host that also exposes an internal admin port on a
    # non-standard port) without needing a large port denylist.
    if parsed.port is not None and parsed.port not in (80, 443):
        raise HTTPException(status_code=400, detail="Only ports 80/443 are allowed")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise HTTPException(status_code=400, detail=f"Could not resolve host: {e}") from e
    for info in infos:
        addr = info[4][0]
        ip = ipaddress.ip_address(addr)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise HTTPException(status_code=400, detail="URL resolves to a non-public network address")


async def _fetch_public_url(url: str, *, max_redirects: int = 5) -> bytes:
    """Fetch a URL with the SSRF guard re-applied on every redirect hop.

    `httpx.AsyncClient(follow_redirects=True)` performs its own DNS
    resolution per-hop with no hook to intercept it, so a URL that passes
    the guard on its original hostname could still redirect to a private
    address and httpx would follow it unchecked. Following redirects
    manually here lets us validate the target of every hop before the
    client ever connects to it."""
    async with httpx.AsyncClient(timeout=180.0, follow_redirects=False) as client:
        current = url
        for hop in range(max_redirects + 1):
            try:
                _validate_public_host(current)
            except HTTPException:
                if hop > 0:
                    logger.warning("SSRF guard blocked redirect to non-public address: %s", current)
                raise
            r = await client.get(current)
            if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                current = str(httpx.URL(current).join(r.headers["location"]))
                continue
            r.raise_for_status()
            if len(r.content) > MAX_IMPORT_BYTES:
                raise HTTPException(status_code=413, detail=f"Fetched file exceeds {MAX_IMPORT_BYTES // (1024 * 1024)}MB limit")
            return r.content
    raise HTTPException(status_code=502, detail="Too many redirects while fetching URL")


def _source_type_and_validate_adapter(brand: str, filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext == ".xls":
        raise HTTPException(status_code=400, detail="Legacy .xls files are not supported reliably; save as .xlsx and upload again.")
    if ext not in {".xlsx", ".pdf", ".csv"}:
        raise HTTPException(status_code=400, detail="Only .xlsx, .pdf, .csv are supported")
    adapter = get_adapter(brand)
    if ext not in adapter.supported_extensions:
        supported = ", ".join(adapter.supported_extensions)
        raise HTTPException(status_code=400, detail=f"{brand} imports support {supported}; received {ext}.")
    return "excel" if ext == ".xlsx" else ("pdf" if ext == ".pdf" else "csv")


async def _store_import_source(brand: str, filename: str, data: bytes) -> dict:
    """Retain the exact supplier input privately under an immutable hash key."""
    digest = hashlib.sha256(data).hexdigest()
    safe_brand = re.sub(r"[^a-z0-9]+", "-", brand.lower()).strip("-") or "supplier"
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(filename).name).strip(".-") or "source"
    key = f"catalog-imports/{safe_brand}/{digest[:2]}/{digest}/{safe_name}"
    content_type = {
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".pdf": "application/pdf", ".csv": "text/csv",
    }.get(Path(safe_name).suffix.lower(), "application/octet-stream")
    bucket = private_bucket()
    await get_media_storage().upload(bucket=bucket, key=key, data=data, content_type=content_type)
    return {"source_bucket": bucket, "source_storage_key": key, "source_sha256": digest, "source_size_bytes": len(data)}


async def _persist_job(brand: str, filename: str, source_type: str, result: dict, user: UserPublic, source: dict) -> dict:
    job = CatalogImportJob(
        filename=filename,
        source_type=source_type,  # type: ignore[arg-type]
        **source,
        supplier_name=brand,
        total_rows=len(result["rows"]),
        accepted_rows=sum(1 for r in result["rows"] if r.get("status") == "accepted"),
        rejected_rows=sum(1 for r in result["rows"] if r.get("status") == "rejected"),
        status="classified",  # type: ignore[arg-type]
        rows=result["rows"],
        created_by=user.id,
        floor_id=floor_for_write(user),
    )
    doc = job.dict()
    doc["extraction"] = result["extraction"]
    doc["certification"] = result["certification"]
    await db.catalog_imports.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("")
async def list_jobs(user: UserPublic = Depends(require_min_role("purchase"))):
    docs = await db.catalog_imports.find(floor_query(user), {"_id": 0, "rows": 0}).sort("created_at", -1).to_list(200)
    return docs


@router.get("/{job_id}")
async def get_job(job_id: str, user: UserPublic = Depends(require_min_role("purchase"))):
    # Unapproved rows carry unverified MRP/dealer pricing — same access tier
    # as every mutating endpoint on this resource, not every authenticated user.
    doc = await db.catalog_imports.find_one(floor_query(user, {"id": job_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Import job not found")
    return doc


@router.post("")
async def upload_and_extract(
    file: UploadFile = File(...),
    brand: str = Form(...),
    user: UserPublic = Depends(require_min_role("purchase")),
):
    if brand not in SUPPORTED_BRANDS:
        raise HTTPException(status_code=400, detail=f"Unsupported brand. Choose from: {SUPPORTED_BRANDS}")
    data = await _read_limited_upload(file)
    filename = file.filename or "upload"
    source_type = _source_type_and_validate_adapter(brand, filename)

    result = await run_pipeline(brand, filename, data)
    if not result["rows"]:
        raise HTTPException(status_code=422, detail="Extraction produced 0 rows. Check the file format.")
    # The review API never retains base64 image payloads in the import job.
    # Embedded Excel/PDF images are staged once in private Supabase Storage;
    # rows retain only a lightweight content-addressed reference until the
    # accepted import creates its public product_media master.
    await _offload_row_images(result["rows"])
    source = await _store_import_source(brand, filename, data)
    return await _persist_job(brand, filename, source_type, result, user, source)


@router.post("/from-url")
async def import_from_url(
    payload: dict = Body(...),
    user: UserPublic = Depends(require_min_role("purchase")),
):
    """Fetch a public supplier URL, run the pipeline. Perfect for large PDFs the
    frontend can't upload easily. Body: { brand, url, filename? }."""
    brand = payload.get("brand")
    url = payload.get("url")
    filename = payload.get("filename") or (url.rsplit("/", 1)[-1] if url else "download")
    if brand not in SUPPORTED_BRANDS:
        raise HTTPException(status_code=400, detail=f"Unsupported brand. Choose from: {SUPPORTED_BRANDS}")
    if not url or not isinstance(url, str) or not url.startswith("http"):
        raise HTTPException(status_code=400, detail="Provide a valid public https URL")
    # Direct outbound URL imports are disabled in production until they run
    # through a DNS-pinning egress proxy. A validate-then-connect client can
    # otherwise be raced by DNS rebinding between those two operations.
    if settings.environment == "production":
        raise HTTPException(status_code=503, detail="URL imports are disabled in production; upload the supplier file instead")

    try:
        data = await _fetch_public_url(url)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not fetch file: {e}") from e

    source_type = _source_type_and_validate_adapter(brand, filename)

    result = await run_pipeline(brand, filename, data)
    if not result["rows"]:
        raise HTTPException(status_code=422, detail="Extraction produced 0 rows.")
    await _offload_row_images(result["rows"])
    source = await _store_import_source(brand, filename, data)
    return await _persist_job(brand, filename, source_type, result, user, source)


_ROW_STRING_FIELDS = ("name", "sku", "category", "finish", "material", "dimensions", "warranty", "status")


def _coerce_row_patch_value(key: str, value):
    """Reject values that would later crash `import_accepted`'s untyped
    `float(r["mrp"])` — a reviewer typing "TBD" into the price field must
    get a 400 now, not silently corrupt the whole import batch later."""
    if key in ("mrp", "dealer_price"):
        if value in (None, MISSING, ""):
            return MISSING
        try:
            num = float(value)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{key} must be a number, got {value!r}")
        if num < 0:
            raise HTTPException(status_code=400, detail=f"{key} cannot be negative")
        return num
    if key == "issues":
        if not isinstance(value, list):
            raise HTTPException(status_code=400, detail="issues must be a list")
        return value
    if key in _ROW_STRING_FIELDS:
        return None if value is None else str(value)
    raise HTTPException(status_code=400, detail=f"Field {key!r} is not editable")


@router.patch("/{job_id}/rows/{row_id}")
async def update_row(
    job_id: str, row_id: str, patch: dict,
    user: UserPublic = Depends(require_min_role("purchase")),
):
    doc = await db.catalog_imports.find_one(floor_query(user, {"id": job_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Import job not found")
    rows = doc.get("rows", [])
    validated = {k: _coerce_row_patch_value(k, v) for k, v in patch.items()}
    for r in rows:
        if r.get("row_id") == row_id:
            r.update(validated)
            break
    else:
        raise HTTPException(status_code=404, detail="Row not found")
    await db.catalog_imports.update_one(floor_query(user, {"id": job_id}), {"$set": {"rows": rows}})
    return {"ok": True}


@router.post("/{job_id}/approve")
async def approve_and_import(
    job_id: str,
    # Maker-checker: the same "purchase" role that uploads/edits a pricelist
    # must not also be the one who approves it into the live catalog —
    # auth.py's documented capability matrix already lists catalog-import
    # approval as a manager action; this endpoint now matches it.
    user: UserPublic = Depends(require_min_role("manager")),
):
    doc = await db.catalog_imports.find_one(floor_query(user, {"id": job_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Import job not found")

    claimed = await claim_for_processing(job_id, floor_query(user, {"id": job_id}))
    if not claimed:
        current = await db.catalog_imports.find_one(floor_query(user, {"id": job_id}), {"_id": 0, "status": 1, "import_progress": 1})
        if current and current.get("status") == "processing":
            raise HTTPException(status_code=409, detail="This import is already processing; refresh for progress.")
        raise HTTPException(status_code=409, detail="This import cannot be approved in its current state.")
    await enqueue(job_id, user.id)
    return {"job_id": job_id, "status": "processing", "progress": claimed.get("import_progress", {"completed": 0, "failed": 0, "total": sum(r.get("status") == "accepted" for r in doc.get("rows", []))})}


@router.post("/{job_id}/rows/{row_id}/retry")
async def retry_failed_row(
    job_id: str, row_id: str,
    user: UserPublic = Depends(require_min_role("manager")),
):
    doc = await db.catalog_imports.find_one(floor_query(user, {"id": job_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Import job not found")
    rows = doc.get("rows") or []
    row = next((r for r in rows if r.get("row_id") == row_id), None)
    if not row:
        raise HTTPException(status_code=404, detail="Row not found")
    if row.get("import_state") != "failed":
        raise HTTPException(status_code=409, detail="Only failed rows can be retried")
    row.update({"import_state": None, "import_error": None, "imported_at": None})
    claimed = await claim_for_processing(job_id, floor_query(user, {"id": job_id}))
    if not claimed:
        # A concurrent retry/approval owns the worker; persist the retry request
        # and let that worker pick it up rather than launching duplicate writes.
        await db.catalog_imports.update_one(floor_query(user, {"id": job_id}), {"$set": {"rows": rows}})
        return {"job_id": job_id, "status": "processing"}
    await db.catalog_imports.update_one(floor_query(user, {"id": job_id}), {"$set": {"rows": rows}})
    await enqueue(job_id, user.id)
    return {"job_id": job_id, "status": "processing"}


@router.post("/{job_id}/rollback")
async def rollback(
    job_id: str,
    user: UserPublic = Depends(require_min_role("manager")),
):
    doc = await db.catalog_imports.find_one(floor_query(user, {"id": job_id}), {"_id": 0, "id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Import job not found")
    stats = await rollback_job(job_id)
    catalog_service.schedule_catalog_refresh()
    return stats


@router.delete("/{job_id}")
async def delete_job(
    job_id: str,
    user: UserPublic = Depends(require_min_role("purchase")),
):
    res = await db.catalog_imports.delete_one(floor_query(user, {"id": job_id, "status": {"$ne": "processing"}}))
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Import job not found")
    return {"ok": True}


@router.get("/config/brands")
async def supported_brands(_: UserPublic = Depends(get_current_user)):
    return {"brands": SUPPORTED_BRANDS}