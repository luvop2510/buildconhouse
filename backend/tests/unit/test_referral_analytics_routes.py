"""Route-level tests for Referral Analytics. Mirrors test_sales_performance_routes.py."""
from __future__ import annotations

import asyncio

from auth import UserPublic
import routes.referral_analytics_routes as referral_routes
from routes.referral_analytics_routes import router


def test_router_is_registered_under_the_analytics_prefix():
    assert router.prefix == "/analytics"


def test_every_route_has_an_auth_dependency():
    for route in router.routes:
        assert route.dependant.dependencies, f"{route.path} has no auth dependency"


def test_the_referrer_list_route_and_the_detail_route_both_exist():
    paths = {r.path for r in router.routes}
    assert "/analytics/referrers" in paths
    assert "/analytics/referrers/{referrer_id}" in paths


def test_architect_export_has_distinct_filename(monkeypatch):
    async def rows(*args):
        return [{"name": "Architect A", "type": "architect", "revenue": 100.0}]

    monkeypatch.setattr(referral_routes, "_referrer_summary_rows", rows)
    user = UserPublic(id="u1", email="owner@example.com", full_name="Owner", role="owner", active=True, floor_ids=[])
    response = asyncio.run(referral_routes.referrers(
        type="architect", floor_id=None, preset="this_month", date_from=None,
        date_to=None, format="xlsx", user=user,
    ))
    assert response.media_type == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert "revenue-by-architect.xlsx" in response.headers["content-disposition"]
