"""Exercise the configured server compressor at the raw ASGI wire boundary."""
import asyncio
import gzip
import json

import httpx
import pytest
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import Response

import server


def configured_compressor(body, content_type="application/json", headers=None, status=200):
    configuration = next(item for item in server.app.user_middleware if item.cls is GZipMiddleware)
    return configuration.cls(Response(body, media_type=content_type, headers=headers, status_code=status),
                             *configuration.args, **configuration.kwargs)


def wire_response(app, accept_encoding):
    async def run():
        messages = []
        async def receive():
            return {"type": "http.request", "body": b""}
        async def send(message):
            messages.append(message)
        await app({"type": "http", "method": "GET", "headers": [(b"accept-encoding", accept_encoding.encode())]}, receive, send)
        headers = dict(messages[0]["headers"])
        body = b"".join(message.get("body", b"") for message in messages[1:])
        return headers, body
    return asyncio.run(run())


@pytest.mark.parametrize("content_type", ["application/json", "text/plain", "text/html"])
def test_large_text_negotiates_gzip_and_reduces_actual_transfer_bytes(content_type):
    body = json.dumps([{"id": index, "name": "Synthetic product", "category": "Tiles"} for index in range(100)]).encode()
    app = configured_compressor(body, content_type)
    identity_headers, identity = wire_response(app, "identity")
    headers, compressed = wire_response(app, "br, gzip")
    assert b"content-encoding" not in identity_headers
    assert identity == body
    assert headers[b"content-encoding"] == b"gzip"
    assert b"Accept-Encoding" in headers[b"vary"]
    assert int(headers[b"content-length"]) == len(compressed)
    assert len(compressed) < len(body) * .2
    assert json.loads(gzip.decompress(compressed)) == json.loads(identity)


def test_small_json_is_not_compressed_and_http_client_parses_large_json():
    headers, body = wire_response(configured_compressor(b'{"ok":true}'), "gzip")
    assert b"content-encoding" not in headers
    assert json.loads(body) == {"ok": True}
    payload = {"items": [{"id": index, "name": "Synthetic item"} for index in range(100)]}
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=configured_compressor(json.dumps(payload))), base_url="http://test") as client:
            response = await client.get("/", headers={"Accept-Encoding": "gzip"})
            assert response.headers["content-encoding"] == "gzip"
            assert response.json() == payload
    asyncio.run(run())


@pytest.mark.parametrize("content_type", ["image/webp", "image/avif", "image/jpeg", "application/zip", "text/event-stream"])
def test_precompressed_formats_and_event_streams_are_not_recompressed(content_type):
    body = b"synthetic opaque payload" * 100
    headers, transmitted = wire_response(configured_compressor(body, content_type), "gzip")
    assert b"content-encoding" not in headers
    assert transmitted == body


def test_existing_content_encoding_and_partial_response_preserve_bytes():
    body = gzip.compress(b"synthetic already encoded payload" * 100)
    headers, transmitted = wire_response(configured_compressor(body, headers={"Content-Encoding": "gzip"}), "gzip")
    assert headers[b"content-encoding"] == b"gzip"
    assert transmitted == body
    headers, transmitted = wire_response(configured_compressor(b"partial text" * 100, status=206), "gzip")
    assert b"content-encoding" not in headers
    assert transmitted == b"partial text" * 100
