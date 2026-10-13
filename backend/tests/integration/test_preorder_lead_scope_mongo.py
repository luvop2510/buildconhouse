"""Floor/assignment/order/call invariants on an isolated local Mongo database."""
import asyncio
import importlib
import os
from uuid import uuid4

import pytest
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient

from models import Followup, FollowupCallOutcomePayload, FollowupContactPayload, UserPublic
from routes import followup_routes, quotation_routes
from services import activity_log, lead_scope
from services.access_grants import build_grant, granted_floor_ids


def local_url():
    url = os.environ.get("LEAD_REFERRALS_TEST_MONGO_URL", "")
    if not url:
        pytest.skip("Requires explicitly selected disposable local Mongo")
    assert url.startswith(("mongodb://127.0.0.1:", "mongodb://localhost:"))
    return url


def test_multifloor_assignment_retry_conflicts_calls_reporting_and_order_consolidation(monkeypatch):
    async def run():
        client = AsyncIOMotorClient(local_url())
        db = client[f"forge_preorder_test_{uuid4().hex}"]
        owner = UserPublic(id="owner", email="owner@example.test", full_name="Owner", role="owner", active_floor_id="first-floor")
        worker = UserPublic(id="worker-a", email="a@example.test", full_name="Worker A", role="sales", floor_ids=["first-floor"], active_floor_id="first-floor")
        for module in (followup_routes, quotation_routes, activity_log):
            monkeypatch.setattr(module, "db", db)
        try:
            migration = importlib.import_module("migrations.0034_preorder_lead_scope")
            await migration.up(db)
            await migration.up(db)
            await db.floors.insert_many([{"id": f, "active": True} for f in ("first-floor", "ground-floor", "second-floor", "third-floor")])
            await db.users.insert_many([
                {"id": "worker-a", "full_name": "Worker A", "role": "sales", "floor_ids": ["first-floor"], "active": True},
                {"id": "worker-b", "full_name": "Worker B", "role": "sales", "floor_ids": ["first-floor", "ground-floor"], "active": True},
            ])
            await db.customers.insert_one({"id": "customer", "name": "Lead", "phone": "9909906652", "floor_id": "first-floor"})
            source = Followup(id="source", floor_id="first-floor", customer_id="customer", customer_name="Lead", customer_phone="9909906652", category="sales", reason="Discuss samples", due_at="2026-10-14T10:00:00Z").model_dump()
            await db.followups.insert_one(source)
            assignments = [{"floor_id": "first-floor", "user_id": "worker-a"}, {"floor_id": "first-floor", "user_id": "worker-b"}, {"floor_id": "ground-floor", "user_id": "worker-b"}]
            grouped = await lead_scope.update_interests(db, user=owner, source=source, floor_ids=["first-floor", "ground-floor"], assignments=assignments)
            assert len(grouped["assignments"]) == 3
            assert await db.followups.count_documents({"lead_group_id": "source", "status": "open"}) == 2
            await lead_scope.update_interests(db, user=owner, source=grouped, floor_ids=["first-floor", "ground-floor"], assignments=assignments)
            assert await db.followups.count_documents({}) == 2
            local = await lead_scope.update_interests(db, user=owner, source=grouped, floor_ids=["first-floor"], assignments=assignments[:2])
            assert await db.followups.count_documents({"floor_id": "ground-floor", "status": "dismissed"}) == 1
            await lead_scope.update_interests(db, user=owner, source=local, floor_ids=["first-floor", "ground-floor"], assignments=assignments)
            assert await db.followups.count_documents({"floor_id": "ground-floor", "status": "open"}) == 1
            with pytest.raises(HTTPException) as denied:
                await lead_scope.update_interests(db, user=worker, source=grouped, floor_ids=["first-floor", "ground-floor", "second-floor"])
            assert denied.value.status_code == 403
            with pytest.raises(HTTPException) as wrong_floor:
                await lead_scope.validate_scope(db, owner, ["ground-floor"], [{"floor_id": "ground-floor", "user_id": "worker-a"}])
            assert wrong_floor.value.status_code == 422
            # The actual UI contact + outcome pair is one call, with an actor
            # and the customer's response on the immutable activity timeline.
            await followup_routes.contact_followup("source", FollowupContactPayload(channel="call"), worker)
            await followup_routes.log_call("source", FollowupCallOutcomePayload(outcome="no_answer", response="Requested a call tomorrow"), worker)
            updated = await db.followups.find_one({"id": "source"})
            assert updated["call_attempts"] == updated["contact_attempts"] == 1
            report = await followup_routes.team_assign(floor_ids="first-floor,ground-floor", page=1, page_size=1, user=owner)
            a = next(w for w in report["workers"] if w["user_id"] == "worker-a")
            b = next(w for w in report["workers"] if w["user_id"] == "worker-b")
            assert a["calls_made"] == a["contacts_made"] == 1
            assert b["assigned_leads"] == 1 and b["calls_made"] == 0
            assert report["has_more"] is True
            assert any(e["payload"].get("response") == "Requested a call tomorrow" for e in a["leads"][0]["activity"])
            worker_b = UserPublic(id="worker-b", email="b@example.test", full_name="Worker B", role="sales", floor_ids=["first-floor", "ground-floor"], active_floor_id="first-floor")
            await followup_routes.contact_followup('source', FollowupContactPayload(channel='call'), worker)
            await followup_routes.contact_followup('source', FollowupContactPayload(channel='call'), worker_b)
            await followup_routes.log_call('source', FollowupCallOutcomePayload(outcome='no_answer'), worker)
            await followup_routes.log_call('source', FollowupCallOutcomePayload(outcome='no_answer'), worker_b)
            shared = await db.followups.find_one({'id': 'source'})
            assert shared['call_attempts'] == shared['contact_attempts'] == 3
            all_work = await followup_routes.team_assign(floor_ids='first-floor,ground-floor', page=1, page_size=50, user=owner)
            assert next(w for w in all_work['workers'] if w['user_id'] == 'worker-a')['calls_made'] == 2
            assert next(w for w in all_work['workers'] if w['user_id'] == 'worker-b')['calls_made'] == 1
            # A conflict on the last destination must leave the source intact.
            await db.customers.insert_one({"id": "ordered-kitchen", "floor_id": "second-floor", "phone_normalized": "9909906652"})
            await db.quotations.insert_one({"id": "ordered-existing", "floor_id": "second-floor", "customer_id": "ordered-kitchen", "status": "ordered"})
            before = await db.followups.find_one({"id": "source"})
            with pytest.raises(HTTPException) as conflict:
                await lead_scope.update_interests(db, user=owner, source=before, floor_ids=["first-floor", "ground-floor", "second-floor"], assignments=assignments)
            assert conflict.value.status_code == 409
            assert (await db.followups.find_one({"id": "source"}))["interested_floor_ids"] == before["interested_floor_ids"]
            await quotation_routes._complete_pre_confirmation_followups("order-one", quotation_number="ORDER-1", floor_id="first-floor", customer_id="customer", creator_id="original-creator", creator_name="Original creator")
            closed = await db.followups.find({"lead_group_id": "source"}).to_list(10)
            assert len(closed) == 2 and all(r["status"] == "done" and r["consolidated_order_id"] == "order-one" for r in closed)
            own_order = next(row for row in closed if row['floor_id'] == 'first-floor')
            assert own_order['quotation_id'] == 'order-one'
            assert own_order['assigned_to'] == 'original-creator'
            assert len(own_order['assignments']) == 3  # Historical worker assignments remain.
            with pytest.raises(HTTPException):
                await lead_scope.update_interests(db, user=owner, source=closed[0], floor_ids=["first-floor"])
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())


def test_notebook_assignee_stage_and_expired_or_deleted_staff():
    worker = {"id": "worker", "active": True, "custom_access": True, "role": "worker", "floor_ids": ["second-floor"]}
    grant = build_grant(user_id="worker", resource="notebook_quotations", actions=["view", "update"], floor_id="second-floor", expires_at=None, actor_id="owner", actor_name="Owner")
    worker["delegation_grants"] = [grant]
    assert lead_scope.can_assign(worker, "second-floor", notebook_converted=True)
    assert not lead_scope.can_assign(worker, "second-floor", notebook_converted=False)
    assert not lead_scope.can_assign({**worker, "is_deleted": True}, "second-floor", notebook_converted=True)
    assert granted_floor_ids([grant], user_id="worker", path="/api/followups/assignees", action="view") == ["second-floor"]


def test_migration_closes_postorder_and_confirmed_leads_but_preserves_unrelated_projects():
    async def run():
        client = AsyncIOMotorClient(local_url())
        db = client[f"forge_lead_migration_test_{uuid4().hex}"]
        try:
            await db.followups.create_index([('lead_group_id', 1), ('floor_id', 1)], name='equivalent_legacy_group_index')
            base = {'floor_id': 'first-floor', 'customer_id': 'customer', 'category': 'sales', 'status': 'open', 'rule_type': 'manual'}
            await db.quotations.insert_one({'id': 'order', 'number': 'ORDER-1', 'floor_id': 'first-floor', 'customer_id': 'customer', 'status': 'ordered'})
            await db.followups.insert_many([
                {**base, 'id': 'root', 'lead_group_id': 'shared'},
                {**base, 'id': 'sibling', 'floor_id': 'ground-floor', 'customer_id': 'local-customer', 'lead_group_id': 'shared'},
                {**base, 'id': 'operational', 'customer_id': 'another', 'category': 'payment'},
                {**base, 'id': 'other-project', 'quotation_id': 'different-quotation'},
                {**base, 'id': 'other-person', 'customer_id': 'different-customer'},
                {**base, 'id': 'closed-history', 'status': 'done', 'resolution_note': 'Historical reason'},
            ])
            migration = importlib.import_module('migrations.0034_preorder_lead_scope')
            await migration.up(db)
            first = await db.followups.find_one({'id': 'root'})
            assert first['consolidated_order_id'] == 'order'
            assert (await db.followups.find_one({'id': 'sibling'}))['consolidated_order_id'] == 'order'
            assert (await db.followups.find_one({'id': 'operational'}))['status'] == 'done'
            assert (await db.followups.find_one({'id': 'other-project'}))['status'] == 'open'
            assert (await db.followups.find_one({'id': 'other-person'}))['status'] == 'open'
            assert (await db.followups.find_one({'id': 'closed-history'}))['resolution_note'] == 'Historical reason'
            await migration.up(db)
            assert (await db.followups.find_one({'id': 'root'}))['completed_at'] == first['completed_at']
            assert await db.followups.count_documents({}) == 6
            assert await db.quotations.count_documents({'status': 'ordered'}) == 1
        finally:
            await client.drop_database(db.name)
            client.close()
    asyncio.run(run())
