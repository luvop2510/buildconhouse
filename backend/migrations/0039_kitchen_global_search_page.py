"""Index universal Kitchen browsing without rewriting customer/project records.

Literal substring searches still scan their Kitchen scope; this index supports
the default global page order without an in-memory sort. Forward-only/repeat-safe.
"""
from pymongo.errors import OperationFailure


async def up(db):
    keys = [("floor_id", 1), ("updated_at", -1), ("id", 1)]
    try:
        await db.kitchen_projects.create_index(keys, name="kitchen_projects_global_page")
    except OperationFailure as exc:
        if exc.code not in {85, 86}:
            raise
        existing = await db.kitchen_projects.index_information()
        if not any(list(index["key"]) == keys and not index.get("unique")
                   and not index.get("partialFilterExpression") and not index.get("sparse")
                   for index in existing.values()):
            raise
