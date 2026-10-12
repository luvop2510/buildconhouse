"""Backward-compatible comma separated choice filters."""
from __future__ import annotations

from auth import floor_query, require_floor_access
from fastapi import HTTPException


def filter_values(value: str | None, *, all_value: str = "all", allowed=None) -> list[str]:
    if not isinstance(value, str):
        return []
    selected = list(dict.fromkeys(part.strip() for part in (value or "").split(",") if part.strip() and part.strip() != all_value))
    if len(selected) > 100:
        raise HTTPException(400, "Choose at most 100 filter values")
    if allowed is not None and any(item not in allowed for item in selected):
        raise HTTPException(400, "Unknown filter value")
    return selected


def filter_condition(value: str | None, *, all_value: str = "all", allowed=None):
    selected = filter_values(value, all_value=all_value, allowed=allowed)
    return selected[0] if len(selected) == 1 else {"$in": selected}


values = filter_values
predicate = filter_condition


def scoped_query(user, query: dict, floor_ids: str | None = None) -> dict:
    selected = values(floor_ids)
    if not selected:
        return floor_query(user, query)
    # Explicit cross-floor filters may widen the active workspace but never
    # the principal's assigned access. Check every requested floor first.
    for floor_id in selected:
        require_floor_access(floor_id, user)
    return {"$and": [{"floor_id": {"$in": selected}}, query]}
