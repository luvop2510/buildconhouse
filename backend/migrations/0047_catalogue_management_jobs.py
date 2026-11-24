"""Indexes for scoped catalogue previews, job recovery and temporary file parts."""
from pymongo.errors import OperationFailure


async def up(db):
    indexes = [
        (db.catalogue_imports, [("floor_id", 1), ("created_at", -1)], "catalogue_history", {}),
        (db.catalogue_imports, [("status", 1), ("lease_until", 1)], "catalogue_pending", {}),
        (db.catalogue_import_rows, [("job_id", 1), ("preview_id", 1), ("index", 1)], "catalogue_preview", {}),
        (db.catalogue_import_parts, [("job_id", 1), ("index", 1)], "catalogue_parts", {}),
        (db.catalogue_import_parts, [("expires_at", 1)], "catalogue_parts_expiry", {"expireAfterSeconds": 0}),
    ]
    for collection, keys, name, options in indexes:
        try:
            await collection.create_index(keys, name=name, **options)
        except OperationFailure as exc:
            if exc.code not in {85, 86}:
                raise
            info = await collection.index_information()
            if not any(list(item["key"]) == keys and item.get("expireAfterSeconds") == options.get("expireAfterSeconds")
                       and not any(key in item for key in ("unique", "sparse", "partialFilterExpression", "hidden", "collation"))
                       for item in info.values()):
                raise
