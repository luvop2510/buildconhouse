"""Stock and its permanent movement register must commit or roll back together."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest

from models import UserPublic
from routes import tile_orders
from services import tile_movement_log


def _matches(doc, query):
    for key, value in query.items():
        if key == "$and":
            if not all(_matches(doc, clause) for clause in value):
                return False
        elif isinstance(value, dict):
            if "$gt" in value and not doc.get(key, 0) > value["$gt"]:
                return False
            if "$in" in value and doc.get(key) not in value["$in"]:
                return False
        elif doc.get(key) != value:
            return False
    return True


class Collection:
    def __init__(self, rows=()):
        self.rows = deepcopy(list(rows))

    async def find_one(self, query, *_args, **_kwargs):
        return next((deepcopy(row) for row in self.rows if _matches(row, query)), None)

    def find(self, query, *_args, **_kwargs):
        rows = [deepcopy(row) for row in self.rows if _matches(row, query)]
        class Cursor:
            async def to_list(self, limit):
                return rows[:limit]
        return Cursor()

    async def update_one(self, query, update, **_kwargs):
        for row in self.rows:
            if _matches(row, query):
                row.update(deepcopy(update.get("$set", {})))
                for key, delta in update.get("$inc", {}).items():
                    row[key] = row.get(key, 0) + delta
                return SimpleNamespace(matched_count=1)
        return SimpleNamespace(matched_count=0)

    async def insert_one(self, doc, **_kwargs):
        self.rows.append(deepcopy(doc))


class MovementCollection(Collection):
    def __init__(self, *, fail):
        super().__init__()
        self.fail = fail
        self.sessions = []

    async def insert_one(self, doc, *, session=None):
        self.sessions.append(session)
        if self.fail:
            raise RuntimeError("Register unavailable")
        assert session is not None and session.in_transaction, "movement escaped stock transaction"
        await super().insert_one(doc, session=session)


class Session:
    def __init__(self, db):
        self.db = db
        self.in_transaction = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def start_transaction(self):
        session = self
        class Transaction:
            async def __aenter__(self):
                session.in_transaction = True
                self.snapshot = {name: deepcopy(collection.rows) for name, collection in vars(session.db).items()}
            async def __aexit__(self, error, *_args):
                if error:
                    for name, rows in self.snapshot.items():
                        getattr(session.db, name).rows = rows
                session.in_transaction = False
                return False
        return Transaction()


def _fixture(*, fail):
    identity = {"floor_id": "ground-floor", "is_deleted": False}
    item = {"id": "line", "name": "Tile", "qty": 20, "boxes_ready": 8, "boxes_pending": 8,
            "boxes_godown": 4, "boxes_dispatched": 0, "overall_status": "Ready"}
    po = {**identity, "id": "po", "number": "TPO-1", "customer_id": "customer", "customer_name": "Customer", "items": [item]}
    dispatch = {**identity, "id": "dispatch", "dispatch_number": "TD-1", "purchase_order_id": "po",
                "chalan_id": "chalan", "delivered_at": None, "source": "godown", "ready_batches_consumed": []}
    chalan = {**identity, "id": "chalan", "number": "TC-1", "dispatch_id": "dispatch",
              "items": [{"po_item_id": "line", "tile_name": "Tile", "boxes": 4}]}
    return SimpleNamespace(
        purchase_orders=Collection([po]), ready_batches=Collection([{**identity, "id": "batch",
            "purchase_order_id": "po", "po_item_id": "line", "remaining_qty": 8, "created_at": "2026-10-01"}]),
        dispatches=Collection([dispatch]), chalans=Collection([chalan]),
        material_movements=MovementCollection(fail=fail),
    )


async def _invoke(action, user):
    items = [{"po_item_id": "line", "qty": 2}]
    if action == "release":
        return await tile_orders.mark_items_ready("po", tile_orders.BulkReadyBody(items=items), user=user)
    if action == "move_to_godown":
        return await tile_orders.move_material_to_godown("po", tile_orders.MoveToGodownBody(items=items), user=user)
    if action == "dispatch_from_godown":
        return await tile_orders.dispatch_from_godown("po", tile_orders.SimpleDispatchBody(items=items), user=user)
    if action == "dispatch_from_released":
        return await tile_orders.dispatch_from_released("po", tile_orders.SimpleDispatchBody(items=items), user=user)
    return await tile_orders.mark_dispatch_delivered("dispatch", tile_orders.DeliveredBody(), user=user)


@pytest.mark.parametrize("action", ["release", "move_to_godown", "dispatch_from_released", "dispatch_from_godown", "delivered"])
@pytest.mark.parametrize("fail", [False, True], ids=["commits", "register_failure_rolls_back"])
def test_stock_and_permanent_movement_share_transaction(monkeypatch, action, fail):
    db = _fixture(fail=fail)
    session = Session(db)
    async def start_session(): return session
    async def next_number(*_args, **_kwargs): return "TEST-1"
    async def log_event(**_kwargs): return None
    monkeypatch.setattr(tile_orders, "db", db)
    monkeypatch.setattr(tile_movement_log, "db", db)
    monkeypatch.setattr(tile_orders, "client", SimpleNamespace(start_session=start_session))
    monkeypatch.setattr(tile_orders, "next_number", next_number)
    monkeypatch.setattr(tile_orders, "log_event", log_event)
    user = UserPublic(email="warehouse@test.local", full_name="Warehouse", role="warehouse",
                      floor_ids=["ground-floor"], active_floor_id="ground-floor")
    before = {name: deepcopy(collection.rows) for name, collection in vars(db).items()}
    if fail:
        with pytest.raises(RuntimeError, match="Register unavailable"):
            asyncio.run(_invoke(action, user))
        assert {name: collection.rows for name, collection in vars(db).items()} == before
    else:
        asyncio.run(_invoke(action, user))
        assert len(db.material_movements.rows) == 1
        assert db.material_movements.rows[0]["movement_type"] == action
        assert db.material_movements.rows[0]["floor_id"] == "ground-floor"
    assert db.material_movements.sessions == [session]
