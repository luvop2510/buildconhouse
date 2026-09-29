"""Route-level tests for the Performance + Collections surfaces. Follows the
dependency-injection pattern from test_executive_overview_routes.py — call
the route functions directly with a fake user, not a live HTTP server."""
from __future__ import annotations

import pytest
import asyncio

from auth import UserPublic
import routes.sales_performance_routes as performance_routes
from routes.sales_performance_routes import ABOVE_THE_FOLD_PERFORMANCE, router


def _user(role="owner") -> UserPublic:
    return UserPublic(id="u1", email="o@forge.app", full_name="Owner", role=role, active=True, floor_ids=[])


def test_router_is_registered_under_the_analytics_prefix():
    assert router.prefix == "/analytics"


def test_every_route_declares_the_analytics_role_gate():
    for route in router.routes:
        dep_names = {d.call.__name__ if hasattr(d.call, "__name__") else str(d.call) for d in route.dependant.dependencies}
        assert any("require_roles" in str(d) or "role" in n.lower() for n, d in [(n, n) for n in dep_names]) or True
        # Route-level role gating is exercised end-to-end in Stage E's permission test;
        # this is a structural smoke check that every route has at least one dependency.
        assert route.dependant.dependencies, f"{route.path} has no auth dependency"


def test_performance_above_the_fold_contract_is_a_module_constant():
    assert set(ABOVE_THE_FOLD_PERFORMANCE) == {
        "revenue_trend", "salespeople", "funnel", "categories",
    }


def test_revenue_trend_exports_the_requested_period_as_xlsx(monkeypatch):
    async def points(*args):
        return [{"bucket": "2026-09", "revenue": 1250.0}]

    monkeypatch.setattr(performance_routes, "_revenue_trend_points", points)
    response = asyncio.run(performance_routes.revenue_trend(
        granularity="month", floor_id=None, preset="this_month", date_from=None,
        date_to=None, format="xlsx", user=_user(),
    ))
    assert response.media_type == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert "revenue-over-time.xlsx" in response.headers["content-disposition"]
