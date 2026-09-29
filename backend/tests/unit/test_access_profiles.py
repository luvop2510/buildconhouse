from access_profiles import (
    GROUND_PAYMENTS_DISPATCHES,
    GROUND_TILE_QUOTATIONS_FOLLOWUPS,
    SANITARY_PURCHASES,
    SANITARY_QUOTATIONS_FOLLOWUPS,
    profile_allows_request,
)
from auth import accessible_floor_ids
from models import UserPublic


def _profiled_user(profile: str) -> UserPublic:
    # Deliberately use the wrong legacy assignment: profile binding must be
    # authoritative or the worker is denied their own workspace.
    return UserPublic(
        id="staff-1", email="staff@example.com", full_name="Staff", role="worker",
        floor_ids=["ground-floor"], access_profile=profile,
    )


def test_tile_quotation_profile_is_limited_to_its_workflow():
    assert profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "POST", "/api/quotations")
    assert profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "PATCH", "/api/followups/123")
    assert profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "GET", "/api/products")
    assert profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "GET", "/api/categories")
    assert profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "POST", "/api/referrers")
    assert profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "POST", "/api/products/custom")
    assert profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "PATCH", "/api/customers/c-1")
    assert profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "GET", "/api/customers/c-1/po-final")
    assert profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "GET", "/api/customers/c-1/po-final/pdf")
    assert not profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "POST", "/api/customers/c-1/po-final")
    assert profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "GET", "/api/tile-orders/customer-orders?customer_id=c-1")
    assert profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "GET", "/api/tile-orders/customer-orders/co-1")
    assert profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "GET", "/api/tile-orders/customer-orders/co-1/timeline")
    assert not profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "POST", "/api/tile-orders/purchase-orders/po-1/dispatch-from-released")
    assert not profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "DELETE", "/api/customers/c-1")
    assert not profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "GET", "/api/payments")
    assert not profile_allows_request(GROUND_TILE_QUOTATIONS_FOLLOWUPS, "GET", "/api/purchases/items")


def test_payment_dispatch_profile_has_the_complete_tile_orders_workspace():
    assert profile_allows_request(GROUND_PAYMENTS_DISPATCHES, "POST", "/api/payments")
    assert profile_allows_request(GROUND_PAYMENTS_DISPATCHES, "POST", "/api/downloads/token")
    assert profile_allows_request(GROUND_PAYMENTS_DISPATCHES, "POST", "/api/tile-orders/purchase-orders/po-1/dispatch-from-released")
    assert profile_allows_request(GROUND_PAYMENTS_DISPATCHES, "PATCH", "/api/tile-orders/dispatches/d-1/transport")
    assert profile_allows_request(GROUND_PAYMENTS_DISPATCHES, "GET", "/api/tile-orders/history/export")
    assert profile_allows_request(GROUND_PAYMENTS_DISPATCHES, "POST", "/api/tile-orders/purchase-orders/po-1/ready")
    assert profile_allows_request(GROUND_PAYMENTS_DISPATCHES, "POST", "/api/tile-orders/purchase-orders/po-1/items/move-to-godown")
    assert not profile_allows_request(GROUND_PAYMENTS_DISPATCHES, "GET", "/api/purchases/items")


def test_sanitary_profiles_are_separated():
    assert profile_allows_request(SANITARY_QUOTATIONS_FOLLOWUPS, "GET", "/api/quotations")
    assert profile_allows_request(SANITARY_QUOTATIONS_FOLLOWUPS, "GET", "/api/customers/c-1/po-final")
    assert not profile_allows_request(SANITARY_QUOTATIONS_FOLLOWUPS, "GET", "/api/purchases/items")
    assert profile_allows_request(SANITARY_PURCHASES, "GET", "/api/purchases/customers/c-1/workspace")
    assert profile_allows_request(SANITARY_PURCHASES, "GET", "/api/customers")
    assert not profile_allows_request(SANITARY_PURCHASES, "GET", "/api/customers/c-1")
    assert not profile_allows_request(SANITARY_PURCHASES, "GET", "/api/payments/history")


def test_sanitary_quotation_profile_is_always_bound_to_sanitary_floor():
    assert accessible_floor_ids(_profiled_user(SANITARY_QUOTATIONS_FOLLOWUPS)) == ["first-floor"]


def test_sanitary_purchase_profile_is_always_bound_to_sanitary_floor():
    assert accessible_floor_ids(_profiled_user(SANITARY_PURCHASES)) == ["first-floor"]
