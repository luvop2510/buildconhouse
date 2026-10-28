"""Furniture editor can load before the optional reference aggregation."""
import asyncio
from routes import furniture_quotation_routes as routes
from services import referrer_identity


def test_furniture_read_can_defer_acquisition_without_changing_default(monkeypatch):
    calls = []
    async def lookup(quotation_id, user):
        return {"id": quotation_id, "referrer_id": "r1"}
    async def counts(db, ids, floors):
        calls.append((ids, floors))
        return {"r1": 7}
    monkeypatch.setattr(routes, "lookup", lookup)
    monkeypatch.setattr(referrer_identity, "acquired_counts", counts)
    async def run():
        initial = await routes.get_quotation("q1", include_acquisition=False, user=object())
        assert initial == {"id": "q1", "referrer_id": "r1"}
        assert calls == []
        enriched = await routes.get_quotation("q1", user=object())
        assert enriched["referrer_customers_acquired"] == 7
    asyncio.run(run())
    assert calls == [(["r1"], ["third-floor"])]
