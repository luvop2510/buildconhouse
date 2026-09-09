from fastapi import FastAPI
from fastapi.testclient import TestClient

from models import UserPublic
from routes import purchase_routes


def test_status_config_literal_route_is_reachable_before_po_id_route():
    """A literal config path must never be captured as ``po_id='config'``."""
    app = FastAPI()
    app.include_router(purchase_routes.router)
    app.dependency_overrides[purchase_routes.get_current_user] = lambda: UserPublic(
        email="purchase@forge.app", full_name="Purchase", role="purchase",
        floor_ids=["first-floor"], active_floor_id="first-floor",
    )

    response = TestClient(app).get("/purchase-orders/config/statuses")

    assert response.status_code == 200
    payload = response.json()
    assert payload["columns"]
    assert payload["transitions"]
    assert payload["labels"]
