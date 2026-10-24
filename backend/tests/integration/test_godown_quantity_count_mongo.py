"""Count unrecorded stock using an isolated real MongoDB process."""
import asyncio
from datetime import date

import pytest
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import ValidationError

from tests.integration.test_purchase_completion_mongo import mongo_url  # noqa: F401
from models import UserPublic
from routes import godown_stock_routes as route


def actor():
    return UserPublic(id="counter", email="counter@example.test", full_name="Stock Counter", role="warehouse", floor_ids=["first-floor"], active_floor_id="first-floor")


def lot(**changes):
    return {"id": "uncounted", "floor_id": "first-floor", "sku": "COUNT", "name": "Counted basin", "quantity_missing": True,
            "qty_received": 0, "available_qty": 0, "loaned_out_qty": 0, "allocations": [], "unit_price": 100, "updated_at": "v1", **changes}


def count(**changes):
    return route.MissingQuantityCount(**{"qty": 3, "counted_on": date(2026, 10, 24), "reason": "Physical count of saleable units", "expected_updated_at": "v1", "idempotency_key": "count-command-one", **changes})


@pytest.mark.parametrize("qty", [0, 3])
def test_count_and_replay_preserve_audit_and_current_balance(mongo_url, monkeypatch, qty):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.quantity_counts
        monkeypatch.setattr(route, "db", db)
        try:
            await db.godown_stock.insert_one(lot())
            first = await route.record_missing_quantity("uncounted", count(qty=qty), actor())
            assert first["quantity_missing"] is False
            assert first["qty_received"] == first["available_qty"] == qty
            assert first["stock_value"] == qty * 100
            assert first["quantity_counts"][0]["reason"] == count().reason
            assert "command_key" not in first["quantity_counts"][0]
            await db.godown_stock.update_one({"id": "uncounted"}, {"$set": {"available_qty": max(0, qty - 1)}})
            replay = await route.record_missing_quantity("uncounted", count(qty=qty), actor())
            assert replay["idempotent"] is True
            assert replay["available_qty"] == max(0, qty - 1)
            assert len((await db.godown_stock.find_one({"id": "uncounted"}))["quantity_counts"]) == 1
            with pytest.raises(HTTPException) as error:
                await route.record_missing_quantity("uncounted", count(qty=qty + 1), actor())
            assert error.value.status_code == 409
        finally:
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("same_command", [True, False])
def test_concurrent_counts_do_not_overwrite_one_another(mongo_url, monkeypatch, same_command):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.quantity_races
        monkeypatch.setattr(route, "db", db)
        try:
            await db.godown_stock.insert_one(lot())
            second = count() if same_command else count(qty=5, idempotency_key="another-count-command")
            results = await asyncio.gather(route.record_missing_quantity("uncounted", count(), actor()), route.record_missing_quantity("uncounted", second, actor()), return_exceptions=True)
            saved = await db.godown_stock.find_one({"id": "uncounted"})
            assert len(saved["quantity_counts"]) == 1
            if same_command:
                assert all(isinstance(result, dict) for result in results)
                assert sum(result.get("idempotent", False) for result in results) == 1
            else:
                assert sum(isinstance(result, HTTPException) and result.status_code == 409 for result in results) == 1
                assert saved["available_qty"] in (3, 5)
        finally:
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("changes,transfer,foreign", [
    ({"updated_at": "changed"}, False, False), ({"archived": True}, False, False),
    ({"quantity_missing": False}, False, False), ({"qty_received": 1}, False, False),
    ({"allocations": [{"qty": 1}]}, False, False), ({}, True, False), ({}, False, True),
])
def test_incompatible_stock_and_floor_cannot_be_counted(mongo_url, monkeypatch, changes, transfer, foreign):
    async def run():
        client = AsyncIOMotorClient(mongo_url)
        db = client.quantity_rejections
        monkeypatch.setattr(route, "db", db)
        try:
            await db.godown_stock.insert_one(lot(**changes))
            if transfer: await db.godown_customer_transfers.insert_one({"stock_id": "uncounted", "floor_id": "first-floor"})
            user = actor().model_copy(update={"active_floor_id": "ground-floor", "floor_ids": ["ground-floor"]}) if foreign else actor()
            with pytest.raises(HTTPException) as error:
                await route.record_missing_quantity("uncounted", count(), user)
            assert error.value.status_code == (404 if foreign else 409)
            saved = await db.godown_stock.find_one({"id": "uncounted"})
            assert not saved.get("quantity_counts")
        finally:
            client.close()
    asyncio.run(run())


@pytest.mark.parametrize("changes", [{"qty": -1}, {"qty": float("nan")}, {"qty": float("inf")}, {"reason": "   "}, {"counted_on": "2026-02-30"}])
def test_invalid_count_inputs_are_rejected(changes):
    with pytest.raises(ValidationError): count(**changes)
