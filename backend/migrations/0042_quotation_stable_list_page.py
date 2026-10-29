"""Keep stable quotation pages bounded without rewriting business records.

Mongo7 fixture: 6,000 documents, pending Ground page of 31 rows. Adding the ID
tie-break to the index reduces fetched records from 2,400 to 62 and replaces
blocking SORT with SORT_MERGE. See the 30 October Ground API performance audit.
"""
from pymongo.errors import OperationFailure


KEYS = [("floor_id", 1), ("status", 1), ("created_at", -1), ("id", -1)]
NAME = "quotations_floor_status_created_id"


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
