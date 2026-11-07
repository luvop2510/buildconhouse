"""Index bounded Walk-in pages without rewriting records.

A disposable 20,000-document fixture examined/sorted 20,000 rows to return
41 across all floors before this index, versus 45 documents and no blocking
sort afterward (local medians 28.38 ms and 0.309 ms). Single-floor reads used
45 documents/178 keys instead of 5,000 documents/keys. Apply through the
migration runner before backend rollout; retain on application rollback.
"""
from pymongo.errors import OperationFailure


KEYS = [("is_deleted", 1), ("visited_at", -1), ("id", -1), ("floor_id", 1)]
NAME = "walkins_active_visited_id_floor"


async def up(db):
    try:
        await db.walkins.create_index(KEYS, name=NAME)
    except OperationFailure as error:
        if error.code != 85:
            raise
        async for index in db.walkins.list_indexes():
            if (list(index["key"].items()) == KEYS
                    and not any(index.get(option) for option in
                                ("sparse", "unique", "partialFilterExpression", "hidden", "collation"))):
                return
        raise
