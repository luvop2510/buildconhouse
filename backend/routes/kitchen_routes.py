"""Connected Kitchen projects. Every route reuses current staff authentication."""
from __future__ import annotations

import json
import os

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Form, UploadFile, File, Response
from typing import Annotated
from urllib.parse import quote

from auth import get_current_user, floor_for_write
from db import db
from models import UserPublic
from models_kitchen import ConfigurePolicy, CreateProject, ProjectCommand, Stage, date_only, CommandKey
from services.kitchen_projects import KitchenProjectService
from services.analytics import cache
from services.kitchen_file_transfers import KitchenFileTransfers, TransferStart, TransferChunk, TransferFinish

# Delegated accounts are already checked for the exact floor/page/action by
# get_current_user. Legacy role labels alone must not open this launch.
async def require_kitchen_launch_access(user: UserPublic = Depends(get_current_user)):
    if os.environ.get("FORGE_KITCHEN_OWNER_ONLY", "false").lower() == "true" and user.role != "owner" and not user.custom_access:
        raise HTTPException(403, "Kitchen is currently available to the owner only")


router = APIRouter(prefix="/kitchen-projects", tags=["kitchen-projects"],
                   dependencies=[Depends(require_kitchen_launch_access)])


@router.get("/customers")
async def customers(search: str = Query("", max_length=250), page: int = Query(1, ge=1, le=100000),
                    limit: int = Query(50, ge=1, le=100), user: UserPublic = Depends(get_current_user)):
    return await KitchenProjectService(db).customers(user, search=search, page=page, limit=limit)


@router.get("/assignees")
async def assignees(user: UserPublic = Depends(get_current_user)):
    return await KitchenProjectService(db).assignees(user)


@router.get("/duplicate-candidates")
async def duplicates(customer_id: str = Query(min_length=1, max_length=128), user: UserPublic = Depends(get_current_user)):
    return {"rows": await KitchenProjectService(db).duplicates(user, customer_id)}


@router.get("/configuration")
async def configuration(user: UserPublic = Depends(get_current_user)):
    return await KitchenProjectService(db).public_policy(user)


@router.put("/configuration")
async def configure(body: ConfigurePolicy, user: UserPublic = Depends(get_current_user)):
    return await KitchenProjectService(db).configure(user, body)


@router.get("")
async def list_projects(search: str = Query("", max_length=250), stage: Stage | None = None,
                        status: str | None = Query(None, max_length=80), assignee: str | None = Query(None, max_length=128),
                        date_from: str | None = None, date_to: str | None = None,
                        date_field: Literal["created_at", "deadline", "target_completion_date", "completion_date"] = "created_at",
                        sort: Literal["updated_at", "created_at", "reference", "customer", "stage", "status", "assignee", "order_amount", "target_completion_date", "next_action", "deadline"] = "updated_at",
                        direction: Literal["asc", "desc"] = "desc", page: int = Query(1, ge=1, le=100000),
                        limit: int = Query(50, ge=1, le=100), completed: bool | None = None,
                        duplicate_review: Literal["pending"] | None = None,
                        attention: Literal["active", "on_hold", "pending_approval", "next_action_overdue", "completion_overdue", "active_order"] | None = None,
                        user: UserPublic = Depends(get_current_user)):
    try:
        date_only(date_from)
        date_only(date_to)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if date_from and date_to and date_from > date_to:
        raise HTTPException(422, "Date range start must not follow its end")
    return await KitchenProjectService(db).list(user, search=search, stage=stage, status=status, assignee=assignee,
        date_from=date_from, date_to=date_to, date_field=date_field, sort=sort, direction=direction,
        page=page, limit=limit, completed=completed, duplicate_review=duplicate_review, attention=attention)


@router.get("/dashboard")
async def dashboard(user: UserPublic = Depends(get_current_user)):
    return await KitchenProjectService(db).dashboard(user)


@router.get("/export")
async def export_completed(search: str = Query("", max_length=250),
                           date_from: str | None = None, date_to: str | None = None,
                           assignee: str | None = Query(None, max_length=128), user: UserPublic = Depends(get_current_user)):
    try:
        date_only(date_from)
        date_only(date_to)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if date_from and date_to and date_from > date_to:
        raise HTTPException(422, "Date range start must not follow its end")
    data = await KitchenProjectService(db).export_completed(user, search=search, assignee=assignee,
        date_from=date_from, date_to=date_to, date_field="completion_date", sort="completion_date")
    return Response(data, media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="kitchen-completed.csv"',
                    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.post("")
async def create_project(body: CreateProject, user: UserPublic = Depends(get_current_user)):
    result = await KitchenProjectService(db).create(user, body)
    await cache.bump("kitchen_projects")
    return result


@router.get("/{project_id}")
async def project_detail(project_id: str, user: UserPublic = Depends(get_current_user)):
    return await KitchenProjectService(db).get(user, project_id)


@router.post("/{project_id}/commands")
async def project_command(project_id: str, body: ProjectCommand, user: UserPublic = Depends(get_current_user)):
    if floor_for_write(user) != "second-floor":
        raise HTTPException(403, "Select the Kitchen Floor for this command")
    result = await KitchenProjectService(db).command(user, project_id, body)
    await cache.bump("kitchen_projects")
    return result


@router.post("/{project_id}/attachments")
async def upload_attachment(project_id: str, expected_version: Annotated[int, Form(ge=1)],
                            idempotency_key: Annotated[CommandKey, Form()],
                            file: Annotated[UploadFile, File()], user: UserPublic = Depends(get_current_user)):
    if floor_for_write(user) != "second-floor":
        raise HTTPException(403, "Select the Kitchen Floor for this upload")
    from media_storage.factory import get_media_storage, private_bucket
    from services.kitchen_attachments import MAX_FILE_BYTES
    data = await file.read(MAX_FILE_BYTES + 1)
    try:
        return await KitchenProjectService(db).attach(user, project_id, expected_version=expected_version,
            key=idempotency_key, filename=file.filename or "", content_type=file.content_type,
            data=data, storage=get_media_storage(), bucket=private_bucket())
    finally:
        await file.close()


@router.get("/{project_id}/attachments/{attachment_id}")
async def download_attachment(project_id: str, attachment_id: str, user: UserPublic = Depends(get_current_user)):
    from media_storage.factory import get_media_storage
    data, metadata = await KitchenProjectService(db).attachment(user, project_id, attachment_id, get_media_storage())
    return Response(data, media_type=metadata["content_type"], headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(metadata['filename'])}",
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    })



@router.post("/{project_id}/file-transfers")
async def begin_file_transfer(project_id: str, body: "TransferStart", user: UserPublic = Depends(get_current_user)):
    if floor_for_write(user) != "second-floor":
        raise HTTPException(403, "Select the Kitchen Floor for file transfers")
    return await KitchenFileTransfers(db).begin(user, project_id, body)


@router.put("/{project_id}/file-transfers/{transfer_id}/parts/{index}")
async def put_file_part(project_id: str, transfer_id: str, index: int, body: "TransferChunk", user: UserPublic = Depends(get_current_user)):
    if floor_for_write(user) != "second-floor":
        raise HTTPException(403, "Select the Kitchen Floor for file transfers")
    return await KitchenFileTransfers(db).put_part(user, project_id, transfer_id, index, body)


@router.post("/{project_id}/file-transfers/{transfer_id}/finish")
async def finish_file_transfer(project_id: str, transfer_id: str, body: "TransferFinish", user: UserPublic = Depends(get_current_user)):
    if floor_for_write(user) != "second-floor":
        raise HTTPException(403, "Select the Kitchen Floor for file transfers")
    from media_storage.factory import get_media_storage, private_bucket
    return await KitchenFileTransfers(db).finish(user, project_id, transfer_id, body, get_media_storage(), private_bucket())


@router.delete("/{project_id}/file-transfers/{transfer_id}")
async def cancel_file_transfer(project_id: str, transfer_id: str, user: UserPublic = Depends(get_current_user)):
    if floor_for_write(user) != "second-floor":
        raise HTTPException(403, "Select the Kitchen Floor for file transfers")
    return await KitchenFileTransfers(db).cancel(user, project_id, transfer_id)



@router.get("/{project_id}/attachments/{attachment_id}/parts/{index}")
async def download_file_part(project_id: str, attachment_id: str, index: int, user: UserPublic = Depends(get_current_user)):
    from media_storage.factory import get_media_storage
    from services.kitchen_file_transfers import download_part
    return Response(json.dumps(await download_part(db, user, project_id, attachment_id, index, get_media_storage())),
                    media_type="application/json", headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/{project_id}/file-transfers")
async def own_file_transfer(project_id: str, user: UserPublic = Depends(get_current_user)):
    if floor_for_write(user) != "second-floor":
        raise HTTPException(403, "Select the Kitchen Floor for file transfers")
    from services import kitchen_access
    await kitchen_access.require_capability(db, user, "view")
    row = await db.kitchen_file_transfers.find_one({"_id": user.id})
    if not row or row["state"] == "completed":
        return {"transfer": None}
    return {"transfer": {**KitchenFileTransfers(db).public(row), "project_id": row["project_id"]}}
