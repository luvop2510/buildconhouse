import asyncio
from copy import deepcopy
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from pypdf import PdfReader

from models import UserPublic
from routes import furniture_quotation_routes as routes
from services.furniture_quotations import FurnitureQuotationInput, build_pdf, prepare_document

NOW = "2026-10-10T04:00:00+00:00"
LATER = "2026-10-11T06:00:00+00:00"


def body(**changes):
    return FurnitureQuotationInput(**{
        "customer_name": "RDCL", "customer_phone": "9909906652",
        "charges": [{"description": "TOTAL PURCHASE", "amount_rmb": "172250"},
                    {"description": "CHARGE", "amount_rmb": "60288"}],
        "deposits": [{"description": "Deposit by customer", "currency": "INR", "amount": "2200000", "rate": "15.12"}],
        **changes,
    })


def document(**changes):
    return {**prepare_document(body(**changes), NOW), "id": "fq-1", "floor_id": "third-floor", "revision": 1}


def staff(active="third-floor", floors=None):
    return UserPublic(id="staff-1", email="unit@example.com", full_name="Unit", role="sales",
                      floor_ids=floors or [active], active_floor_id=active)


def test_exact_inr_division_usd_multiplication_and_balance():
    doc = document(deposits=[{"amount": "1512", "rate": "15.12", "currency": "INR"},
                             {"amount": "200", "rate": "7.25", "currency": "USD"}])
    assert [entry["amount_rmb"] for entry in doc["deposits"]] == ["100.00", "1450.00"]
    assert doc["total_payable_rmb"] == "232538.00"
    assert doc["total_received_rmb"] == "1550.00"
    assert doc["balance_rmb"] == "230988.00"
    assert doc["deposits"][0]["rate"] == "15.12"


def test_photo_values_round_only_at_receipt_precision():
    doc = document()
    assert doc["total_received_rmb"] == "145502.65"
    assert doc["balance_rmb"] == "87035.35"


@pytest.mark.parametrize("value", ["0", "-1", "NaN", "Infinity", "1e2", "1.1234567", "1000000000001", ""])
def test_invalid_money_rejected_before_write(value):
    with pytest.raises(ValidationError):
        body(charges=[{"description": "TOTAL PURCHASE", "amount_rmb": value}])
    with pytest.raises(ValidationError):
        body(deposits=[{"amount": "100", "rate": value, "currency": "INR"}])


def editable(doc, **changes):
    return body(charges=[{k: entry[k] for k in ("id", "description", "amount_rmb")} for entry in doc["charges"]],
                deposits=[{k: entry[k] for k in ("id", "description", "currency", "amount", "rate")} for entry in doc["deposits"]],
                **changes)


def test_unchanged_rates_keep_receipt_dates_and_changed_receipts_are_dated():
    doc = document()
    incoming = editable(doc)
    incoming.charges[0].amount_rmb = "180000"
    result = prepare_document(incoming, LATER, doc)
    assert result["charges"][0]["updated_at"] == LATER
    assert result["charges"][0]["created_at"] == NOW
    assert result["charges"][1]["updated_at"] == NOW
    assert result["deposits"][0]["rate"] == "15.12"
    assert result["deposits"][0]["updated_at"] == NOW
    assert result["updated_at"] == LATER


def test_finalized_price_locked_while_new_deposit_updates_balance():
    doc = document(status="final")
    incoming = editable(doc, status="final")
    incoming.deposits.append(body(deposits=[{"amount": "100", "rate": "1", "currency": "RMB"}]).deposits[0])
    result = prepare_document(incoming, LATER, doc)
    assert result["total_payable_rmb"] == doc["total_payable_rmb"]
    assert result["total_received_rmb"] == "145602.65"
    assert result["finalized_at"] == NOW
    incoming.charges[0].amount_rmb = "999"
    with pytest.raises(HTTPException) as error:
        prepare_document(incoming, LATER, doc)
    assert error.value.status_code == 409
    with pytest.raises(HTTPException):
        prepare_document(editable(doc, status="draft"), LATER, doc)


def test_duplicate_or_foreign_entry_ids_are_rejected():
    doc = document()
    incoming = editable(doc)
    incoming.charges[1].id = incoming.charges[0].id
    with pytest.raises(HTTPException):
        prepare_document(incoming, LATER, doc)
    incoming.charges[1].id = "another-quotation-entry"
    with pytest.raises(HTTPException):
        prepare_document(incoming, LATER, doc)


def test_rmb_deposit_requires_rate_one_and_credit_balance_is_retained():
    with pytest.raises(HTTPException, match="RNB deposits must use rate 1"):
        document(deposits=[{"amount": "100", "rate": "2", "currency": "RMB"}])
    doc = document(deposits=[{"amount": "240000", "rate": "1", "currency": "RMB"}])
    assert doc["balance_rmb"] == "-7462.00"


def test_pdf_displays_rnb_for_legacy_receipts_without_changing_stored_currency():
    doc = document(deposits=[{"amount": "100", "rate": "1", "currency": "RMB"}])
    text = PdfReader(BytesIO(build_pdf(doc)[0])).pages[0].extract_text()
    assert text.count("RNB") == 3  # Two ledger headings and the saved deposit currency.
    assert "100 RNB" in text and "RMB" not in text
    assert doc["deposits"][0]["currency"] == "RMB"
    assert doc["deposits"][0]["amount_rmb"] == "100.00"


def test_pdf_layout_unbranded_deterministic_and_totals_present():
    doc = document()
    data, filename = build_pdf(doc)
    assert data == build_pdf(doc)[0]
    assert filename.endswith(".pdf")
    pdf = PdfReader(BytesIO(data))
    assert len(pdf.pages) == 1
    text = pdf.pages[0].extract_text()
    assert "RDCL" in text and "TOTAL PURCHASE" in text and "BALANCE AMOUNT" in text
    assert "232538.00" in text and "145502.65" in text and "87035.35" in text
    assert "10-10-2026 09:30" in text
    assert text.count("RNB") == 2 and "RMB" not in text
    assert "Buildcon" not in text and "BuildCon" not in text and "Forge" not in text


def test_large_pdf_continues_with_repeat_headers_and_complete_totals():
    doc = document(charges=[{"description": f"Furniture charge {i} " + "long description " * 7, "amount_rmb": "1"} for i in range(60)], deposits=[])
    pdf = PdfReader(BytesIO(build_pdf(doc)[0]))
    assert len(pdf.pages) > 1
    for page in pdf.pages:
        assert "DESCRIPTION" in page.extract_text() and "RDCL" in page.extract_text()
        assert "RNB" in page.extract_text() and "RMB" not in page.extract_text()
    text = " ".join(page.extract_text() for page in pdf.pages)
    assert "Furniture charge 59" in text and "60.00" in text and "BALANCE AMOUNT" in text


def test_floor_access_rejects_kitchen_and_unassigned_staff():
    assert routes.scope(staff()) == {"floor_id": "third-floor"}
    for user in [staff("second-floor"), staff("third-floor", ["first-floor"])]:
        with pytest.raises(HTTPException):
            routes.scope(user)


def test_save_checks_snapshot_and_atomic_revision_before_mutation(monkeypatch):
    doc = document()
    collection = SimpleNamespace(find_one=AsyncMock(return_value=doc), update_one=AsyncMock(return_value=SimpleNamespace(modified_count=1)))
    monkeypatch.setattr(routes, "db", SimpleNamespace(furniture_quotations=collection))
    incoming = editable(doc)
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.update_quotation(doc["id"], incoming, staff()))
    assert error.value.status_code == 409
    collection.update_one.assert_not_awaited()
    incoming.expected_updated_at = NOW
    result = asyncio.run(routes.update_quotation(doc["id"], incoming, staff()))
    assert result["revision"] == 2
    query = collection.update_one.call_args.args[0]
    assert query["floor_id"] == "third-floor" and query["updated_at"] == NOW and query["revision"] == 1
    collection.update_one.return_value = SimpleNamespace(modified_count=0)
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.update_quotation(doc["id"], incoming, staff()))
    assert error.value.status_code == 409


def test_wrong_floor_document_cannot_be_updated_or_sent(monkeypatch):
    doc = deepcopy(document())
    doc["floor_id"] = "second-floor"
    collection = SimpleNamespace(find_one=AsyncMock(return_value=doc), update_one=AsyncMock())
    monkeypatch.setattr(routes, "db", SimpleNamespace(furniture_quotations=collection))
    user = staff("third-floor", ["third-floor", "second-floor"])
    incoming = editable(doc)
    incoming.expected_updated_at = NOW
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.update_quotation(doc["id"], incoming, user))
    assert error.value.status_code == 404
    collection.update_one.assert_not_awaited()


def test_send_uses_saved_pdf_normalized_phone_and_idempotent_delivery(monkeypatch):
    from services import whatsapp_delivery
    doc = document()
    collection = SimpleNamespace(find_one=AsyncMock(return_value=doc))
    monkeypatch.setattr(routes, "db", SimpleNamespace(furniture_quotations=collection))
    sender = AsyncMock(return_value={"status": "accepted", "message_id": "provider-1"})
    monkeypatch.setattr(whatsapp_delivery, "send_document", sender)
    request = routes.WhatsAppSendInput(message="Quotation attached", expected_updated_at=NOW, idempotency_key="unit-send-request-1")
    result = asyncio.run(routes.send_quotation(doc["id"], request, staff()))
    assert result["status"] == "accepted"
    arguments = sender.call_args.kwargs
    assert arguments["pdf_bytes"] == build_pdf(doc)[0]
    assert arguments["recipient_phone"] == "919909906652"
    assert arguments["source_id"] == doc["id"] and arguments["floor_id"] == "third-floor"
    request.expected_updated_at = LATER
    sender.reset_mock()
    with pytest.raises(HTTPException):
        asyncio.run(routes.send_quotation(doc["id"], request, staff()))
    sender.assert_not_awaited()


def test_furniture_create_snapshots_authorized_partner_name_and_company(monkeypatch):
    collection = SimpleNamespace(insert_one=AsyncMock())
    directory = SimpleNamespace(find_one=AsyncMock(return_value={"company": "NTS Studio"}))
    resolver = AsyncMock(return_value={"referrer_id": "partner-1", "referrer_name": "NTS", "referrer_type": "architect"})
    monkeypatch.setattr(routes, "db", SimpleNamespace(furniture_quotations=collection, referrers=directory))
    monkeypatch.setattr(routes, "referrer_fields", resolver)
    user = staff()
    result = asyncio.run(routes.create_quotation(body(referrer_id="partner-1"), user))
    resolver.assert_awaited_once_with(routes.db, "partner-1", "third-floor", user)
    assert result["referrer_name"] == "NTS"
    assert result["referrer_company"] == "NTS Studio"
    assert collection.insert_one.call_args.args[0]["referrer_id"] == "partner-1"


def test_furniture_update_can_explicitly_clear_partner_without_changing_history_when_omitted(monkeypatch):
    doc = {**document(), "referrer_id": "partner-1", "referrer_name": "NTS", "referrer_type": "architect", "referrer_company": "NTS Studio"}
    collection = SimpleNamespace(find_one=AsyncMock(return_value=doc), update_one=AsyncMock(return_value=SimpleNamespace(modified_count=1)))
    monkeypatch.setattr(routes, "db", SimpleNamespace(furniture_quotations=collection))
    kept = asyncio.run(routes.update_quotation(doc["id"], editable(doc, expected_updated_at=NOW), staff()))
    assert kept["referrer_name"] == "NTS"
    cleared = asyncio.run(routes.update_quotation(doc["id"], editable(doc, expected_updated_at=NOW, referrer_id=None), staff()))
    assert cleared["referrer_id"] is None and cleared["referrer_company"] is None
