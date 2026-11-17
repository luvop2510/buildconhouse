"""Append-only stage interactions, independent of workflow transitions.

The unique (project, stage, number) index arbitrates concurrent writers. A
deterministic actor/request ID makes an uncertain response safe to retry without
allocating another number. No history array or project BSON size limits entries.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Literal

from fastapi import HTTPException
from pydantic import Field, field_validator
from pymongo.errors import DuplicateKeyError

from models_kitchen import CommandKey, Stage, StrictModel, date_only
from services import kitchen_access as access
from services.kitchen_projects import KitchenProjectService, bounded_read


class CreateStageFollowup(StrictModel):
    stage: Stage
    date: str
    notes: str = Field(default="", max_length=250)
    interaction_type: Literal["Visit", "Call"]
    idempotency_key: CommandKey

    _date = field_validator("date", mode="before")(date_only)

    @field_validator("notes")
    @classmethod
    def single_line(cls, value):
        if "\n" in value or "\r" in value:
            raise ValueError("Use a short one-line note")
        return value


def public_followup(row, user):
    result = {key: value for key, value in row.items() if key not in {"_id", "request_fingerprint"}}
    if access.restricted(user):
        result["notes"] = None
    return result


class KitchenStageFollowups:
    def __init__(self, database):
        self.db = database

    async def project(self, user, project_id, action="view"):
        project = await self.db.kitchen_projects.find_one({"id": project_id, "floor_id": access.KITCHEN_FLOOR})
        await access.require_project(self.db, user, project, {}, action)
        return project

    async def list(self, user, project_id, *, stage=None, page=1, limit=30):
        async with bounded_read():
            await self.project(user, project_id)
            stages = access.semantic_stages(user)
            if stage and stage not in stages:
                raise HTTPException(403, "Kitchen stage history is not permitted")
            selector = {"floor_id": access.KITCHEN_FLOOR, "project_id": project_id,
                        "stage": stage if stage else {"$in": stages}}
            collection = self.db.kitchen_stage_followups
            total = await collection.count_documents(selector, maxTimeMS=5000)
            order = [("number", -1)] if stage else [("created_at", -1), ("id", 1)]
            rows = await collection.find(selector, {"_id": 0}).sort(order).skip((page - 1) * limit).limit(limit).max_time_ms(5000).to_list(limit)
            return {"rows": [public_followup(row, user) for row in rows], "total": total,
                    "page": page, "limit": limit}

    async def create(self, user, project_id, body: CreateStageFollowup):
        # Use the existing policy admission as well as HTTP graph admission.
        # Deletion therefore cannot race a child insert, and a policy edit never
        # silently changes an admitted operation's authority.
        async with KitchenProjectService(self.db).admission(user, "update", scope={"project_id": project_id}):
            project = await self.project(user, project_id, "update")
            if body.stage not in access.semantic_stages(user, "update") or body.stage not in access.semantic_stages(user):
                raise HTTPException(403, "Kitchen stage interaction is not permitted")
            collection = self.db.kitchen_stage_followups
            identity = hashlib.sha256(json.dumps([project_id, user.id, body.idempotency_key]).encode()).hexdigest()
            fingerprint = hashlib.sha256(json.dumps(body.model_dump(), sort_keys=True).encode()).hexdigest()
            for _ in range(8):
                saved = await collection.find_one({"_id": identity})
                if saved:
                    if saved.get("request_fingerprint") != fingerprint:
                        raise HTTPException(409, "This follow-up request was already used with different details")
                    return {**public_followup(saved, user), "replayed": True}
                latest = await collection.find_one({"project_id": project_id, "floor_id": access.KITCHEN_FLOOR,
                    "stage": body.stage}, sort=[("number", -1)])
                row = {"_id": identity, "id": identity, "project_id": project_id,
                       "customer_id": project["customer_id"], "floor_id": access.KITCHEN_FLOOR,
                       "stage": body.stage, "number": (latest["number"] if latest else 0) + 1,
                       "date": body.date, "notes": body.notes, "interaction_type": body.interaction_type,
                       "actor_id": user.id, "actor_name": user.full_name,
                       "created_at": datetime.now(timezone.utc).isoformat(), "request_fingerprint": fingerprint}
                try:
                    await collection.insert_one(dict(row))
                    return public_followup(row, user)
                except DuplicateKeyError:
                    # Either this exact intent committed, or another writer won
                    # the next number. Re-read both without overwriting either.
                    continue
            raise HTTPException(409, "Another follow-up is saving; retry this same entry")
