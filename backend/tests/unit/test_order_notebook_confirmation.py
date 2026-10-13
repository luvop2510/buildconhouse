import asyncio
from copy import deepcopy
from types import SimpleNamespace

from routes import quotation_routes
from models import UserPublic


def _matches(row, query):
    for key, value in query.items():
        if key == "$and":
            if not all(_matches(row, term) for term in value):
                return False
        elif key == "$or":
            if not any(_matches(row, term) for term in value):
                return False
        elif isinstance(value, dict):
            if "$in" in value and row.get(key) not in value["$in"]:
                return False
            if "$nin" in value and row.get(key) in value["$nin"]:
                return False
            if "$ne" in value and row.get(key) == value["$ne"]:
                return False
            if "$type" in value and not isinstance(row.get(key), str):
                return False
        elif row.get(key) != value:
            return False
    return True


def test_placed_order_completes_only_matching_active_notebook_in_same_transaction(monkeypatch):
    base = {"floor_id": "second-floor", "customer_id": "c1", "notebook_key": "second-floor:c1", "notebook_status": "pending", "status": "open", "rule_type": "manual"}
    rows = [
        {**base, "id": "unlinked"}, {**base, "id": "linked", "quotation_id": "q1"},
        {**base, "id": "other_quote", "quotation_id": "q2"},
        {**base, "id": "other_floor", "floor_id": "third-floor"},
        {**base, "id": "other_customer", "customer_id": "c2"},
        {**base, "id": "lost", "notebook_status": "lost", "status": "dismissed"},
        {**base, "id": "ops", "rule_type": "order_confirmed_ops"},
        {**base, "id": "purchase", "purchase_id": "po1"},
        {**base, "id": "ordinary", "notebook_key": None, "quotation_id": "q1"},
        {**base, "id": "ordinary_purchase", "notebook_key": None, "quotation_id": "q1", "purchase_id": "po1"},
    ]
    original = deepcopy(rows)
    token = object()
    class Followups:
        async def update_many(self, query, update, *, session=None):
            assert session is token
            count = 0
            for row in rows:
                if _matches(row, query):
                    row.update(update["$set"])
                    count += 1
            return SimpleNamespace(modified_count=count)
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(followups=Followups()))
    doc = {"id": "q1", "number": "FQ-1", "floor_id": "second-floor", "customer_id": "c1", "created_by": "creator", "created_by_name": "Original creator"}
    assert asyncio.run(quotation_routes._complete_order_notebook_followups(doc, session=token)) == 2
    for row in rows[:2]:
        assert row["notebook_status"] == "won" and row["status"] == "done"
        assert row["completed_outcome"] == "won" and row["quotation_id"] == "q1"
        assert row["auto_resolved"] is True
        assert row["assigned_to"] == "creator"
    assert rows[2:] == original[2:]
    first_confirmation = deepcopy(rows)
    assert asyncio.run(quotation_routes._complete_order_notebook_followups(doc, session=token)) == 0
    assert rows == first_confirmation
    assert asyncio.run(quotation_routes._complete_pre_confirmation_followups("q1", "FQ-1", floor_id="second-floor", session=token)) == 1
    assert rows[-2]["status"] == "done"
    assert rows[2:-2] == original[2:-2]
    assert rows[-1] == original[-1]
    assert asyncio.run(quotation_routes._complete_pre_confirmation_followups("q1", "FQ-1", floor_id="second-floor", session=token)) == 0


def test_place_order_retry_does_not_reclose_later_notebook_followups(monkeypatch):
    class Quotations:
        async def find_one(self, query, *_args, **_kwargs):
            assert query == {"id": "q1"}
            return {"id": "q1", "floor_id": "second-floor"}
    class Outbox:
        async def find_one(self, query, *_args):
            assert query == {"idempotency_key": "order-placed:q1"}
            return {"id": "event1", "status": "completed"}
    async def unexpected(*_args, **_kwargs):
        raise AssertionError("a journaled order must not update followups again")
    async def dispatch(event_id):
        assert event_id == "event1"
        return {"purchase_order_ids": ["po1"]}
    async def reconcile():
        return None
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(event_outbox=Outbox(), quotations=Quotations()))
    monkeypatch.setattr(quotation_routes, "_complete_order_notebook_followups", unexpected)
    monkeypatch.setattr(quotation_routes, "_complete_pre_confirmation_followups", unexpected)
    monkeypatch.setattr(quotation_routes, "dispatch_event", dispatch)
    monkeypatch.setattr(quotation_routes, "reconcile_followups", reconcile)
    user = UserPublic(email="sales@example.com", full_name="Sales", role="sales", floor_ids=["second-floor"], active_floor_id="second-floor")
    response = asyncio.run(quotation_routes.place_order_confirm("q1", quotation_routes.PlaceOrderConfirmPayload(project_name="Project"), user=user))
    assert response["idempotent"] is True
    assert response["purchase_order_ids"] == ["po1"]


def test_actual_order_closes_unlinked_same_customer_showroom_sales_only(monkeypatch):
    base = {"floor_id": "first-floor", "customer_id": "c1", "category": "walk_in", "status": "open", "rule_type": "manual", "assigned_to": "recipient", "notes": "Historical visit note"}
    rows = [
        {**base, "id": "showroom", "origin": "visit_showroom", "quotation_id": None},
        {**base, "id": "walkin", "rule_type": "walk_in_new"},
        {**base, "id": "empty_link", "quotation_id": "", "status": "snoozed"},
        {**base, "id": "other_customer", "customer_id": "c2"},
        {**base, "id": "other_floor", "floor_id": "ground-floor"},
        {**base, "id": "other_quotation", "quotation_id": "q2"},
        {**base, "id": "ops", "rule_type": "order_confirmed_ops"},
        {**base, "id": "operations", "category": "operations", "quotation_id": "q1"},
        {**base, "id": "payment", "category": "payment", "quotation_id": "q1"},
        {**base, "id": "payment_unlinked", "category": "payment"},
        {**base, "id": "purchase", "purchase_id": "po1"},
        {**base, "id": "lost", "status": "dismissed", "completed_outcome": "lost"},
        {**base, "id": "notebook", "notebook_key": "first-floor:c1"},
        {**base, "id": "ordinary_unlinked", "category": "general"},
    ]
    original = deepcopy(rows)
    transaction = object()
    class Followups:
        async def update_many(self, query, update, *, session=None):
            assert session is transaction
            count = 0
            for row in rows:
                if _matches(row, query):
                    row.update(update["$set"])
                    count += 1
            return SimpleNamespace(modified_count=count)
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(followups=Followups()))
    args = dict(floor_id="first-floor", customer_id="c1", creator_id="creator", creator_name="Original creator", session=transaction)
    assert asyncio.run(quotation_routes._complete_pre_confirmation_followups("q1", "FQ-1", **args)) == 3
    assert rows[3:] == original[3:]
    for row in rows[:3]:
        assert row["status"] == "done" and row["completed_outcome"] == "won"
        assert row["assigned_to"] == "creator" and row["assigned_to_name"] == "Original creator"
        assert row["quotation_id"] == "q1" and row["quotation_number"] == "FQ-1"
        assert row["notes"] == "Historical visit note"
    first = deepcopy(rows)
    assert asyncio.run(quotation_routes._complete_pre_confirmation_followups("q1", "FQ-1", **args)) == 0
    assert rows == first
