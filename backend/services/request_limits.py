"""Bound incoming bodies before FastAPI parses JSON or spools multipart files."""
import asyncio
import json
import math
from re import fullmatch

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse


def _finite_json_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Non-finite JSON number")
    return number


def _reject_json_constant(_value):
    raise ValueError("Non-finite JSON number")


class RequestBodyLimitMiddleware:
    def __init__(self, app, *, body_limit=4 * 1024 * 1024,
                 upload_limit=81 * 1024 * 1024, upload_slots=4):
        self.app = app
        self.body_limit = body_limit
        self.upload_limit = upload_limit
        self.uploads = asyncio.Semaphore(upload_slots)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        raw_headers = scope.get("headers", [])
        # ASGI/Starlette selects the first duplicate, while dict() selects
        # the last. Reject ambiguous parser/framing metadata before either
        # body policy or the framework can interpret a different value.
        for name in (b"content-type", b"content-length"):
            if sum(key.lower() == name for key, _value in raw_headers) > 1:
                return await JSONResponse({"detail": "Ambiguous request headers"}, status_code=400)(scope, receive, send)
        headers = {key.lower(): value for key, value in raw_headers}
        multipart = headers.get(b"content-type", b"").lower().startswith(b"multipart/form-data")
        limit = self.upload_limit if multipart else self.body_limit
        path = scope.get("path", "")
        if path.startswith("/api/auth/") or fullmatch(r"/api/team/[^/]+/(?:password|reset-password)", path):
            limit = min(limit, 64 * 1024)
        declared = headers.get(b"content-length")
        if declared is not None:
            try:
                length = int(declared)
                if length < 0:
                    raise ValueError()
            except ValueError:
                return await JSONResponse({"detail": "Invalid request length"}, status_code=400)(scope, receive, send)
            if length > limit:
                return await JSONResponse({"detail": "Request body exceeds the size limit"}, status_code=413)(scope, receive, send)
        acquired = False
        if multipart:
            try:
                await asyncio.wait_for(self.uploads.acquire(), timeout=0.25)
                acquired = True
            except TimeoutError:
                return await JSONResponse({"detail": "Uploads are busy; retry shortly"}, status_code=429,
                                          headers={"Retry-After": "1"})(scope, receive, send)
        consumed = 0
        started = False

        async def bounded_receive():
            nonlocal consumed
            message = await receive()
            if message["type"] == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > limit:
                    raise HTTPException(status_code=413, detail="Request body exceeds the size limit")
            return message

        async def track_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            content_type = headers.get(b"content-type", b"").split(b";", 1)[0].strip().lower()
            if content_type == b"application/json" or content_type.endswith(b"+json"):
                # Python's default JSON decoder accepts NaN/Infinity and turns
                # finite-looking exponents such as 1e999 into infinity. Reject
                # these before any route can persist a non-serializable record.
                # Replay the exact bytes, preserving signed-webhook bodies.
                chunks = []
                while True:
                    message = await bounded_receive()
                    if message["type"] == "http.disconnect":
                        return
                    chunks.append(message.get("body", b""))
                    if not message.get("more_body", False):
                        break
                body = b"".join(chunks)
                if body:
                    try:
                        json.loads(body, parse_float=_finite_json_float, parse_constant=_reject_json_constant)
                    except (ValueError, UnicodeError, RecursionError):
                        return await JSONResponse({"detail": [{"loc": ["body"], "type": "json_invalid",
                            "msg": "Invalid JSON or non-finite number"}]}, status_code=422)(scope, receive, send)
                replayed = False

                async def json_receive():
                    nonlocal replayed
                    if not replayed:
                        replayed = True
                        return {"type": "http.request", "body": body, "more_body": False}
                    return await receive()

                return await self.app(scope, json_receive, track_send)
            await self.app(scope, bounded_receive, track_send)
        except HTTPException as exc:
            if started or exc.status_code != 413:
                raise
            await JSONResponse({"detail": exc.detail}, status_code=413)(scope, receive, send)
        finally:
            if acquired:
                self.uploads.release()
