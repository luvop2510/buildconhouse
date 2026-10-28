"""Index warehouse pages without rewriting stock or changing archive semantics.

Read-only production explain found 1,025 fetched records for two active lots.
Putting archive status in the index filters archived records before FETCH and
also supports the summary facet's floor/archive match. The $ne predicate can
still require an index-key sort; no claim of a sort-free query is made.
See docs/audits/2026-10-28-application-performance.md for measured evidence.
"""
from pymongo.errors import OperationFailure


KEYS = [("floor_id", 1), ("archived", 1), ("transferred_at", -1), ("id", 1)]
NAME = "godown_floor_archived_page"


async def up(db):
    try:
        await db.godown_stock.create_index(KEYS, name=NAME)
    except OperationFailure as error:
        if error.code != 85:
            raise
        # A legacy name is safe only if it really covers the same full dataset.
        async for index in db.godown_stock.list_indexes():
            if (list(index["key"].items()) == KEYS
                    and not any(index.get(option) for option in
                                ("sparse", "unique", "partialFilterExpression", "hidden", "collation"))):
                return
        raise
