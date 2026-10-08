"""Settings > Company, PDF branding, and Catalog backup.

All three follow the same generic `db.settings` key/value pattern already
established by routes/purchases_tracker.py's TrackerSettings — one document
per settings "key", upserted on save. Every default value here matches what
was previously hardcoded (theme/tokens.ts `brand`, pdf_generator.py's
_draw_footer/_draw_room_watermark), so reading these before anyone has ever
saved a change behaves identically to before this file existed.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from io import BytesIO

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from auth import floor_query, get_current_user, require_min_role
from db import db
from models import CompanySettings, PDFSettings, UserPublic, now_iso

router = APIRouter(prefix="/settings", tags=["settings"])

COMPANY_KEY = "company"
PDF_KEY = "pdf"

# A base64 data: URL comfortably covering a real logo (a few hundred KB) while
# staying well clear of MongoDB's 16MB document limit — same style of guard
# used by media_routes.py's MAX_MEDIA_BYTES for product photos.
MAX_LOGO_B64_CHARS = 3 * 1024 * 1024


async def _load(key: str, model):
    doc = await db.settings.find_one({"key": key}, {"_id": 0})
    if not doc:
        return model()
    return model(**{k: v for k, v in doc.items() if k in model.__fields__})


# ---------- Company profile ----------
@router.get("/company", response_model=CompanySettings)
async def get_company_settings(_: UserPublic = Depends(get_current_user)):
    return await _load(COMPANY_KEY, CompanySettings)


@router.put("/company", response_model=CompanySettings)
async def update_company_settings(body: CompanySettings, user: UserPublic = Depends(require_min_role("admin"))):
    if body.logo_base64 and len(body.logo_base64) > MAX_LOGO_B64_CHARS:
        raise HTTPException(status_code=413, detail="Logo image is too large")
    patch = body.model_dump(exclude={"updated_at", "updated_by", "updated_by_name"})
    patch.update({"key": COMPANY_KEY, "updated_at": now_iso(), "updated_by": user.id, "updated_by_name": user.full_name})
    await db.settings.update_one({"key": COMPANY_KEY}, {"$set": patch}, upsert=True)
    return await _load(COMPANY_KEY, CompanySettings)


# ---------- PDF branding ----------
@router.get("/pdf", response_model=PDFSettings)
async def get_pdf_settings(_: UserPublic = Depends(get_current_user)):
    return await _load(PDF_KEY, PDFSettings)


@router.put("/pdf", response_model=PDFSettings)
async def update_pdf_settings(body: PDFSettings, user: UserPublic = Depends(require_min_role("admin"))):
    patch = body.model_dump(exclude={"updated_at", "updated_by", "updated_by_name"})
    patch.update({"key": PDF_KEY, "updated_at": now_iso(), "updated_by": user.id, "updated_by_name": user.full_name})
    await db.settings.update_one({"key": PDF_KEY}, {"$set": patch}, upsert=True)
    return await _load(PDF_KEY, PDFSettings)


# ---------- Catalog backup (download-only, by design) ----------
# Restore is intentionally NOT implemented — a bad restore could silently
# corrupt the live 2,966-product catalog right before launch. This endpoint
# gives an admin a real, dated JSON snapshot of the catalog collections they
# can hand to support/engineering if something ever needs to be recovered by
# hand; it is not a substitute for a proper Atlas backup policy.
CATALOG_BACKUP_COLLECTIONS = ["products", "brands", "categories"]


@router.get("/catalog-backup")
async def catalog_backup(user: UserPublic = Depends(require_min_role("admin"))):
    payload: dict[str, object] = {
        "exported_at": now_iso(),
        "source": "forge-catalog-backup",
    }
    for name in CATALOG_BACKUP_COLLECTIONS:
        payload[name] = await db[name].find(floor_query(user), {"_id": 0}).to_list(10000)
    buf = BytesIO(json.dumps(payload, default=str, indent=2).encode("utf-8"))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    return StreamingResponse(
        buf, media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="forge-catalog-backup-{stamp}.json"'},
    )
