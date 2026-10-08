"""Backend regression tests for the Tile Orders workflow redesign
(Release Material / Move to Godown / Dispatch from Released / Dispatch
from Godown) and the new GET /tile-orders/dispatches (Dispatch List)
endpoint. Also covers a Quotation -> Place Order -> "order_created"
Material Movement Register smoke check, and a general
Quotations/Purchases regression.

Run: pytest /app/backend/tests/test_tile_orders_dispatch_workflow.py -v
"""
import os

import pytest
import requests

BASE_URL = os.environ.get("EXPO_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Fallback used only inside this container's own network for direct
    # backend testing when the public preview URL isn't exported to this
    # process's env — mirrors what other test files in this repo do.
    BASE_URL = "http://localhost:8001"

OWNER_EMAIL = "owner@forge.app"
OWNER_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]


@pytest.fixture(scope="module")
def api_client():
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    r = session.post(f"{BASE_URL}/api/auth/login", json={"email": OWNER_EMAIL, "password": OWNER_PASSWORD})
    if r.status_code != 200:
        pytest.skip(f"Could not log in as {OWNER_EMAIL}: {r.status_code} {r.text}")
    token = r.json().get("access_token")
    if not token:
        pytest.skip("Login response did not contain access_token")
    session.headers.update({"Authorization": f"Bearer {token}"})
    return session


class TestDispatchListEndpoint:
    """GET /api/tile-orders/dispatches — the Dispatch List tab's data source."""

    def test_returns_200_with_expected_shape(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches")
        assert r.status_code == 200
        body = r.json()
        assert "rows" in body and isinstance(body["rows"], list)
        assert "total" in body and isinstance(body["total"], int)
        assert body["total"] >= len(body["rows"])

    def test_rows_never_contain_release_or_godown_movement_rows(self, api_client):
        """Every row must be a dispatch — never a Release/Move-to-Godown
        event (those only ever appear in the Material Movement Register)."""
        r = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"page_size": 500})
        assert r.status_code == 200
        rows = r.json()["rows"]
        assert len(rows) > 0, "Expected at least one dispatch row from prior test-flow data"
        for row in rows:
            assert row["source"] in ("Released", "Godown")
            assert row["status"] in ("Dispatched", "At Godown", "Delivered")
            assert row["chalan_number"], "Every dispatch row must carry a chalan number"
            assert row["dispatch_number"], "Every dispatch row must carry a dispatch number"

    def test_filter_by_search_customer_name(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"search": "Task18"})
        assert r.status_code == 200
        rows = r.json()["rows"]
        assert len(rows) > 0
        assert all("task18" in row["customer_name"].lower() for row in rows)

    def test_filter_by_search_product_name(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"search": "AEMILIA"})
        assert r.status_code == 200
        rows = r.json()["rows"]
        assert len(rows) > 0
        assert all("aemilia" in row["tile_name"].lower() for row in rows)

    def test_filter_by_chalan_number(self, api_client):
        # First discover a real chalan number from the unfiltered list.
        r = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"page_size": 5})
        assert r.status_code == 200
        rows = r.json()["rows"]
        assert len(rows) > 0
        chalan_number = rows[0]["chalan_number"]
        r2 = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"chalan_number": chalan_number})
        assert r2.status_code == 200
        rows2 = r2.json()["rows"]
        assert len(rows2) > 0
        assert all(row["chalan_number"] == chalan_number for row in rows2)

    def test_filter_by_dispatch_number(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"page_size": 5})
        rows = r.json()["rows"]
        dispatch_number = rows[0]["dispatch_number"]
        r2 = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"dispatch_number": dispatch_number})
        assert r2.status_code == 200
        rows2 = r2.json()["rows"]
        assert all(row["dispatch_number"] == dispatch_number for row in rows2)

    def test_filter_by_customer_id(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"search": "Task18", "page_size": 1})
        rows = r.json()["rows"]
        assert len(rows) > 0
        customer_id = rows[0]["customer_id"]
        assert customer_id
        r2 = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"customer_id": customer_id})
        assert r2.status_code == 200
        rows2 = r2.json()["rows"]
        assert all(row["customer_id"] == customer_id for row in rows2)

    def test_filter_by_brand_id(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"page_size": 5})
        rows = r.json()["rows"]
        brand_id = next((row["brand_id"] for row in rows if row.get("brand_id")), None)
        if not brand_id:
            pytest.skip("No dispatch row currently has a brand_id to filter by")
        r2 = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"brand_id": brand_id})
        assert r2.status_code == 200
        rows2 = r2.json()["rows"]
        assert len(rows2) > 0
        assert all(row["brand_id"] == brand_id for row in rows2)

    def test_filter_by_product(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"product": "ALBA FIORIO"})
        assert r.status_code == 200
        rows = r.json()["rows"]
        assert len(rows) > 0
        assert all("alba fiorio" in row["tile_name"].lower() for row in rows)

    def test_filter_by_status_dispatched(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"status": "Dispatched"})
        assert r.status_code == 200
        rows = r.json()["rows"]
        assert all(row["status"] == "Dispatched" for row in rows)

    def test_filter_by_status_at_godown_is_currently_unreachable(self, api_client):
        """KNOWN GAP (see test report): nothing in the redesigned workflow
        ever sets Dispatch.godown_received_at (the old /godown-received
        endpoint is not called anywhere in the new frontend), so this
        filter can never return rows under the current implementation.
        This test documents that fact rather than asserting it's correct."""
        r = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"status": "At Godown"})
        assert r.status_code == 200
        rows = r.json()["rows"]
        assert rows == [], "If this ever returns rows, the 'At Godown' dead-filter gap has been fixed upstream"

    def test_filter_by_date_range(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tile-orders/dispatches", params={"date_from": "2020-01-01", "date_to": "2020-01-02"})
        assert r.status_code == 200
        assert r.json()["rows"] == []


class TestMaterialMovementsEndpoint:
    """GET /api/tile-orders/movements — the audit register backing the
    Material Movement Register tab."""

    def test_returns_200_with_rows(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tile-orders/movements")
        assert r.status_code == 200
        body = r.json()
        assert isinstance(body["rows"], list)
        assert len(body["rows"]) > 0

    def test_dispatch_type_rows_have_chalan_numbers_others_dont(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tile-orders/movements", params={"page_size": 500})
        rows = r.json()["rows"]
        dispatch_types = {"dispatch_from_released", "dispatch_from_godown"}
        non_dispatch_types = {"release", "move_to_godown", "order_created"}
        seen_dispatch = seen_non_dispatch = False
        for row in rows:
            if row["movement_type"] in dispatch_types:
                seen_dispatch = True
                assert row["chalan_number"], f"{row['movement_type']} row missing chalan_number"
                assert row["dispatch_number"], f"{row['movement_type']} row missing dispatch_number"
            elif row["movement_type"] in non_dispatch_types:
                seen_non_dispatch = True
                assert not row["chalan_number"], f"{row['movement_type']} row must NOT carry a chalan_number"
        assert seen_dispatch and seen_non_dispatch

    def test_search_filters_by_customer_name(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tile-orders/movements", params={"search": "Task18"})
        assert r.status_code == 200
        rows = r.json()["rows"]
        assert len(rows) > 0
        assert all("task18" in row["customer_name"].lower() for row in rows)


class TestOrderPlacementCreatesOrderCreatedMovement:
    """Regression for the 'order_created' row that domain_outbox.py's
    _handle_order_placed writes for every PO item at order-placement time
    — the first row in every tile's Material Movement Register lifecycle.
    Creates one throwaway TEST_ quotation via the real API flow (not a
    direct DB insert) to prove the write path is live, not just present in
    source."""

    def test_place_order_writes_order_created_movement(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/customers", params={"page_size": 1})
        assert r.status_code == 200
        customers = r.json()
        customer_list = customers if isinstance(customers, list) else (customers.get("customers") or customers.get("items") or [])
        if not customer_list:
            pytest.skip("No customers available to attach a test quotation to")
        customer_id = customer_list[0]["id"]

        r = api_client.get(
            f"{BASE_URL}/api/products", params={"page_size": 60},
            headers={"X-Floor-Id": "ground-floor"},
        )
        assert r.status_code == 200
        products = r.json()
        product_list = products.get("products") or products.get("items") or (products if isinstance(products, list) else [])
        if not product_list:
            pytest.skip("No products available to build a test quotation line")
        product = next((p for p in product_list if p.get("floor_id") == "ground-floor"), None)
        if not product:
            pytest.skip("No Ground Floor tile product available to build a tile quotation line")

        line_item = {
            "product_id": product["id"], "sku": product.get("sku", "TEST-SKU"), "name": product.get("name", "TEST_Product"),
            "qty": 3, "unit_price": 50, "size": product.get("size") or "600X600",
        }
        r = api_client.post(f"{BASE_URL}/api/quotations", json={
            "customer_id": customer_id, "items": [line_item], "doc_type": "tiles_quotation",
            "project_name": "TEST_pytest_order_created_regression",
        })
        assert r.status_code == 200, r.text
        quotation = r.json()
        qid = quotation["id"]

        r = api_client.patch(f"{BASE_URL}/api/quotations/{qid}", json={"status": "approved"})
        assert r.status_code == 200, r.text

        r = api_client.post(f"{BASE_URL}/api/quotations/{qid}/place-order/confirm", json={})
        assert r.status_code == 200, r.text
        result = r.json()
        po_ids = result.get("purchase_order_ids") or []
        assert len(po_ids) >= 1

        r = api_client.get(f"{BASE_URL}/api/tile-orders/movements", params={"page_size": 500})
        assert r.status_code == 200
        rows = r.json()["rows"]
        matching = [row for row in rows if row["purchase_order_id"] in po_ids and row["movement_type"] == "order_created"]
        assert len(matching) >= 1, "Expected an 'order_created' Material Movement row for the freshly placed order"


class TestRegressionQuotationsAndPurchases:
    """Confirm unrelated modules still load fine (no regressions from the
    Tile Orders / Dispatch List changes)."""

    def test_quotations_list_loads(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/quotations")
        assert r.status_code == 200

    def test_purchases_shortages_loads(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/purchases/shortages", params={"status": "awaiting_reorder"})
        assert r.status_code == 200

    def test_tile_orders_customer_orders_loads(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tile-orders/customer-orders")
        assert r.status_code == 200

    def test_tile_orders_brands_loads(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/tile-orders/brands")
        assert r.status_code == 200
