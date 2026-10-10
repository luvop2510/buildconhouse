"""Additive bounded furniture listing and duplicate-safe WhatsApp receipts."""
from pymongo.errors import OperationFailure


async def up(db):
    for collection, keys, name, options in [
        (db.furniture_quotations, [("id", 1)], "furniture_quotation_id", {"unique": True}),
        (db.furniture_quotations, [("floor_id", 1), ("updated_at", -1), ("id", -1)], "furniture_quotation_list", {}),
        (db.whatsapp_deliveries, [("floor_id", 1), ("source_id", 1), ("idempotency_key", 1)], "whatsapp_delivery_request", {"unique": True}),
        (db.whatsapp_deliveries, [("message_id", 1)], "whatsapp_provider_message", {"unique": True, "sparse": True}),
        (db.whatsapp_status_events, [("message_id", 1)], "whatsapp_status_message", {"unique": True}),
        (db.whatsapp_status_events, [("created_at", 1)], "whatsapp_status_expiry", {"expireAfterSeconds": 30 * 86400}),
    ]:
        try:
            await collection.create_index(keys, name=name, **options)
        except OperationFailure as error:
            if error.code != 85:
                raise
            # The request guard requires an actual unique constraint, not just
            # a same-key index under an older name. Fail closed on conflicts.
            indexes = await collection.list_indexes().to_list(None)
            matching = [entry for entry in indexes if list(entry["key"].items()) == keys]
            if not any(all(entry.get(option, False) == value for option, value in options.items()) for entry in matching):
                raise
