"""Private unfinished Kitchen file staging; never expires committed objects."""
from pymongo.errors import OperationFailure


async def up(db):
    for collection in (db.kitchen_file_transfers, db.kitchen_file_parts):
        try:
            await collection.create_index('expires_at', name='kitchen_unfinished_transfer_expiry', expireAfterSeconds=0)
        except OperationFailure as exc:
            if exc.code not in {85, 86}:
                raise
            indexes = await collection.index_information()
            if not any(list(value['key']) == [('expires_at', 1)] and value.get('expireAfterSeconds') == 0
                       for value in indexes.values()):
                raise
    await db.kitchen_file_parts.create_index([('transfer_id', 1), ('index', 1)], name='kitchen_transfer_parts')
