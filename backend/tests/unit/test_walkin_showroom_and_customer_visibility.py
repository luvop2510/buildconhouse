"""Walk-in transfer and confirmed-customer boundary, without external services."""
import asyncio
from unittest.mock import AsyncMock
import importlib
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response

from models import UserPublic
from routes import customer_routes, followup_routes, walkin_routes
from services.multi_filters import scoped_query


def user(floors=("first-floor",), role="sales"):
    return UserPublic(email="sales@example.com", full_name="Sales", role=role,
                      floor_ids=list(floors), active_floor_id=floors[0])


def match(row, query):
    for key, wanted in query.items():
        if key == "$and":
            if not all(match(row, item) for item in wanted):
                return False
        elif isinstance(wanted, dict):
            if "$in" in wanted and row.get(key) not in wanted["$in"]:
                return False
            if "$ne" in wanted and row.get(key) == wanted["$ne"]:
                return False
        elif row.get(key) != wanted:
            return False
    return True


class Cursor:
    def __init__(self, rows):
        self.rows = rows
    def sort(self, *_): return self
    def skip(self, n): self.rows = self.rows[n:]; return self
    def limit(self, n): self.rows = self.rows[:n]; return self
    async def to_list(self, n): return self.rows[:n]


class Store:
    def aggregate(self, _pipeline):
        assert not self.rows, "Nonempty purchase aggregates require the disposable Mongo suite"
        return Cursor([])
    def __init__(self, rows=()):
        self.rows = list(rows)
    async def find_one(self, query, *_):
        return next((dict(row) for row in self.rows if match(row, query)), None)
    def find(self, query, *_):
        return Cursor([dict(row) for row in self.rows if match(row, query)])
    async def update_one(self, query, update, upsert=False):
        row = next((row for row in self.rows if match(row, query)), None)
        if row is None and upsert:
            row = dict(update["$setOnInsert"])
            self.rows.append(row)
            return SimpleNamespace(modified_count=0)
        if row is not None:
            row.update(update.get("$set", {}))
        return SimpleNamespace(modified_count=int(row is not None))
    async def update_many(self, query, update):
        for row in self.rows:
            if match(row, query): row.update(update["$set"])
    async def distinct(self, field, query):
        return list({row[field] for row in self.rows if match(row, query)})


def install_transfer(monkeypatch):
    source = {"id": "walkin-1", "floor_id": "first-floor", "number": "WI-1",
              "customer_id": "lead-1", "customer_name": "Lead", "customer_phone": "9876543210",
              "status": "new", "is_deleted": False, "salesperson_id": "sales-1", "salesperson_name": "Sales"}
    walkins, followups = Store([source]), Store()
    monkeypatch.setattr(walkin_routes, "db", SimpleNamespace(walkins=walkins, followups=followups, users=Store()))
    events = []
    async def log(**event): events.append(event)
    monkeypatch.setattr(walkin_routes, "log_event", log)
    return walkins, followups, events


def test_visit_showroom_is_immediate_and_repeat_safe(monkeypatch):
    walkins, followups, events = install_transfer(monkeypatch)
    first = asyncio.run(walkin_routes.visit_showroom("walkin-1", user()))
    repeated = asyncio.run(walkin_routes.visit_showroom("walkin-1", user()))
    assert first == repeated
    assert len(followups.rows) == len(events) == 1
    row = followups.rows[0]
    assert row["origin"] == "visit_showroom"
    assert row["walkin_id"] == "walkin-1"
    assert row["is_automated"] is False
    assert row["assigned_to"] == "sales-1"
    assert walkins.rows[0]["showroom_followup_id"] == row["id"]


def test_showroom_transfer_never_reopens_completed_followup(monkeypatch):
    _, followups, _ = install_transfer(monkeypatch)
    asyncio.run(walkin_routes.visit_showroom("walkin-1", user()))
    followups.rows[0]["status"] = "done"
    asyncio.run(walkin_routes.visit_showroom("walkin-1", user()))
    assert followups.rows[0]["status"] == "done"


def test_showroom_transfer_promotes_existing_assigned_walkin_lead(monkeypatch):
    walkins, followups, events = install_transfer(monkeypatch)
    assignments = [{"floor_id": "first-floor", "user_id": "selected-worker", "user_name": "Selected worker"}]
    walkins.rows[0].update(scope_followup_id="walkin-lead:walkin-1", assignments=assignments)
    followups.rows.append({
        "id": "walkin-lead:walkin-1", "floor_id": "first-floor", "origin": "walkin",
        "walkin_id": "walkin-1", "customer_id": "lead-1", "rule_type": "manual", "status": "open", "assignments": assignments,
        "assigned_to": "selected-worker", "lead_group_id": "shared-group", "contact_attempts": 3,
    })
    first = asyncio.run(walkin_routes.visit_showroom("walkin-1", user()))
    repeated = asyncio.run(walkin_routes.visit_showroom("walkin-1", user()))
    assert first == repeated == {"walkin_id": "walkin-1", "followup_id": "walkin-lead:walkin-1"}
    assert len(followups.rows) == len(events) == 1
    row = followups.rows[0]
    assert row["origin"] == "visit_showroom", "The transferred lead must match the showroom list filter"
    assert row["status"] == "open"
    assert row["assigned_to"] == "selected-worker"
    assert row["assignments"] == assignments
    assert row["lead_group_id"] == "shared-group"
    assert row["contact_attempts"] == 3


def test_showroom_retry_repairs_legacy_transferred_origin_without_reopening_history(monkeypatch):
    walkins, followups, events = install_transfer(monkeypatch)
    identity = "walkin-lead:walkin-1"
    walkins.rows[0].update(scope_followup_id=identity, showroom_followup_id=identity,
                          showroom_transferred_at="2026-10-19T00:00:00Z")
    history = {"status": "done", "completed_at": "2026-10-20T00:00:00Z", "contact_attempts": 4,
               "due_at": "2026-10-19T00:00:00Z", "assigned_to": "selected-worker",
               "assignments": [{"floor_id": "first-floor", "user_id": "selected-worker"}]}
    followups.rows.append({"id": identity, "floor_id": "first-floor", "origin": "walkin", "walkin_id": "walkin-1", "customer_id": "lead-1", "rule_type": "manual", **history})
    asyncio.run(walkin_routes.visit_showroom("walkin-1", user()))
    assert followups.rows[0]["origin"] == "visit_showroom"
    assert all(followups.rows[0][key] == value for key, value in history.items())
    assert events == []


def test_showroom_transfer_cannot_read_another_floor(monkeypatch):
    _, followups, _ = install_transfer(monkeypatch)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(walkin_routes.visit_showroom("walkin-1", user(("ground-floor",))))
    assert caught.value.status_code == 404
    assert followups.rows == []


def test_confirmed_customers_excludes_walkins_drafts_and_other_floor(monkeypatch):
    customers = Store([
        {"id": item, "name": item, "floor_id": "first-floor"}
        for item in ("lead", "draft", "ordered", "won", "other-floor")
    ])
    quotations = Store([
        {"customer_id": "draft", "status": "draft", "floor_id": "first-floor"},
        {"customer_id": "ordered", "status": "ordered", "floor_id": "first-floor"},
        {"customer_id": "won", "status": "won", "floor_id": "first-floor"},
        {"customer_id": "other-floor", "status": "ordered", "floor_id": "ground-floor"},
    ])
    monkeypatch.setattr(customer_routes, "db", SimpleNamespace(customers=customers, quotations=quotations, customer_orders=Store(), purchase_orders=Store()))
    result = asyncio.run(customer_routes.list_customers(Response(), skip=0, limit=500, confirmed_only=True, user=user()))
    assert {row.id for row in result} == {"ordered", "won"}
    # Internal customer selection still resolves prospective identities.
    result = asyncio.run(customer_routes.list_customers(Response(), skip=0, limit=500, confirmed_only=False, user=user()))
    assert len(result) == 5


def test_explicit_multifloor_filters_validate_every_assignment():
    assert scoped_query(user(("first-floor", "ground-floor")), {"source": "Reference"}, "first-floor,ground-floor") == {
        "$and": [{"floor_id": {"$in": ["first-floor", "ground-floor"]}}, {"source": "Reference"}],
    }
    with pytest.raises(HTTPException):
        scoped_query(user(), {}, "first-floor,ground-floor")


def test_showroom_tab_and_multi_filters_are_database_side():
    query = followup_routes._paged_followup_query(
        user(), bucket=None, priority="high,critical", category="walk_in,sales", customer_tier="retail,trade",
        assigned_to="a,b", q=None, rule_type=None, view="active", waiting=False, completed_today=False,
        origin="visit_showroom",
    )
    clauses = query["$and"][1]["$and"]
    assert {"origin": "visit_showroom"} in clauses
    assert {"category": {"$in": ["walk_in", "sales"]}} in clauses
    assert {"$or": [{"assigned_to": {"$in": ["a", "b"]}}, {"assignments": {"$elemMatch": {"user_id": {"$in": ["a", "b"]}, "floor_id": "first-floor"}}}]} in clauses


def test_migration_removes_only_verified_test_choices():
    migration = importlib.import_module("migrations.0031_walkin_kitchen_and_lead_sources")
    assert migration.TEST_SOURCES == ["TEST Source 1785460004", "TEST_SRC_1785460004"]


def test_mixed_due_bucket_filter_keeps_each_branch_floor_scoped():
    query = followup_routes._paged_followup_query(
        user(), bucket="today,overdue,waiting,completed_today", priority=None, category=None,
        customer_tier=None, assigned_to=None, q=None, rule_type=None, view="active", waiting=False,
        completed_today=False, origin="visit_showroom",
    )
    assert len(query["$or"]) == 4
    for branch in query["$or"]:
        assert branch["$and"][0] == {"floor_id": {"$in": ["first-floor"]}}
        assert {"origin": "visit_showroom"} in branch["$and"][1]["$and"]


def test_confirmed_customer_directory_includes_legacy_tile_order(monkeypatch):
    customers = Store([{"id": "tile-buyer", "name": "Tile buyer", "floor_id": "ground-floor"}])
    customer_orders = Store([
        {"customer_id": "tile-buyer", "floor_id": "ground-floor", "is_deleted": False},
        {"customer_id": "deleted-buyer", "floor_id": "ground-floor", "is_deleted": True},
    ])
    monkeypatch.setattr(customer_routes, "db", SimpleNamespace(customers=customers, quotations=Store(), customer_orders=customer_orders, purchase_orders=Store()))
    result = asyncio.run(customer_routes.list_customers(Response(), skip=0, limit=500, confirmed_only=True, user=user(("ground-floor",))))
    assert [row.id for row in result] == ["tile-buyer"]


def test_showroom_pending_callback_keeps_origin_and_walkin_link(monkeypatch):
    from datetime import datetime, timedelta, timezone
    from models import FollowupCallOutcomePayload
    row = {"id": "showroom-1", "floor_id": "first-floor", "customer_id": "lead-1", "customer_name": "Lead",
           "category": "walk_in", "origin": "visit_showroom", "walkin_id": "walkin-1", "due_at": "2026-01-01T00:00:00Z", "assigned_to": "selected-worker"}
    store = Store([row])
    inserted = []
    async def insert_one(document): inserted.append(document)
    store.insert_one = insert_one
    monkeypatch.setattr(followup_routes, "db", SimpleNamespace(followups=store, users=SimpleNamespace(find_one=AsyncMock(return_value=None))))
    monkeypatch.setattr(followup_routes.lead_scope, "validate_assignments", AsyncMock(return_value=[{"floor_id": "first-floor", "user_id": "selected-worker", "user_name": "Selected worker"}]))
    asyncio.run(followup_routes.log_call("showroom-1", FollowupCallOutcomePayload(
        outcome="pending", next_followup_at=datetime.now(timezone.utc) + timedelta(days=2),
    ), user()))
    assert inserted[0]["origin"] == "visit_showroom"
    assert inserted[0]["walkin_id"] == "walkin-1"


def test_showroom_transferred_walkin_permanently_exits_register_and_counts(monkeypatch):
    walkins, _, _ = install_transfer(monkeypatch)
    asyncio.run(walkin_routes.visit_showroom("walkin-1", user()))
    # Querying after a hard reload must still omit the same durable source.
    rows = asyncio.run(walkin_routes.list_walkins(user=user()))
    counts = asyncio.run(walkin_routes.walkins_dashboard(floor_ids=None, user=user()))
    assert rows == []
    assert counts["total"] == counts["pending_followups"] == 0
    assert len(walkins.rows) == 1  # Preserve the source and its audit identity.


def test_historical_showroom_marker_alone_excludes_register(monkeypatch):
    walkins, _, _ = install_transfer(monkeypatch)
    walkins.rows[0]["showroom_transferred_at"] = "2026-10-11T00:00:00Z"
    assert asyncio.run(walkin_routes.list_walkins(user=user())) == []


def test_transferred_walkin_cannot_be_reopened_in_register(monkeypatch):
    from models_walkins import WalkInUpdate
    walkins, _, _ = install_transfer(monkeypatch)
    asyncio.run(walkin_routes.visit_showroom("walkin-1", user()))
    with pytest.raises(HTTPException) as caught:
        asyncio.run(walkin_routes.update_walkin("walkin-1", WalkInUpdate(status="new"), user()))
    assert caught.value.status_code == 409


@pytest.mark.parametrize("patch", [{"notes": "Ordinary note"}, {"lost_reason": "Standalone reason"}])
def test_walkin_non_loss_cannot_write_note(monkeypatch, patch):
    from models_walkins import WalkInUpdate
    walkins, _, _ = install_transfer(monkeypatch)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(walkin_routes.update_walkin("walkin-1", WalkInUpdate(**patch), user()))
    assert caught.value.status_code == 422
    assert "notes" not in walkins.rows[0]


def test_old_note_cannot_satisfy_new_lost_transition(monkeypatch):
    from models_walkins import WalkInUpdate
    walkins, _, _ = install_transfer(monkeypatch)
    walkins.rows[0]["notes"] = "Old visit note"
    with pytest.raises(HTTPException) as caught:
        asyncio.run(walkin_routes.update_walkin("walkin-1", WalkInUpdate(status="lost"), user()))
    assert caught.value.status_code == 422
    assert walkins.rows[0]["status"] == "new"


@pytest.mark.parametrize("change", [
    {"customer_id": "other-customer"}, {"customer_id": None}, {"walkin_id": "other-walkin"},
    {"rule_type": "quotation_followup"}, {"origin": "quotation"},
    {"origin": "visit_showroom", "customer_id": "other-customer"},
])
def test_showroom_transfer_rejects_unrelated_link_without_hiding_walkin(monkeypatch, change):
    walkins, followups, events = install_transfer(monkeypatch)
    walkins.rows[0]["scope_followup_id"] = "stale-link"
    row = {"id": "stale-link", "floor_id": "first-floor", "origin": "walkin",
           "walkin_id": "walkin-1", "customer_id": "lead-1", "rule_type": "manual", "status": "done", **change}
    followups.rows.append(dict(row))
    with pytest.raises(HTTPException) as caught:
        asyncio.run(walkin_routes.visit_showroom("walkin-1", user()))
    assert caught.value.status_code == 409
    assert followups.rows == [row]
    assert "showroom_followup_id" not in walkins.rows[0]
    assert events == []


@pytest.mark.parametrize("customer_id", [None, "", "   ", 123])
def test_showroom_transfer_rejects_missing_customer_before_writing(monkeypatch, customer_id):
    walkins, followups, events = install_transfer(monkeypatch)
    walkins.rows[0]["customer_id"] = customer_id
    with pytest.raises(HTTPException) as caught:
        asyncio.run(walkin_routes.visit_showroom("walkin-1", user()))
    assert caught.value.status_code == 409
    assert followups.rows == events == []
    assert "showroom_followup_id" not in walkins.rows[0]


def test_showroom_promotion_rechecks_identity_after_validation_race(monkeypatch):
    walkins, followups, events = install_transfer(monkeypatch)
    walkins.rows[0]["scope_followup_id"] = "linked"
    followups.rows.append({"id": "linked", "floor_id": "first-floor", "origin": "walkin",
                           "walkin_id": "walkin-1", "customer_id": "lead-1", "rule_type": "manual", "status": "open"})
    update = followups.update_one

    async def changed_before_promotion(query, patch, upsert=False):
        if "$set" in patch and patch["$set"].get("origin") == "visit_showroom":
            followups.rows[0]["customer_id"] = "another-customer"
        return await update(query, patch, upsert=upsert)

    monkeypatch.setattr(followups, "update_one", changed_before_promotion)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(walkin_routes.visit_showroom("walkin-1", user()))
    assert caught.value.status_code == 409
    assert followups.rows[0]["origin"] == "walkin"
    assert "showroom_followup_id" not in walkins.rows[0]
    assert events == []


def test_customer_search_finds_old_walkin_by_literal_name_and_phone_with_floor_isolation(monkeypatch):
    import re
    rows = [{"id": str(i), "name": f"Recent customer {i}", "floor_id": "ground-floor"} for i in range(520)]
    rows.extend([
        {"id": "old-walkin", "name": "A.* Shah", "phone": "9876543210", "address": "12 Saved Walk-in Road", "floor_id": "ground-floor"},
        {"id": "foreign", "name": "A.* Shah", "phone": "9876543210", "address": "Foreign floor", "floor_id": "first-floor"},
        {"id": "regex-lookalike", "name": "Anything Shah", "floor_id": "ground-floor"},
    ])
    def accepts(row, query):
        for key, value in query.items():
            if key == "$and" and not all(accepts(row, child) for child in value): return False
            if key == "$or" and not any(accepts(row, child) for child in value): return False
            if key.startswith("$"): continue
            if isinstance(value, dict) and "$regex" in value:
                if not re.search(value["$regex"], str(row.get(key, "")), re.I): return False
            elif isinstance(value, dict):
                if "$in" in value and row.get(key) not in value["$in"]: return False
                if "$ne" in value and row.get(key) == value["$ne"]: return False
            elif row.get(key) != value: return False
        return True
    class SearchStore(Store):
        def find(self, query, projection): return Cursor([row for row in self.rows if accepts(row, query)])
    monkeypatch.setattr(customer_routes, "db", SimpleNamespace(customers=SearchStore(rows)))
    for term in ("A.*", "9876543210"):
        response = Response()
        result = asyncio.run(customer_routes.list_customers(response, skip=0, limit=20, confirmed_only=False, search=term, user=user(("ground-floor",))))
        assert [record.id for record in result] == ["old-walkin"]
        assert result[0].address == "12 Saved Walk-in Road"
        assert response.headers["X-Has-More"] == "false"
