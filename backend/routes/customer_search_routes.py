"""Home search uses current source/floor/stage permissions for every read."""
from typing import Literal
from fastapi import APIRouter, Depends, Query, Response
from auth import get_current_user
from db import db
from models import UserPublic
from services.customer_search import CustomerSearchService

router = APIRouter(prefix="/customer-search", tags=["customer-search"])

@router.get("")
async def search_customers(response: Response, search: str = Query("", max_length=200), page: int = Query(1, ge=1, le=100000), limit: int = Query(20, ge=1, le=50), user: UserPublic = Depends(get_current_user)):
    response.headers["Cache-Control"] = "no-store"
    return await CustomerSearchService(db).search(user, search, page, limit)

@router.get("/profile")
async def customer_profile(response: Response, kind: Literal["customer", "kitchen", "walkin", "followup", "quotation", "furniture", "order"], id: str = Query(min_length=1, max_length=128), floor_id: str = Query(min_length=1, max_length=128), user: UserPublic = Depends(get_current_user)):
    response.headers["Cache-Control"] = "no-store"
    return await CustomerSearchService(db).profile(user, kind, id, floor_id)
