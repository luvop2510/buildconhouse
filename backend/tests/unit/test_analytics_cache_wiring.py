"""Acting on an Attention row must refresh the numbers. Every analytics-visible
write bumps its collection version, which changes every dependent cache key."""
from __future__ import annotations

import asyncio

from services import domain_outbox
from services.analytics import cache


def test_a_quotation_write_invalidates_every_quotation_backed_metric():
    async def go():
        cache.reset_memory_state()
        before = await cache.cache_key("revenue", ["quotations"], "sig", None)
        await cache.bump("quotations")
        assert await cache.cache_key("revenue", ["quotations"], "sig", None) != before
    asyncio.run(go())


def test_every_outbox_event_declares_the_collections_it_invalidates():
    for event_type in (domain_outbox.EVENT_QUOTATION_GENERATED,
                       domain_outbox.EVENT_ORDER_PLACED,
                       domain_outbox.EVENT_PURCHASE_TRANSFERRED):
        assert domain_outbox._EVENT_COLLECTIONS.get(event_type), f"{event_type} bumps nothing"


def test_placing_an_order_invalidates_revenue_and_outstanding():
    async def go():
        cache.reset_memory_state()
        revenue_before = await cache.cache_key("revenue", ["quotations"], "sig", None)
        outstanding_before = await cache.cache_key("outstanding", ["quotations", "payments"], "sig", None)
        await domain_outbox._bump_analytics_versions(domain_outbox.EVENT_ORDER_PLACED)
        assert await cache.cache_key("revenue", ["quotations"], "sig", None) != revenue_before
        assert await cache.cache_key("outstanding", ["quotations", "payments"], "sig", None) != outstanding_before
    asyncio.run(go())


def test_an_unrelated_metric_is_not_invalidated():
    async def go():
        cache.reset_memory_state()
        before = await cache.cache_key("walkins", ["walkins"], "sig", None)
        await domain_outbox._bump_analytics_versions(domain_outbox.EVENT_QUOTATION_GENERATED)
        assert await cache.cache_key("walkins", ["walkins"], "sig", None) == before
    asyncio.run(go())


def test_a_failing_bump_never_fails_the_committed_command(monkeypatch):
    """The business transaction is already committed. A cache problem must
    degrade to TTL expiry, not turn a placed order into an error."""
    async def boom(_collection):
        raise RuntimeError("redis down")

    monkeypatch.setattr(cache, "bump", boom)
    asyncio.run(domain_outbox._bump_analytics_versions(domain_outbox.EVENT_ORDER_PLACED))


def test_the_bump_happens_after_the_transaction_not_inside_it():
    """Driver retries must finish before cache versions expose committed effects."""
    import ast
    import inspect
    tree = ast.parse(inspect.getsource(domain_outbox))
    transaction_calls = [n for n in ast.walk(tree) if isinstance(n, ast.Await)
                         and isinstance(n.value, ast.Call)
                         and getattr(n.value.func, "attr", "") == "with_transaction"]
    assert transaction_calls
    for commit in transaction_calls:
        function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
                        and n.lineno <= commit.lineno <= n.end_lineno)
        bumps = [n for n in ast.walk(function) if isinstance(n, ast.Await)
                 and isinstance(n.value, ast.Call)
                 and getattr(n.value.func, "id", "") == "_bump_analytics_versions"]
        assert len(bumps) == 1
        assert bumps[0].lineno > commit.lineno
        # A direct function statement is outside both session and transaction callbacks.
        assert any(isinstance(n, ast.Expr) and n.value is bumps[0] for n in function.body)
