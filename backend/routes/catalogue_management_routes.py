"""Catalogue Management for staff and the Buildcon import skills."""
from __future__ import annotations

from base64 import b64decode
from binascii import Error as Base64Error
from hashlib import sha256
from io import BytesIO
import json
from pathlib import PurePath
from typing import Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from pydantic import BaseModel, ConfigDict, Field
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from starlette.concurrency import run_in_threadpool

from auth import get_current_user
from catalog_pipeline.resource_limits import MAX_SOURCE_BYTES
from catalog_pipeline.self_service_files import PRODUCT_COLUMNS, SPEC_FIELDS, new_product_issues, write_template
from catalog_policy import removed_brand_document
from db import db
from models import UserPublic, now_iso
from services import catalog_service, catalogue_jobs as jobs
from services.catalogue_changes import applicable_categories, effective_mrp, get_or_create_brand, get_or_create_category, new_product, scoped_brand
from services.catalogue_permissions import OPERATION_PERMISSIONS, capabilities, require_capabilities

router = APIRouter(prefix="/catalog/management", tags=["catalogue-management"])
Floor = Literal["ground-floor", "first-floor", "second-floor", "third-floor"]
Operation = Literal["add", "prices", "update", "sync", "images"]


class Name(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)


class NewCategory(Name):
    brand_id: str = Field(min_length=1, max_length=100)


class TileProductSpecs(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    price_unit: Literal["piece", "box", "sqft"]
    pcs_per_box: int | None = Field(default=None, gt=0)
    sqft_per_box: float | None = Field(default=None, gt=0)
    rate_per_sqft: float | None = Field(default=None, ge=0)


class NewProduct(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid", allow_inf_nan=False)
    brand_id: str = Field(min_length=1, max_length=100)
    category_id: str = Field(min_length=1, max_length=100)
    sku: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=200)
    mrp: float = Field(ge=0)
    price: float | None = Field(default=None, ge=0)
    finish: str | None = Field(default=None, max_length=240)
    size: str | None = Field(default=None, max_length=240)
    specs: TileProductSpecs | None = None


class JobCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    key: UUID
    brand_id: str | None = Field(default=None, min_length=1, max_length=100)
    brand_name: str | None = Field(default=None, min_length=1, max_length=100)
    operation: Operation
    create_brand: bool = False
    create_categories: bool = False
    filename: str = Field(min_length=1, max_length=240)
    size_bytes: int = Field(gt=0, le=MAX_SOURCE_BYTES)
    sheet: str | None = Field(default=None, min_length=1, max_length=100)
    physical_pages: tuple[int, int] | None = None
    printed_pages: tuple[int, int] | None = None


class Part(BaseModel):
    data_base64: str = Field(min_length=1, max_length=4 * ((jobs.PART_BYTES + 2) // 3))


def _dto(job: dict) -> dict:
    excluded = {"_id", "claim", "lease_until", "fingerprint", "preview_id", "missing_from_source"}
    return {"id": job["_id"], **{key: value for key, value in job.items() if key not in excluded}}


async def _grants(floor, user):
    granted = await capabilities(db, user.id, floor)
    if not granted:
        raise HTTPException(403, "The Owner can grant Catalogue Management access for this department.")
    return granted


async def _brand(floor, brand_id):
    brand = await scoped_brand(db, floor, brand_id=brand_id)
    if not brand or removed_brand_document(brand):
        raise HTTPException(404, "Brand not found in this department.")
    return brand


async def _floor_scoped_catalogue_job(floor, user, job_id, *, own_only=False, include_missing=False):
    grants = await _grants(floor, user)
    job = await db.catalogue_imports.find_one({"_id": job_id, "floor_id": floor},
        None if include_missing else {"missing_from_source": 0})
    if not job or (
        job["created_by"] != user.id and (own_only or not {"catalogue_history", "catalogue_rollback"} & grants)
    ):
        raise HTTPException(404, "Catalogue import not found.")
    if job["created_by"] == user.id and not (
        set(OPERATION_PERMISSIONS[job["operation"]]) <= grants or "catalogue_history" in grants
        or "catalogue_rollback" in grants
    ):
        raise HTTPException(403, "Import access changed. Ask the Owner to review your permissions.")
    return job, grants


def _workbook(data: bytes, filename: str) -> Response:
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "private, no-store"})


@router.get("/options")
async def options(floor_id: Floor, user: UserPublic = Depends(get_current_user)):
    grants = await _grants(floor_id, user)
    brands = await db.brands.find({"floor_id": floor_id}, {"_id": 0, "id": 1, "name": 1, "slug": 1}).sort("name", 1).to_list(2000)
    categories = await db.categories.find({"floor_id": floor_id},
        {"_id": 0, "id": 1, "name": 1, "brand_id": 1}).sort("name", 1).to_list(3000)
    return {"capabilities": sorted(grants), "brands": [brand for brand in brands if not removed_brand_document(brand)],
            "categories": categories, "part_bytes": jobs.PART_BYTES, "max_bytes": MAX_SOURCE_BYTES}


@router.post("/brands")
async def add_brand(floor_id: Floor, body: Name, user: UserPublic = Depends(get_current_user)):
    await require_capabilities(db, user.id, floor_id, "catalogue_brands")
    brand = await get_or_create_brand(db, floor_id, body.name)
    await catalog_service.refresh_after_product_creation()
    return brand


@router.post("/categories")
async def add_category(floor_id: Floor, body: NewCategory, user: UserPublic = Depends(get_current_user)):
    await require_capabilities(db, user.id, floor_id, "catalogue_categories")
    category = await get_or_create_category(db, floor_id, await _brand(floor_id, body.brand_id), body.name)
    await catalog_service.refresh_after_product_creation()
    return category


@router.post("/products")
async def add_product(floor_id: Floor, body: NewProduct, user: UserPublic = Depends(get_current_user)):
    await require_capabilities(db, user.id, floor_id, "catalogue_products_add")
    brand = await _brand(floor_id, body.brand_id)
    category = await db.categories.find_one({"id": body.category_id, "floor_id": floor_id,
                                           "brand_id": {"$in": [None, brand["id"]]}})
    if not category:
        raise HTTPException(422, "Choose a category in the selected brand or department.")
    if body.specs is not None and floor_id != "ground-floor":
        raise HTTPException(422, "Box and coverage fields are available on the Tiles floor.")
    fields = body.model_dump(exclude={"brand_id", "category_id", "sku"}, exclude_none=True)
    errors = new_product_issues({**fields, "category": category["name"]}, floor_id)
    if errors:
        raise HTTPException(422, " ".join(errors))
    product = new_product(floor_id, brand["id"], category["id"], body.sku, fields)
    try:
        await db.products.insert_one(dict(product))
    except DuplicateKeyError:
        candidate = await db.products.find_one({"floor_id": floor_id, "brand_id": brand["id"], "sku": body.sku}, {"_id": 0})
        if candidate and candidate.get("active") and all(candidate.get(key) == product[key] for key in [*fields, "category_id"]):
            product = candidate
        else:
            raise HTTPException(409, "That article number already belongs to a different product.") from None
    await catalog_service.refresh_after_product_creation()
    return product


@router.get("/products")
async def browse_products(floor_id: Floor, q: str = Query("", max_length=120),
                          brand_id: str | None = Query(None, max_length=100),
                          category_id: str | None = Query(None, max_length=100),
                          skip: int = Query(0, ge=0, le=50000), user: UserPublic = Depends(get_current_user)):
    await require_capabilities(db, user.id, floor_id, "catalogue_view")
    limit = 24
    result = await catalog_service.list_products_page(
        user_id=user.id, q=q.strip() or None, brand_id=brand_id, category_id=category_id,
        subcategory=None, series=None, family_key=None, finish=None, colour=None,
        sort="source", limit=limit, skip=skip, floor_ids=[floor_id],
    )
    fields = ("id", "listing_id", "sku", "name", "brand_id", "category_id", "finish", "size", "mrp", "price")
    return {"total": result["total"], "next_skip": skip + limit if result["total"] > skip + limit else None,
            "items": [{field: item.get(field) for field in fields} for item in result["items"]]}


@router.get("/template.xlsx")
async def template(floor_id: Floor, operation: Operation, user: UserPublic = Depends(get_current_user)):
    await require_capabilities(db, user.id, floor_id, *OPERATION_PERMISSIONS[operation])
    return _workbook(await run_in_threadpool(write_template, floor_id, operation), f"buildcon-{floor_id}-{operation}.xlsx")


@router.get("/export.xlsx")
async def export(floor_id: Floor, operation: Operation, brand_id: str, user: UserPublic = Depends(get_current_user)):
    await require_capabilities(db, user.id, floor_id, *(
        ("catalogue_prices",) if operation == "prices" else ("catalogue_view",)
    ))
    brand = await _brand(floor_id, brand_id)
    categories = await applicable_categories(db, floor_id, brand_id)
    category_names = {category["id"]: category["name"] for category in categories.values()}
    export_fields = {"sku", "name", "category_id", "mrp", "catalog_mrp_override",
                     "catalog_mrp_only_override", "catalog_entries.mrp"}
    if operation != "prices":
        export_fields.update(PRODUCT_COLUMNS.keys() - SPEC_FIELDS)
        export_fields.update(f"specs.{key}" for key in SPEC_FIELDS)
    products = await db.products.find({"floor_id": floor_id, "brand_id": brand_id, "active": {"$ne": False}},
        {"_id": 0, **dict.fromkeys(export_fields, 1)}).sort("sku", 1).limit(50001).to_list(50001)
    if len(products) > 50000:
        raise HTTPException(422, "This brand exceeds the workbook row limit.")
    rows = [
        {**product, "brand": brand["name"], "category": category_names.get(product.get("category_id")),
         "current_mrp": effective_mrp(product)}
        for product in products
    ]
    return _workbook(await run_in_threadpool(write_template, floor_id, operation, rows), f"buildcon-{floor_id}-{operation}-export.xlsx")


@router.post("/jobs")
async def create_job(floor_id: Floor, body: JobCreate, user: UserPublic = Depends(get_current_user)):
    required = list(OPERATION_PERMISSIONS[body.operation])
    if body.create_brand:
        required.append("catalogue_brands")
    if body.create_categories:
        required.append("catalogue_categories")
    await require_capabilities(db, user.id, floor_id, *required)
    if bool(body.brand_id) == bool(body.brand_name) or (not body.brand_id and not body.create_brand):
        raise HTTPException(422, "Choose one existing brand or enter a new brand name.")
    if not body.brand_id and body.operation not in {"add", "sync"}:
        raise HTTPException(422, "Choose an existing brand for this operation.")
    if PurePath(body.filename).suffix.lower() not in {".xlsx", ".csv", ".pdf"} or any(
        char in body.filename for char in ("/", "\\", "\r", "\n", "\x00")
    ):
        raise HTTPException(422, "Upload an XLSX, CSV or supported text PDF file.")
    brand = await _brand(floor_id, body.brand_id) if body.brand_id else None
    raw = body.model_dump(mode="json", exclude={"key"})
    fingerprint = sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest()
    job = {**raw, "_id": str(uuid5(NAMESPACE_URL, f"buildcon:catalogue:{user.id}:{floor_id}:{body.key}")),
           "brand_name": brand["name"] if brand else body.brand_name, "floor_id": floor_id,
           "fingerprint": fingerprint, "status": "upload", "created_by": user.id,
           "created_at": now_iso(), "updated_at": now_iso()}
    try:
        await db.catalogue_imports.insert_one(job)
    except DuplicateKeyError:
        existing = await db.catalogue_imports.find_one({"_id": job["_id"]})
        if not existing or existing["fingerprint"] != fingerprint:
            raise HTTPException(409, "This upload key is already used for another file or operation.") from None
        job = existing
    return _dto(job)


@router.put("/jobs/{job_id}/parts/{index}")
async def upload_part(floor_id: Floor, job_id: str, index: int, body: Part, user: UserPublic = Depends(get_current_user)):
    job, grants = await _floor_scoped_catalogue_job(floor_id, user, job_id, own_only=True)
    if job["status"] != "upload":
        raise HTTPException(409, "This import is no longer accepting uploads.")
    if not set(OPERATION_PERMISSIONS[job["operation"]]) <= grants:
        raise HTTPException(403, "Import access changed. Ask the Owner to review your permissions.")
    try:
        data = b64decode(body.data_base64, validate=True)
    except (Base64Error, ValueError):
        raise HTTPException(422, "Invalid file part encoding.") from None
    await jobs.store_part(job, index, data)
    return {"ok": True}


async def _transition(job, status: str, **extra):
    updated = await db.catalogue_imports.find_one_and_update({"_id": job["_id"], "status": job["status"]}, {
        "$set": {"status": status, "updated_at": now_iso(), **extra}, "$unset": {"error": "", "failed_phase": ""},
    }, return_document=ReturnDocument.AFTER)
    current = updated or await db.catalogue_imports.find_one({"_id": job["_id"]})
    if current["status"] in jobs.WORK_PHASES:
        jobs.enqueue(current["_id"])
    return _dto(current)


@router.post("/jobs/{job_id}/preview")
async def start_preview(floor_id: Floor, job_id: str, user: UserPublic = Depends(get_current_user)):
    job, _ = await _floor_scoped_catalogue_job(floor_id, user, job_id, own_only=True)
    if job["status"] != "upload":
        return _dto(job)
    await require_capabilities(db, user.id, floor_id, *OPERATION_PERMISSIONS[job["operation"]])
    if await db.catalogue_import_parts.count_documents({"job_id": job_id}) != jobs.number_of_parts(job):
        raise HTTPException(409, "Upload all file parts before requesting a preview.")
    return await _transition(job, "queued")


@router.post("/jobs/{job_id}/apply")
async def apply(floor_id: Floor, job_id: str, user: UserPublic = Depends(get_current_user)):
    job, _ = await _floor_scoped_catalogue_job(floor_id, user, job_id, own_only=True)
    await require_capabilities(db, user.id, floor_id, *OPERATION_PERMISSIONS[job["operation"]])
    if job["status"] in {"applying", "complete"}:
        return _dto(job)
    if job["status"] != "preview":
        raise HTTPException(409, "A completed preview is required before confirming an import.")
    return await _transition(job, "applying", apply_confirmed_at=now_iso())


@router.post("/jobs/{job_id}/resume")
async def resume(floor_id: Floor, job_id: str, user: UserPublic = Depends(get_current_user)):
    job, _ = await _floor_scoped_catalogue_job(floor_id, user, job_id)
    if job["status"] != "failed" or job["failed_phase"] not in jobs.WORK_PHASES:
        return _dto(job)
    phase = job["failed_phase"]
    if phase == "rolling_back":
        await require_capabilities(db, user.id, floor_id, "catalogue_rollback")
        return await _transition(job, phase, rollback_by=user.id)
    if job["created_by"] != user.id:
        raise HTTPException(403, "Only the employee who started this import can resume it.")
    await require_capabilities(db, user.id, floor_id, *OPERATION_PERMISSIONS[job["operation"]])
    return await _transition(job, phase)


@router.post("/jobs/{job_id}/rollback")
async def rollback(floor_id: Floor, job_id: str, user: UserPublic = Depends(get_current_user)):
    job, _ = await _floor_scoped_catalogue_job(floor_id, user, job_id)
    await require_capabilities(db, user.id, floor_id, "catalogue_rollback")
    if job["status"] in {"rolled_back", "rolling_back"}:
        return _dto(job)
    if job["status"] != "complete" and not (job["status"] == "failed" and job.get("failed_phase") == "applying"):
        raise HTTPException(409, "Only an applied import can be rolled back.")
    return await _transition(job, "rolling_back", rollback_by=user.id, rollback_requested_at=now_iso())


@router.get("/jobs")
async def history(floor_id: Floor, user: UserPublic = Depends(get_current_user)):
    await require_capabilities(db, user.id, floor_id, "catalogue_history")
    rows = await db.catalogue_imports.find({"floor_id": floor_id},
        {"missing_from_source": 0}).sort("created_at", -1).to_list(100)
    return [_dto(row) for row in rows]


@router.get("/jobs/{job_id}")
async def job_status(floor_id: Floor, job_id: str, offset: int = Query(0, ge=0),
                     limit: int = Query(30, ge=1, le=100), user: UserPublic = Depends(get_current_user)):
    job, _ = await _floor_scoped_catalogue_job(floor_id, user, job_id)
    if job["status"] in jobs.WORK_PHASES:
        jobs.enqueue(job_id)
    dto = _dto(job)
    if job.get("preview_id"):
        query = {"job_id": job_id, "preview_id": job["preview_id"]}
        dto["rows"] = await db.catalogue_import_rows.find(query,
            {"_id": 0, "row": 1, "sheet": 1, "sku": 1, "action": 1, "delta": 1, "previous_mrp": 1,
             "errors": 1, "error": 1, "outcome": 1, "rollback": 1}).sort("index", 1).skip(offset).limit(limit).to_list(limit)
        dto["total_rows"] = sum(job["summary"].values())
    return dto


def _format_errors(rows: list[dict], missing: list[str], missing_total: int) -> bytes:
    book = Workbook(write_only=True)
    sheet = book.create_sheet("Rejected rows")
    sheet.append(["Worksheet or page", "Source row", "Article No.", "Reason"])
    for row in rows:
        buffer = []
        for value in (row["sheet"], row["row"], row["sku"], " ".join([*row.get("errors", []), row.get("error") or ""])):
            cell = WriteOnlyCell(sheet, value=value)
            if isinstance(value, str):
                cell.data_type = "s"
            buffer.append(cell)
        sheet.append(buffer)
    if missing_total:
        absent = book.create_sheet("Missing from source")
        absent.append(["Article No.", "Saved products remain in the catalogue."])
        for sku in missing:
            cell = WriteOnlyCell(absent, value=sku)
            cell.data_type = "s"
            absent.append([cell])
        if missing_total > len(missing):
            absent.append([f"Showing {len(missing)} of {missing_total} saved articles."])
    output = BytesIO()
    book.save(output)
    return output.getvalue()


@router.get("/jobs/{job_id}/errors.xlsx")
async def job_errors(floor_id: Floor, job_id: str, user: UserPublic = Depends(get_current_user)):
    job, _ = await _floor_scoped_catalogue_job(floor_id, user, job_id, include_missing=True)
    rows = await db.catalogue_import_rows.find(
        {"job_id": job_id, "preview_id": job.get("preview_id"), "$or": [
            {"action": "rejected"}, {"outcome": {"$in": ["rejected", "conflict"]}}, {"rollback": "conflict"},
        ]}, {"_id": 0, "row": 1, "sheet": 1, "sku": 1, "errors": 1, "error": 1, "rollback": 1},
    ).sort("index", 1).to_list(50000)
    for row in rows:
        if row.get("rollback") == "conflict":
            row.setdefault("errors", []).append("Rollback skipped because the product changed after import.")
    return _workbook(await run_in_threadpool(_format_errors, rows, job.get("missing_from_source", []),
        job.get("missing_from_source_total", 0)), "buildcon-import-errors.xlsx")
