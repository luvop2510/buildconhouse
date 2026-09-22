"""Support floor-scoped Pending and Completed quotation lists.

The workspace now reads quotations by floor, lifecycle status, and newest
first.  This additive index keeps those lists bounded and responsive as
completed orders accumulate.  It is safe to apply repeatedly.
"""
from __future__ import annotations

from pymongo.errors import OperationFailure


async def up(db) -> None:
    try:
        await db.quotations.create_index(
            [("floor_id", 1), ("status", 1), ("created_at", -1)],
            name="quotations_floor_status_created",
        )
    except OperationFailure as error:
        # A legacy deployment may already have this key pattern under a
        # different name.  Preserve the existing safe index instead.
        if error.code != 85:
            raise
