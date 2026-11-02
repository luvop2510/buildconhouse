"""Owner-initiated reset of sanitary customer workflows, retaining inventory."""
from uuid import UUID
from fastapi import HTTPException
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from models import now_iso
from services.customer_data_reset import related_customer_query
from services.customer_deletion import apply_plan, plan_deletion

FLOOR = "first-floor"


def assert_floor(plan, floor_id):
    # Never let an imported customer graph silently erase another floor.
    for collection, rows in plan["delete"].items():
        for row in rows:
            floor = row.get("floor_id")
            if floor and floor != floor_id:
                raise HTTPException(409, f"Customer data is linked to another floor ({collection}).")
    for collection, changes in plan["updates"].items():
        for row, _ in changes:
            floor = row.get("floor_id")
            if floor and floor != floor_id:
                raise HTTPException(409, f"Customer data is linked to another floor ({collection}).")


async def reset_customer_floor(database, client, actor_id, request_id, floor_id=FLOOR):
    if floor_id not in {"first-floor", "ground-floor"}:
        raise HTTPException(403, "Reset is available only on the Ground and Sanitary floors.")
    try:
        UUID(request_id)
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, "A valid reset request ID is required.")
    receipt_id = "customer-floor-reset:" + floor_id + ":" + request_id

    async def operation(session):
        previous = await database.settings.find_one({"id": receipt_id}, session=session)
        if previous:
            if previous.get("actor_id") != actor_id:
                raise HTTPException(409, "Reset request belongs to another account.")
            return {"ok": True, "already_applied": True}
        customers = await database.customers.find({"floor_id": floor_id}, session=session).to_list(10001)
        if len(customers) > 10000:
            raise HTTPException(409, "Too many customers to reset together.")
        files = []
        async def execute(plan):
            assert_floor(plan, floor_id)
            files.extend(plan["files"])
            await apply_plan(database, plan, session)
        for row in customers:
            if await database.customers.find_one({"id": row["id"], "floor_id": floor_id}, session=session):
                await execute(await plan_deletion(database, customer_id=row["id"], session=session))
        # Drafts with no customer are not reachable through a customer graph.
        quotes = await database.quotations.find({"floor_id": floor_id}, session=session).to_list(10001)
        if len(quotes) > 10000:
            raise HTTPException(409, "Too many quotations to reset together.")
        for quote in quotes:
            if await database.quotations.find_one({"id": quote["id"], "floor_id": floor_id}, session=session):
                await execute(await plan_deletion(database, quotation=quote, session=session))
        # Remove orphan leads and payments as well as customer-linked legacy
        # purchases; supplier-only inventory purchases remain in place.
        for name in ("walkins", "followups", "payments"):
            await database[name].delete_many({"floor_id": floor_id}, session=session)
        orphan_purchase = {"$and": [{"floor_id": floor_id}, related_customer_query()]}
        purchases = await database.purchase_orders.find(orphan_purchase, session=session).to_list(10001)
        if len(purchases) > 10000:
            raise HTTPException(409, "Too many purchases to reset together.")
        from media_storage.factory import private_bucket
        for purchase in purchases:
            for attachment in purchase.get("attachments", []):
                key = attachment.get("storage_key")
                if key:
                    if not key.startswith("purchase-orders/" + purchase["id"] + "/") or ".." in key.split("/"):
                        raise HTTPException(409, "Purchase attachment needs attention before reset.")
                    files.append({"bucket": private_bucket(), "key": key})
        await database.purchase_orders.delete_many(orphan_purchase, session=session)
        await database.settings.update_one({"id": "customer-reset-generation:" + floor_id},
            {"$set": {"generation": request_id}}, upsert=True, session=session)
        await database.settings.insert_one({"id": receipt_id, "kind": "customer_deletion_receipt", "actor_id": actor_id,
            "completed_at": now_iso(), "pending_private_files": files}, session=session)
        return {"ok": True, "already_applied": False, "_customer_ids": [row["id"] for row in customers]}

    async with await client.start_session() as session:
        return await session.with_transaction(operation, read_concern=ReadConcern("snapshot"), write_concern=WriteConcern("majority"))
