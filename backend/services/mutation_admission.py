"""Distributed admission for short, exclusive customer/quotation deletion.

Ordinary HTTP mutations and automation may overlap each other. Destructive
snapshot cleanup may start only when all admitted writers have finished. Tokens
never expire: a paused/crashed writer cannot silently resume after its lease.
A crash therefore blocks deletion safely until an operator reconciles admission.
"""
from contextlib import asynccontextmanager
import asyncio
from uuid import uuid4
from fastapi import HTTPException

KEY = "customer-graph-mutation-admission:v1"


class AdmissionBusy(HTTPException):
    def __init__(self):
        super().__init__(409, "A write is still pending. Wait a moment and try again.")


async def finish_on_cancel(operation):
    """Let an admitted operation settle before the caller can release its token."""
    task = asyncio.ensure_future(operation)
    cancelled = False
    while True:
        try:
            result = await asyncio.shield(task)
        except asyncio.CancelledError:
            if task.cancelled():
                raise
            cancelled = True
        else:
            if cancelled:
                raise asyncio.CancelledError
            return result


@asynccontextmanager
async def admission(database, *, exclusive=False):
    gate = database.settings
    await gate.update_one({"_id": KEY}, {"$setOnInsert": {"writers": [], "exclusive": None}}, upsert=True)
    token = str(uuid4())
    query = {"_id": KEY, "exclusive": None}
    update = {"$addToSet": {"writers": token}}
    release_query = {"_id": KEY, "writers": token}
    release = {"$pull": {"writers": token}}
    if exclusive:
        query["writers"] = []
        update = {"$set": {"exclusive": token}}
        release_query = {"_id": KEY, "exclusive": token}
        release = {"$set": {"exclusive": None}}

    needs_release = False
    try:
        # The driver may finish the reservation after caller cancellation.
        # Let that write settle before attempting exact-token cleanup.
        for attempt in range(41 if exclusive else 1):
            if attempt:
                await asyncio.sleep(0.1)
            needs_release = True
            result = await finish_on_cancel(gate.update_one(query, update))
            if result.matched_count:
                break
            needs_release = False
        else:
            raise AdmissionBusy()
        yield
    finally:
        if needs_release:
            await finish_on_cancel(gate.update_one(release_query, release))


class MutationAdmissionMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        import re
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/") or scope.get("method") in {"GET", "HEAD", "OPTIONS"}:
            return await self.app(scope, receive, send)
        from db import db
        from starlette.responses import JSONResponse
        exclusive = (scope["method"] == "POST" and scope["path"] == "/api/customers/floor-reset") or (scope["method"] == "DELETE" and bool(re.fullmatch(
            r"/api/(?:categories/[^/]+|products/[^/]+(?:/variants)?|customers/[^/]+|kitchen-customer-deletion/[^/]+|walkins/[^/]+|payments/[^/]+|godown-stock/[^/]+(?:/movements/[^/]+)?|purchase-orders/[^/]+|quotations/(?:[^/]+|client-draft/[^/]+))", scope["path"],
        )))
        try:
            async with admission(db, exclusive=exclusive):
                await finish_on_cancel(self.app(scope, receive, send))
        except AdmissionBusy as error:
            await JSONResponse({"detail": error.detail, "code": "mutation_admission_busy"}, status_code=error.status_code)(scope, receive, send)
        except HTTPException as error:
            await JSONResponse({"detail": error.detail}, status_code=error.status_code)(scope, receive, send)
