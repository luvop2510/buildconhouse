"""Recoverable Kitchen customer removal using owner-configured delete access.

The customer pin, all project tombstones and audit receipt commit together.
Files and workflow evidence are retained for controlled recovery.
"""
from __future__ import annotations

import hashlib
import hmac
import json

from fastapi import HTTPException
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from models import now_iso
from services import kitchen_access as access
from services.customer_delete_access import require_customer_delete
from settings import settings

LIMIT = 1000


async def require_delete(database, user):
    await require_customer_delete(database, user, access.KITCHEN_FLOOR)
    # Delete Customers is separate from access to the affected Kitchen stages.
    # A grant cannot expose or remove another team's unpermitted project.
    await access.require_capability(database, user, "view")


def confirmation_for(user, customer, projects):
    snapshot = {"actor": user.id, "customer": customer["id"], "updated_at": customer.get("updated_at"),
                "projects": sorted((p["id"], p.get("version", 0)) for p in projects)}
    return hmac.new(settings.jwt_secret.encode(), json.dumps(snapshot, sort_keys=True).encode(), hashlib.sha256).hexdigest()


async def deletion_plan(database, user, project_id, *, session=None):
    project = await database.kitchen_projects.find_one({"id": project_id, "floor_id": access.KITCHEN_FLOOR}, session=session)
    if not project or not access.project_visible(project, user, {}):
        raise HTTPException(404, "Kitchen project not found")
    customer = await database.customers.find_one({"id": project["customer_id"], "floor_id": access.KITCHEN_FLOOR,
        "deleted_at": {"$exists": False}}, session=session)
    if not customer:
        raise HTTPException(404, "Kitchen customer not found")
    projects = await database.kitchen_projects.find({"customer_id": customer["id"], "floor_id": access.KITCHEN_FLOOR,
        "deleted_at": {"$exists": False}}, session=session).limit(LIMIT + 1).to_list(LIMIT + 1)
    if len(projects) > LIMIT:
        raise HTTPException(413, "This customer has too many projects for one deletion")
    if any(not access.project_visible(row, user, {}) for row in projects):
        raise HTTPException(403, "Deletion requires access to every affected Kitchen stage")
    return customer, projects


async def preview(database, user, project_id):
    await require_delete(database, user)
    customer, projects = await deletion_plan(database, user, project_id)
    return {"customer_id": customer["id"], "customer_name": customer.get("name", ""),
            "projects": [{"id": row["id"], "reference": row.get("project_reference") or row.get("reference") or "Kitchen project", "stage": row["stage"]} for row in projects],
            "confirmation": confirmation_for(user, customer, projects)}


async def remove(database, user, project_id, confirmation):
    await require_delete(database, user)
    async def commit(session):
        # A lost HTTP acknowledgement may be explicitly retried with the same
        # actor-bound confirmation, without deleting a newly created customer.
        receipt = await database.kitchen_customer_deletions.find_one({"project_id": project_id,
            "actor_id": user.id, "confirmation": confirmation}, session=session)
        if receipt:
            return {"deleted": True, "customer_id": receipt["customer_id"], "recoverable": True}
        customer, projects = await deletion_plan(database, user, project_id, session=session)
        if not hmac.compare_digest(confirmation_for(user, customer, projects), confirmation):
            raise HTTPException(409, "Customer or projects changed. Review the deletion again.")
        # Read fresh delegation on every delete request, including retries.
        await require_delete(database, user)
        at = now_iso()
        tombstone = {"deleted_at": at, "deleted_by": user.id, "is_deleted": True}
        changed = await database.customers.update_one({"id": customer["id"], "floor_id": access.KITCHEN_FLOOR,
            "deleted_at": {"$exists": False}}, {"$set": {**tombstone, "kitchen_delete_token": confirmation,
                "portal_enabled": False}}, session=session)
        if changed.matched_count != 1:
            raise HTTPException(409, "Customer changed. Review the deletion again.")
        await database.user_sessions.update_many({"user_id": customer["id"], "user_type": "customer"},
            {"$set": {"revoked": True}}, session=session)
        await database.download_tokens.update_many({"user_id": customer["id"], "kind": "customer"},
            {"$set": {"used": True}}, session=session)
        # Increment each aggregate version so in-flight saves/uploads cannot
        # replace its tombstone with their pre-deletion snapshot.
        for row in projects:
            result = await database.kitchen_projects.update_one({"id": row["id"], "floor_id": access.KITCHEN_FLOOR,
                "version": row["version"], "deleted_at": {"$exists": False}},
                {"$set": {**tombstone, "updated_at": at}, "$inc": {"version": 1}}, session=session)
            if result.matched_count != 1:
                raise HTTPException(409, "A project changed. Review the deletion again.")
        await database.kitchen_customer_deletions.insert_one({"_id": customer["id"], "customer_id": customer["id"],
            "project_id": project_id, "project_ids": [p["id"] for p in projects], "actor_id": user.id,
            "actor_name": user.full_name, "deleted_at": at, "confirmation": confirmation, "recoverable": True,
            "floor_id": access.KITCHEN_FLOOR, "portal_was_enabled": customer.get("portal_enabled", False)}, session=session)
        return {"deleted": True, "customer_id": customer["id"], "recoverable": True}
    async with await database.client.start_session() as session:
        return await session.with_transaction(commit, read_concern=ReadConcern("snapshot"), write_concern=WriteConcern("majority"))
