"""Home search uses current source/floor/stage permissions for every read."""
from typing import Literal
from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field, StringConstraints
from typing import Annotated
from auth import get_current_user, require_owner
from db import db
from models import UserPublic
from services.customer_search import CustomerSearchService
from services.canonical_customers import review_candidates, save_identity_decision

router = APIRouter(prefix="/customer-search", tags=["customer-search"])

@router.get("")
async def search_customers(response: Response, search: str = Query("", max_length=200), page: int = Query(1, ge=1, le=100000), limit: int = Query(20, ge=1, le=50), user: UserPublic = Depends(get_current_user)):
    response.headers["Cache-Control"] = "no-store"
    return await CustomerSearchService(db).search(user, search, page, limit)

@router.get("/profile")
async def customer_profile(response: Response, kind: Literal["customer", "kitchen", "walkin", "followup", "quotation", "furniture", "order"], id: str = Query(min_length=1, max_length=128), floor_id: str = Query(min_length=1, max_length=128), user: UserPublic = Depends(get_current_user)):
    response.headers["Cache-Control"] = "no-store"
    return await CustomerSearchService(db).profile(user, kind, id, floor_id)


@router.get("/candidates")
async def customer_candidates(response: Response, name: str = Query("", max_length=200), phone: str = Query("", max_length=80), user: UserPublic = Depends(get_current_user)):
    response.headers["Cache-Control"] = "no-store"
    return await CustomerSearchService(db).intake_candidates(user, name, phone)


class CustomerIdentityDecision(BaseModel):
    customer_ids: tuple[Annotated[str, StringConstraints(min_length=1, max_length=128)],
                        Annotated[str, StringConstraints(min_length=1, max_length=128)]]
    decision: Literal["same", "distinct", "review"]
    note: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    expected_revision: int = Field(ge=0)


@router.get("/identity-review")
async def customer_identity_review(response: Response, page: int = Query(1, ge=1), limit: int = Query(20, ge=1, le=50), user: UserPublic = Depends(require_owner)):
    response.headers["Cache-Control"] = "no-store"
    return await review_candidates(db, page, limit)


@router.post("/identity-review")
async def save_customer_identity_review(body: CustomerIdentityDecision, response: Response, user: UserPublic = Depends(require_owner)):
    response.headers["Cache-Control"] = "no-store"
    return await save_identity_decision(db, user, body.customer_ids, body.decision, body.note, body.expected_revision)
