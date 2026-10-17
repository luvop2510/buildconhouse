"""Bound incoming bodies before FastAPI parses JSON or spools multipart files."""
import asyncio
from re import fullmatch

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse


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
        headers = dict(scope.get("headers", []))
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
            await self.app(scope, bounded_receive, track_send)
        except HTTPException as exc:
            if started or exc.status_code != 413:
                raise
            await JSONResponse({"detail": exc.detail}, status_code=413)(scope, receive, send)
        finally:
            if acquired:
                self.uploads.release()
