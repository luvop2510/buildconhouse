"""Ensure MongoDB indexes exist for fast catalog navigation + search.

Run via `python -m scripts.ensure_indexes`. Safe to run repeatedly —
Motor's `create_index` is idempotent, and `_safe_create_index` additionally
tolerates a same-key-different-name conflict (MongoDB error code 85), which
happens whenever an index was previously created by hand (e.g. via the
Atlas UI) under its auto-generated default name instead of through this
script — the requirement is already satisfied in that case, just under a
different name, so it's logged and skipped rather than treated as fatal.
"""
from __future__ import annotations
import asyncio
import logging
import sys
from pathlib import Path

from dotenv import load_dotenv
from pymongo.errors import OperationFailure

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
load_dotenv(BASE / ".env")

from db import db  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s :: %(message)s")
log = logging.getLogger("forge.indexes")

_INDEX_CONFLICT_CODE = 85  # IndexOptionsConflict — same key(s), different name/options.
_DUPLICATE_KEY_CODE = 11000  # unique index creation found existing duplicate data.


async def _safe_create_index(collection, keys, **kwargs) -> None:
    name = kwargs.get("name", "?")
    try:
        await collection.create_index(keys, **kwargs)
    except OperationFailure as e:
        if e.code == _INDEX_CONFLICT_CODE:
            log.info("%s.%s: equivalent index already exists under a different name — skipped.", collection.name, name)
        elif e.code == _DUPLICATE_KEY_CODE:
            log.warning(
                "%s.%s NOT created — live duplicate data violates this unique constraint; "
                "resolve the duplicate before this index can be applied: %s",
                collection.name, name, e,
            )
        else:
            raise


async def ensure_all() -> None:
    # products: text search + facet lookups
    await _safe_create_index(db.products, [
        ("name", "text"), ("sku", "text"), ("family_name", "text"),
        ("series", "text"), ("subcategory", "text"), ("finish", "text"),
        ("colour", "text"), ("dimensions", "text"), ("description", "text"),
        ("tags", "text"),
    ], name="products_text_v1", default_language="english", weights={
        "sku": 20, "name": 12, "family_name": 10, "series": 6,
        "subcategory": 4, "finish": 3, "colour": 3, "tags": 2,
        "dimensions": 1, "description": 1,
    })
    await _safe_create_index(db.products, "id", unique=True, name="products_id")
    await _safe_create_index(db.products, "sku", name="products_sku")
    await _safe_create_index(db.products, "family_key", name="products_family_key")
    await _safe_create_index(
        db.products, [("brand_id", 1), ("category_id", 1), ("subcategory", 1), ("series", 1)],
        name="products_hierarchy",
    )
    await _safe_create_index(db.products, [("active", 1), ("brand_id", 1)], name="products_active_brand")
    await _safe_create_index(
        db.products, [("active", 1), ("name", 1), ("id", 1)],
        name="products_active_name_id",
    )
    await _safe_create_index(
        db.products, [("active", 1), ("price", 1), ("id", 1)],
        name="products_active_price_id",
    )
    await _safe_create_index(
        db.products, [("active", 1), ("price", -1), ("id", 1)],
        name="products_active_price_desc_id",
    )

    # product_usage: per-user recent/frequent tabs.
    await _safe_create_index(db.product_usage, "user_id", name="usage_user")
    await _safe_create_index(db.product_usage, "product_id", name="usage_product")
    await _safe_create_index(
        db.product_usage, [("user_id", 1), ("last_used_at", -1)], name="usage_user_recent",
    )
    await _safe_create_index(
        db.product_usage, [("user_id", 1), ("count", -1)], name="usage_user_count",
    )

    # product_media: lookup by product/family, plus sha1 dedupe
    await _safe_create_index(db.product_media, "id", unique=True, name="pm_id")
    await _safe_create_index(db.product_media, "product_id", name="pm_product_id")
    await _safe_create_index(db.product_media, "family_key", name="pm_family_key")
    await _safe_create_index(
        db.product_media, [("sha1", 1), ("product_id", 1), ("source_type", 1)],
        name="pm_sha1_scope",
    )
    await _safe_create_index(
        db.product_media, [("is_primary", -1), ("sort_order", 1)], name="pm_ordering",
    )

    # brands + categories
    await _safe_create_index(db.brands, "id", unique=True, name="brands_id")
    await _safe_create_index(
        db.brands, [("floor_id", 1), ("slug", 1)],
        unique=True, name="brands_floor_slug", sparse=True,
    )
    await _safe_create_index(db.categories, "id", unique=True, name="categories_id")
    await _safe_create_index(
        db.categories, [("floor_id", 1), ("slug", 1)],
        unique=True, name="categories_floor_slug", sparse=True,
    )

    # legacy blob store
    await _safe_create_index(db.catalog_image_blobs, "sha1", unique=True, name="blob_sha1")

    # -------------------------------------------------------------------
    # Data Integrity Audit (Phase 2, 2026-08): the historical Hansgrohe/AXOR
    # recovery incident (see /app/memory/PRD.md "CRITICAL BUG FOUND") was
    # caused by exactly one gap — SKU uniqueness was enforced only by
    # application code (`{"sku": sku, "brand_id": ...}` lookups), never by
    # the database itself, so a coding mistake could silently clobber a
    # different brand's product sharing the same numeric code. A read-only
    # audit this session confirmed zero duplicates exist today (0 same-brand
    # SKU dupes, 0 duplicate quotation/PO numbers, 0 duplicate user emails)
    # — these unique indexes convert that "no duplicates today" into
    # "duplicates are now structurally impossible", closing the exact class
    # of bug that caused real data loss twice before.
    # SKU identity is deliberately scoped by floor as well as brand.  A tile
    # and sanitary supplier may legitimately reuse the same SKU.
    await _safe_create_index(
        db.products, [("floor_id", 1), ("brand_id", 1), ("sku", 1)],
        unique=True, name="products_floor_brand_sku_unique",
    )

    await _safe_create_index(db.users, "email", unique=True, name="users_email_unique")
    await _safe_create_index(db.quotations, "number", unique=True, name="quotations_number_unique")
    await _safe_create_index(db.purchase_orders, "number", unique=True, name="purchase_orders_number_unique")
    await _safe_create_index(
        db.purchase_orders, [("floor_id", 1), ("items.id", 1)],
        name="purchase_orders_floor_item_id",
    )
    await _safe_create_index(
        db.purchase_orders, [("floor_id", 1), ("items.product_id", 1), ("customer_id", 1)],
        name="purchase_orders_floor_product_customer",
    )

    # Executive Analytics: every dashboard aggregation starts with confirmed
    # order status plus floor/date, then commonly drills by owner/customer or
    # unwinds line items. These compound indexes preserve that leading match
    # at scale instead of scanning draft/pending documents.
    await _safe_create_index(db.quotations, [("status", 1), ("floor_id", 1), ("updated_at", -1)], name="analytics_orders_floor_date")
    await _safe_create_index(db.quotations, [("status", 1), ("created_by", 1), ("updated_at", -1)], name="analytics_orders_salesperson_date")
    await _safe_create_index(db.quotations, [("status", 1), ("customer_id", 1), ("updated_at", -1)], name="analytics_orders_customer_date")
    await _safe_create_index(db.payments, [("floor_id", 1), ("status", 1), ("paid_at", -1)], name="analytics_payments_floor_date")

    # Production readiness audit (2026-07-23), Low: the embedded
    # purchase_orders.chalans[] array (Ground Floor Tiles) shipped with no
    # index entry, consistent with this collection's pre-existing gap on
    # items.id — not a regression, but worth closing now that something
    # actually scans across it: services/sequence.py's collision-recovery
    # path (`_seed_from_existing`, fixed alongside this to scan the nested
    # array instead of the top-level `number` field) runs a `^CH-`
    # prefix-anchored regex over `chalans.number` across the whole
    # collection whenever the CH- counter is missing or reset. A regular
    # index lets Mongo use an index-prefix scan for that anchored regex
    # instead of a full collection scan. (No equivalent index for
    # chalans.id: unlike items.id, nothing looks up a PO by chalan id
    # without already knowing po_id from the URL path.)
    await _safe_create_index(db.purchase_orders, "chalans.number", name="purchase_orders_chalans_number")

    # BACKEND_AUDIT_2026-07-17.md High #14: customers.email had a
    # check-then-insert race with nothing backing it at the DB layer.
    # Verified duplicate-free against live data before adding.
    await _safe_create_index(db.customers, "email", unique=True, sparse=True, name="customers_email_unique")

    # BACKEND_AUDIT_2026-07-17.md High #15: bootstrap.py's REQUIRED_INDEXES
    # has demanded these on every startup preflight since it was written, but
    # nothing in version control ever created them — they only existed on
    # this database because someone made them by hand outside of this
    # script (confirmed present here under Mongo's auto-generated names
    # `id_1` / `user_type_1_user_id_1`, which is why startup never actually
    # failed). A fresh environment/database gets them for real now.
    await _safe_create_index(db.user_sessions, "id", unique=True, name="user_sessions_id_unique")
    await _safe_create_index(
        db.user_sessions, [("user_type", 1), ("user_id", 1)], name="user_sessions_type_user",
    )

    # MEDIUM #31: no index on payments.quotation_id (aggregated on every
    # order list/detail/stats page load via _paid_by_quotation), and
    # activity_events/suppliers had nothing beyond their automation_key /
    # _id_ defaults — every entity-timeline or supplier-list query was a
    # full collection scan.
    await _safe_create_index(db.payments, "quotation_id", name="payments_quotation_id")
    await _safe_create_index(
        db.payments, [("quotation_id", 1), ("status", 1)], name="payments_quotation_status",
    )
    await _safe_create_index(
        db.activity_events, [("entity_type", 1), ("entity_id", 1), ("created_at", -1)],
        name="activity_entity_timeline",
    )
    await _safe_create_index(
        db.activity_events, [("quotation_id", 1), ("created_at", -1)],
        name="activity_quotation_timeline", sparse=True,
    )
    await _safe_create_index(
        db.activity_events, [("customer_id", 1), ("created_at", -1)],
        name="activity_customer_timeline", sparse=True,
    )
    await _safe_create_index(db.suppliers, "id", unique=True, name="suppliers_id")
    await _safe_create_index(db.suppliers, "floor_id", name="suppliers_floor_id", sparse=True)
    await _safe_create_index(db.suppliers, "name", name="suppliers_name")

    # Material Movement Register (Tile Orders workflow redesign, 2026-08) —
    # every filter the GET /tile-orders/movements endpoint supports.
    await _safe_create_index(db.material_movements, "id", unique=True, name="material_movements_id")
    await _safe_create_index(
        db.material_movements, [("customer_id", 1), ("created_at", -1)], name="material_movements_customer",
    )
    await _safe_create_index(
        db.material_movements, [("brand_id", 1), ("created_at", -1)], name="material_movements_brand",
    )
    await _safe_create_index(
        db.material_movements, [("movement_type", 1), ("created_at", -1)], name="material_movements_type",
    )
    await _safe_create_index(db.material_movements, "purchase_order_id", name="material_movements_po")
    await _safe_create_index(db.material_movements, "dispatch_number", name="material_movements_dispatch_number", sparse=True)
    await _safe_create_index(db.material_movements, "chalan_number", name="material_movements_chalan_number", sparse=True)

    # Follow-ups 2.0 (2026-07-30): reconcile_followups() is invoked as
    # fire-and-forget `asyncio.create_task(...)` from many routes and had NO
    # database-level guard against two overlapping runs both inserting the
    # same automated card — confirmed live (12 distinct duplicate
    # source_keys, up to 6 copies of one payment_overdue card) before this
    # index + the in-process lock added to reconcile_followups() itself.
    # Duplicates were cleaned up (kept newest per source_key) before adding
    # this constraint. `sparse` because manual follow-ups never set
    # source_key.
    await _safe_create_index(
        db.followups, "source_key", unique=True, name="followups_source_key_unique",
        partialFilterExpression={"source_key": {"$type": "string"}},
    )

    # Walk-ins (Phase 4, 2026-07-30)
    await _safe_create_index(db.walkins, [("customer_id", 1)], name="walkins_customer_id")
    await _safe_create_index(db.walkins, [("status", 1)], name="walkins_status")
    await _safe_create_index(db.walkins, [("floor_id", 1)], name="walkins_floor_id")
    await _safe_create_index(db.walkins, [("visited_at", -1)], name="walkins_visited_at")
    await _safe_create_index(db.walkins, [("selection_quotation_id", 1)], name="walkins_selection_quotation_id", sparse=True)
    # Duplicate-detection lookups (services/walkin_service.py) filter by phone
    # suffix — a plain index still helps the initial customers scan even
    # though the query is a $regex suffix match, not a prefix match.
    await _safe_create_index(db.customers, [("phone", 1)], name="customers_phone")
    await _safe_create_index(db.customers, [("alternate_phone", 1)], name="customers_alternate_phone", sparse=True)


    # catalog_import_snapshots.job_id (CRITICAL #3 rollback lookups) is
    # intentionally NOT created here — it's owned solely by
    # migrations/0002_add_catalog_import_snapshots_index.py. The two
    # mechanisms picking different default names for "the same" index caused
    # a real startup crash (OperationFailure code 85, IndexOptionsConflict)
    # the first time both ran against the same database; the versioned
    # migration runner is the authoritative path going forward, this script
    # is not.

    log.info("All indexes ensured.")


if __name__ == "__main__":
    asyncio.run(ensure_all())
