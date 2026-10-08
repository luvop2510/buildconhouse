"""Tile Orders restore regression: release -> move to godown -> dispatch from released/godown."""

from __future__ import annotations

import os
import uuid

import pytest
import requests


BASE_URL = (os.environ.get("EXPO_BACKEND_URL") or "").rstrip("/")
OWNER_EMAIL = "owner@forge.app"
OWNER_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]


@pytest.fixture(scope="module")
def api_client() -> requests.Session:
    """Authenticated API session for Tile Orders workflow endpoints."""
    if not BASE_URL:
        pytest.skip("EXPO_BACKEND_URL is required for regression testing")

    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})

    login = None
    last_error: Exception | None = None
    for _ in range(2):
        try:
            login = session.post(
                f"{BASE_URL}/api/auth/login",
                json={"email": OWNER_EMAIL, "password": OWNER_PASSWORD},
                timeout=45,
            )
            break
        except requests.exceptions.RequestException as exc:
            last_error = exc
    if login is None:
        pytest.skip(f"Owner login network timeout: {last_error}")
    if login.status_code != 200:
        pytest.skip(f"Owner login failed: {login.status_code}")

    token = login.json().get("access_token")
    if not token:
        pytest.skip("Owner login response missing access_token")
    session.headers.update({"Authorization": f"Bearer {token}"})
    return session


def _customer_id(session: requests.Session) -> str:
    r = session.get(f"{BASE_URL}/api/customers", params={"page_size": 1}, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    rows = body if isinstance(body, list) else (body.get("customers") or body.get("items") or [])
    assert rows, "No customers available"
    return rows[0]["id"]


def _tile_product(session: requests.Session) -> dict:
    r = session.get(f"{BASE_URL}/api/products", params={"page_size": 25}, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    rows = body.get("products") or body.get("items") or (body if isinstance(body, list) else [])
    assert rows, "No products available"
    product = next((p for p in rows if p.get("id") and p.get("name")), rows[0])
    return product


def _po_item(detail: dict, product_name: str) -> dict:
    items = detail.get("items") or []
    assert items, "Purchase order has no items"
    by_name = next((i for i in items if i.get("name") == product_name), None)
    return by_name or items[0]


def test_restore_workflow_generates_single_dispatch_and_chalan_per_action(api_client: requests.Session):
    """Full API path: quotation->PO, release, move, two dispatches, dispatch-list + movement checks."""
    customer_id = _customer_id(api_client)
    product = _tile_product(api_client)

    # module: quotation -> place-order
    unique = f"TEST_restore_{uuid.uuid4().hex[:8]}"
    quotation_payload = {
        "customer_id": customer_id,
        "doc_type": "tiles_quotation",
        "project_name": unique,
        "items": [
            {
                "product_id": product["id"],
                "sku": product.get("sku") or f"TEST-SKU-{uuid.uuid4().hex[:6]}",
                "name": product.get("name") or "TEST_Tile",
                "qty": 3,
                "unit_price": float(product.get("price") or 100),
                "size": product.get("size") or "600X600",
            }
        ],
    }
    create_q = api_client.post(f"{BASE_URL}/api/quotations", json=quotation_payload, timeout=30)
    assert create_q.status_code == 200, create_q.text
    qid = create_q.json()["id"]

    approve = api_client.patch(f"{BASE_URL}/api/quotations/{qid}", json={"status": "approved"}, timeout=30)
    assert approve.status_code == 200, approve.text

    placed = api_client.post(f"{BASE_URL}/api/quotations/{qid}/place-order/confirm", json={}, timeout=40)
    assert placed.status_code == 200, placed.text
    po_ids = placed.json().get("purchase_order_ids") or []
    assert po_ids, "No purchase_order_ids returned from place-order/confirm"
    po_id = po_ids[0]

    detail_1 = api_client.get(f"{BASE_URL}/api/tile-orders/purchase-orders/{po_id}", timeout=30)
    assert detail_1.status_code == 200, detail_1.text
    po_before = detail_1.json()
    item = _po_item(po_before, quotation_payload["items"][0]["name"])
    po_item_id = item["id"]

    # module: release material (brand flow)
    release = api_client.post(
        f"{BASE_URL}/api/tile-orders/purchase-orders/{po_id}/ready",
        json={"items": [{"po_item_id": po_item_id, "qty": 2}]},
        timeout=30,
    )
    assert release.status_code == 200, release.text

    detail_2 = api_client.get(f"{BASE_URL}/api/tile-orders/purchase-orders/{po_id}", timeout=30)
    assert detail_2.status_code == 200
    item_2 = _po_item(detail_2.json(), quotation_payload["items"][0]["name"])
    assert float(item_2.get("boxes_ready") or 0) == 2
    assert float(item_2.get("boxes_pending") or 0) == 1

    # module: move to godown (customer flow)
    moved = api_client.post(
        f"{BASE_URL}/api/tile-orders/purchase-orders/{po_id}/items/move-to-godown",
        json={"items": [{"po_item_id": po_item_id, "qty": 1}]},
        timeout=30,
    )
    assert moved.status_code == 200, moved.text

    detail_3 = api_client.get(f"{BASE_URL}/api/tile-orders/purchase-orders/{po_id}", timeout=30)
    assert detail_3.status_code == 200
    item_3 = _po_item(detail_3.json(), quotation_payload["items"][0]["name"])
    assert float(item_3.get("boxes_ready") or 0) == 1
    assert float(item_3.get("boxes_godown") or 0) == 1

    # module: dispatch from released
    dispatch_rel = api_client.post(
        f"{BASE_URL}/api/tile-orders/purchase-orders/{po_id}/dispatch-from-released",
        json={"items": [{"po_item_id": po_item_id, "qty": 1}]},
        timeout=30,
    )
    assert dispatch_rel.status_code == 200, dispatch_rel.text
    rel_body = dispatch_rel.json()
    rel_dispatch_number = rel_body["dispatch"]["dispatch_number"]
    rel_chalan_id = rel_body["chalan"]["id"]
    rel_chalan_number = rel_body["chalan"]["number"]

    # module: dispatch from godown
    dispatch_godown = api_client.post(
        f"{BASE_URL}/api/tile-orders/purchase-orders/{po_id}/dispatch-from-godown",
        json={"items": [{"po_item_id": po_item_id, "qty": 1}]},
        timeout=30,
    )
    assert dispatch_godown.status_code == 200, dispatch_godown.text
    godown_body = dispatch_godown.json()
    godown_dispatch_number = godown_body["dispatch"]["dispatch_number"]
    godown_chalan_id = godown_body["chalan"]["id"]
    godown_chalan_number = godown_body["chalan"]["number"]

    assert rel_dispatch_number != godown_dispatch_number
    assert rel_chalan_number != godown_chalan_number

    detail_4 = api_client.get(f"{BASE_URL}/api/tile-orders/purchase-orders/{po_id}", timeout=30)
    assert detail_4.status_code == 200
    item_4 = _po_item(detail_4.json(), quotation_payload["items"][0]["name"])
    assert float(item_4.get("boxes_ready") or 0) == 0
    assert float(item_4.get("boxes_godown") or 0) == 0
    assert float(item_4.get("boxes_dispatched") or 0) == 2
    assert float(item_4.get("boxes_pending") or 0) == 1

    # module: dispatch list rows exactly once per dispatch action
    rel_rows = api_client.get(
        f"{BASE_URL}/api/tile-orders/dispatches", params={"dispatch_number": rel_dispatch_number, "page_size": 50}, timeout=30,
    )
    assert rel_rows.status_code == 200, rel_rows.text
    rel_filtered = rel_rows.json().get("rows") or []
    assert len(rel_filtered) == 1
    assert rel_filtered[0]["source"] == "Released"
    assert rel_filtered[0]["chalan_number"] == rel_chalan_number

    godown_rows = api_client.get(
        f"{BASE_URL}/api/tile-orders/dispatches", params={"dispatch_number": godown_dispatch_number, "page_size": 50}, timeout=30,
    )
    assert godown_rows.status_code == 200, godown_rows.text
    godown_filtered = godown_rows.json().get("rows") or []
    assert len(godown_filtered) == 1
    assert godown_filtered[0]["source"] == "Godown"
    assert godown_filtered[0]["chalan_number"] == godown_chalan_number

    # module: chalan PDF bytes valid for both dispatch paths
    rel_pdf = api_client.get(f"{BASE_URL}/api/tile-orders/chalans/{rel_chalan_id}/pdf", timeout=30)
    assert rel_pdf.status_code == 200
    assert rel_pdf.headers.get("content-type", "").startswith("application/pdf")
    assert rel_pdf.content[:4] == b"%PDF"

    godown_pdf = api_client.get(f"{BASE_URL}/api/tile-orders/chalans/{godown_chalan_id}/pdf", timeout=30)
    assert godown_pdf.status_code == 200
    assert godown_pdf.headers.get("content-type", "").startswith("application/pdf")
    assert godown_pdf.content[:4] == b"%PDF"

    # module: movement register entries created once per submitted action
    movement_resp = api_client.get(f"{BASE_URL}/api/tile-orders/movements", params={"page_size": 500}, timeout=30)
    assert movement_resp.status_code == 200, movement_resp.text
    rows = movement_resp.json().get("rows") or []
    po_rows = [r for r in rows if r.get("purchase_order_id") == po_id and r.get("po_item_id") == po_item_id]

    types = [r.get("movement_type") for r in po_rows]
    assert types.count("release") == 1
    assert types.count("move_to_godown") == 1
    assert types.count("dispatch_from_released") == 1
    assert types.count("dispatch_from_godown") == 1
