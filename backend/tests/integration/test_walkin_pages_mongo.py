"""Walk-in keyset boundaries and export scope against disposable local Mongo."""
import asyncio
import importlib
from uuid import uuid4

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from motor.motor_asyncio import AsyncIOMotorClient

from models import UserPublic
from routes import walkin_routes as routes
from tests.integration.test_purchase_completion_mongo import mongo_url  # noqa: F401


def record(index, **extra):
    return {"id": f"walkin-{index:05d}", "number": f"WI-{index}", "customer_id": "customer",
            "customer_name": "Visitor [literal]", "customer_phone": "9000000000",
            "visited_at": f"2026-11-{1 + index // 100:02d}", "floor_id": "first-floor",
            "is_deleted": False, "status": "new", "source": "Reference", **extra}


def test_walkin_pages_match_full_filters_and_do_not_truncate_at_legacy_export_limit(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client[f"walkin_pages_{uuid4().hex}"]
        monkeypatch.setattr(routes, "db", db)
        actor = UserPublic(id="owner", full_name="Owner", role="owner", active_floor_id="first-floor")
        app = FastAPI()
        app.include_router(routes.router)
        app.dependency_overrides[routes.get_current_user] = lambda: actor
        try:
            docs = [record(i, floor_id="first-floor" if i % 2 else "ground-floor",
                           status="contacted" if i % 3 else "new",
                           source="Reference" if i % 5 else "Instagram",
                           **({"manual_priority_override": "high"} if i % 7 == 0 else {}))
                    for i in range(2301)]
            docs.extend([record(3000, is_deleted=True), record(3001, showroom_followup_id="showroom"),
                         record(3002, showroom_transferred_at="2026-11-01")])
            await db.walkins.insert_many(docs)
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
                async def collect(params):
                    found, cursor = [], None
                    while True:
                        query = {**params, "limit": 40}
                        if cursor:
                            query.update(before_visited_at=cursor["visited_at"], before_id=cursor["id"])
                        response = await http.get("/walkins/page", params=query)
                        assert response.status_code == 200, response.text
                        body = response.json()
                        assert len(body["items"]) <= 40
                        found.extend(body["items"])
                        cursor = body["next_cursor"]
                        if cursor is None:
                            return found

                all_floors = {"floor_ids": "first-floor,ground-floor"}
                found = await collect(all_floors)
                expected = sorted(docs[:2301], key=lambda row: (row["visited_at"], row["id"]), reverse=True)
                assert [row["id"] for row in found] == [row["id"] for row in expected]
                assert len({row["id"] for row in found}) == 2301
                legacy = await http.get("/walkins", params=all_floors)
                assert len(legacy.json()) == 2000
                assert [row["id"] for row in legacy.json()] == [row["id"] for row in expected[:2000]]

                filters = {**all_floors, "status": "new,contacted", "source": "Reference",
                           "priority": "medium", "date_from": "2026-11-03", "date_to": "2026-11-08",
                           "search": "[literal]"}
                filtered = await collect(filters)
                expected_filter = [row for row in expected if row["source"] == "Reference"
                                   and not row.get("manual_priority_override")
                                   and "2026-11-03" <= row["visited_at"] <= "2026-11-08"]
                assert [row["id"] for row in filtered] == [row["id"] for row in expected_filter]
                full_filter = (await http.get("/walkins", params=filters)).json()
                assert [row["id"] for row in full_filter] == [row["id"] for row in filtered]
                assert not (await collect({**all_floors, "search": "[wildcard]"}))

                first = (await http.get("/walkins/page", params=all_floors)).json()
                cursor = first["next_cursor"]
                await db.walkins.delete_one({"id": cursor["id"]})
                await db.walkins.insert_one(record(9000, visited_at="2099-01-01"))
                next_page = (await http.get("/walkins/page", params={**all_floors,
                    "before_visited_at": cursor["visited_at"], "before_id": cursor["id"]})).json()
                assert [row["id"] for row in next_page["items"]] == [row["id"] for row in expected[40:80]]
                for params in ({"limit": 0}, {"limit": 51}, {"before_id": "x"}, {"before_visited_at": "x"}):
                    assert (await http.get("/walkins/page", params=params)).status_code == 422

                actor = UserPublic(id="sales", full_name="Sales", role="sales", floor_ids=["first-floor"], active_floor_id="first-floor")
                assert (await http.get("/walkins/page", params=all_floors)).status_code == 403
                assert all(row["floor_id"] == "first-floor" for row in (await http.get("/walkins/page")).json()["items"])
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_walkin_legacy_cursor_attribution_and_repeatable_index(mongo_url, monkeypatch):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client[f"walkin_legacy_page_{uuid4().hex}"]
        monkeypatch.setattr(routes, "db", db)
        migration = importlib.import_module("migrations.0044_walkin_stable_list_page")
        actor = UserPublic(id="owner", full_name="Owner", role="owner", active_floor_id="first-floor")
        app = FastAPI()
        app.include_router(routes.router)
        app.dependency_overrides[routes.get_current_user] = lambda: actor
        try:
            await db.users.insert_one({"id": "owner", "role": "owner"})
            await db.walkins.insert_many([record(i, visited_at="legacy/" + "x" * 150, salesperson_id="owner") for i in range(45)])
            await db.walkins.insert_one(record(100, visited_at="", assignments=[{"floor_id": "first-floor", "user_id": "worker", "user_name": "Assigned worker"}]))
            before = await db.walkins.find({}, {"_id": 0}).sort("id", 1).to_list(None)
            await migration.up(db)
            await migration.up(db)
            assert await db.walkins.find({}, {"_id": 0}).sort("id", 1).to_list(None) == before
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
                first = (await http.get("/walkins/page")).json()
                assert len(first["items"]) == 40
                assert all(row["salesperson_id"] is None for row in first["items"])
                cursor = first["next_cursor"]
                second = await http.get("/walkins/page", params={"before_visited_at": cursor["visited_at"], "before_id": cursor["id"]})
                assert second.status_code == 200
                assert len(second.json()["items"]) == 6 and second.json()["next_cursor"] is None
                assert second.json()["items"][-1]["salesperson_id"] == "worker"
                # Empty legacy visit strings are valid boundary values too.
                empty = await http.get("/walkins/page", params={"before_visited_at": "", "before_id": "walkin-00100"})
                assert empty.status_code == 200 and empty.json()["items"] == []
            plan = await db.command("explain", {"find": "walkins", "filter": {"is_deleted": False},
                "sort": {"visited_at": -1, "id": -1}, "limit": 41}, verbosity="executionStats")
            assert plan["executionStats"]["totalDocsExamined"] == 41
            assert migration.NAME in str(plan["queryPlanner"]["winningPlan"])
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())
