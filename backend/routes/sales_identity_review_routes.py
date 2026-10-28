import asyncio
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from auth import UserPublic, accessible_floor_ids, require_roles
from db import db
from routes.sales_analytics_routes import Kind, filters
from services.analytics.identity_review import review_identity, review_page
from services.analytics.unified import Query as SalesQuery
from services.analytics.filters import FloorAccessError

router = APIRouter(prefix="/sales-analytics/duplicates", tags=["sales-analytics"])


class IdentityDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["companies", "products", "architects", "customers"]
    entity_ids: list[str] = Field(min_length=2, max_length=100)
    decision: Literal["distinct", "needs_correction", "resolved"]
    note: str = Field(min_length=1, max_length=1000)
    expected_revision: int = Field(ge=0)

    @field_validator("note")
    @classmethod
    def note_required(cls, value):
        if not value.strip():
            raise ValueError("Record the reason for this identity decision")
        return value.strip()

    @field_validator("entity_ids")
    @classmethod
    def stable_ids(cls, value):
        if any(not identity or len(identity) > 200 for identity in value):
            raise ValueError("Use valid stable identity IDs")
        return value


@router.get("")
async def get_reviews(response: Response, kind: Kind = "customers", q: SalesQuery = Depends(filters), page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100), user: UserPublic = Depends(require_roles("owner", "admin", "manager"))):
    try:
        async with asyncio.timeout(20):
            result = await review_page(db, q, accessible_floor_ids(user), kind, page, page_size)
    except FloorAccessError as exc:
        raise HTTPException(403, "You do not have access to the selected sales department") from exc
    except TimeoutError as exc:
        raise HTTPException(503, "Identity review took too long; choose one business unit and retry") from exc
    response.headers["Cache-Control"] = "no-store"
    return result


@router.post("/review")
async def save_review(body: IdentityDecision, response: Response, q: SalesQuery = Depends(filters), user: UserPublic = Depends(require_roles("owner"))):
    try:
        async with asyncio.timeout(20):
            result = await review_identity(db, q, accessible_floor_ids(user), user, body)
    except FloorAccessError as exc:
        raise HTTPException(403, "You do not have access to the selected sales department") from exc
    except TimeoutError as exc:
        raise HTTPException(503, "The review could not be acknowledged. Retry the same decision and note") from exc
    response.headers["Cache-Control"] = "no-store"
    return result
