"""Exercise request fanout and cache outage behavior, without live infrastructure."""
import asyncio
from types import SimpleNamespace

import pytest

from models import UserPublic
from routes import payment_routes as payments
from services.analytics import cache


def test_payment_detail_overlaps_all_independent_reads(monkeypatch):
    started = set()
    async def run():
        gate = asyncio.Event()
        async def read(name, result):
            started.add(name)
            if len(started) == 6:
                gate.set()
            await gate.wait()
            return result
        quote = {"id": "q", "floor_id": "ground-floor", "customer_id": "c", "status": "ordered", "grand_total": 500}
        class Quotes:
            async def find_one(self, *_args): return quote
        class Customers:
            async def find_one(self, *_args): return await read("customer", {"id": "c"})
        class Cursor:
            def sort(self, *_args): return self
            async def to_list(self, *_args): return await read("ledger", [])
        class Ledger:
            def find(self, *_args): return Cursor()
        async def paid(_ids, **kwargs): return await read("cash" if kwargs.get("cash_only") else "paid", {})
        async def stock(*_args, **_kwargs): return await read("stock", {})
        async def mrp(*_args): return await read("mrp", 500)
        monkeypatch.setattr(payments, "db", SimpleNamespace(quotations=Quotes(), customers=Customers(), payments=Ledger()))
        monkeypatch.setattr(payments, "_paid_by_quotation", paid)
        monkeypatch.setattr(payments, "_godown_value_by_quotation", stock)
        monkeypatch.setattr(payments, "_mrp_for_quotation", mrp)
        user = UserPublic(id="u", email="u@example.com", full_name="Accounts", role="owner", active_floor_id="ground-floor")
        detail = await asyncio.wait_for(payments.order_detail("q", user=user), 1)
        assert detail["outstanding"] == 500
        assert detail["floor_id"] == "ground-floor"
    asyncio.run(run())
    assert len(started) == 6


@pytest.mark.parametrize("failure", ["version", "read", "store"])
def test_cache_outage_cannot_hold_authoritative_read(monkeypatch, failure):
    class Redis:
        async def get(self, key):
            if failure == "version" or failure == "read" and not key.startswith("analytics:ver:"):
                await asyncio.Event().wait()
            return None
        async def set(self, *_args, **_kwargs):
            if failure == "store": await asyncio.Event().wait()
        async def incr(self, *_args): await asyncio.Event().wait()
    monkeypatch.setattr(cache, "_redis", lambda: Redis())
    monkeypatch.setattr(cache, "_REDIS_TIMEOUT_SECONDS", 0.01)
    async def run():
        calls = []
        async def load(): calls.append(True); return {"fresh": True}
        result = await asyncio.wait_for(cache.cached("outage", ["payments"], "", ["ground-floor"], load), 0.2)
        assert result == {"fresh": True}
        assert calls == [True]
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(cache.bump("payments"), 0.2)
    asyncio.run(run())


def test_labor_history_names_the_editor_without_changing_cash_totals(monkeypatch):
    class Cursor:
        async def to_list(self, *_args): return []
    class Collection:
        def find(self, *_args): return Cursor()
    monkeypatch.setattr(payments, "db", SimpleNamespace(quotations=Collection(), payments=Collection()))
    async def names(): return {"ground-floor": "Ground Floor"}
    monkeypatch.setattr(payments, "_floor_names", names)
    row = {"id": "labor", "label": "labor cost", "amount": 500, "status": "pending", "floor_id": "ground-floor", "recorded_by_name": "Dispatch Worker"}
    result = asyncio.run(payments._enrich_history_rows([row]))
    assert result[0]["label"] == "Labor cost has been added · ₹500.00 by Dispatch Worker"
    assert result[0]["status"] == "pending"
