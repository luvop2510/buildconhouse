import asyncio
import pytest
from fastapi import FastAPI, File, UploadFile
from httpx import ASGITransport, AsyncClient
from services.request_limits import RequestBodyLimitMiddleware


@pytest.mark.asyncio
async def test_declared_oversize_rejected_before_downstream_or_body_read():
    called = False
    async def app(*args):
        nonlocal called
        called = True
    async def receive():
        raise AssertionError("Oversized declared body must never be buffered")
    sent = []
    async def send(message):
        sent.append(message)
    middleware = RequestBodyLimitMiddleware(app, body_limit=8)
    await middleware({"type": "http", "path": "/api/products", "headers": [(b"content-length", b"9")]}, receive, send)
    assert sent[0]["status"] == 413
    assert not called


@pytest.mark.asyncio
async def test_chunked_upload_cut_off_before_full_multipart_spooling():
    app = FastAPI()
    handled = False
    @app.post("/upload")
    async def upload(file: UploadFile = File(...)):
        nonlocal handled
        handled = True
        return {"bytes": len(await file.read())}
    app.add_middleware(RequestBodyLimitMiddleware, upload_limit=1024)
    emitted = 0
    async def chunks():
        nonlocal emitted
        for chunk in [b'--test\r\nContent-Disposition: form-data; name="file"; filename="x"\r\n\r\n', b'a' * 2048, b'b' * 2048, b'\r\n--test--\r\n']:
            emitted += 1
            yield chunk
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/upload", content=chunks(), headers={"Content-Type": "multipart/form-data; boundary=test"})
    assert response.status_code == 413
    assert emitted == 2
    assert not handled


@pytest.mark.asyncio
async def test_upload_admission_and_cancellation_release_capacity():
    entered = asyncio.Event()
    release = asyncio.Event()
    async def app(scope, receive, send):
        entered.set()
        await release.wait()
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}
    async def send(message):
        results.append(message)
    results = []
    middleware = RequestBodyLimitMiddleware(app, upload_slots=1)
    scope = {"type": "http", "path": "/upload", "headers": [(b"content-type", b"multipart/form-data; boundary=test")]}
    first = asyncio.create_task(middleware(scope, receive, send))
    await entered.wait()
    await middleware(scope, receive, send)
    assert results[0]["status"] == 429
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    release.set()
    await middleware(scope, receive, send)
    assert middleware.uploads._value == 1


@pytest.mark.asyncio
async def test_valid_upload_and_json_keep_working():
    app = FastAPI()
    @app.post("/upload")
    async def upload(file: UploadFile = File(...)):
        return {"bytes": len(await file.read())}
    app.add_middleware(RequestBodyLimitMiddleware)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/upload", files={"file": ("file.txt", b"safe")})
    assert response.status_code == 200
    assert response.json() == {"bytes": 4}


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/team/member/password", "/api/team/member/reset-password", "/api/auth/change-password"])
async def test_credential_endpoints_reject_oversized_payload_before_auth_or_parse(path):
    called = False
    async def app(*args):
        nonlocal called
        called = True
    async def receive():
        raise AssertionError("Oversized credential request must not be buffered")
    sent = []
    async def send(message):
        sent.append(message)
    await RequestBodyLimitMiddleware(app)({"type": "http", "path": path,
        "headers": [(b"content-length", str(64 * 1024 + 1).encode())]}, receive, send)
    assert sent[0]["status"] == 413
    assert not called
