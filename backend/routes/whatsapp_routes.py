"""Signature authenticated provider receipts; staff status is floor scoped."""
import hmac
import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse

from auth import floor_query, get_current_user
from db import db
from models import UserPublic
from services.whatsapp_delivery import configuration, configured, public_receipt, record_statuses, verify_signature

router = APIRouter(prefix="/whatsapp", tags=["whatsapp"])


@router.get("/configuration")
async def status(user: UserPublic = Depends(get_current_user)):
    return {"configured": configured(), "template_configured": bool(configuration()["WHATSAPP_DOCUMENT_TEMPLATE"])}


@router.get("/deliveries/{source_id}/{request_id}")
async def receipt(source_id: str, request_id: str, user: UserPublic = Depends(get_current_user)):
    record = await db.whatsapp_deliveries.find_one(floor_query(user, {
        "source_id": source_id, "idempotency_key": request_id}), {"_id": 0})
    if not record:
        raise HTTPException(404, "Delivery request not found")
    return public_receipt(record)


@router.get("/webhook", response_class=PlainTextResponse)
async def verify(mode: str = Query(alias="hub.mode"), token: str = Query(alias="hub.verify_token"),
                 challenge: str = Query(alias="hub.challenge", max_length=256)):
    expected = configuration()["WHATSAPP_VERIFY_TOKEN"]
    if mode != "subscribe" or not expected or not hmac.compare_digest(token, expected):
        raise HTTPException(403, "Invalid verification")
    return challenge


@router.post("/webhook")
async def webhook(request: Request):
    body = await request.body()
    if not verify_signature(body, request.headers.get("x-hub-signature-256")):
        raise HTTPException(403, "Invalid signature")
    try:
        payload = json.loads(body)
        if not isinstance(payload, dict) or payload.get("object") != "whatsapp_business_account":
            raise ValueError()
        await record_statuses(payload)
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(400, "Invalid webhook payload")
    return {"received": True}
