"""Direct private PDF delivery via Meta; never retry an ambiguous message send."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from db import db
from services.quotation_shares import whatsapp_phone


def configuration() -> dict:
    return {key: os.environ.get(key, "").strip() for key in (
        "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_GRAPH_VERSION",
        "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_DOCUMENT_TEMPLATE",
        "WHATSAPP_TEMPLATE_LANGUAGE",
    )}


def configured() -> bool:
    config = configuration()
    return bool(config["WHATSAPP_ACCESS_TOKEN"] and re.fullmatch(r"\d+", config["WHATSAPP_PHONE_NUMBER_ID"]))


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def public_receipt(record: dict) -> dict:
    return {key: record.get(key) for key in ("idempotency_key", "source_id", "status", "message_id", "created_at", "updated_at", "error_code")}


async def send_document(pdf_bytes: bytes, filename: str, recipient_phone: str, message: str,
                        idempotency_key: str, floor_id: str, source_id: str, actor_id: str) -> dict:
    config = configuration()
    if not configured():
        raise HTTPException(503, "Direct WhatsApp sending is not configured. Add the WhatsApp Business sender in Railway.")
    version = config["WHATSAPP_GRAPH_VERSION"] or "v23.0"
    if not re.fullmatch(r"v\d+\.0", version):
        raise HTTPException(503, "The WhatsApp API version is invalid.")
    phone = whatsapp_phone(recipient_phone)
    if not phone:
        raise HTTPException(422, "Add a valid WhatsApp phone number first.")
    if not message.strip() or len(message) > 1024:
        raise HTTPException(422, "Enter a message of 1 to 1024 characters.")
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,100}", idempotency_key):
        raise HTTPException(422, "A valid send request ID is required.")
    if not pdf_bytes.startswith(b"%PDF") or len(pdf_bytes) > 16 * 1024 * 1024:
        raise HTTPException(422, "The generated PDF is invalid or too large.")
    filename = re.sub(r"[\r\n/\\]", "_", filename)[:150]
    scope = {"floor_id": floor_id, "source_id": source_id, "idempotency_key": idempotency_key}
    fingerprint = hashlib.sha256(pdf_bytes + json.dumps([phone, message, filename]).encode()).hexdigest()
    record = {**scope, "payload_hash": fingerprint, "created_by": actor_id,
              "created_at": now(), "updated_at": now(), "status": "preparing"}
    try:
        await db.whatsapp_deliveries.insert_one(record)
    except DuplicateKeyError:
        previous = await db.whatsapp_deliveries.find_one(scope, {"_id": 0})
        if not previous or previous.get("payload_hash") != fingerprint:
            raise HTTPException(409, "This request ID belongs to a different PDF or message.")
        return public_receipt(previous)
    endpoint = f"https://graph.facebook.com/{version}/{config['WHATSAPP_PHONE_NUMBER_ID']}"
    headers = {"Authorization": f"Bearer {config['WHATSAPP_ACCESS_TOKEN']}"}
    sending = False
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=10), follow_redirects=False) as client:
            upload = await client.post(f"{endpoint}/media", headers=headers,
                data={"messaging_product": "whatsapp", "type": "application/pdf"},
                files={"file": (filename, pdf_bytes, "application/pdf")})
            upload.raise_for_status()
            media_id = upload.json().get("id")
            if not isinstance(media_id, str) or not media_id:
                raise ValueError("Missing media ID")
            document = {"id": media_id, "filename": filename}
            payload = {"messaging_product": "whatsapp", "to": phone, "type": "document",
                       "document": {**document, "caption": message}}
            if config["WHATSAPP_DOCUMENT_TEMPLATE"]:
                payload = {"messaging_product": "whatsapp", "to": phone, "type": "template", "template": {
                    "name": config["WHATSAPP_DOCUMENT_TEMPLATE"],
                    "language": {"code": config["WHATSAPP_TEMPLATE_LANGUAGE"] or "en"},
                    "components": [{"type": "header", "parameters": [{"type": "document", "document": document}]},
                                   {"type": "body", "parameters": [{"type": "text", "text": message}]}],
                }}
            await db.whatsapp_deliveries.update_one(scope, {"$set": {"status": "sending", "updated_at": now()}})
            sending = True
            response = await client.post(f"{endpoint}/messages", headers=headers, json=payload)
            response.raise_for_status()
            message_id = response.json()["messages"][0]["id"]
            if not isinstance(message_id, str) or not message_id:
                raise ValueError("Missing message ID")
            record.update(status="accepted", message_id=message_id, updated_at=now())
            # Attach the provider ID first; never overwrite a concurrently
            # received terminal status with the local acceptance acknowledgement.
            await db.whatsapp_deliveries.update_one(scope, {"$set": {
                "message_id": message_id, "updated_at": record["updated_at"]}})
            await db.whatsapp_deliveries.update_one({**scope, "provider_event_order": {"$exists": False}},
                {"$set": {"status": "accepted"}})
            early = await db.whatsapp_status_events.find_one({"message_id": message_id}, {"_id": 0})
            if early:
                await apply_status(message_id, early["status"], early["provider_event_order"])
                record["status"] = early["status"]
            return public_receipt(await db.whatsapp_deliveries.find_one(scope, {"_id": 0}) or record)
    except httpx.HTTPStatusError as error:
        code = None
        try:
            code = error.response.json().get("error", {}).get("code")
        except (ValueError, AttributeError):
            pass
        ambiguous = sending and error.response.status_code >= 500
        record.update(status="unknown" if ambiguous else "failed", error_code=str(code or error.response.status_code), updated_at=now())
    except (httpx.RequestError, ValueError, KeyError, IndexError, TypeError):
        record.update(status="unknown" if sending else "failed", error_code="send_unconfirmed" if sending else "upload_failed", updated_at=now())
    await db.whatsapp_deliveries.update_one(scope, {"$set": {key: record[key] for key in ("status", "error_code", "updated_at")}})
    return public_receipt(record)


def verify_signature(body: bytes, signature: str | None) -> bool:
    secret = configuration()["WHATSAPP_APP_SECRET"]
    if not secret or not signature:
        return False
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


async def record_statuses(payload: dict) -> int:
    """Signed provider timestamps are monotonic; older/replayed events cannot regress."""
    updated = 0
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            if str(value.get("metadata", {}).get("phone_number_id", "")) != configuration()["WHATSAPP_PHONE_NUMBER_ID"]:
                continue
            for status in value.get("statuses", []):
                message_id, state = status.get("id"), status.get("status")
                if not isinstance(message_id, str) or state not in {"sent", "delivered", "read", "failed"}:
                    continue
                try:
                    timestamp = int(status["timestamp"])
                except (KeyError, TypeError, ValueError):
                    continue
                # Same-second delivered/read beats sent. No terminal receipt regression.
                rank = {"sent": 1, "failed": 2, "delivered": 3, "read": 4}[state]
                event_order = timestamp * 10 + rank
                # Keep unmatched signed receipts briefly: Meta may deliver the
                # callback before the send response's ID has reached our DB.
                event_query = status_query(message_id, state, event_order)
                try:
                    await db.whatsapp_status_events.update_one(event_query, {"$set": {
                        "status": state, "provider_event_order": event_order, "updated_at": now()},
                        "$setOnInsert": {"message_id": message_id, "created_at": datetime.now(timezone.utc)}}, upsert=True)
                except DuplicateKeyError:
                    pass  # An older/terminal replay failed the monotonic filter.
                updated += await apply_status(message_id, state, event_order)
    return updated


def status_query(message_id: str, state: str, event_order: int) -> dict:
    return {"message_id": message_id,
        "status": {"$nin": ["read"] if state == "delivered" else ["read", "delivered"] if state in {"sent", "failed"} else []},
        "$or": [{"provider_event_order": {"$lt": event_order}}, {"provider_event_order": {"$exists": False}}]}


async def apply_status(message_id: str, state: str, event_order: int) -> int:
    result = await db.whatsapp_deliveries.update_one(status_query(message_id, state, event_order),
        {"$set": {"status": state, "provider_event_order": event_order, "updated_at": now()}})
    return result.modified_count
