"""Unique optional work IDs without changing existing email identities."""
from pymongo.errors import OperationFailure


async def up(db):
    try:
        await db.users.create_index(
            [("login_id_key", 1)], name="users_login_id_unique", unique=True,
            partialFilterExpression={"login_id_key": {"$type": "string"}},
        )
    except OperationFailure as error:
        if error.code != 85:
            raise
        indexes = await db.users.index_information()
        if not any(
            spec.get("key") == [("login_id_key", 1)]
            and spec.get("unique") is True
            and spec.get("partialFilterExpression") == {"login_id_key": {"$type": "string"}}
            for spec in indexes.values()
        ):
            raise
