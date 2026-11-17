"""Small reusable driver directory; each dispatch retains its own snapshot.

The normalized mobile is the identity, scoped to the dispatch floor. Mongo's
built-in unique _id makes concurrent first use safe without a data migration.
Trip fields (receiver, destination, reference and labour) never enter profiles.
"""
from __future__ import annotations

import re

from pydantic import BaseModel, Field, field_validator, model_validator

from models import now_iso


def normalize_driver_mobile(value: str | None) -> str | None:
    if not value or not value.strip():
        return None
    if re.search(r"[^\d\s()+-]", value):
        raise ValueError("Enter a valid driver mobile number")
    digits = re.sub(r"\D", "", value)
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) != 10:
        raise ValueError("Enter a 10 digit driver mobile number")
    return digits


class DriverSnapshotFields(BaseModel):
    driver_name: str | None = Field(default=None, max_length=120)
    driver_mobile: str | None = Field(default=None, max_length=30)
    vehicle_number: str | None = Field(default=None, max_length=40)

    @field_validator("driver_mobile")
    @classmethod
    def valid_mobile(cls, value):
        return normalize_driver_mobile(value)

    @field_validator("driver_name", "vehicle_number")
    @classmethod
    def trimmed(cls, value):
        return value.strip() if value is not None else None

    @model_validator(mode="after")
    def named_driver(self):
        if self.driver_mobile and not self.driver_name:
            raise ValueError("Enter the driver's name to save their mobile number")
        return self


async def save_dispatch_driver(database, snapshot: DriverSnapshotFields, *, floor_id: str, actor_id: str, session):
    """Run inside the dispatch transaction so a failed dispatch saves no profile.

    Old callers may omit a mobile and continue dispatching. A name alone must
    never merge unrelated drivers; only entered mobile numbers create profiles.
    """
    if not snapshot.driver_mobile:
        return
    now = now_iso()
    await database.dispatch_drivers.update_one(
        {"_id": f"{floor_id}:{snapshot.driver_mobile}"},
        {"$set": {
            "floor_id": floor_id, "mobile": snapshot.driver_mobile,
            "name": snapshot.driver_name, "vehicle_number": snapshot.vehicle_number or "",
            "updated_at": now, "updated_by": actor_id,
        }, "$setOnInsert": {"created_at": now, "created_by": actor_id}},
        upsert=True, session=session,
    )


def _phone_search_digits(text: str) -> str:
    if re.search(r"[^\d\s()+-]", text):
        return ""
    digits = re.sub(r"\D", "", text)
    if digits.startswith("91") and (len(digits) > 10 or (text.startswith("+") and len(digits) > 2)):
        return digits[2:]
    if len(digits) == 11 and digits.startswith("0"):
        return digits[1:]
    return digits


async def search_dispatch_drivers(database, *, floor_id: str, search: str):
    text = search.strip()[:80]
    query = {"floor_id": floor_id}
    projection = {"_id": 0, "name": 1, "mobile": 1, "vehicle_number": 1}
    sort = {"updated_at": -1, "_id": 1}
    limit = 12
    if not text:
        return await database.dispatch_drivers.find(query, projection).sort(list(sort.items())).to_list(limit)

    literal = re.escape(text)
    fields = {"name": literal, "vehicle_number": literal}
    digits = _phone_search_digits(text)
    if digits:
        fields["mobile"] = re.escape(digits)

    query["$or"] = [
        {field: {"$regex": pattern, "$options": "i"}}
        for field, pattern in fields.items()
    ]

    def matches(suffix: str):
        return {"$or": [
            {"$regexMatch": {"input": {"$ifNull": [f"${field}", ""]}, "regex": f"^{pattern}{suffix}", "options": "i"}}
            for field, pattern in fields.items()
        ]}

    # Rank before limiting so newer substring hits can't hide an exact or
    # prefix match. Mongo returns only the compact, bounded result set.
    pipeline = [
        {"$match": query},
        {"$set": {"search_rank": {"$switch": {"branches": [
            {"case": matches("$"), "then": 0},
            {"case": matches(""), "then": 1},
        ], "default": 2}}}},
        {"$sort": {"search_rank": 1, **sort}},
        {"$limit": limit},
        {"$project": projection},
    ]
    return await database.dispatch_drivers.aggregate(pipeline).to_list(limit)
