"""A Purchases board always represents one concrete business floor."""
from fastapi import Depends

from auth import floor_scope_ids, get_current_user
from models import UserPublic
from services.purchase_stages import active_quantity_expression, dispatched_quantity_expression, stage_expression


def delivered_tracker_quantity_expression() -> dict:
    """Partition fulfilled quantities, including a partially dispatched chalan."""
    quantity = active_quantity_expression()
    return {"$cond": [{"$eq": [stage_expression(), "dispatched"]}, quantity,
        {"$max": [0, {"$min": [quantity, dispatched_quantity_expression()]}]}]}


def pending_tracker_quantity_expression() -> dict:
    return {"$max": [0, {"$subtract": [active_quantity_expression(), delivered_tracker_quantity_expression()]}]}


async def get_purchase_workspace_user(
    user: UserPublic = Depends(get_current_user),
) -> UserPublic:
    # Native/deep-link callers can omit X-Floor-Id. A multi-floor assignment
    # must not then turn a single-floor board into a combined purchase feed.
    # Keep deny-all scopes intact and retain permission/grant attributes.
    if user.active_floor_id:
        return user
    floors = floor_scope_ids(user)
    return user.model_copy(update={"active_floor_id": floors[0]}) if floors else user
