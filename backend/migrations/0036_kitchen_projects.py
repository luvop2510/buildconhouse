"""Add isolated Kitchen aggregate indexes. Never imports or changes legacy rows.

Forward-only and repeat-safe. Customer identity is deliberately NOT unique:
one customer may legitimately commission multiple kitchens/projects.
"""
from pymongo.errors import OperationFailure

INDEXES = (
    ([("id", 1)], "kitchen_projects_id_unique", True),
    ([("reference", 1)], "kitchen_projects_reference_unique", True),
    ([("floor_id", 1), ("stage", 1), ("updated_at", -1), ("id", 1)], "kitchen_projects_stage_page", False),
    ([("floor_id", 1), ("customer_id", 1), ("updated_at", -1), ("id", 1)], "kitchen_projects_customer_page", False),
    ([("floor_id", 1), ("assigned_to", 1), ("updated_at", -1), ("id", 1)], "kitchen_projects_assignee_page", False),
    ([("floor_id", 1), ("status", 1), ("deadline", 1), ("id", 1)], "kitchen_projects_status_deadline", False),
    ([("floor_id", 1), ("completion_date", 1), ("id", 1)], "kitchen_projects_completed_page", False),
)


async def up(db):
    for keys, name, unique in INDEXES:
        try:
            await db.kitchen_projects.create_index(keys, name=name, unique=unique)
        except OperationFailure as exc:
            if exc.code not in {85, 86}:
                raise
            existing = await db.kitchen_projects.index_information()
            if not any(list(index["key"]) == keys and bool(index.get("unique")) == unique
                       and not index.get("partialFilterExpression") and not index.get("sparse")
                       for index in existing.values()):
                raise

