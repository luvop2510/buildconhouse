"""Furniture-only quotations/payments, with pinned floor access and revision checks."""
from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from uuid import uuid4
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field

from auth import accessible_floor_ids, floor_for_write, get_current_user, get_floor_scoped_or_404, require_min_role
from db import db
from models import UserPublic
from services.furniture_quotations import FURNITURE_FLOOR_ID, FurnitureQuotationInput, build_pdf, prepare_document
from services.quotation_shares import whatsapp_phone
from services.lead_scope import referrer_fields

router = APIRouter(prefix="/furniture-quotations", tags=["furniture-quotations"])


def scope(user: UserPublic) -> dict:
    allowed = accessible_floor_ids(user)
    if (allowed is not None and FURNITURE_FLOOR_ID not in allowed) or floor_for_write(user) != FURNITURE_FLOOR_ID:
        raise HTTPException(403, "Furniture quotations require access to the Furniture Floor")
    return {"floor_id": FURNITURE_FLOOR_ID}


async def validate_customer_link(customer_id, user):
    if customer_id:
        customer = await get_floor_scoped_or_404(db.customers, customer_id, user, not_found="Customer not found")
        if customer.get("floor_id") != FURNITURE_FLOOR_ID:
            raise HTTPException(404, "Customer not found on Furniture Floor")


async def furniture_referrer_fields(referrer_id, user):
    fields = await referrer_fields(db, referrer_id, FURNITURE_FLOOR_ID, user)
    if referrer_id:
        # The shared resolver has already checked this directory identity's access.
        partner = await db.referrers.find_one({"id": fields["referrer_id"]}, {"_id": 0, "company": 1})
        fields["referrer_company"] = (partner or {}).get("company")
    else:
        fields["referrer_company"] = None
    return fields


async def lookup(quotation_id: str, user: UserPublic) -> dict:
    doc = await db.furniture_quotations.find_one({**scope(user), "id": quotation_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Furniture quotation not found")
    return doc


@router.get("")
async def list_quotations(cursor: str | None = None, limit: int = Query(50, ge=1, le=100),
                          user: UserPublic = Depends(get_current_user)):
    query = scope(user)
    if cursor:
        try:
            if len(cursor) > 512:
                raise ValueError()
            decoded = json.loads(base64.urlsafe_b64decode(cursor.encode()))
            if not isinstance(decoded, list) or len(decoded) != 2:
                raise ValueError()
            updated_at, entry_id = decoded
            if not isinstance(updated_at, str) or not isinstance(entry_id, str) or len(cursor) > 512:
                raise ValueError()
            query["$or"] = [{"updated_at": {"$lt": updated_at}}, {"updated_at": updated_at, "id": {"$lt": entry_id}}]
        except (ValueError, TypeError, UnicodeDecodeError):
            raise HTTPException(422, "Invalid list cursor")
    # Exclude potentially large receipt/charge arrays until opening one record.
    rows = await db.furniture_quotations.find(query, {"_id": 0, "charges": 0, "deposits": 0}).sort(
        [("updated_at", -1), ("id", -1)]).limit(limit + 1).to_list(limit + 1)
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = base64.urlsafe_b64encode(json.dumps([rows[-1]["updated_at"], rows[-1]["id"]]).encode()).decode() if has_more else None
    return {"rows": rows, "next_cursor": next_cursor}


@router.post("", status_code=201)
async def create_quotation(body: FurnitureQuotationInput, user: UserPublic = Depends(require_min_role("sales"))):
    floor = scope(user)
    await validate_customer_link(body.customer_id, user)
    if any(entry.id for entry in [*body.charges, *body.deposits]):
        raise HTTPException(422, "New quotation entries cannot contain existing IDs")
    if not whatsapp_phone(body.customer_phone):
        raise HTTPException(422, "Enter a valid customer mobile number")
    now = datetime.now(timezone.utc).isoformat()
    doc = {**prepare_document(body, now), **floor, "id": str(uuid4()), "created_at": now,
           "created_by": user.id, "updated_by": user.id, "revision": 1}
    if body.referrer_id:
        doc.update(await furniture_referrer_fields(body.referrer_id, user))
    await db.furniture_quotations.insert_one(dict(doc))
    return doc


@router.get("/{quotation_id}")
async def get_quotation(quotation_id: str, user: UserPublic = Depends(get_current_user)):
    doc = await lookup(quotation_id, user)
    if doc.get("referrer_id"):
        from services.referrer_identity import acquired_counts
        counts = await acquired_counts(db, [doc["referrer_id"]], [FURNITURE_FLOOR_ID])
        doc = {**doc, "referrer_customers_acquired": counts.get(doc["referrer_id"], 0)}
    return doc


@router.put("/{quotation_id}")
async def update_quotation(quotation_id: str, body: FurnitureQuotationInput,
                           user: UserPublic = Depends(require_min_role("sales"))):
    scope(user)
    old = await get_floor_scoped_or_404(db.furniture_quotations, quotation_id, user,
                                       not_found="Furniture quotation not found", projection={"_id": 0})
    if old.get("floor_id") != FURNITURE_FLOOR_ID:
        raise HTTPException(404, "Furniture quotation not found")
    if body.expected_updated_at != old["updated_at"]:
        raise HTTPException(409, "This quotation changed. Reload it before saving.")
    if not whatsapp_phone(body.customer_phone):
        raise HTTPException(422, "Enter a valid customer mobile number")
    if "customer_id" in body.model_fields_set:
        await validate_customer_link(body.customer_id, user)
    now = datetime.now(timezone.utc).isoformat()
    fields = {**prepare_document(body, now, old), "updated_by": user.id, "revision": old["revision"] + 1}
    if "referrer_id" in body.model_fields_set:
        fields.update(await furniture_referrer_fields(body.referrer_id, user))
    result = await db.furniture_quotations.update_one(
        {**scope(user), "id": quotation_id, "updated_at": old["updated_at"], "revision": old["revision"]},
        {"$set": fields},
    )
    if not result.modified_count:
        raise HTTPException(409, "This quotation changed. Reload it before saving.")
    return {**old, **fields}


@router.get("/{quotation_id}/pdf")
async def quotation_pdf(quotation_id: str, user: UserPublic = Depends(get_current_user)):
    doc = await lookup(quotation_id, user)
    data, filename = await run_in_threadpool(build_pdf, doc)
    return Response(data, media_type="application/pdf", headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    })


class WhatsAppSendInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field(min_length=1, max_length=1024)
    expected_updated_at: str = Field(max_length=64)
    idempotency_key: str = Field(min_length=8, max_length=128)


@router.post("/{quotation_id}/whatsapp-send")
async def send_quotation(quotation_id: str, body: WhatsAppSendInput,
                         user: UserPublic = Depends(require_min_role("sales"))):
    from services.whatsapp_delivery import send_document
    scope(user)
    doc = await get_floor_scoped_or_404(db.furniture_quotations, quotation_id, user,
                                       not_found="Furniture quotation not found", projection={"_id": 0})
    if doc.get("floor_id") != FURNITURE_FLOOR_ID:
        raise HTTPException(404, "Furniture quotation not found")
    if body.expected_updated_at != doc["updated_at"]:
        raise HTTPException(409, "This quotation changed. Reload it before sending.")
    phone = whatsapp_phone(doc["customer_phone"])
    if not phone:
        raise HTTPException(422, "Enter a valid customer WhatsApp number")
    data, filename = await run_in_threadpool(build_pdf, doc)
    return await send_document(pdf_bytes=data, filename=filename, recipient_phone=phone,
                               message=body.message, idempotency_key=body.idempotency_key,
                               floor_id=doc["floor_id"], source_id=doc["id"], actor_id=user.id)
