"""Prospective walk-in identities are not purchasing customer workspaces."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from models import UserPublic
from routes import purchases_tracker as tracker
from services import customer_completion


def user():
    return UserPublic(email="sales@example.test", full_name="Sales", role="sales",
                      floor_ids=["first-floor", "ground-floor"], active_floor_id="first-floor")


def test_confirmation_reads_run_in_parallel_and_keep_only_usable_identities():
    async def run():
        started = []
        all_started = asyncio.Event()

        async def read(name, values):
            started.append(name)
            if len(started) == 3:
                all_started.set()
            await asyncio.wait_for(all_started.wait(), timeout=1)
            return values

        async def quotation_read(*_):
            return await read("quotation", ["buyer", None, 123])

        async def tile_read(*_):
            return await read("tile", ["tile", ""])

        quotations = SimpleNamespace(distinct=AsyncMock(side_effect=quotation_read))
        tiles = SimpleNamespace(distinct=AsyncMock(side_effect=tile_read))
        purchases = SimpleNamespace(aggregate=lambda _: SimpleNamespace(
            to_list=lambda _: read("purchase", [{"_id": "recipient"}, {"_id": "buyer"}]),
        ))
        database = SimpleNamespace(quotations=quotations, customer_orders=tiles, purchase_orders=purchases)
        assert await customer_completion.confirmed_customer_ids(database, user()) == {"buyer", "tile", "recipient"}
        quote_query = quotations.distinct.call_args.args[1]
        tile_query = tiles.distinct.call_args.args[1]
        assert quote_query == {"$and": [{"floor_id": {"$in": ["first-floor"]}}, {"status": {"$in": ["ordered", "won"]}}]}
        assert tile_query == {"$and": [{"floor_id": {"$in": ["first-floor"]}}, {"is_deleted": {"$ne": True}}]}
    asyncio.run(run())


@pytest.mark.parametrize("include_completed", [False, True])
def test_purchases_workspace_query_requires_orders_even_when_including_completed(monkeypatch, include_completed):
    recorded = []
    profiles = {value: {"id": value, "name": value} for value in ["walkin", "draft", "buyer", "complete"]}

    class Customers:
        def aggregate(self, pipeline):
            recorded.append(pipeline)
            eligible = pipeline[0]["$match"]["$and"][1]["id"]["$in"]
            return SimpleNamespace(to_list=AsyncMock(return_value=[profiles[c] for c in eligible]))

    database = SimpleNamespace(
        customers=Customers(),
        quotations=SimpleNamespace(distinct=AsyncMock(return_value=["buyer", "complete"])),
        customer_orders=SimpleNamespace(distinct=AsyncMock(return_value=[])),
        purchase_orders=SimpleNamespace(aggregate=lambda _: SimpleNamespace(to_list=AsyncMock(return_value=[]))),
    )
    completed = AsyncMock(return_value={"complete"})
    monkeypatch.setattr(tracker, "db", database)
    monkeypatch.setattr(tracker, "completed_customer_ids", completed)
    result = asyncio.run(tracker.active_customer_workspaces(include_completed, user()))
    assert {row["id"] for row in result} == ({"buyer", "complete"} if include_completed else {"buyer"})
    assert recorded[0][0]["$match"]["$and"][0] == {"floor_id": {"$in": ["first-floor"]}}
    assert (completed.await_count == 0) == include_completed
