"""Bound catalog history and large-catalog floor/owner queries; safe to repeat."""
from pymongo.errors import OperationFailure

async def up(db):
    indexes = (
        ("catalog_import_snapshots", [("floor_id", 1), ("product_id", 1), ("created_at", -1)], "catalog_snapshot_floor_product_date"),
        ("products", [("active", 1), ("floor_id", 1), ("brand_id", 1), ("category_id", 1), ("name", 1), ("id", 1)], "catalog_active_floor_brand_category_name"),
        ("products", [("floor_id", 1), ("brand_id", 1), ("family_key", 1), ("category_id", 1), ("active", 1)], "catalog_family_namespace"),
        ("products", [("floor_id", 1), ("brand_id", 1), ("specs.configuration_group", 1), ("category_id", 1)], "catalog_configuration_namespace"),
        ("product_media", [("product_id", 1), ("floor_id", 1), ("brand_id", 1)], "catalog_media_owner"),
        ("product_media", [("family_key", 1), ("floor_id", 1), ("brand_id", 1)], "catalog_media_family_owner"),
        ("product_usage", [("product_id", 1), ("user_id", 1)], "catalog_usage_product_user"),
    )
    for collection, keys, name in indexes:
        try:
            await getattr(db, collection).create_index(keys, name=name)
        except OperationFailure as error:
            if error.code != 85:
                raise
