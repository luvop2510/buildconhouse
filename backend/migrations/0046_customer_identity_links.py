"""Index confirmed customer relationships without modifying customer records."""
from importlib import import_module

_create_index_tolerant = import_module("migrations.0003_add_user_sessions_indexes")._create_index_tolerant


async def up(db):
    for field in ("imported_from_customer_id", "identity_source_customer_id"):
        await _create_index_tolerant(db.customers, field, name=f"customers_{field}_lookup")
