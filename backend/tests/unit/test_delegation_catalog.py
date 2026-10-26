"""Current page choices never erase or widen historical floor grants."""
from services.access_grants import (
    RESOURCE_REGISTRY, build_grant, delegation_resource_catalog, grant_allows,
    resource_supports,
)

FLOORS = ["ground-floor", "first-floor", "second-floor", "third-floor"]


def test_kitchen_assignment_only_offers_the_current_workspace():
    catalog = delegation_resource_catalog(FLOORS)
    kitchen = [row for row in catalog if "second-floor" in row["assignable_floor_ids"]]
    assert [row["key"] for row in kitchen] == ["kitchen_projects"]
    assert kitchen[0]["label"] == "Kitchen workspace"
    assert kitchen[0]["actions"] == ["view", "create", "update", "export"]


def test_current_catalog_preserves_historical_grants_for_round_trip_and_revocation():
    catalog = {row["key"]: row for row in delegation_resource_catalog(FLOORS)}
    for key in ["dashboard", "customers", "payments", "followups", "walkins", "notifications", "sales_data", "notebook_walkins", "notebook_quotations"]:
        assert "second-floor" in catalog[key]["floor_ids"]
        assert "second-floor" not in catalog[key]["assignable_floor_ids"]
        assert resource_supports(key, "second-floor", ["view"])
    assert catalog["notebook_walkins"]["assignable_floor_ids"] == []
    assert catalog["notebook_quotations"]["assignable_floor_ids"] == []


def test_other_floors_keep_current_resources_and_floor_boundaries():
    catalog = {row["key"]: row for row in delegation_resource_catalog(FLOORS)}
    assert catalog["payments"]["assignable_floor_ids"] == ["ground-floor", "first-floor", "third-floor"]
    assert catalog["tiles"]["assignable_floor_ids"] == ["ground-floor"]
    assert catalog["quotations"]["assignable_floor_ids"] == ["first-floor"]
    assert catalog["furniture_quotations"]["assignable_floor_ids"] == ["third-floor"]
    assert catalog["kitchen_projects"]["floor_ids"] == ["second-floor"]
    assert "reports" not in catalog
    assert delegation_resource_catalog([]) == [dict(row, floor_ids=[], assignable_floor_ids=[]) for row in delegation_resource_catalog(FLOORS)]


def test_catalog_does_not_modify_permission_enforcement_registry():
    before = {key: dict(value) for key, value in RESOURCE_REGISTRY.items()}
    delegation_resource_catalog(FLOORS)
    assert RESOURCE_REGISTRY == before
    grant = build_grant(user_id="staff", resource="payments", actions=["view"], floor_id="second-floor", expires_at=None, actor_id="owner", actor_name="Owner")
    assert grant_allows(grant, user_id="staff", resource="payments", action="view", floor_id="second-floor")
    assert not grant_allows(grant, user_id="staff", resource="kitchen_projects", action="view", floor_id="second-floor")
    assert not grant_allows(grant, user_id="staff", resource="payments", action="view", floor_id="first-floor")
