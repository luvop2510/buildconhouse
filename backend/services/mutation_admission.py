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


@asynccontextmanager
async def admission(database, *, exclusive=False):
    gate = database.settings
    await gate.update_one({"_id": KEY}, {"$setOnInsert": {"writers": [], "exclusive": None}}, upsert=True)
    token = str(uuid4())
    query = {"_id": KEY, "exclusive": None}
    update = {"$addToSet": {"writers": token}}
    if exclusive:
        query["writers"] = []
        update = {"$set": {"exclusive": token}}
    result = await gate.update_one(query, update)
    # Briefly wait for ordinary in-flight saves; never expire a writer token.
    if exclusive:
        for _ in range(40):
            if result.matched_count:
                break
            await asyncio.sleep(0.1)
            result = await gate.update_one(query, update)
    if not result.matched_count:
        raise HTTPException(409, "Another operation is still saving. Please try again.")
    try:
        yield
    finally:
        # A canceled request must release only its own token. If the process
        # dies before release, no unsafe deletion can bypass that token.
        if exclusive:
            await asyncio.shield(gate.update_one({"_id": KEY, "exclusive": token}, {"$set": {"exclusive": None}}))
        else:
            await asyncio.shield(gate.update_one({"_id": KEY}, {"$pull": {"writers": token}}))


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
            r"/api/(?:categories/[^/]+|products/[^/]+(?:/variants)?|customers/[^/]+|walkins/[^/]+|payments/[^/]+|godown-stock/[^/]+(?:/movements/[^/]+)?|purchase-orders/[^/]+|quotations/(?:[^/]+|client-draft/[^/]+))", scope["path"],
        )))
        try:
            async with admission(db, exclusive=exclusive):
                await self.app(scope, receive, send)
        except HTTPException as error:
            await JSONResponse({"detail": error.detail}, status_code=error.status_code)(scope, receive, send)
