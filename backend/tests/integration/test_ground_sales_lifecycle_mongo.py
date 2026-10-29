"""Run-owned local replica: summary HTTP reads and atomic linked sales losses."""
import asyncio
import os
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from motor.motor_asyncio import AsyncIOMotorClient


def test_summary_pages_and_lost_followups_use_real_mongo(monkeypatch):
    uri = os.environ.get("TILE_DRAFT_TEST_MONGO_URL")
    if uri != "mongodb://127.0.0.1:28176":
        pytest.skip("Explicit run-owned local replica required")
    assert os.environ.get("PYTHON_DOTENV_DISABLED") == "1"
    import auth
    import db as connection
    from models import UserPublic
    from routes import followup_routes as followups, quotation_routes as quotes

    async def run():
        client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=3000)
        database = client["forge_ground_lifecycle_qa_" + uuid4().hex]
        monkeypatch.setattr(connection, "client", client)
        monkeypatch.setattr(quotes, "db", database)
        monkeypatch.setattr(followups, "db", database)
        actor = UserPublic(id="local-sales-qa", full_name="Local QA", role="owner", active_floor_id="ground-floor")
        app = FastAPI()
        app.dependency_overrides[auth.get_current_user] = lambda: actor
        app.include_router(quotes.router, prefix="/api")
        try:
            await database.quotations.insert_many([{
                "id": f"q-{index:03d}", "number": f"TQ-{index}", "doc_type": "tiles_quotation",
                "floor_id": "ground-floor", "customer_id": "c", "customer_name": f"Buyer {index}",
                "status": "approved" if index == 120 else "draft", "grand_total": 100,
                "created_at": "2026-10-30T00:00:00Z", "updated_at": "v1",
                "items": [{"name": "Synthetic tile", "qty": 1}],
                "phone_snapshot": "private-fixture", "revisions": [{"private": True}],
            } for index in range(125)])
            await database.quotations.insert_one({"id": "foreign", "floor_id": "first-floor", "status": "draft", "customer_name": "Buyer 124"})
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-qa") as http:
                base = "/api/quotations?doc_type=tiles_quotation&view=pending&summary=true&limit=31"
                first = await http.get(base)
                assert first.status_code == 200, first.text
                rows = first.json()
                assert len(rows) == 31 and rows[0]["id"] == "q-124"
                assert rows[0]["item_count"] == 1
                assert not {"items", "phone_snapshot", "revisions", "_id"} & rows[0].keys()
                second = (await http.get(base + "&skip=30")).json()
                assert rows[30]["id"] == second[0]["id"]
                assert len({row["id"] for row in rows[:30] + second[:30]}) == 60
                assert len((await http.get(base + "&q=Buyer%20124")).json()) == 1
                assert (await http.get(base + "&q=%5B.*%5D")).json() == []

                for floor in ("ground-floor", "first-floor"):
                    qid, fid = f"lost-{floor}", f"followup-{floor}"
                    quote = {"id": qid, "floor_id": floor, "customer_id": "c", "doc_type": "tiles_quotation" if floor == "ground-floor" else "standard", "status": "approved"}
                    reminder = {"id": fid, "floor_id": floor, "customer_id": "c", "quotation_id": qid, "status": "open", "updated_at": "v1"}
                    await database.quotations.insert_one(quote.copy())
                    await database.followups.insert_many([reminder.copy(), {**reminder, "id": fid + "-sibling", "status": "snoozed"}])
                    patch = {"status": "dismissed", "completed_at": "v2", "completed_outcome": "lost", "resolution_note": "Other supplier", "lost_reason": "Other supplier", "updated_at": "v2"}
                    await followups._record_lost_quotation_followup(reminder, {"$set": patch, "$inc": {"call_attempts": 1}}, actor)
                    saved = await database.quotations.find_one({"id": qid})
                    assert saved["customer_outcome"] == "lost" and saved["status"] == "approved"
                    assert await database.followups.count_documents({"quotation_id": qid, "completed_outcome": "lost"}) == 2
                    with pytest.raises(HTTPException) as error:
                        await quotes.place_order_confirm(qid, quotes.PlaceOrderConfirmPayload(), actor)
                    assert error.value.status_code == 409
                    assert await database.event_outbox.count_documents({}) == 0

                completed = (await http.get("/api/quotations?doc_type=tiles_quotation&view=completed&summary=true")).json()
                assert [row["id"] for row in completed] == ["q-120"]
                lost = (await http.get("/api/quotations?doc_type=tiles_quotation&view=lost&summary=true")).json()
                assert [row["id"] for row in lost] == ["lost-ground-floor"]

                # A write failure after the quotation change rolls back the whole loss.
                reminder = {"id": "missing", "floor_id": "ground-floor", "customer_id": "c", "quotation_id": "q-001", "status": "open", "updated_at": "v1"}
                await database.followups.insert_one(reminder.copy())
                class BrokenFollowups:
                    find_one = database.followups.find_one
                    async def update_one(self, *args, **kwargs):
                        raise RuntimeError("injected follow-up write failure")
                from types import SimpleNamespace
                monkeypatch.setattr(followups, "db", SimpleNamespace(quotations=database.quotations, followups=BrokenFollowups()))
                with pytest.raises(RuntimeError, match="injected"):
                    await followups._record_lost_quotation_followup(reminder, {"$set": patch}, actor)
                assert "customer_outcome" not in await database.quotations.find_one({"id": "q-001"})
                assert (await database.followups.find_one({"id": "missing"}))["status"] == "open"
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(run())
