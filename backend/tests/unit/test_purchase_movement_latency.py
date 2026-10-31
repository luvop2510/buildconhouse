"""Bound bulk work and keep status/receiving bookkeeping atomic under contention."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

from models import UserPublic
from routes import purchases_tracker as tracker


def flat(query):
    return {key: value for part in query.get("$and", [query]) for key, value in part.items()}


def user():
    return UserPublic(email="warehouse@forge.app", full_name="Warehouse", role="warehouse",
                      floor_ids=["first-floor"], active_floor_id="first-floor")


def delivered_doc(count=30):
    return {"id": "po", "floor_id": "first-floor", "status": "ordered", "items": [
        {"id": f"item-{i}", "stage": "dispatched", "qty": i + 1, "qty_received": 0}
        for i in range(count)
    ]}


def test_status_and_received_quantities_use_one_guarded_write(monkeypatch):
    doc = delivered_doc()
    collection = SimpleNamespace(find_one=AsyncMock(return_value=deepcopy(doc)),
                                 update_one=AsyncMock(return_value=SimpleNamespace(matched_count=1)))
    monkeypatch.setattr(tracker, "db", SimpleNamespace(purchase_orders=collection))
    monkeypatch.setattr(tracker, "log_event", AsyncMock())
    assert asyncio.run(tracker._sync_po_status_with_stages("po", user())) == "fully_received"
    assert collection.update_one.await_count == 1
    query, update = collection.update_one.call_args.args
    query = flat(query)
    assert query["items"] == doc["items"]
    assert query["status"] == "ordered"
    assert query["floor_id"] == {"$in": ["first-floor"]}
    assert update["$set"]["status"] == "fully_received"
    assert [update["$set"][f"items.{i}.qty_received"] for i in range(30)] == list(range(1, 31))
    assert len(update["$push"]["status_history"]) > 0


def test_status_sync_reloads_after_losing_snapshot_and_never_overwrites_new_items(monkeypatch):
    first = delivered_doc(1)
    latest = {**delivered_doc(1), "items": first["items"] + [
        {"id": "new-item", "stage": "order_in_company", "qty": 2, "qty_received": 0},
    ]}
    collection = SimpleNamespace(find_one=AsyncMock(side_effect=[deepcopy(first), deepcopy(latest)]),
                                 update_one=AsyncMock(side_effect=[SimpleNamespace(matched_count=0), SimpleNamespace(matched_count=1)]))
    monkeypatch.setattr(tracker, "db", SimpleNamespace(purchase_orders=collection))
    log = AsyncMock()
    monkeypatch.setattr(tracker, "log_event", log)
    assert asyncio.run(tracker._sync_po_status_with_stages("po", user())) == "partial_received"
    assert collection.find_one.await_count == 2
    assert flat(collection.update_one.call_args.args[0])["items"] == latest["items"]
    assert collection.update_one.call_args.args[1]["$set"]["status"] == "partial_received"
    assert log.await_count == 1


def test_status_already_synced_still_repairs_receiving_quantities(monkeypatch):
    doc = {**delivered_doc(1), "status": "fully_received"}
    collection = SimpleNamespace(find_one=AsyncMock(return_value=deepcopy(doc)),
                                 update_one=AsyncMock(return_value=SimpleNamespace(matched_count=1)))
    monkeypatch.setattr(tracker, "db", SimpleNamespace(purchase_orders=collection))
    log = AsyncMock()
    monkeypatch.setattr(tracker, "log_event", log)
    assert asyncio.run(tracker._sync_po_status_with_stages("po", user())) is None
    assert collection.update_one.call_args.args[1]["$set"]["items.0.qty_received"] == 1
    assert "status" not in collection.update_one.call_args.args[1]["$set"]
    assert log.await_count == 0


def test_bulk_move_uses_bounded_concurrency_and_retains_result_order(monkeypatch):
    async def run():
        active = maximum = 0
        started = asyncio.Event()
        async def move(item_id, *args):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            if active == 3:
                started.set()
            await started.wait()
            await asyncio.sleep(0)
            active -= 1
            if item_id == "bad":
                from fastapi import HTTPException
                raise HTTPException(409, "Changed; retry")
            return {"item_id": item_id, "to_stage": "in_box"}
        monkeypatch.setattr(tracker, "_apply_stage_change", move)
        monkeypatch.setattr(tracker, "db", SimpleNamespace(purchase_orders=SimpleNamespace(
            find=lambda *args: SimpleNamespace(to_list=AsyncMock(return_value=[])))))
        ids = ["a", "bad", "b", "c", "d", "e"]
        result = await asyncio.wait_for(tracker.bulk_move(tracker.BulkMoveBody(item_ids=ids, stage="in_box"), user()), 0.5)
        assert maximum == 3
        assert [row["item_id"] for row in result["results"]] == ids
        assert result["succeeded"] == 5
        assert result["failed"] == 1
        assert result["results"][1]["error_code"] == "conflict"
    asyncio.run(run())


def test_bulk_same_po_preserves_every_item_and_final_status_under_contention(monkeypatch):
    async def run():
        doc = {**delivered_doc(12), "status": "ordered"}
        for item in doc["items"]:
            item["stage"] = "in_box"
        doc["items"][4]["cancelled"] = True
        conflicts = 0
        class Orders:
            def find(self, *args):
                return SimpleNamespace(to_list=AsyncMock(return_value=[deepcopy(doc)]))
            async def find_one(self, query, *args):
                query = flat(query)
                snapshot = deepcopy(doc)
                await asyncio.sleep(0)
                if query.get("items.id") and not any(item["id"] == query["items.id"] for item in doc["items"]):
                    return None
                return snapshot
            async def update_one(self, query, update):
                nonlocal conflicts
                query = flat(query)
                await asyncio.sleep(0)
                elem = query.get("items", {}).get("$elemMatch") if isinstance(query.get("items"), dict) else None
                selected = next((item for item in doc["items"] if elem and item["id"] == elem["id"]), None)
                matches = True
                if elem:
                    matches = bool(selected) and all(selected.get(key) == value for key, value in elem.items() if not isinstance(value, dict)) and not selected.get("cancelled")
                elif "items" in query:
                    matches = query["items"] == doc["items"] and query["status"] == doc["status"]
                if not matches:
                    conflicts += 1
                    return SimpleNamespace(matched_count=0)
                for key, value in update.get("$set", {}).items():
                    if key.startswith("items.$."):
                        selected[key.removeprefix("items.$.")] = value
                    elif key.startswith("items."):
                        _, index, field = key.split(".")
                        doc["items"][int(index)][field] = value
                    else:
                        doc[key] = value
                for key, value in update.get("$push", {}).items():
                    if key == "items.$.stage_history":
                        selected.setdefault("stage_history", []).append(value)
                    else:
                        doc.setdefault(key, []).append(value)
                return SimpleNamespace(matched_count=1)
        monkeypatch.setattr(tracker, "db", SimpleNamespace(purchase_orders=Orders()))
        monkeypatch.setattr(tracker, "log_event", AsyncMock())
        monkeypatch.setattr(tracker, "reconcile_followups_admitted", AsyncMock())
        ids = [item["id"] for item in doc["items"]] + ["missing"]
        result = await tracker.bulk_move(tracker.BulkMoveBody(item_ids=ids, stage="dispatched"), user())
        assert result["succeeded"] == 11
        assert result["failed"] == 2
        assert [row["item_id"] for row in result["results"]] == ids
        assert result["results"][4]["error_code"] == "conflict"
        assert result["results"][-1]["error_code"] == "not_found"
        assert doc["status"] == "fully_received"
        for item in doc["items"]:
            if not item.get("cancelled"):
                assert item["stage"] == "dispatched"
                assert item["qty_received"] == item["qty"]
                assert len(item["stage_history"]) == 1
        assert conflicts == 0
    asyncio.run(run())


def test_bulk_move_observes_other_inflight_groups_before_propagating_failure(monkeypatch):
    async def run():
        other_finished = False
        async def move(item_id, *args):
            nonlocal other_finished
            if item_id == "broken":
                raise RuntimeError("connection lost")
            await asyncio.sleep(0)
            other_finished = True
            return {"item_id": item_id}
        monkeypatch.setattr(tracker, "_apply_stage_change", move)
        monkeypatch.setattr(tracker, "db", SimpleNamespace(purchase_orders=SimpleNamespace(
            find=lambda *args: SimpleNamespace(to_list=AsyncMock(return_value=[])))))
        import pytest
        with pytest.raises(RuntimeError, match="connection lost"):
            await tracker.bulk_move(tracker.BulkMoveBody(item_ids=["broken", "other"], stage="in_box"), user())
        assert other_finished
    asyncio.run(run())


def test_unchanged_movement_retry_repairs_status_without_moving_stock_again(monkeypatch):
    doc = delivered_doc(1)
    collection = SimpleNamespace(find_one=AsyncMock(return_value=deepcopy(doc)), update_one=AsyncMock())
    monkeypatch.setattr(tracker, "db", SimpleNamespace(purchase_orders=collection))
    sync = AsyncMock(return_value="fully_received")
    monkeypatch.setattr(tracker, "_sync_po_status_with_stages", sync)
    result = asyncio.run(tracker._apply_stage_change("item-0", "dispatched", user(), None))
    assert result["no_change"] is True
    assert result["po_status_synced_to"] == "fully_received"
    assert sync.await_count == 1
    assert collection.update_one.await_count == 0


def test_bulk_grouping_ignores_legacy_siblings_without_item_identity(monkeypatch):
    monkeypatch.setattr(tracker, "db", SimpleNamespace(purchase_orders=SimpleNamespace(
        find=lambda *args: SimpleNamespace(to_list=AsyncMock(return_value=[
            {"id": "po", "items": [{"id": "selected"}, {"name": "Legacy sibling"}]},
        ])))))
    move = AsyncMock(return_value={"item_id": "selected"})
    monkeypatch.setattr(tracker, "_apply_stage_change", move)
    result = asyncio.run(tracker.bulk_move(tracker.BulkMoveBody(item_ids=["selected"], stage="in_box"), user()))
    assert result["succeeded"] == 1
    assert result["failed"] == 0
    assert move.await_count == 1
