import asyncio
import hashlib
import hmac
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from services import whatsapp_delivery as service


def setup(monkeypatch, responses=None):
    monkeypatch.setenv("WHATSAPP_ACCESS_TOKEN", "unit-token")
    monkeypatch.setenv("WHATSAPP_PHONE_NUMBER_ID", "123")
    monkeypatch.delenv("WHATSAPP_DOCUMENT_TEMPLATE", raising=False)
    monkeypatch.delenv("WHATSAPP_GRAPH_VERSION", raising=False)
    collection = SimpleNamespace(insert_one=AsyncMock(), update_one=AsyncMock(return_value=SimpleNamespace(modified_count=1)), find_one=AsyncMock(return_value=None))
    events = SimpleNamespace(find_one=AsyncMock(return_value=None), update_one=AsyncMock())
    monkeypatch.setattr(service, "db", SimpleNamespace(whatsapp_deliveries=collection, whatsapp_status_events=events))
    calls = []
    outcomes = iter(responses or [{"id": "media1"}, {"messages": [{"id": "wamid.1"}]}])
    class Client:
        def __init__(self, **kwargs):
            assert kwargs["follow_redirects"] is False
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def post(self, url, **kwargs):
            calls.append((url, kwargs))
            outcome = next(outcomes)
            if isinstance(outcome, Exception):
                raise outcome
            return httpx.Response(200, json=outcome, request=httpx.Request("POST", url))
    monkeypatch.setattr(service.httpx, "AsyncClient", Client)
    return collection, calls


def send(**kwargs):
    return asyncio.run(service.send_document(b"%PDF-1.4 unit", "Quotation.pdf", "9909906652", "Hey Mira, quotation attached.",
        kwargs.get("key", "request1234567890"), "third-floor", "quote1", "actor1"))


def test_direct_document_upload_and_caption_are_private_and_accepted(monkeypatch):
    collection, calls = setup(monkeypatch)
    assert send()["status"] == "accepted"
    assert calls[0][0] == "https://graph.facebook.com/v23.0/123/media"
    assert calls[0][1]["files"]["file"][1] == b"%PDF-1.4 unit"
    assert calls[1][1]["json"]["document"] == {"id": "media1", "filename": "Quotation.pdf", "caption": "Hey Mira, quotation attached."}
    assert calls[1][1]["json"]["to"] == "919909906652"
    record = collection.insert_one.call_args.args[0]
    assert record["floor_id"] == "third-floor"
    assert "unit-token" not in str(record) and "9909906652" not in str(record)
    assert "Hey Mira" not in str(record)


def test_duplicate_request_returns_receipt_without_sending_again(monkeypatch):
    collection, calls = setup(monkeypatch)
    send()
    record = collection.insert_one.call_args.args[0]
    record.update(status="accepted", message_id="wamid.1")
    collection.insert_one.side_effect = DuplicateKeyError("duplicate")
    collection.find_one.return_value = record
    assert send()["message_id"] == "wamid.1"
    assert len(calls) == 2


def test_duplicate_request_for_different_pdf_is_rejected(monkeypatch):
    collection, calls = setup(monkeypatch)
    collection.insert_one.side_effect = DuplicateKeyError("duplicate")
    collection.find_one.return_value = {"payload_hash": "other"}
    with pytest.raises(HTTPException) as error:
        send()
    assert error.value.status_code == 409 and not calls


def test_timeout_during_message_send_is_unknown_and_not_retried(monkeypatch):
    _, calls = setup(monkeypatch, [{"id": "media1"}, httpx.ReadTimeout("timeout")])
    assert send()["status"] == "unknown"
    assert len(calls) == 2


def test_provider_server_error_during_send_is_unknown(monkeypatch):
    response = httpx.Response(503, request=httpx.Request("POST", "https://graph.facebook.com/messages"))
    _, calls = setup(monkeypatch, [{"id": "media1"}, httpx.HTTPStatusError("failed", request=response.request, response=response)])
    assert send()["status"] == "unknown"
    assert len(calls) == 2


def test_receipt_arriving_before_message_response_is_reconciled(monkeypatch):
    collection, _ = setup(monkeypatch)
    service.db.whatsapp_status_events.find_one.return_value = {"status": "delivered", "provider_event_order": 1003}
    assert send()["status"] == "delivered"
    acknowledgement = collection.update_one.call_args_list[2].args
    assert acknowledgement[0]["provider_event_order"] == {"$exists": False}
    assert acknowledgement[1]["$set"]["status"] == "accepted"
    terminal = collection.update_one.call_args.args
    assert terminal[1]["$set"]["status"] == "delivered"


def test_upload_timeout_is_failed_and_no_message_sent(monkeypatch):
    _, calls = setup(monkeypatch, [httpx.ReadTimeout("timeout")])
    assert send()["status"] == "failed"
    assert len(calls) == 1


def test_unconfigured_sender_does_not_write_or_claim_sent(monkeypatch):
    collection, calls = setup(monkeypatch)
    monkeypatch.delenv("WHATSAPP_ACCESS_TOKEN")
    with pytest.raises(HTTPException) as error:
        send()
    assert error.value.status_code == 503
    collection.insert_one.assert_not_awaited()
    assert not calls


def test_approved_document_template_carries_pdf_and_message(monkeypatch):
    _, calls = setup(monkeypatch)
    monkeypatch.setenv("WHATSAPP_DOCUMENT_TEMPLATE", "quotation_document")
    monkeypatch.setenv("WHATSAPP_TEMPLATE_LANGUAGE", "en_IN")
    send()
    template = calls[1][1]["json"]["template"]
    assert template["language"]["code"] == "en_IN"
    assert template["components"][0]["parameters"][0]["document"]["id"] == "media1"
    assert template["components"][1]["parameters"][0]["text"] == "Hey Mira, quotation attached."


def test_webhook_requires_correct_hmac_for_exact_body(monkeypatch):
    monkeypatch.setenv("WHATSAPP_APP_SECRET", "unit-secret")
    raw = b'{"object":"whatsapp_business_account"}'
    signature = "sha256=" + hmac.new(b"unit-secret", raw, hashlib.sha256).hexdigest()
    assert service.verify_signature(raw, signature)
    assert not service.verify_signature(raw + b" ", signature)
    assert not service.verify_signature(raw, None)


def test_webhook_is_sender_scoped_and_monotonic(monkeypatch):
    collection, _ = setup(monkeypatch)
    payload = {"entry": [{"changes": [{"value": {"metadata": {"phone_number_id": "123"}, "statuses": [
        {"id": "wamid.1", "status": "delivered", "timestamp": "100"}]}}]}]}
    assert asyncio.run(service.record_statuses(payload)) == 1
    query, update = collection.update_one.call_args.args
    assert query["message_id"] == "wamid.1"
    assert query["status"] == {"$nin": ["read"]}
    assert update["$set"]["provider_event_order"] == 1003
    payload["entry"][0]["changes"][0]["value"]["metadata"]["phone_number_id"] = "different"
    assert asyncio.run(service.record_statuses(payload)) == 0
