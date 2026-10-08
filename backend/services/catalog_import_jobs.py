"""Durable, bounded catalog-import approval jobs.

The Mongo document is the source of truth: a process crash leaves a job in a
resumable state and successful rows are never selected again.  Workers are
deliberately in-process (there is no queue service in this deployment), so the
API exposes explicit resume/retry operations and never claims distributed
exactly-once delivery.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
import logging
from datetime import datetime, timezone
from typing import Any
from bson import BSON
from bson.errors import InvalidDocument
from fastapi import HTTPException
from pymongo import ReturnDocument

from catalog_pipeline.orchestrator import import_accepted
from db import db
from services import catalog_service

logger = logging.getLogger("forge.catalog_import.jobs")
MAX_CONCURRENT_IMPORT_JOBS = 2
ROW_BATCH_SIZE = 20
MAX_CATALOG_DOCUMENT_BYTES = 16 * 1024 * 1024 - 64 * 1024
ROW_OUTCOME_RESERVE_BYTES = 384
_workers = asyncio.Semaphore(MAX_CONCURRENT_IMPORT_JOBS)
_scheduled: set[str] = set()


def ensure_catalog_document_size(document: dict, *, reserve_bytes: int = 0) -> None:
    """Fail before Mongo writes, reserving space for bounded processing outcomes."""
    try:
        size = len(BSON.encode(document))
    except (InvalidDocument, OverflowError, ValueError):
        raise HTTPException(status_code=413, detail="Catalog import exceeds the supported document size") from None
    if size + reserve_bytes > MAX_CATALOG_DOCUMENT_BYTES:
        raise HTTPException(status_code=413, detail="Catalog import is too large for approval; split the supplier file into smaller imports")


def pending_rows(rows: list[dict]) -> list[dict]:
    """Return accepted rows that have not completed successfully."""
    return [r for r in rows if r.get("status") == "accepted" and r.get("import_state") != "succeeded"]


def row_version_query(doc: dict) -> dict:
    """Legacy review jobs start at version zero; every new edit increments it."""
    version = int(doc.get("rows_version") or 0)
    if "rows_version" not in doc:
        return {"rows_version": {"$exists": False}}
    return {"rows_version": version}


def approved_work_rows(job: dict) -> list[dict]:
    """Keep manager-approved content immutable while recording row outcomes."""
    if "approved_rows" not in job:
        raise ValueError("Catalog job must be reapproved before processing")
    outcomes = {str(row.get("row_id")): row for row in job.get("rows", [])}
    rows = deepcopy(job["approved_rows"])
    for row in rows:
        outcome = outcomes.get(str(row.get("row_id")), {})
        for key in ("import_state", "import_error", "imported_at"):
            if key in outcome:
                row[key] = outcome[key]
    return rows


def apply_batch_result(rows: list[dict], result: dict) -> tuple[int, int]:
    """Record terminal per-row results without changing the reviewer decision."""
    failures = {str(e.get("row_id")): str(e.get("error") or "Import failed").encode("utf-8")[:160].decode("utf-8", errors="ignore") for e in result.get("errors", [])}
    attempted = set(result.get("attempted_row_ids") or [])
    succeeded = 0
    failed = 0
    for row in rows:
        row_id = str(row.get("row_id"))
        if row_id not in attempted:
            continue
        if row_id in failures:
            row.update({"import_state": "failed", "import_error": failures[row_id], "imported_at": None})
            failed += 1
        else:
            row.update({"import_state": "succeeded", "import_error": None, "imported_at": datetime.now(timezone.utc).isoformat()})
            succeeded += 1
    return succeeded, failed


async def enqueue(job_id: str, actor_id: str) -> None:
    """Schedule at most one local worker per job; persisted status enables resume."""
    if job_id in _scheduled:
        return
    _scheduled.add(job_id)
    asyncio.create_task(_run(job_id, actor_id), name=f"catalog-import-{job_id}")


async def _run(job_id: str, actor_id: str) -> None:
    try:
        async with _workers:
            attempted_this_run: set[str] = set()
            while True:
                job = await db.catalog_imports.find_one({"id": job_id}, {"_id": 0})
                if not job or job.get("status") != "processing":
                    return
                rows = approved_work_rows(job)
                claim = {"id": job_id, "status": "processing", "approved_version": job["approved_version"]}
                batch = [row for row in pending_rows(rows) if str(row.get("row_id")) not in attempted_this_run][:ROW_BATCH_SIZE]
                if not batch:
                    failures = sum(1 for row in rows if row.get("import_state") == "failed")
                    await db.catalog_imports.update_one(claim, {"$set": {
                        "status": "partial_failed" if failures else "imported",
                        "import_finished_at": datetime.now(timezone.utc).isoformat(),
                        "import_progress": {"completed": sum(row.get("import_state") == "succeeded" for row in rows), "failed": failures, "total": len([r for r in rows if r.get("status") == "accepted"])},
                    }})
                    catalog_service.schedule_catalog_refresh()
                    return
                attempted_this_run.update(str(row.get("row_id")) for row in batch)
                result = await import_accepted({**job, "rows": batch}, actor_id, floor_id=job.get("floor_id"))
                apply_batch_result(rows, result)
                completed = sum(row.get("import_state") == "succeeded" for row in rows)
                failed = sum(row.get("import_state") == "failed" for row in rows)
                await db.catalog_imports.update_one(claim, {"$set": {
                    "rows": rows,
                    "import_progress": {"completed": completed, "failed": failed, "total": len([r for r in rows if r.get("status") == "accepted"])},
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }})
    except Exception as exc:  # leave completed rows persisted; retry endpoint can resume safely
        logger.warning("Catalog import job failed job=%s error_type=%s", job_id, type(exc).__name__)
        await db.catalog_imports.update_one({"id": job_id, "status": "processing"}, {"$set": {"status": "failed", "error": "Background import interrupted; retry failed rows or resume the job."}})
    finally:
        _scheduled.discard(job_id)


async def claim_for_processing(job_id: str, floor_filter: dict[str, Any], *, reviewed_job: dict, actor_id: str, rows: list[dict] | None = None) -> dict | None:
    """Atomically claim an eligible job so duplicate approve requests get no work."""
    query = dict(floor_filter)
    query["status"] = {"$in": ["classified", "reviewed", "partial_failed", "failed"]}
    query.update(row_version_query(reviewed_job))
    approved = deepcopy(rows if rows is not None else reviewed_job.get("rows", []))
    changes = {"status": "processing", "error": None, "import_started_at": datetime.now(timezone.utc).isoformat(),
               "rows": approved, "approved_rows": approved, "approved_version": int(reviewed_job.get("rows_version") or 0), "approved_by": actor_id}
    ensure_catalog_document_size({**reviewed_job, **changes}, reserve_bytes=len(approved) * ROW_OUTCOME_RESERVE_BYTES)
    return await db.catalog_imports.find_one_and_update(
        query,
        {"$set": changes},
        return_document=ReturnDocument.AFTER,
    )
