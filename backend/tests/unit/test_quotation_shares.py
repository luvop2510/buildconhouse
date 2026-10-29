"""Customer PDF capabilities expire, respect source floors, and never expose JWTs."""
import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import HTTPException
import pytest

from routes import quotation_routes
from services import quotation_shares as shares


@pytest.mark.parametrize("raw, expected", [
    ("99099 06652", "919909906652"), ("+91 (99099) 06652", "919909906652"),
    ("0091-9909906652", "919909906652"), ("+44 20 7946 0958", "442079460958"),
    ("+1 415 555 0123", "14155550123"), (None, None), ("123", None),
    ("call 9909906652 ext2", None), ("0000000000", None), ("+0123456789", None),
    ("1234567890", None), ("+" + "1" * 16, None),
])
def test_whatsapp_phone_normalizes_contact_numbers(raw, expected):
    assert shares.whatsapp_phone(raw) == expected


def fake_share_database(monkeypatch, share=None, quotation=True, customer=True):
    database = SimpleNamespace(
        quotation_shares=SimpleNamespace(find_one=AsyncMock(return_value=share), insert_one=AsyncMock()),
        quotations=SimpleNamespace(find_one=AsyncMock(return_value={"id": "q1"} if quotation else None)),
        customers=SimpleNamespace(find_one=AsyncMock(return_value={"id": "c1"} if customer else None)),
    )
    storage = SimpleNamespace(require_private_bucket=AsyncMock(), upload=AsyncMock(),
                              download=AsyncMock(return_value=b"%PDF-snapshot"), delete=AsyncMock())
    monkeypatch.setattr(shares, "db", database)
    monkeypatch.setattr(shares, "get_media_storage", lambda: storage)
    monkeypatch.setattr(shares, "private_bucket", lambda: "private-unit")
    return database, storage


def test_share_persists_only_token_digest_and_uses_private_storage(monkeypatch):
    database, storage = fake_share_database(monkeypatch)
    doc = {"id": "q1", "customer_id": "c1", "floor_id": "ground-floor"}
    result = asyncio.run(shares.create_share(doc, b"%PDF-snapshot", "Client.pdf", "u1"))
    token = result["pdf_path"].rsplit("/", 1)[-1]
    record = database.quotation_shares.insert_one.call_args.args[0]
    assert record["token_hash"] == shares.token_digest(token)
    assert token not in str(record)
    assert record["floor_id"] == "ground-floor"
    assert record["storage_key"].startswith("quotation-shares/q1/")
    assert result["expires_in"] == 86400
    assert 86395 < (record["expires_at"] - datetime.now(timezone.utc)).total_seconds() <= 86400
    storage.require_private_bucket.assert_awaited_once_with("private-unit")
    assert storage.upload.call_args.kwargs["cache_control"] == "private, no-store"
    assert storage.upload.call_args.kwargs["upsert"] is False


def test_failed_share_metadata_does_not_leave_private_snapshot(monkeypatch):
    database, storage = fake_share_database(monkeypatch)
    database.quotation_shares.insert_one.side_effect = RuntimeError("db unavailable")
    with pytest.raises(RuntimeError):
        asyncio.run(shares.create_share({"id": "q1", "customer_id": "c1", "floor_id": "first-floor"}, b"pdf", "Client.pdf", "u1"))
    storage.delete.assert_awaited_once()
    assert storage.delete.call_args.kwargs["key"].startswith("quotation-shares/q1/")


def test_share_refuses_unverified_public_bucket(monkeypatch):
    database, storage = fake_share_database(monkeypatch)
    storage.require_private_bucket.side_effect = RuntimeError("Bucket is public")
    with pytest.raises(RuntimeError):
        asyncio.run(shares.create_share({"id": "q1", "customer_id": "c1"}, b"pdf", "Client.pdf", "u1"))
    storage.upload.assert_not_awaited()
    database.quotation_shares.insert_one.assert_not_awaited()


def share_record():
    return {"token_hash": shares.token_digest("a" * 43), "quotation_id": "q1", "customer_id": "c1",
            "floor_id": "ground-floor", "bucket": "private-unit", "storage_key": "quotation-shares/q1/snapshot.pdf",
            "filename": "Client.pdf", "expires_at": datetime.now(timezone.utc) + timedelta(hours=1)}


def test_valid_share_rechecks_source_entities_on_original_floor(monkeypatch):
    database, storage = fake_share_database(monkeypatch, share_record())
    assert asyncio.run(shares.read_share("a" * 43)) == (b"%PDF-snapshot", "Client.pdf")
    database.quotations.find_one.assert_awaited_once_with(
        {"id": "q1", "customer_id": "c1", "floor_id": "ground-floor"}, {"id": 1})
    database.customers.find_one.assert_awaited_once_with({"id": "c1", "floor_id": "ground-floor"}, {"id": 1})
    query = database.quotation_shares.find_one.call_args.args[0]
    assert query["token_hash"] == shares.token_digest("a" * 43)
    assert query["revoked"] == {"$ne": True}
    assert query["expires_at"]["$gt"].tzinfo is timezone.utc
    storage.download.assert_awaited_once()


@pytest.mark.parametrize("quotation,customer", [(False, True), (True, False), (False, False)])
def test_deleted_or_moved_source_revokes_download(monkeypatch, quotation, customer):
    _, storage = fake_share_database(monkeypatch, share_record(), quotation, customer)
    with pytest.raises(HTTPException) as error:
        asyncio.run(shares.read_share("a" * 43))
    assert error.value.status_code == 404
    storage.download.assert_not_awaited()


def test_expired_revoked_or_unknown_token_cannot_download(monkeypatch):
    database, storage = fake_share_database(monkeypatch)
    with pytest.raises(HTTPException) as error:
        asyncio.run(shares.read_share("a" * 43))
    assert error.value.status_code == 404
    assert "$gt" in database.quotation_shares.find_one.call_args.args[0]["expires_at"]
    database.quotations.find_one.assert_not_awaited()
    storage.download.assert_not_awaited()


def test_malformed_token_does_not_hit_database(monkeypatch):
    database, _ = fake_share_database(monkeypatch)
    with pytest.raises(HTTPException):
        asyncio.run(shares.read_share("not-a-valid-token"))
    database.quotation_shares.find_one.assert_not_awaited()


def test_revocation_invalidates_links_before_storage_deletion(monkeypatch):
    calls = []
    record = share_record()
    async def remove_metadata(query, update):
        calls.append(("metadata", query, update))
    async def remove_file(**kwargs):
        calls.append(("storage", kwargs))
    database, storage = fake_share_database(monkeypatch)
    database.quotation_shares.find = lambda *args: SimpleNamespace(to_list=AsyncMock(return_value=[record]))
    database.quotation_shares.update_many = remove_metadata
    database.quotation_shares.delete_one = AsyncMock()
    storage.delete = remove_file
    asyncio.run(shares.revoke_shares("q1", "ground-floor"))
    assert calls[0] == ("metadata", {"quotation_id": "q1", "floor_id": "ground-floor"}, {"$set": {"revoked": True}})
    assert calls[1][0] == "storage"


def test_cleanup_retains_failed_object_metadata_for_retry(monkeypatch):
    database, storage = fake_share_database(monkeypatch)
    cursor = SimpleNamespace(to_list=AsyncMock(return_value=[share_record()]))
    cursor.limit = lambda limit: cursor
    database.quotation_shares.find = lambda *args: cursor
    database.quotation_shares.delete_one = AsyncMock()
    storage.delete.side_effect = RuntimeError("storage unavailable")
    with pytest.raises(RuntimeError):
        asyncio.run(shares.cleanup_expired_shares())
    database.quotation_shares.delete_one.assert_not_awaited()


def test_draft_endpoint_uses_current_contact_and_never_marks_sent(monkeypatch):
    doc = {"id": "q1", "customer_id": "c1", "floor_id": "ground-floor", "status": "draft", "phone_snapshot": "9000000000", "updated_at": "2026-10-17T09:00:00Z"}
    lookup = AsyncMock(return_value=doc)
    customers = SimpleNamespace(find_one=AsyncMock(return_value={"name": "Customer", "phone": "9909906652"}))
    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", lookup)
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(customers=customers, quotations=object()))
    renderer = AsyncMock(return_value=(b"%PDF", "Customer.pdf"))
    monkeypatch.setattr(quotation_routes, "_build_quotation_file", renderer)
    create = AsyncMock(return_value={"pdf_path": "/api/quotations/shared-pdf/token"})
    monkeypatch.setattr(shares, "create_share", create)
    user = SimpleNamespace(id="u1")
    result = asyncio.run(quotation_routes.quotation_whatsapp_draft("q1", True, user))
    assert result["phone"] == "919909906652"
    assert doc["status"] == "draft"
    customers.find_one.assert_awaited_once_with({"id": "c1", "floor_id": "ground-floor"}, {"_id": 0, "password_hash": 0})
    assert result["filename"] == quotation_routes.quotation_pdf_filename("Customer", doc)
    assert result["expected_updated_at"] == doc["updated_at"]
    assert result["include_dimensions"] is True
    assert "pdf_path" not in result
    renderer.assert_not_awaited()
    create.assert_not_awaited()
    assert lookup.call_args.args[2] is user


@pytest.mark.parametrize("customer,status", [(None, 404)])
def test_draft_contact_errors_do_not_render_or_store_pdf(monkeypatch, customer, status):
    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", AsyncMock(return_value={"id": "q1", "customer_id": "c1", "floor_id": "first-floor"}))
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(customers=SimpleNamespace(find_one=AsyncMock(return_value=customer)), quotations=object()))
    render = AsyncMock()
    monkeypatch.setattr(quotation_routes, "_build_quotation_file", render)
    with pytest.raises(HTTPException) as error:
        asyncio.run(quotation_routes.quotation_whatsapp_draft("q1", user=SimpleNamespace(id="u1")))
    assert error.value.status_code == status
    render.assert_not_awaited()


def test_public_pdf_response_is_private_noncacheable_and_downloadable(monkeypatch):
    monkeypatch.setattr(shares, "read_share", AsyncMock(return_value=(b"%PDF", "Client name.pdf")))
    response = asyncio.run(quotation_routes.shared_quotation_pdf("a" * 43))
    assert response.media_type == "application/pdf"
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert "Client%20name.pdf" in response.headers["Content-Disposition"]


def test_failed_revocation_retains_storage_key_for_retry(monkeypatch):
    database, storage = fake_share_database(monkeypatch)
    database.quotation_shares.update_many = AsyncMock()
    database.quotation_shares.delete_one = AsyncMock()
    database.quotation_shares.find = lambda *args: SimpleNamespace(to_list=AsyncMock(return_value=[share_record()]))
    storage.delete.side_effect = RuntimeError("storage unavailable")
    with pytest.raises(RuntimeError):
        asyncio.run(shares.revoke_shares("q1", "ground-floor"))
    database.quotation_shares.update_many.assert_awaited_once()
    database.quotation_shares.delete_one.assert_not_awaited()


def test_draft_endpoint_does_not_use_stale_contact_snapshot(monkeypatch):
    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", AsyncMock(return_value={
        "id": "q1", "customer_id": "c1", "floor_id": "first-floor", "phone_snapshot": "9909906652",
    }))
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(quotations=object(), customers=SimpleNamespace(
        find_one=AsyncMock(return_value={"name": "Customer", "phone": ""}),
    )))
    render = AsyncMock()
    monkeypatch.setattr(quotation_routes, "_build_quotation_file", render)
    result = asyncio.run(quotation_routes.quotation_whatsapp_draft("q1", user=SimpleNamespace(id="u1")))
    assert result["phone"] is None
    assert "pdf_path" not in result
    render.assert_not_awaited()

@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_public_pdf_capability_is_independent_of_viewer_staff_session(monkeypatch, method):
    from starlette.requests import Request
    from starlette.responses import Response
    import server
    authenticate = AsyncMock(side_effect=HTTPException(401, "Expired viewer session"))
    monkeypatch.setattr(server, "decode_token", lambda token: {"kind": "staff"})
    monkeypatch.setattr(server, "get_current_user", authenticate)
    request = Request({"type": "http", "method": method,
        "path": "/api/quotations/shared-pdf/" + "a" * 43,
        "headers": [(b"authorization", b"Bearer expired-or-restricted")], "query_string": b""})
    response = asyncio.run(server.enforce_access_profile(request, AsyncMock(return_value=Response(status_code=200))))
    assert response.status_code == 200
    authenticate.assert_not_awaited()


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/quotations/shared-pdf/" + "a" * 43),
    ("GET", "/api/quotations/shared-pdf/not-a-valid-token"),
    ("GET", "/api/quotations/q1/pdf"),
    ("GET", "/api/quotations/shared-pdf/" + "a" * 43 + "/other"),
])
def test_public_pdf_exemption_does_not_broaden_staff_auth_bypass(monkeypatch, method, path):
    from starlette.requests import Request
    from starlette.responses import Response
    import server
    authenticate = AsyncMock(side_effect=HTTPException(401, "Expired viewer session"))
    monkeypatch.setattr(server, "decode_token", lambda token: {"kind": "staff"})
    monkeypatch.setattr(server, "get_current_user", authenticate)
    request = Request({"type": "http", "method": method, "path": path,
        "headers": [(b"authorization", b"Bearer expired-or-restricted")], "query_string": b""})
    response = asyncio.run(server.enforce_access_profile(request, AsyncMock(return_value=Response(status_code=200))))
    assert response.status_code == 401
    authenticate.assert_awaited_once()


@pytest.mark.parametrize("phone", [None, "123"])
def test_pdf_file_sharing_remains_available_without_valid_phone(monkeypatch, phone):
    doc = {"id": "q1", "customer_id": "c1", "floor_id": "second-floor", "customer_name": "Customer"}
    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", AsyncMock(return_value=doc))
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(customers=SimpleNamespace(
        find_one=AsyncMock(return_value={"name": "Customer", "phone": phone})), quotations=object()))
    result = asyncio.run(quotation_routes.quotation_whatsapp_draft("q1", user=SimpleNamespace(id="u1")))
    assert result["phone"] is None
    assert result["floor_id"] == "second-floor"
    assert result["filename"] == quotation_routes.quotation_pdf_filename("Customer", doc)
    assert "pdf_path" not in result


@pytest.mark.parametrize("floor_id,doc_type", [
    ("ground-floor", "tiles_selection"), ("ground-floor", "tiles_quotation"),
    ("first-floor", "standard"), ("second-floor", "standard"), ("third-floor", "standard"),
])
def test_direct_send_delivers_pdf_bytes_for_document_floor(monkeypatch, floor_id, doc_type):
    from services import whatsapp_delivery
    doc = {"id": "q1", "customer_id": "c1", "floor_id": floor_id,
           "doc_type": doc_type, "updated_at": "2026-10-17T09:00:00Z", "status": "draft"}
    customer = {"name": "Customer", "phone": "9909906652"}
    lookup = AsyncMock(return_value=doc)
    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", lookup)
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(customers=SimpleNamespace(
        find_one=AsyncMock(return_value=customer)), quotations=object()))
    renderer = AsyncMock(return_value=(b"%PDF-private", "Customer.pdf"))
    send = AsyncMock(return_value={"status": "accepted"})
    create = AsyncMock()
    monkeypatch.setattr(quotation_routes, "_build_quotation_file", renderer)
    monkeypatch.setattr(whatsapp_delivery, "send_document", send)
    monkeypatch.setattr(shares, "create_share", create)
    body = quotation_routes.QuotationWhatsAppSendInput(message="Please review", expected_updated_at=doc["updated_at"],
        idempotency_key="quotation_request_123", include_dimensions=True)
    user = SimpleNamespace(id="u1")
    assert asyncio.run(quotation_routes.send_quotation_whatsapp("q1", body, user)) == {"status": "accepted"}
    renderer.assert_awaited_once_with(doc, customer, True)
    send.assert_awaited_once_with(pdf_bytes=b"%PDF-private", filename="Customer.pdf", recipient_phone="919909906652",
        message="Please review", idempotency_key="quotation_request_123", floor_id=floor_id, source_id="q1", actor_id="u1")
    create.assert_not_awaited()
    assert doc["status"] == "draft"
    assert lookup.call_args.args[2] is user


@pytest.mark.parametrize("phone,expected_version,status", [("9909906652", "stale", 409), ("invalid", "current", 422)])
def test_direct_send_rejects_stale_document_or_invalid_phone_before_render(monkeypatch, phone, expected_version, status):
    from services import whatsapp_delivery
    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", AsyncMock(return_value={
        "id": "q1", "customer_id": "c1", "floor_id": "first-floor", "updated_at": "current"}))
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(customers=SimpleNamespace(
        find_one=AsyncMock(return_value={"phone": phone})), quotations=object()))
    render, send = AsyncMock(), AsyncMock()
    monkeypatch.setattr(quotation_routes, "_build_quotation_file", render)
    monkeypatch.setattr(whatsapp_delivery, "send_document", send)
    body = quotation_routes.QuotationWhatsAppSendInput(message="Please review", expected_updated_at=expected_version,
        idempotency_key="quotation_request_123")
    with pytest.raises(HTTPException) as error:
        asyncio.run(quotation_routes.send_quotation_whatsapp("q1", body, SimpleNamespace(id="u1")))
    assert error.value.status_code == status
    render.assert_not_awaited()
    send.assert_not_awaited()
