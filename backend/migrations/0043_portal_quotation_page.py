"""Index customer portal summary pages without changing quotation records.

A disposable 20,000-document fixture examined 2,000 customer rows and sorted
before returning 20. The matching index examines 20 rows without a blocking
sort. Local paired medians were 2.94 ms before and 0.65 ms after. The additive
nonunique index used 274,432 bytes. Apply through the migration runner before
backend rollout and retain it on application rollback.
"""
from pymongo.errors import OperationFailure


KEYS = [("customer_id", 1), ("created_at", -1), ("id", -1)]
NAME = "quotations_customer_created_id"


async def up(db):
    try:
        await db.quotations.create_index(KEYS, name=NAME)
    except OperationFailure as error:
        if error.code != 85:
            raise
        async for index in db.quotations.list_indexes():
            if (list(index["key"].items()) == KEYS
                    and not any(index.get(option) for option in
                                ("sparse", "unique", "partialFilterExpression", "hidden", "collation"))):
                return
        raise
