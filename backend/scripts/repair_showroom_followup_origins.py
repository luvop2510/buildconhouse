"""Audit/repair confirmed showroom transfers hidden under their old origin.

Dry-run by default. Run with injected backend environment, never pasted secrets:
python scripts/repair_showroom_followup_origins.py --floor first-floor
Add --apply only after reviewing the counts. No rows are created or deleted.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

FLOORS = ("ground-floor", "first-floor", "second-floor", "third-floor")


async def repair(database, floor: str, *, apply: bool = False) -> dict:
    if floor not in FLOORS:
        raise ValueError("Choose one persisted business floor")
    result = {"floor": floor, "apply": apply, "candidates": 0, "repaired": 0, "conflicts": 0}
    query = {"floor_id": floor, "is_deleted": False,
             "showroom_transferred_at": {"$type": "string", "$ne": ""},
             "showroom_followup_id": {"$type": "string", "$ne": ""}}
    async for walkin in database.walkins.find(query, {"_id": 0, "id": 1, "customer_id": 1,
            "showroom_followup_id": 1}):
        customer_id, walkin_id = walkin.get("customer_id"), walkin.get("id")
        if any(not isinstance(value, str) or not value.strip() for value in (customer_id, walkin_id)):
            result["conflicts"] += 1
            continue
        identity = {"id": walkin["showroom_followup_id"], "floor_id": floor}
        row = await database.followups.find_one(identity, {"_id": 0})
        # Never guess another customer's identity or repurpose an unrelated lead.
        if (not row or row.get("origin") not in {"walkin", "visit_showroom"} or row.get("rule_type") != "manual"
                or row.get("customer_id") != customer_id
                or row.get("walkin_id") != walkin_id):
            result["conflicts"] += 1
            continue
        if row.get("origin") == "visit_showroom":
            continue
        result["candidates"] += 1
        if apply:
            changed = await database.followups.update_one(
                {**identity, "origin": "walkin", "rule_type": "manual",
                 "customer_id": customer_id, "walkin_id": walkin_id},
                {"$set": {"origin": "visit_showroom"}},
            )
            result["repaired"] += changed.modified_count
    return result


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--floor", choices=FLOORS, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    from db import client, db
    try:
        print(json.dumps(await repair(db, args.floor, apply=args.apply), sort_keys=True))
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(main())
