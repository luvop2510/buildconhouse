"""Add stage-interaction indexes without modifying existing business records.

Forward-only and repeat-safe. Keep this collection and indexes on app rollback
so saved interactions remain recoverable. Apply with the controlled runner.
"""
from pymongo.errors import OperationFailure


async def up(db):
    indexes = [
        ([("project_id", 1), ("stage", 1), ("number", -1)], "kitchen_followups_sequence", True),
        ([("floor_id", 1), ("project_id", 1), ("created_at", -1), ("id", 1)], "kitchen_followups_history", False),
        ([("floor_id", 1), ("customer_id", 1)], "kitchen_followups_customer", False),
    ]
    for keys, name, unique in indexes:
        try:
            await db.kitchen_stage_followups.create_index(keys, name=name, unique=unique)
        except OperationFailure as error:
            if error.code not in {85, 86}:
                raise
            info = await db.kitchen_stage_followups.index_information()
            if not any(list(item["key"]) == keys and bool(item.get("unique")) == unique
                       and not any(item.get(key) for key in ("sparse", "partialFilterExpression", "hidden", "collation"))
                       for item in info.values()):
                raise
