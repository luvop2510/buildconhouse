"""Manager review remains bound to exact row content and an atomic version."""
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import HTTPException
import pytest

from models import UserPublic
from routes import catalog_import_routes as routes
from services import catalog_import_jobs as jobs


def user():
    return UserPublic(id="purchase", email="purchase@example.com", full_name="Purchase", role="purchase", floor_ids=["first-floor"], active_floor_id="first-floor")


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["worker", "purchase", "accounts"])
async def test_custom_grants_do_not_bypass_manager_approval(role):
    staff = user().model_copy(update={"role": role, "custom_access": True})
    with pytest.raises(HTTPException) as rejected:
        await routes._require_import_approver(staff)
    assert rejected.value.status_code == 403


@pytest.mark.asyncio
async def test_manager_remains_eligible_for_review():
    staff = user().model_copy(update={"role": "manager"})
    assert await routes._require_import_approver(staff) is staff


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["processing", "imported"])
async def test_edit_rejected_after_review_claim(monkeypatch, status):
    collection = SimpleNamespace(find_one=AsyncMock(return_value={"id": "job", "status": status, "rows": [{"row_id": "row", "mrp": 100}]}), update_one=AsyncMock())
    monkeypatch.setattr(routes, "db", SimpleNamespace(catalog_imports=collection))
    with pytest.raises(HTTPException) as rejected:
        await routes.update_row("job", "row", {"mrp": 1}, user())
    assert rejected.value.status_code == 409
    collection.update_one.assert_not_awaited()


@pytest.mark.asyncio
async def test_edit_loses_race_to_manager_claim(monkeypatch):
    collection = SimpleNamespace(find_one=AsyncMock(return_value={"id": "job", "status": "classified", "rows_version": 4, "rows": [{"row_id": "row", "mrp": 100}]}), update_one=AsyncMock(return_value=SimpleNamespace(modified_count=0)))
    monkeypatch.setattr(routes, "db", SimpleNamespace(catalog_imports=collection))
    with pytest.raises(HTTPException) as rejected:
        await routes.update_row("job", "row", {"mrp": 1}, user())
    assert rejected.value.status_code == 409
    query = collection.update_one.call_args.args[0]
    base = query["$and"][1] if "$and" in query else query
    assert base["rows_version"] == 4 and "processing" not in base["status"]["$in"]


@pytest.mark.asyncio
async def test_approval_freezes_content_and_checks_reviewed_version(monkeypatch):
    claim = AsyncMock(return_value={"status": "processing"})
    monkeypatch.setattr(jobs, "db", SimpleNamespace(catalog_imports=SimpleNamespace(find_one_and_update=claim)))
    reviewed = {"rows_version": 7, "rows": [{"row_id": "row", "mrp": 100, "status": "accepted"}]}
    await jobs.claim_for_processing("job", {"id": "job", "floor_id": "first-floor"}, reviewed_job=reviewed, actor_id="manager")
    query, update = claim.call_args.args
    assert query["rows_version"] == 7
    assert update["$set"]["approved_version"] == 7
    reviewed["rows"][0]["mrp"] = 1
    assert update["$set"]["approved_rows"][0]["mrp"] == 100


@pytest.mark.asyncio
async def test_snapshot_document_size_rejected_before_approval_write(monkeypatch):
    monkeypatch.setattr(jobs, "MAX_CATALOG_DOCUMENT_BYTES", 10_000)
    claim = AsyncMock()
    monkeypatch.setattr(jobs, "db", SimpleNamespace(catalog_imports=SimpleNamespace(find_one_and_update=claim)))
    reviewed = {"rows_version": 0, "rows": [{"row_id": "row", "description": "a" * 6_000}]}
    jobs.ensure_catalog_document_size(reviewed)
    with pytest.raises(HTTPException) as rejected:
        await jobs.claim_for_processing("job", {"id": "job"}, reviewed_job=reviewed, actor_id="manager")
    assert rejected.value.status_code == 413
    claim.assert_not_awaited()


def test_worker_rejects_tampered_live_content_and_keeps_frozen_approval():
    approved = [{"row_id": "row", "mrp": 100, "status": "accepted"}]
    job = {"approved_rows": deepcopy(approved), "rows": [{"row_id": "row", "mrp": 1, "status": "rejected", "import_state": "succeeded"}]}
    rows = jobs.approved_work_rows(job)
    assert rows[0]["mrp"] == 100 and rows[0]["status"] == "accepted"
    assert rows[0]["import_state"] == "succeeded"
    rows[0]["mrp"] = 0
    assert job["approved_rows"] == approved


def test_unapproved_legacy_worker_fails_closed():
    with pytest.raises(ValueError, match="reapproved"):
        jobs.approved_work_rows({"rows": [{"status": "accepted"}]})


def test_error_outcome_budget_counts_utf8_bytes():
    rows = [{"row_id": "row"}]
    jobs.apply_batch_result(rows, {"attempted_row_ids": ["row"], "errors": [{"row_id": "row", "error": "😀" * 160}]})
    assert len(rows[0]["import_error"].encode("utf-8")) <= 160


@pytest.mark.asyncio
async def test_permanently_failed_row_terminates_job_instead_of_looping(monkeypatch):
    row = {"row_id": "bad", "status": "accepted", "mrp": 100}
    job = {"id": "job", "status": "processing", "approved_version": 0, "approved_rows": [deepcopy(row)], "rows": [deepcopy(row)]}
    async def fetch(query, projection):
        return deepcopy(job)
    async def update(query, operation):
        job.update(deepcopy(operation["$set"]))
    monkeypatch.setattr(jobs, "db", SimpleNamespace(catalog_imports=SimpleNamespace(find_one=fetch, update_one=update)))
    importer = AsyncMock(return_value={"attempted_row_ids": ["bad"], "errors": [{"row_id": "bad", "error": "invalid image"}]})
    monkeypatch.setattr(jobs, "import_accepted", importer)
    monkeypatch.setattr(jobs.catalog_service, "schedule_catalog_refresh", lambda: None)
    await jobs._run("job", "manager")
    importer.assert_awaited_once()
    assert job["status"] == "partial_failed" and job["import_progress"]["failed"] == 1


@pytest.mark.asyncio
async def test_background_failure_does_not_log_exception_text(monkeypatch, caplog):
    secret = "https://private.invalid/file?token=private-customer-secret"
    collection = SimpleNamespace(find_one=AsyncMock(side_effect=RuntimeError(secret)), update_one=AsyncMock())
    monkeypatch.setattr(jobs, "db", SimpleNamespace(catalog_imports=collection))
    await jobs._run("safe-job-id", "manager")
    assert secret not in caplog.text and "private-customer-secret" not in caplog.text
    assert "RuntimeError" in caplog.text and "safe-job-id" in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


@pytest.mark.asyncio
async def test_blob_failure_does_not_log_private_storage_url(monkeypatch, caplog):
    from catalog_pipeline import orchestrator
    secret = "https://private.invalid/file?token=private-customer-secret"
    blobs = SimpleNamespace(find_one=AsyncMock(return_value={"bucket": "private", "storage_key": "private-key", "mime": "image/png"}))
    monkeypatch.setattr(orchestrator, "db", SimpleNamespace(catalog_image_blobs=blobs))
    monkeypatch.setattr(orchestrator, "get_media_storage", lambda: SimpleNamespace(download=AsyncMock(side_effect=RuntimeError(secret))))
    assert await orchestrator._resolve_blob("blob:0123456789abcdef") is None
    assert secret not in caplog.text and "private-customer-secret" not in caplog.text
    assert "RuntimeError" in caplog.text
