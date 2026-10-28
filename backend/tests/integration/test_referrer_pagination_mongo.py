"""Actual Mongo semantics for bounded directory reads; disposable local data only."""
import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorClient

from models import UserPublic
from routes import referrer_routes as directory
from routes import sales_workspace_routes as reporting
from tests.integration.test_purchase_completion_mongo import mongo_url  # noqa: F401


class CountedCollection:
    def __init__(self, collection): self.collection = collection; self.finds = []; self.counts = []
    def find(self, query, projection):
        self.finds.append((query, projection))
        return self.collection.find(query, projection)
    async def count_documents(self, query):
        self.counts.append(query)
        return await self.collection.count_documents(query)


def test_pages_search_history_and_payload_against_real_mongo(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client[f"referrer_paging_{uuid4().hex}"]
        counted = CountedCollection(db.referrers)
        monkeypatch.setattr(directory, "db", SimpleNamespace(referrers=counted))
        monkeypatch.setattr(reporting, "db", SimpleNamespace(referrers=counted, floors=db.floors))
        user = UserPublic(id="fixture", email="fixture@example.test", full_name="Fixture", role="sales",
                          floor_ids=["first-floor", "ground-floor"], active_floor_id="first-floor")
        base = {"name": "Studio", "normalized_name": "studio", "type": "architect", "created_by": "fixture"}
        async def page(offset=0, search="", floor="first-floor,ground-floor", kind=None):
            return await directory.referrers_page(floor_id=floor, type=kind, search=search, offset=offset, limit=25, user=user)
        try:
            await db.floors.insert_many([{"id": floor, "active": True, "created_at": "2026-01-01"}
                                         for floor in ("first-floor", "ground-floor")])
            docs = [{**base, "id": f"{prefix}-{index:04}", "floor_id": floor}
                    for prefix, floor in (("a", "first-floor"), ("b", "ground-floor")) for index in range(2003)]
            docs += [{**base, "id": f"archived-{index:03}", "name": "A archived", "floor_id": "first-floor", "active": False} for index in range(100)]
            docs += [{**base, "id": "shared", "floor_id": "second-floor", "shared_across_floors": True},
                     {**base, "id": "private", "floor_id": "second-floor", "company": "Secret Studio"}]
            docs[2002].update(company="Studio (A)+", phone="9876543210")
            await db.referrers.insert_many(docs)
            first = await page()
            assert first["total"] == 4007 and [row.id for row in first["rows"]] == [f"a-{i:04}" for i in range(25)]
            assert len(counted.finds) == len(counted.counts) == 1
            late = await page(4000)
            assert [row.id for row in late["rows"]] == [f"b-{i:04}" for i in range(1997, 2003)] + ["shared"]
            assert (await page(floor="first-floor"))["total"] == 2004
            for search in ("Studio (A)+", "98765", "ARC-A-2002", "rc-a-2002"):
                result = await page(search=search)
                assert result["total"] == 1 and [row.id for row in result["rows"]] == ["a-2002"]
            assert (await page(search=".*"))["total"] == 0
            assert (await page(search="Secret Studio"))["total"] == 0
            assert (await page(kind="interior_designer"))["total"] == 0
            counted.finds.clear()
            result = await reporting._mark_historical_references(
                [{"id": f"a-{i:04}"} for i in range(1001)] + [{"id": id} for id in ("shared", "private", "archived-000", "missing")],
                "all", ["first-floor", "ground-floor"],
            )
            assert {row["id"] for row in result if row["historical"]} == {"private", "archived-000", "missing"}
            assert len(counted.finds) == 3 and all(projection == {"_id": 0, "id": 1} for _, projection in counted.finds)
            legacy = []
            for floor in ("first-floor", "ground-floor"):
                user.active_floor_id = floor
                legacy += await directory.list_referrers(type=None, include_inactive=False, user=user, include_counts=False)
            user.active_floor_id = "first-floor"
            counted.finds.clear(); counted.counts.clear()
            measured = await page()
            before = len(json.dumps(jsonable_encoder(legacy), separators=(",", ":")).encode())
            after = len(json.dumps(jsonable_encoder(measured), separators=(",", ":")).encode())
            evidence = {"fixture": "disposable local Mongo; two authorized floors, 4007 active visible references and 100 archived",
                        "before": {"find_commands": 2, "returned_contacts": len(legacy), "json_bytes": before, "limited_to_2000_per_floor": True},
                        "after": {"find_commands": len(counted.finds), "count_commands": len(counted.counts), "returned_contacts": len(measured["rows"]), "total": measured["total"], "json_bytes": after},
                        "json_reduction_percent": round((1 - after / before) * 100, 2)}
            print(json.dumps(evidence))
            target = os.environ.get("REFERRER_PAGING_EVIDENCE")
            if target: Path(target).write_text(json.dumps(evidence, indent=2) + "\n")
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_owner_all_units_retains_inactive_and_missing_floor_reference_history(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client[f"referrer_old_floors_{uuid4().hex}"]
        monkeypatch.setattr(directory, "db", db)
        monkeypatch.setattr(reporting, "db", db)
        base = {"name": "Studio", "normalized_name": "studio", "type": "architect", "created_by": "fixture"}
        owner = UserPublic(id="owner", email="owner@example.test", full_name="Owner", role="owner", active_floor_id="first-floor")
        try:
            await db.floors.insert_many([
                {"id": "first-floor", "active": True, "created_at": "2026-01-01"},
                {"id": "ground-floor", "active": True, "created_at": "2026-01-02"},
                {"id": "inactive-floor", "active": False, "created_at": "2026-01-03"},
            ])
            await db.referrers.insert_many([
                *[{**base, "id": f"active-{index:03}", "floor_id": "first-floor"} for index in range(30)],
                {**base, "id": "inactive-private", "floor_id": "inactive-floor"},
                {**base, "id": "missing-private", "floor_id": "missing-floor"},
                {**base, "id": "inactive-shared", "floor_id": "inactive-floor", "shared_across_floors": True},
            ])
            selected = await directory.referrers_page(floor_id="first-floor,ground-floor", type=None, search="", offset=0, limit=25, user=owner)
            assert selected["total"] == 31 and len(selected["rows"]) == 25
            assert not {"active-029", "inactive-private", "missing-private"} & {row.id for row in selected["rows"]}
            performance = [{"id": id} for id in ("active-029", "inactive-private", "missing-private", "inactive-shared")]
            result = await reporting._mark_historical_references(performance, "all", None)
            assert {row["id"] for row in result if row["historical"]} == {"inactive-private", "missing-private"}
            shared = await directory.referrers_page(floor_id="first-floor,ground-floor", type=None, search="ARC-INACTIVE-SHARED", offset=0, limit=25, user=owner)
            assert [row.id for row in shared["rows"]] == ["inactive-shared"]
            concrete = await reporting._mark_historical_references(performance, "inactive-floor", None)
            assert next(row for row in concrete if row["id"] == "inactive-private")["historical"] is False
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())
