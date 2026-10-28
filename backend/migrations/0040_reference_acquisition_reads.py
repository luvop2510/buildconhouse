"""Bound exact-reference date drilldowns across lead and customer sources.

Adds read indexes only; no business records or historical attribution changes.
"""
from pymongo.errors import OperationFailure


async def up(db):
    keys = [("referrer_id", 1), ("floor_id", 1), ("created_at", -1)]
    for name in ("customers", "walkins", "followups", "quotations", "furniture_quotations", "kitchen_projects"):
        collection = getattr(db, name)
        try:
            await collection.create_index(keys, name="reference_floor_acquired")
        except OperationFailure as exc:
            if exc.code not in {85, 86}:
                raise
            indexes = await collection.index_information()
            if not any(list(index["key"]) == keys and not index.get("unique")
                       and not index.get("partialFilterExpression") and not index.get("sparse")
                       for index in indexes.values()):
                raise
