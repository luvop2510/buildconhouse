"""Run-owned Mongo + real authenticated Home search API acceptance.

Run only this file with KITCHEN_TEST_MONGO_URL and hermetic runtime settings.
The shared harness creates/drops a random database and never boots production.
"""
import asyncio
from uuid import uuid4

import pytest
from tests.integration.test_tile_release_godown_mongo import tile_replica


@pytest.fixture(autouse=True)
def owned_replica(tile_replica, monkeypatch):
    monkeypatch.setenv("KITCHEN_TEST_MONGO_URL", tile_replica.split("?")[0])
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")

from auth import invalidate_principal_cache
from services.access_grants import build_grant
from tests.integration.test_kitchen_projects_mongo import environment, headers, create_project


def test_home_search_real_phone_matching_current_profile_and_source_permissions():
    async def scenario():
        async with environment() as env:
            project, _ = await create_project(env)
            customer = env["ids"]["customer"]
            await env["db"].customers.update_one({"id": customer}, {"$set": {"phone": "+91 (98765) 43210"}})
            await env["db"].kitchen_projects.update_one({"id": project["id"]}, {"$set": {
                "customer.phone": "+91 (98765) 43210", "stage": "completed", "completion_date": "2026-11-15",
                "installation": {"status": "Completed", "notes": "Saved installation history", "completed_date": "2026-11-15"},
                "activity": [{"id": "past-stage", "type": "stage.changed", "at": "2026-11-14", "actor_id": env["ids"]["owner"], "payload": {"from_stage": "installation", "to_stage": "completed"}}],
                "attachments": [{"id": "saved-pdf", "filename": "design.pdf", "content_type": "application/pdf", "stage": "design", "storage_key": "private-object", "bucket": "private"}]}})
            await env["db"].kitchen_stage_followups.insert_one({"id": "interaction", "floor_id": "second-floor", "project_id": project["id"], "customer_id": customer, "stage": "lead", "number": 1, "date": "2026-11-10", "interaction_type": "Call", "notes": "Saved inquiry call", "request_fingerprint": "private"})
            await env["db"].customers.insert_one({"id": str(uuid4()), "floor_id": "first-floor", "name": "Other floor Meena", "phone": "+91 (98765) 43210"})
            for term in ("Kitchen acceptance customer", "acceptance cust", "9876543210", "98765", "+91 98765 43210"):
                response = await env["api"].get("/api/customer-search", params={"search": term}, headers=headers(env))
                assert response.status_code == 200, response.text
                rows = response.json()["rows"]
                assert any(row["kind"] == "kitchen" and row["id"] == project["id"] for row in rows)
                if "98765" in term:
                    assert {row["floor_id"] for row in rows} == {"first-floor", "second-floor"}
            response = await env["api"].get("/api/customer-search/profile", params={"kind": "kitchen", "id": project["id"], "floor_id": "second-floor"}, headers=headers(env))
            assert response.status_code == 200, response.text
            assert response.headers["cache-control"] == "no-store"
            assert response.json()["records"] == []
            assert response.json()["workflows"] == []
            # Completed stages disappear from the current view, while immutable
            # workflow/file/follow-up evidence remains safely stored.
            stored = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            assert stored["installation"]["notes"] == "Saved installation history"
            assert stored["activity"][0]["payload"]["from_stage"] == "installation"
            assert stored["attachments"][0]["storage_key"] == "private-object"
            assert await env["db"].kitchen_stage_followups.count_documents({"project_id": project["id"]}) == 1
            assert "private-object" not in response.text and '"request_fingerprint"' not in response.text
            # The normal Kitchen worker has this floor only, so same phone on
            # another floor never enlarges the consolidated identity.
            response = await env["api"].get("/api/customer-search", params={"search": "98765"}, headers=headers(env, "worker"))
            assert response.status_code == 200
            assert all(row["floor_id"] == "second-floor" for row in response.json()["rows"])
            # Replace all-section access with a single stage grant. Current-stage
            # Completed records and their direct profile must disappear.
            grant = build_grant(user_id=env["ids"]["worker"], resource="kitchen_design", actions=["view"], floor_id="second-floor", expires_at=None, actor_id=env["ids"]["owner"], actor_name="Synthetic owner")
            await env["db"].users.update_one({"id": env["ids"]["worker"]}, {"$set": {"delegation_grants": [grant]}})
            invalidate_principal_cache("staff", env["ids"]["worker"])
            response = await env["api"].get("/api/customer-search", params={"search": "98765"}, headers=headers(env, "worker"))
            assert response.status_code == 200 and response.json()["rows"] == [], response.text
            response = await env["api"].get("/api/customer-search/profile", params={"kind": "kitchen", "id": project["id"], "floor_id": "second-floor"}, headers=headers(env, "worker"))
            assert response.status_code == 404
            # A customer soft deletion also retires related shared source rows.
            await env["db"].customers.update_one({"id": customer}, {"$set": {"deleted_at": "2026-11-16"}})
            await env["db"].followups.insert_one({"id": "old-shared", "floor_id": "second-floor", "customer_id": customer, "customer_name": "Kitchen acceptance customer"})
            response = await env["api"].get("/api/customer-search", params={"search": "Kitchen acceptance customer"}, headers=headers(env))
            assert response.status_code == 200 and response.json()["rows"] == [], response.text
    asyncio.run(scenario())


def test_cross_floor_confirmation_reversal_profile_balances_and_sale_totals():
    from dataclasses import replace
    from importlib import import_module

    from services.analytics.unified import Query, load_model, totals
    from services.canonical_customers import canonical_customer_ids, review_state

    async def scenario():
        async with environment() as env:
            db = env["db"]
            api = env["api"]
            owner = headers(env, floor="first-floor")
            worker = headers(env, "worker")
            migration = import_module("migrations.0046_customer_identity_links")
            await migration.up(db)
            await migration.up(db)
            await db.floors.insert_many([{"id": floor, "active": True} for floor in ("ground-floor", "third-floor")])
            ground, sanitary, furniture, relative, namesake = [str(uuid4()) for _ in range(5)]
            docs = [
                {"id": ground, "floor_id": "ground-floor", "name": "Synthetic person", "phone": "9888812345"},
                {"id": sanitary, "floor_id": "first-floor", "name": "Synthetic person", "phone": "+91 (98888) 12345"},
                {"id": furniture, "floor_id": "third-floor", "name": "Synthetic person", "phone": "09888812345", "imported_from_customer_id": sanitary},
                {"id": relative, "floor_id": "first-floor", "name": "Synthetic relative", "phone": "9888812345"},
                {"id": namesake, "floor_id": "ground-floor", "name": "Synthetic person", "phone": "9888812346"},
            ]
            await db.customers.insert_many(docs)
            quotes = [
                {"id": "ground-order", "floor_id": "ground-floor", "customer_id": ground, "status": "ordered", "number": "ORDER-1",
                 "grand_total": 300, "ordered_at": "2026-11-18T11:00:00+05:30"},
                {"id": "sanitary-order", "floor_id": "first-floor", "customer_id": sanitary, "status": "ordered", "number": "ORDER-2",
                 "grand_total": 200, "ordered_at": "2026-11-19T10:30:00+05:30"},
                {"id": "past-quote", "floor_id": "first-floor", "customer_id": sanitary, "status": "cancelled", "number": "QUOTE-PAST"},
            ]
            await db.quotations.insert_many(quotes)
            await db.furniture_quotations.insert_one({"id": "furniture-order", "floor_id": "third-floor", "customer_id": furniture,
                "status": "final", "total_payable_rmb": 80, "total_received_rmb": 80, "balance_rmb": 0, "finalized_at": "2026-11-20T10:00:00+05:30"})
            await db.payments.insert_many([
                {"id": "receipt", "floor_id": "first-floor", "quotation_id": "sanitary-order", "status": "completed", "amount": 125},
                {"id": "wrong-floor", "floor_id": "ground-floor", "quotation_id": "sanitary-order", "status": "completed", "amount": 999},
            ])
            await db.followups.insert_many([{"id": f"reminder-{i}", "floor_id": "first-floor", "customer_id": sanitary,
                "status": "open", "due_at": f"2026-11-{i}T05:00:00Z"} for i in (19, 20)])
            q = Query(preset="all")
            before = totals(await load_model(db, q, None))
            assert (before["sales"], before["sales_rnb"], before["orders"], before["customers"]) == (500, 80, 3, 2)

            query = {"search": "98888 12345"}
            search = await api.get("/api/customer-search", headers=owner, params=query)
            assert search.json()["total"] == 3
            candidates = await api.get("/api/customer-search/identity-review", headers=owner)
            assert any({ground, sanitary, furniture, relative} == set(row["customer_ids"]) for row in candidates.json()["rows"] if row["evidence"] == "phone")
            decision = {"customer_ids": [ground, sanitary], "decision": "same", "note": "Verified with this synthetic person", "expected_revision": 0}
            assert (await api.get("/api/customer-search/identity-review", headers=worker)).status_code == 403
            assert (await api.post("/api/customer-search/identity-review", headers=worker, json=decision)).status_code == 403
            saved = await api.post("/api/customer-search/identity-review", headers=owner, json=decision)
            assert saved.status_code == 200, saved.text
            assert (await api.post("/api/customer-search/identity-review", headers=owner, json=decision)).json() == saved.json()
            identity = await canonical_customer_ids(db, [ground, sanitary, furniture, namesake, relative])
            assert identity[ground] == identity[sanitary] == identity[furniture]
            assert identity[namesake] != identity[relative] and identity[relative] != identity[ground]
            after = totals(await load_model(db, q, None))
            assert (after["sales"], after["sales_rnb"], after["orders"], after["customers"]) == (500, 80, 3, 1)
            assert len(await load_model(db, replace(q, customer_id=sanitary), None)) == 3
            assert (await api.get("/api/customer-search", headers=owner, params=query)).json()["total"] == 2

            profile_query = {"kind": "customer", "id": ground, "floor_id": "ground-floor"}
            profile_resp = await api.get("/api/customer-search/profile", headers=owner, params=profile_query)
            assert profile_resp.status_code == 200, profile_resp.text
            profile = profile_resp.json()
            assert set(profile["departments"]) == {"first-floor", "ground-floor", "third-floor"}
            assert {row["summary"]["id"] for row in profile["records"]} == {"ground-order", "sanitary-order", "furniture-order", "reminder-19", "reminder-20"}
            assert {row["summary"]["id"] for row in profile["history"]} == {"past-quote"}
            assert {row["id"]: row["outstanding"] for row in profile["payments"]} == {"ground-order": 300, "sanitary-order": 75}
            assert (await api.get("/api/customer-search/profile", headers=worker, params=profile_query)).status_code == 404
            assert (await api.get("/api/customer-search/candidates", headers=worker, params={"phone": "9888812345"})).json() == []

            decision.update(decision="distinct", note="Reversed test decision", expected_revision=1)
            revoked = await api.post("/api/customer-search/identity-review", headers=owner, json=decision)
            assert revoked.status_code == 200, revoked.text
            assert len((await review_state(db))["history"]) == 2
            assert await db.quotations.count_documents({"id": {"$in": [row["id"] for row in quotes]}}) == 3
            assert (await api.get("/api/customer-search", headers=owner, params=query)).json()["total"] == 3

    asyncio.run(scenario())


def test_customer_intake_cross_floor_reuses_approved_link_and_retry():
    async def scenario():
        async with environment() as env:
            db, api = env["db"], env["api"]
            owner = headers(env, floor="first-floor")
            await db.floors.insert_one({"id": "ground-floor", "active": True})
            original = {"id": str(uuid4()), "floor_id": "ground-floor", "name": "QA contact", "phone": "9888812345", "address": "QA Address"}
            await db.customers.insert_many([original, {"id": "separate", "floor_id": "first-floor", "name": "QA contact", "phone": "9888812345"}])
            candidates = await api.get("/api/customer-search/candidates", headers=owner, params={"phone": "+91 98888 12345"})
            assert candidates.status_code == 200, candidates.text
            assert {row["id"] for row in candidates.json()} == {original["id"], "separate"}
            chosen = {"name": original["name"], "identity_source_customer_id": original["id"], "identity_source_floor_id": "ground-floor"}
            first, retry = await asyncio.gather(*(api.post("/api/customers", headers=owner, json=chosen) for _ in range(2)))
            assert first.status_code == retry.status_code == 200, (first.text, retry.text)
            assert first.json()["id"] == retry.json()["id"] != "separate"
            assert await db.customers.count_documents({"identity_source_customer_id": original["id"]}) == 1
            same_floor = await api.post("/api/customers", headers=owner, json={**chosen, "identity_source_customer_id": "separate", "identity_source_floor_id": "first-floor"})
            assert same_floor.json()["id"] == "separate"
            new = {"name": "Separate name", "phone": "9888812345", "request_key": str(uuid4())}
            first, retry = await asyncio.gather(*(api.post("/api/customers", headers=owner, json=new) for _ in range(2)))
            assert first.status_code == retry.status_code == 200
            assert first.json()["id"] == retry.json()["id"] != "separate"
            assert await db.customers.count_documents({"id": first.json()["id"]}) == 1
            assert (await api.post("/api/customers", headers=owner, json={**new, "name": "Edited name"})).status_code == 409

    asyncio.run(scenario())
