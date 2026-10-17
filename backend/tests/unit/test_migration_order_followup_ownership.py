"""Historical order attribution is scoped, confirmed-only and repeat-safe."""
import asyncio
import importlib
from copy import deepcopy
from types import SimpleNamespace
from routes import followup_routes
from models import UserPublic

migration = importlib.import_module("migrations.0033_order_followup_creator_ownership")


def matches(row, query):
    for key, value in query.items():
        if key == "$or":
            if not any(matches(row, term) for term in value): return False
        elif isinstance(value, dict):
            if "$in" in value and row.get(key) not in value["$in"]: return False
            if "$nin" in value and row.get(key) in value["$nin"]: return False
            if "$ne" in value and row.get(key) == value["$ne"]: return False
            if "$type" in value and not isinstance(row.get(key), str): return False
        elif row.get(key) != value: return False
    return True


class Cursor:
    def __init__(self, rows): self.rows = rows
    def limit(self, count): self.rows = self.rows[:count]; return self
    async def to_list(self, count): return [dict(row) for row in self.rows[:count]]
    def __aiter__(self):
        async def iterate():
            for row in self.rows: yield dict(row)
        return iterate()


class Store:
    def __init__(self, rows): self.rows = rows
    def find(self, query, *_): return Cursor([row for row in self.rows if matches(row, query)])
    async def find_one(self, query, *_): return next((row for row in self.rows if matches(row, query)), None)
    async def update_one(self, query, update):
        for row in self.rows:
            if matches(row, query): row.update(update["$set"])


def test_migration_assigns_only_confirmed_same_floor_sales_to_creator():
    base = {"floor_id": "first-floor", "status": "done", "auto_resolved": True, "completed_outcome": "won", "quotation_id": "q1", "assigned_to": "transferred-salesperson", "notes": "Historical note", "completed_at": "old"}
    rows = [
        {**base, "id": "sale"}, {**base, "id": "converted", "completed_outcome": "converted"},
        {**base, "id": "other-floor", "floor_id": "ground-floor"},
        {**base, "id": "draft", "quotation_id": "q2"},
        {**base, "id": "ops", "rule_type": "order_confirmed_ops"},
        {**base, "id": "lost", "completed_outcome": "lost"},
        {**base, "id": "unlinked", "quotation_id": None},
        {**base, "id": "purchase", "purchase_id": "po1"},
    ]
    unchanged = deepcopy(rows[2:])
    db = SimpleNamespace(followups=Store(rows), quotations=Store([
        {"id": "q1", "floor_id": "first-floor", "status": "ordered", "created_by": "creator", "created_by_name": "Creator"},
        {"id": "q2", "floor_id": "first-floor", "status": "draft", "created_by": "creator"},
    ]))
    asyncio.run(migration.up(db))
    assert rows[2:] == unchanged
    assert all(row["assigned_to"] == "creator" for row in rows[:2])
    assert all(row["notes"] == "Historical note" and row["completed_at"] == "old" for row in rows[:2])
    first = deepcopy(rows)
    asyncio.run(migration.up(db))
    assert rows == first


def test_own_orders_defaults_to_current_team_member():
    user = UserPublic(id="recipient", email="sales@example.com", full_name="Sales", role="sales", floor_ids=["first-floor"], active_floor_id="first-floor")
    query = followup_routes._paged_followup_query(user, bucket=None, priority=None, category=None, customer_tier=None, assigned_to=None, q=None, rule_type=None, view="won", waiting=False, completed_today=False)
    assert {"assigned_to": "recipient"} in query["$and"][1]["$and"]


def test_migration_links_unambiguous_showroom_wins_but_preserves_ambiguous_history():
    base = {"floor_id": "first-floor", "status": "done", "auto_resolved": True, "completed_outcome": "won", "assigned_to": "old-recipient", "notes": "Historical note", "completed_at": "old", "category": "walk_in", "origin": "visit_showroom"}
    rows = [
        {**base, "id": "single", "customer_id": "single", "quotation_id": None},
        {**base, "id": "ambiguous", "customer_id": "multiple"},
        {**base, "id": "different_floor", "customer_id": "other"},
        {**base, "id": "draft_only", "customer_id": "draft"},
        {**base, "id": "creator_missing", "customer_id": "no-creator"},
        {**base, "id": "payment", "customer_id": "single", "category": "payment"},
        {**base, "id": "open", "customer_id": "single", "status": "open"},
        {**base, "id": "lost", "customer_id": "single", "completed_outcome": "lost"},
    ]
    unchanged = deepcopy(rows[1:])
    orders = [
        {"id": "q1", "number": "FQ-1", "customer_id": "single", "floor_id": "first-floor", "status": "ordered", "created_by": "creator", "created_by_name": "Creator"},
        {"id": "q2", "customer_id": "multiple", "floor_id": "first-floor", "status": "ordered", "created_by": "creator"},
        {"id": "q3", "customer_id": "multiple", "floor_id": "first-floor", "status": "ordered", "created_by": "creator"},
        {"id": "q4", "customer_id": "other", "floor_id": "ground-floor", "status": "ordered", "created_by": "creator"},
        {"id": "q5", "customer_id": "draft", "floor_id": "first-floor", "status": "draft", "created_by": "creator"},
        {"id": "q6", "customer_id": "no-creator", "floor_id": "first-floor", "status": "ordered"},
    ]
    db = SimpleNamespace(followups=Store(rows), quotations=Store(orders))
    asyncio.run(migration.up(db))
    assert rows[1:] == unchanged
    assert rows[0]["quotation_id"] == "q1" and rows[0]["quotation_number"] == "FQ-1"
    assert rows[0]["assigned_to"] == "creator"
    assert rows[0]["notes"] == "Historical note" and rows[0]["completed_at"] == "old"
    first = deepcopy(rows)
    asyncio.run(migration.up(db))
    assert rows == first
