"""Fence destructive snapshots against their conflicting writers across replicas.

Existing v1 owners still honor the exclusive field. Every new scoped delete
holds a marker there so older runtimes cannot admit a write mid-delete. New
runtimes check the actual scope. Unknown legacy tokens stay conservative.
"""
from contextlib import asynccontextmanager
import asyncio
from datetime import datetime, timezone
import hashlib
import logging
import os
from uuid import uuid4
from fastapi import HTTPException
from pymongo.errors import ConnectionFailure, ExecutionTimeout, PyMongoError, WriteConcernError
from pymongo.write_concern import WriteConcern

from services.mutation_scopes import classify_http_mutation, is_mutating_read

KEY = "customer-graph-mutation-admission:v1"
SCOPED_EXCLUSIVE = "scoped-deletion:v2"
PROCESS_ID = str(uuid4())
logger = logging.getLogger("forge.mutation_admission")
_release_tasks = set()
_UNCERTAIN_WRITES = (ConnectionFailure, ExecutionTimeout, WriteConcernError)


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
            "exclusive": describe(gate["exclusive"], gate.get("exclusive_info", {}))
            if gate.get("exclusive") and gate["exclusive"] != SCOPED_EXCLUSIVE else None,
            "scoped_deletions": [describe(entry["token"], entry) for entry in gate.get("scoped_exclusives", [])]}


def http_operation(scope):
    # Do not persist URLs, IDs, query strings, headers, bodies or customer data.
    resource = scope.get("path", "").split("/")[2:3]
    resource = resource[0] if resource else "other"
    if resource not in {"kitchen-projects", "kitchen-customer-deletion", "customers", "quotations", "payments",
                        "walkins", "purchase-orders", "godown-stock", "tile-orders", "settings", "auth",
                        "products", "categories", "followups", "referrers", "uploads"}:
        resource = "other"
    method = scope.get("method", "")
    method = method if method in {"GET", "POST", "PUT", "PATCH", "DELETE"} else "other"
    return f"http:{method}:{resource}"


class AdmissionBusy(HTTPException):
    def __init__(self):
        super().__init__(409, "Another operation is changing this record or linked data. Finish that operation, then try again.")


class AdmissionUnavailable(HTTPException):
    def __init__(self):
        super().__init__(503, "The database could not start this operation. Please try again.")


def _scope_overlaps(scope, other):
    if scope is None:
        return {"$literal": True}
    overlap = [{"$eq": [{"$type": other}, "missing"]}]
    for resource, identity in scope.items():
        value = f"{other}.{resource}"
        declared = {"$ne": [{"$type": value}, "missing"]}
        if identity is not None:
            declared = {"$and": [declared, {"$in": [value, [None, identity]]}]}
        overlap.append(declared)
    return {"$or": overlap}


def _no_scoped_exclusive_conflict(scope):
    return {"$not": [{"$anyElementTrue": [{"$map": {
        "input": {"$ifNull": ["$scoped_exclusives", []]},
        "as": "entry", "in": _scope_overlaps(scope, "$$entry.scope"),
    }}]}]}


def _no_writer_conflict(scope):
    writers = {"$ifNull": ["$writers", []]}
    entries = {"$filter": {
        "input": {"$objectToArray": {"$ifNull": ["$writer_info", {}]}},
        "as": "entry", "cond": {"$in": ["$$entry.k", writers]},
    }}
    return {"$let": {"vars": {"entries": entries}, "in": {"$and": [
        # Legacy writer tokens without scope or metadata can still be live.
        {"$eq": [{"$size": "$$entries"}, {"$size": writers}]},
        {"$not": [{"$anyElementTrue": [{"$map": {
            "input": "$$entries", "as": "entry", "in": _scope_overlaps(scope, "$$entry.v.scope"),
        }}]}]},
    ]}}}


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


async def _release_token(gate, query, update, token, uncertain_claim):
    if uncertain_claim:
        # A driver timeout does not prove that Mongo rejected the claim. Fence
        # this exact reservation so a late server write cannot recreate it.
        await gate.update_one({"_id": KEY}, {"$addToSet": {"cancelled_claims": token}})
    await gate.update_one(query, update)


async def _release_when_database_recovers(gate, query, update, token, uncertain_claim):
    # The write itself is idempotent and matches only our token. A transient
    # connection failure must not strand a token for the lifetime of a worker.
    seconds = 1
    while True:
        try:
            await _release_token(gate, query, update, token, uncertain_claim)
            return
        except PyMongoError:
            logger.warning("Mutation token cleanup will retry: fingerprint=%s", token_fingerprint(token))
            await asyncio.sleep(seconds)
            seconds = min(seconds * 2, 30)


@asynccontextmanager
async def admission(database, *, exclusive=False, operation="unclassified", scope=None):
    gate = database.settings.with_options(write_concern=WriteConcern("majority"))
    try:
        await gate.update_one({"_id": KEY}, {"$setOnInsert": {"writers": [], "exclusive": None}}, upsert=True)
    except _UNCERTAIN_WRITES as error:
        raise AdmissionUnavailable() from error
    token = str(uuid4())
    metadata = {"operation": operation, "process_id": PROCESS_ID,
                "deployment_id": os.environ.get("RAILWAY_DEPLOYMENT_ID", "local"),
                "started_at": datetime.now(timezone.utc).isoformat()}
    if scope is not None:
        metadata["scope"] = scope
    query = {"_id": KEY, "$or": [{"exclusive": None},
             {"exclusive": SCOPED_EXCLUSIVE, "scoped_exclusives.0": {"$exists": True}}],
             "$expr": _no_scoped_exclusive_conflict(scope)}
    update = {"$addToSet": {"writers": token}, "$set": {f"writer_info.{token}": metadata}}
    release_query = {"_id": KEY, "writers": token}
    release = {"$pull": {"writers": token}, "$unset": {f"writer_info.{token}": ""}}
    if exclusive and scope is not None:
        query["$expr"] = {"$and": [query["$expr"], _no_writer_conflict(scope)]}
        update = {"$set": {"exclusive": SCOPED_EXCLUSIVE},
                  "$push": {"scoped_exclusives": {**metadata, "token": token}}}
        release_query = {"_id": KEY, "exclusive": SCOPED_EXCLUSIVE, "scoped_exclusives.token": token}
        release = [{"$set": {"scoped_exclusives": {"$filter": {
            "input": "$scoped_exclusives", "as": "entry", "cond": {"$ne": ["$$entry.token", token]},
        }}}}, {"$set": {"exclusive": {"$cond": [
            {"$gt": [{"$size": "$scoped_exclusives"}, 0]}, SCOPED_EXCLUSIVE, None,
        ]}}}]
    elif exclusive:
        # Global operators and maintenance still have the v1 contract.
        query = {"_id": KEY, "exclusive": None, "writers": []}
        update = {"$set": {"exclusive": token, "exclusive_info": metadata}}
        release_query = {"_id": KEY, "exclusive": token}
        release = {"$set": {"exclusive": None}, "$unset": {"exclusive_info": ""}}

    query["cancelled_claims"] = {"$ne": token}
    needs_release = False
    uncertain_claim = False
    try:
        # The driver may finish the reservation after caller cancellation.
        # Let that write settle before attempting exact-token cleanup.
        for attempt in range(41 if exclusive and scope is None else 1):
            if attempt:
                await asyncio.sleep(0.1)
            needs_release = True
            try:
                result = await finish_on_cancel(gate.update_one(query, update))
            except _UNCERTAIN_WRITES as error:
                uncertain_claim = True
                raise AdmissionUnavailable() from error
            if result.matched_count:
                break
            needs_release = False
        else:
            raise AdmissionBusy()
        yield
    finally:
        if needs_release:
            try:
                await finish_on_cancel(_release_token(gate, release_query, release, token, uncertain_claim))
            except PyMongoError as error:
                logger.error("Mutation token cleanup failed: fingerprint=%s process=%s operation=%s error_type=%s",
                             token_fingerprint(token), PROCESS_ID, operation, type(error).__name__)
                job = asyncio.create_task(_release_when_database_recovers(gate, release_query, release, token, uncertain_claim))
                _release_tasks.add(job)
                job.add_done_callback(_release_tasks.discard)


class MutationAdmissionMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            return await self.app(scope, receive, send)
        if scope["method"] in {"GET", "HEAD", "OPTIONS"} and not is_mutating_read(scope):
            return await self.app(scope, receive, send)
        from db import db
        from starlette.responses import JSONResponse
        exclusive, mutation_scope = classify_http_mutation(scope)
        ending = None

        async def send_before_release(message):
            nonlocal ending
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                ending = message
            else:
                await send(message)

        try:
            async with admission(db, exclusive=exclusive, operation=http_operation(scope), scope=mutation_scope):
                await finish_on_cancel(self.app(scope, receive, send_before_release))
            # An immediate delete after a confirmed save must observe the
            # released admission. Earlier streaming frames still pass through.
            if ending is not None:
                await send(ending)
        except AdmissionBusy as error:
            detail = error.detail
            reason = "conflicting_mutation"
            try:
                status = await admission_status(db)
                logger.warning("Mutation admission blocked: operation=%s gate=%s", http_operation(scope), status)
                if ((exclusive and any(not entry["owner_known"] for entry in status["writers"]))
                        or (status["exclusive"] and not status["exclusive"]["owner_known"])):
                    reason = "unverified_legacy_operation"
                    detail = "This operation is paused while an earlier database write is checked. Ask an administrator to review it."
            except Exception:
                logger.warning("Mutation admission blocked: operation=%s; gate diagnostics unavailable", http_operation(scope))
            await JSONResponse({"detail": detail, "code": "mutation_admission_busy", "reason": reason}, status_code=error.status_code)(scope, receive, send)
        except HTTPException as error:
            await JSONResponse({"detail": error.detail}, status_code=error.status_code)(scope, receive, send)
