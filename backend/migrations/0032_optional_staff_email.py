"""Allow multiple username-only staff accounts; preserve email uniqueness.

Build the replacement constraint before dropping the legacy constraint so
there is never a window in which duplicate email addresses are accepted.
No account identity or credential data is rewritten.
"""
from pymongo.errors import OperationFailure


async def up(db):
    keys = [("email", 1)]
    partial = {"email": {"$type": "string"}}
    try:
        await db.users.create_index(
            keys, name="users_email_optional_unique", unique=True,
            partialFilterExpression=partial,
        )
    except OperationFailure as error:
        if error.code != 85:
            raise
        indexes = await db.users.index_information()
        if not any(spec.get("key") == keys and spec.get("unique") is True
                   and spec.get("partialFilterExpression") == partial for spec in indexes.values()):
            raise
    indexes = await db.users.index_information()
    for name, spec in indexes.items():
        if spec.get("key") == keys and spec.get("unique") is True and spec.get("partialFilterExpression") != partial:
            await db.users.drop_index(name)
