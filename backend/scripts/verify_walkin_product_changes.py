"""Controlled live acceptance: temporary records only, always cleaned up.

Run explicitly with --live. Uses the configured database and an existing owner
as the route actor; never changes any existing product or customer record.
"""
import argparse
import asyncio
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import Response
from db import db
from models import CustomerPublic, Product, ProductPatch, Quotation, QuotationLineItem, QuotationUpdate, UserPublic
from models_walkins import WalkIn
from routes import catalog_routes, customer_routes, quotation_routes, walkin_routes
from services import catalog_service


async def verify():
    tag = f"acceptance-{uuid.uuid4()}"
    ids = {key: f"{tag}-{key}" for key in ("customer", "walkin", "silver", "black", "quotation")}
    actor_doc = await db.users.find_one({"role": "owner", "active": True}, {"_id": 0, "password_hash": 0})
    if not actor_doc:
        raise RuntimeError("Acceptance needs an active owner")
    actor = UserPublic(**{**actor_doc, "active_floor_id": "first-floor"})
    source = await db.products.find_one({"floor_id": "first-floor", "active": True}, {"_id": 0, "brand_id": 1, "category_id": 1})
    products = [Product(id=ids[color], sku=ids[color], name=tag, brand_id=source["brand_id"], category_id=source["category_id"], floor_id="first-floor", family_key=tag, family_name=tag, price=100, mrp=100, colour=color.title()).model_dump() for color in ("silver", "black")]
    customer = CustomerPublic(id=ids["customer"], name=tag, floor_id="first-floor").model_dump()
    customer.pop("email", None)
    walkin = WalkIn(id=ids["walkin"], number=tag, customer_id=ids["customer"], customer_name=tag, customer_phone="0000000000", floor_id="first-floor", source="Walk-in", visited_at=datetime.now(timezone.utc).isoformat(), salesperson_id=actor.id, salesperson_name=actor.full_name, created_by=actor.id, created_by_name=actor.full_name).model_dump()
    lines = [QuotationLineItem(id=f"{tag}-{i}", product_id=p["id"], name=tag, sku=p["sku"], category_id=p["category_id"], qty=1, unit_price=100, room="Bathroom") for i, p in enumerate(products)]
    quotation = Quotation(id=ids["quotation"], number=tag, customer_id=ids["customer"], customer_name=tag, floor_id="first-floor", items=lines, rooms=["Bathroom"], created_by=actor.id, created_by_name=actor.full_name).model_dump()
    checks = []
    try:
        await db.products.insert_many(products)
        await db.customers.insert_one(customer)
        await db.walkins.insert_one(walkin)
        await db.quotations.insert_one(quotation)
        before = await customer_routes.list_customers(Response(), skip=0, limit=2000, confirmed_only=True, user=actor)
        assert ids["customer"] not in [row.id for row in before]
        checks.append("walkin_and_draft_excluded_from_customers")
        transfer = await walkin_routes.visit_showroom(ids["walkin"], actor)
        assert transfer == await walkin_routes.visit_showroom(ids["walkin"], actor)
        persisted = await db.followups.find_one({"id": transfer["followup_id"]}, {"_id": 0})
        assert persisted["origin"] == "visit_showroom" and persisted["walkin_id"] == ids["walkin"]
        assert await db.followups.count_documents({"source_key": f"visit_showroom:{ids['walkin']}"}) == 1
        checks.append("showroom_immediate_persistence_and_idempotency")
        await catalog_service.refresh_catalog_snapshot()
        result = await catalog_service.list_products_page(user_id=actor.id, q=tag, brand_id=None, category_id=None, subcategory=None, series=None, family_key=None, finish=None, colour=None, sort="name", limit=10, skip=0, floor_ids=["first-floor"])
        assert result["total"] == 1 and len(result["items"][0]["family_variants"]) == 2
        checks.append("live_family_grouping_with_full_variants")
        await catalog_routes.update_product(ids["black"], ProductPatch(variant_label="Acceptance Midnight"), actor)
        assert (await db.products.find_one({"id": ids["black"]}))["variant_label"] == "Acceptance Midnight"
        checks.append("variant_label_live_persistence")
        await quotation_routes.update_quotation(ids["quotation"], QuotationUpdate(items=list(reversed(lines)), silent=True), actor)
        saved = await db.quotations.find_one({"id": ids["quotation"]}, {"_id": 0, "items": 1})
        assert [row["id"] for row in saved["items"]] == [line.id for line in reversed(lines)]
        checks.append("quotation_reorder_live_persistence")
        await db.quotations.update_one({"id": ids["quotation"]}, {"$set": {"status": "ordered"}})
        after = await customer_routes.list_customers(Response(), skip=0, limit=2000, confirmed_only=True, user=actor)
        assert ids["customer"] in [row.id for row in after]
        checks.append("confirmed_customer_inclusion")
        print(json.dumps({"live_database_route_checks": checks, "result": "pass"}))
    finally:
        for collection in ("products", "customers", "walkins", "quotations"):
            await db[collection].delete_many({"id": {"$in": list(ids.values())}})
        await db.followups.delete_many({"walkin_id": ids["walkin"]})
        await db.activity_events.delete_many({"entity_id": {"$in": list(ids.values())}})
        await db.product_usage.delete_many({"product_id": {"$in": [ids["silver"], ids["black"]]}})
        remaining = sum([await db[name].count_documents({"id": {"$in": list(ids.values())}}) for name in ("products", "customers", "walkins", "quotations")])
        assert remaining == 0
        print(json.dumps({"temporary_acceptance_records_removed": True}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", required=True)
    parser.parse_args()
    asyncio.run(verify())
