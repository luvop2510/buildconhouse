"""Distributed admission for short, exclusive customer/quotation deletion.

Ordinary HTTP mutations and automation may overlap each other. Destructive
snapshot cleanup may start only when all admitted writers have finished. Tokens
never expire: a paused/crashed writer cannot silently resume after its lease.
A crash therefore blocks deletion safely until an operator reconciles admission.
"""
from contextlib import asynccontextmanager
import asyncio
from datetime import datetime, timezone
import hashlib
import logging
import os
from uuid import uuid4
from fastapi import HTTPException

KEY = "customer-graph-mutation-admission:v1"
PROCESS_ID = str(uuid4())
logger = logging.getLogger("forge.mutation_admission")


def token_fingerprint(token):
    return hashlib.sha256(token.encode()).hexdigest()[:12]


async def admission_status(database):
    """Read-only diagnostics. Never infer abandonment from a token's age."""
    gate = await database.settings.find_one({"_id": KEY}) or {}
    now = datetime.now(timezone.utc)

    def describe(token, metadata):
        result = {"fingerprint": token_fingerprint(token), "owner_known": bool(metadata)}
        for key in ("operation", "process_id", "deployment_id", "started_at"):
            if key in metadata:
                result[key] = metadata[key]
        try:
            result["age_seconds"] = max(0, int((now - datetime.fromisoformat(metadata["started_at"])).total_seconds()))
        except (KeyError, TypeError, ValueError):
            result["age_seconds"] = None
        return result

    info = gate.get("writer_info", {})
    return {"sampled_at": now.isoformat(), "writer_count": len(gate.get("writers", [])),
            "writers": [describe(token, info.get(token, {})) for token in gate.get("writers", [])],
            "exclusive": describe(gate["exclusive"], gate.get("exclusive_info", {})) if gate.get("exclusive") else None}


def http_operation(scope):
    # Do not persist URLs, IDs, query strings, headers, bodies or customer data.
    resource = scope.get("path", "").split("/")[2:3]
    resource = resource[0] if resource else "other"
    if resource not in {"kitchen-projects", "kitchen-customer-deletion", "customers", "quotations", "payments",
                        "walkins", "purchase-orders", "godown-stock", "tile-orders", "settings", "auth",
                        "products", "categories", "followups", "referrers", "uploads"}:
        resource = "other"
    method = scope.get("method", "")
    method = method if method in {"POST", "PUT", "PATCH", "DELETE"} else "other"
    return f"http:{method}:{resource}"


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
async def admission(database, *, exclusive=False, operation="unclassified"):
    gate = database.settings
    await gate.update_one({"_id": KEY}, {"$setOnInsert": {"writers": [], "exclusive": None}}, upsert=True)
    token = str(uuid4())
    metadata = {"operation": operation, "process_id": PROCESS_ID,
                "deployment_id": os.environ.get("RAILWAY_DEPLOYMENT_ID", "local"),
                "started_at": datetime.now(timezone.utc).isoformat()}
    query = {"_id": KEY, "exclusive": None}
    update = {"$addToSet": {"writers": token}, "$set": {f"writer_info.{token}": metadata}}
    release_query = {"_id": KEY, "writers": token}
    release = {"$pull": {"writers": token}, "$unset": {f"writer_info.{token}": ""}}
    if exclusive:
        query["writers"] = []
        update = {"$set": {"exclusive": token, "exclusive_info": metadata}}
        release_query = {"_id": KEY, "exclusive": token}
        release = {"$set": {"exclusive": None}, "$unset": {"exclusive_info": ""}}

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
            try:
                await finish_on_cancel(gate.update_one(release_query, release))
            except Exception as error:
                logger.error("Mutation token cleanup failed: fingerprint=%s process=%s operation=%s error_type=%s",
                             token_fingerprint(token), PROCESS_ID, operation, type(error).__name__)
                raise


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
        # Kitchen uses recoverable tombstones and its transactional policy/
        # customer/project fence. Keep shared global admission to exclude hard
        # graph cleanup, without draining unrelated or abandoned global writers.
        headers = dict(scope.get("headers", []))
        if (exclusive and scope["method"] == "DELETE" and headers.get(b"x-floor-id") == b"second-floor"
                and re.fullmatch(r"/api/customers/[^/]+", scope["path"])):
            exclusive = False
        try:
            async with admission(db, exclusive=exclusive, operation=http_operation(scope)):
                await finish_on_cancel(self.app(scope, receive, send))
        except AdmissionBusy as error:
            try:
                logger.warning("Mutation admission blocked: operation=%s gate=%s", http_operation(scope), await admission_status(db))
            except Exception:
                logger.warning("Mutation admission blocked: operation=%s; gate diagnostics unavailable", http_operation(scope))
            await JSONResponse({"detail": error.detail, "code": "mutation_admission_busy"}, status_code=error.status_code)(scope, receive, send)
        except HTTPException as error:
            await JSONResponse({"detail": error.detail}, status_code=error.status_code)(scope, receive, send)
