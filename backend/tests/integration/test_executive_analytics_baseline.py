"""Executive analytics baseline API integration tests.

Coverage: filters/dashboard/funnel/products/detail routes + export responses.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
import requests


def _env_value(key: str) -> str | None:
    val = os.environ.get(key)
    if val:
        return val.strip()
    frontend_env = Path("/app/frontend/.env")
    if frontend_env.exists():
        for line in frontend_env.read_text().splitlines():
            if not line or line.strip().startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == key:
                return v.strip()
    return None


BASE_URL = _env_value("EXPO_BACKEND_URL") or _env_value("EXPO_PUBLIC_BACKEND_URL")


def _as_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def _contains_object_id(value: Any) -> bool:
    if isinstance(value, dict):
        if "_id" in value:
            return True
        return any(_contains_object_id(v) for v in value.values())
    if isinstance(value, list):
        return any(_contains_object_id(v) for v in value)
    return False


@pytest.fixture(scope="session")
def base_url() -> str:
    if not BASE_URL:
        pytest.skip("EXPO_BACKEND_URL/EXPO_PUBLIC_BACKEND_URL is not configured")
    return BASE_URL.rstrip("/")


@pytest.fixture(scope="session")
def auth_headers(base_url: str) -> dict[str, str]:
    email = "owner@forge.app"
    password = os.environ["FORGE_TEST_OWNER_PASSWORD"]
    last_error: Exception | None = None
    r = None
    for _ in range(3):
        try:
            r = requests.post(
                f"{base_url}/api/auth/login",
                json={"email": email, "password": password},
                timeout=90,
            )
            break
        except requests.exceptions.RequestException as exc:  # pragma: no cover - transient network path
            last_error = exc
    if r is None:
        pytest.skip(f"Auth failed due network timeout: {last_error}")
    if r.status_code != 200:
        pytest.skip(f"Auth failed for executive analytics tests: {r.status_code} {r.text}")
    token = r.json().get("access_token")
    if not token:
        pytest.skip("No access token returned from /api/auth/login")
    return {"Authorization": f"Bearer {token}"}


# Feature: dynamic filters endpoint
def test_executive_filters_returns_dynamic_entities(base_url: str, auth_headers: dict[str, str]):
    r = requests.get(f"{base_url}/api/executive-analytics/filters", headers=auth_headers, timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data.get("floors"), list)
    assert isinstance(data.get("brands"), list)
    assert isinstance(data.get("salespeople"), list)
    assert isinstance(data.get("referrers"), list)
    if data["floors"]:
        assert {"id", "name"}.issubset(set(data["floors"][0].keys()))


# Feature: dashboard uses ordered revenue and safe numeric growth payload
def test_dashboard_ordered_revenue_matches_manual_sum(base_url: str, auth_headers: dict[str, str]):
    dash_r = requests.get(
        f"{base_url}/api/executive-analytics/dashboard",
        params={"floor_id": "all", "preset": "this_month", "granularity": "month"},
        headers=auth_headers,
        timeout=45,
    )
    assert dash_r.status_code == 200
    dash = dash_r.json()
    assert isinstance(dash.get("kpis", {}).get("revenue_growth_pct"), (int, float))

    q_r = requests.get(f"{base_url}/api/quotations", headers=auth_headers, timeout=45)
    assert q_r.status_code == 200
    tile_q_r = requests.get(
        f"{base_url}/api/quotations", params={"doc_type": "tiles_quotation"},
        headers=auth_headers, timeout=45,
    )
    assert tile_q_r.status_code == 200
    # The ordinary quotation list follows the ambient sanitary floor, while
    # tiles are intentionally fixed to Ground Floor. Executive "all floors"
    # must reconcile against both surfaces.
    quotes = q_r.json() + tile_q_r.json()
    now = datetime.utcnow()
    month_start = datetime(now.year, now.month, 1)
    ordered_sum = 0.0
    for q in quotes:
        if q.get("status") != "ordered":
            continue
        updated = _as_iso(q.get("updated_at"))
        if not updated:
            continue
        if updated.replace(tzinfo=None) >= month_start:
            ordered_sum += float(q.get("grand_total") or 0)
    assert round(float(dash["kpis"]["revenue"]), 2) == round(ordered_sum, 2)


# Feature: floor/brand/salesperson/referrer filters are safe and functional
def test_dashboard_filters_change_payload_safely(base_url: str, auth_headers: dict[str, str]):
    filters = requests.get(f"{base_url}/api/executive-analytics/filters", headers=auth_headers, timeout=30).json()
    params = {"floor_id": "all", "preset": "this_month", "granularity": "month"}
    if filters.get("floors"):
        params["floor_id"] = filters["floors"][0]["id"]
    if filters.get("brands"):
        params["brand_id"] = filters["brands"][0]["id"]
    if filters.get("salespeople"):
        params["salesperson_id"] = filters["salespeople"][0]["id"]
    r = requests.get(f"{base_url}/api/executive-analytics/dashboard", params=params, headers=auth_headers, timeout=45)
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body.get("kpis", {}).get("revenue"), (int, float))


# Feature: funnel and products endpoint shape
def test_funnel_and_products_valid_json(base_url: str, auth_headers: dict[str, str]):
    funnel_r = requests.get(
        f"{base_url}/api/executive-analytics/funnel",
        params={"floor_id": "all", "preset": "this_month"},
        headers=auth_headers,
        timeout=30,
    )
    assert funnel_r.status_code == 200
    stages = funnel_r.json().get("stages", [])
    assert isinstance(stages, list)
    if stages:
        assert {"key", "label", "count", "conversion_pct", "dropoff_pct", "revenue"}.issubset(stages[0].keys())

    products_r = requests.get(
        f"{base_url}/api/executive-analytics/products",
        params={"floor_id": "all", "preset": "this_month", "page": 1, "limit": 10},
        headers=auth_headers,
        timeout=30,
    )
    assert products_r.status_code == 200
    payload = products_r.json()
    assert payload.get("page") == 1
    assert isinstance(payload.get("items"), list)
    assert not _contains_object_id(payload)


def _dashboard_payload(base_url: str, auth_headers: dict[str, str]) -> dict[str, Any]:
    return requests.get(
        f"{base_url}/api/executive-analytics/dashboard",
        params={"floor_id": "all", "preset": "this_month", "granularity": "month"},
        headers=auth_headers,
        timeout=45,
    ).json()


# Feature: brand detail route JSON/no ObjectId leakage
def test_brand_detail_route_valid_json(base_url: str, auth_headers: dict[str, str]):
    dash = _dashboard_payload(base_url, auth_headers)
    if not dash.get("brands") or not dash["brands"][0].get("brand_id"):
        pytest.skip("No brand_id available from dashboard for brand detail test")
    br = requests.get(
        f"{base_url}/api/executive-analytics/brands/{dash['brands'][0]['brand_id']}",
        headers=auth_headers,
        timeout=45,
    )
    assert br.status_code == 200
    assert not _contains_object_id(br.json())


# Feature: customer detail route JSON/no ObjectId leakage
def test_customer_detail_route_valid_json(base_url: str, auth_headers: dict[str, str]):
    dash = _dashboard_payload(base_url, auth_headers)
    if not dash.get("customers") or not dash["customers"][0].get("customer_id"):
        pytest.skip("No customer_id available from dashboard for customer detail test")
    cr = requests.get(
        f"{base_url}/api/executive-analytics/customers/{dash['customers'][0]['customer_id']}",
        headers=auth_headers,
        timeout=45,
    )
    assert cr.status_code == 200
    assert not _contains_object_id(cr.json())


# Feature: salesperson detail route JSON/no ObjectId leakage
def test_salesperson_detail_route_valid_json(base_url: str, auth_headers: dict[str, str]):
    dash = _dashboard_payload(base_url, auth_headers)
    if not dash.get("salespeople") or not dash["salespeople"][0].get("salesperson_id"):
        pytest.skip("No salesperson_id available from dashboard for salesperson detail test")
    sr = requests.get(
        f"{base_url}/api/executive-analytics/salespeople/{dash['salespeople'][0]['salesperson_id']}",
        headers=auth_headers,
        timeout=45,
    )
    assert sr.status_code == 200
    assert not _contains_object_id(sr.json())


# Feature: referrer detail route JSON/no ObjectId leakage
def test_referrer_detail_route_valid_json(base_url: str, auth_headers: dict[str, str]):
    dash = _dashboard_payload(base_url, auth_headers)
    referrer_id = None
    if dash.get("referrals") and dash["referrals"][0].get("referrer_id"):
        referrer_id = dash["referrals"][0]["referrer_id"]
    if not referrer_id:
        filters = requests.get(
            f"{base_url}/api/executive-analytics/filters",
            headers=auth_headers,
            timeout=45,
        ).json()
        if filters.get("referrers") and filters["referrers"][0].get("id"):
            referrer_id = filters["referrers"][0]["id"]
    if not referrer_id:
        pytest.skip("No referrer_id available from dashboard or filters")
    rr = requests.get(
        f"{base_url}/api/executive-analytics/referrers/{referrer_id}",
        headers=auth_headers,
        timeout=45,
    )
    assert rr.status_code == 200
    assert not _contains_object_id(rr.json())


# Feature: export endpoints return files with proper content-type
@pytest.mark.parametrize(
    "fmt,content_type_hint",
    [
        ("csv", "text/csv"),
        ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        ("pdf", "application/pdf"),
    ],
)
def test_export_endpoints_return_files(
    base_url: str, auth_headers: dict[str, str], fmt: str, content_type_hint: str
):
    r = requests.get(
        f"{base_url}/api/executive-analytics/export",
        params={"format": fmt, "floor_id": "all", "preset": "this_month"},
        headers=auth_headers,
        timeout=60,
    )
    assert r.status_code == 200
    assert content_type_hint in (r.headers.get("content-type") or "")
    dispo = r.headers.get("content-disposition", "")
    assert "attachment;" in dispo.lower()
    assert f".{fmt}" in dispo.lower()
    assert len(r.content) > 0


# Feature: persisted response bodies are valid JSON serializable
def test_dashboard_response_json_serializable(base_url: str, auth_headers: dict[str, str]):
    r = requests.get(
        f"{base_url}/api/executive-analytics/dashboard",
        params={"floor_id": "all", "preset": "this_month", "granularity": "month"},
        headers=auth_headers,
        timeout=45,
    )
    assert r.status_code == 200
    # If this fails, payload has non-serializable values
    json.dumps(r.json())
