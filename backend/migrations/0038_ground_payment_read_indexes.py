"""Add bounded payment history/detail and current-order read indexes.

No records or financial values change. Existing equivalent indexes are retained.
"""
from pymongo.errors import OperationFailure


async def up(db) -> None:
    for collection, keys, name in (
        (db.payments, [("floor_id", 1), ("created_at", -1)], "payments_floor_created"),
        (db.payments, [("floor_id", 1), ("quotation_id", 1), ("status", 1)], "payments_floor_quotation_status"),
        (db.quotations, [("floor_id", 1), ("status", 1), ("updated_at", -1)], "quotations_floor_status_updated"),
    ):
        try:
            await collection.create_index(keys, name=name)
        except OperationFailure as error:
            if error.code != 85:
                raise
