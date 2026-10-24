"""Kitchen grant integration must not widen another floor or a retired page."""
from services.access_grants import (
    action_for_api_request, resource_for_api_path, resource_supports,
    resource_candidates_for_api_path,
)
from access_profiles import profile_allows_request


def test_kitchen_commands_and_private_uploads_require_update_not_create():
    for suffix in ("commands", "attachments"):
        assert action_for_api_request("POST", f"/api/kitchen-projects/project-a/{suffix}") == "update"
    assert action_for_api_request("POST", "/api/kitchen-projects") == "create"
    assert action_for_api_request("GET", "/api/kitchen-projects/export") == "export"
    assert resource_for_api_path("/api/kitchen-projects/project-a/attachments/file-a") == "kitchen_projects"
    assert resource_for_api_path("/api/kitchen-projects-spoof") is None


def test_kitchen_allocation_stays_on_its_floor_and_old_profiles_remain_narrow():
    assert resource_supports("kitchen_projects", "second-floor", ["view", "update", "export"])
    for floor in ("first-floor", "ground-floor", "third-floor"):
        assert not resource_supports("kitchen_projects", floor, ["view"])
    assert not resource_supports("kitchen_projects", "second-floor", ["delete"])
    assert resource_candidates_for_api_path("/api/kitchen-projects", "second-floor") == ("kitchen_projects",)
    for profile in ("ground_tile_quotations_followups", "ground_payments_dispatches", "sanitary_quotations_followups", "sanitary_purchases"):
        assert not profile_allows_request(profile, "GET", "/api/kitchen-projects")
