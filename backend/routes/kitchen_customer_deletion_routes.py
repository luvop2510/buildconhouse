"""Kitchen customer deletion requires a current, separately delegated grant."""
import logging

from fastapi import APIRouter, Depends, Query, Response

from auth import get_current_user, floor_for_write, invalidate_principal_cache
from db import db
from fastapi import HTTPException
from models import UserPublic
from services.kitchen_customer_deletion import preview, remove

router = APIRouter(prefix="/kitchen-customer-deletion", tags=["kitchen-projects"])


@router.get("/{project_id}")
async def deletion_preview(project_id: str, response: Response, user: UserPublic = Depends(get_current_user)):
    if floor_for_write(user) != "second-floor":
        raise HTTPException(403, "Select the Kitchen Floor for customer deletion")
    response.headers["Cache-Control"] = "no-store"
    return await preview(db, user, project_id)


@router.delete("/{project_id}")
async def delete_customer(project_id: str, response: Response, confirmation: str = Query(min_length=64, max_length=64, pattern="^[a-f0-9]+$"),
                          user: UserPublic = Depends(get_current_user)):
    if floor_for_write(user) != "second-floor":
        raise HTTPException(403, "Select the Kitchen Floor for customer deletion")
    result = await remove(db, user, project_id, confirmation)
    invalidate_principal_cache("customer", result["customer_id"])
    response.headers["Cache-Control"] = "no-store"
    try:
        from services.analytics import cache
        await cache.bump("kitchen_projects")
    except Exception:
        logging.getLogger("forge.kitchen").exception("Analytics invalidation failed after committed Kitchen customer deletion")
    return result
