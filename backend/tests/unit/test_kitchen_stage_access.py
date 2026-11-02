"""Stage delegation uses existing grant resources and never inherits sibling access."""
import copy
import pytest
from fastapi import HTTPException

from models import UserPublic
from services import kitchen_access as access
from services.access_grants import (KITCHEN_STAGE_RESOURCES, action_for_api_request, build_grant,
    delegation_resource_catalog, granted_floor_ids, resource_supports)
from tests.unit.test_kitchen_projects import setup
from tests.unit.test_kitchen_version_relationships import aggregate


def stage_staff(database, stage, actions=None):
    user = UserPublic(id="staff-a", full_name="Scoped staff", role="worker", active_floor_id="second-floor",
                      floor_ids=["second-floor"], custom_access=True)
    grant = build_grant(user_id=user.id, resource=KITCHEN_STAGE_RESOURCES[stage], actions=actions or ["view", "update"],
                        floor_id="second-floor", expires_at=None, actor_id="owner", actor_name="Owner")
    database.users.rows[0].update(delegation_grants=[grant])
    return user, grant


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", KITCHEN_STAGE_RESOURCES)
async def test_each_stage_grant_is_independent_and_only_lead_supports_creation(setup, stage):
    database, _, _ = setup
    user, grant = stage_staff(database, stage)
    assert await access.capability(database, user, "view", stage=stage)
    assert await access.capability(database, user, "update", stage=stage)
    sibling = "visit" if stage == "lead" else "lead"
    assert not await access.capability(database, user, "view", stage=sibling)
    assert access.scope_query(user, {}) == {"floor_id": "second-floor", "stage": {"$in": [stage]}}
    assert not await access.capability(database, user, "create")
    assert resource_supports(grant["resource"], "second-floor", ["view", "create"]) is (stage == "lead")
    assert not resource_supports(grant["resource"], "first-floor", ["view"])
    assert granted_floor_ids([grant], user_id=user.id, path="/api/kitchen-projects/project/commands", action="update", method="POST") == ["second-floor"]


@pytest.mark.asyncio
async def test_production_update_does_not_grant_financial_commands(setup):
    database, _, _ = setup
    user, _ = stage_staff(database, "production")
    await access.capability(database, user, "update")
    await access.require_command(database, user, {"stage": "production"}, "production_update")
    for command in ("order_installment", "order_advance", "installation_material_photos", "design_handoff", "site_visit"):
        with pytest.raises(HTTPException) as denied:
            await access.require_command(database, user, {"stage": "production"}, command)
        assert denied.value.status_code == 403


@pytest.mark.asyncio
async def test_legacy_workspace_grant_still_authorizes_every_stage(setup):
    database, _, _ = setup
    user, grant = stage_staff(database, "lead", ["view", "create", "update", "export"])
    grant["resource"] = "kitchen_projects"
    database.users.rows[0]["delegation_grants"] = [grant]
    assert await access.capability(database, user, "create")
    assert access.allowed_stages(user) == list(KITCHEN_STAGE_RESOURCES)
    assert access.scope_query(user, {}) == {"floor_id": "second-floor"}
    assert not access.scoped(user)


def test_stage_resources_are_assignable_and_uploads_use_update_permission():
    catalog = delegation_resource_catalog(["second-floor", "first-floor"])
    for resource in KITCHEN_STAGE_RESOURCES.values():
        row = next(row for row in catalog if row["key"] == resource)
        assert row["assignable_floor_ids"] == ["second-floor"]
    assert action_for_api_request("POST", "/api/kitchen-projects/p/file-transfers") == "update"
    assert action_for_api_request("POST", "/api/kitchen-projects/p/file-transfers/t/finish") == "update"
    assert action_for_api_request("DELETE", "/api/kitchen-projects/p/file-transfers/t") == "update"


@pytest.mark.asyncio
async def test_quotation_worker_sees_binding_without_order_details(setup):
    database, _, _ = setup
    user, _ = stage_staff(database, "quotation")
    await access.capability(database, user, "update", stage="quotation")
    project = aggregate("quotation")
    project["floor_id"] = "second-floor"
    project["orders"] = [{"quotation_version_id": "q1", "final_amount": "123456.00", "authorization_invalidated": True}]
    original = copy.deepcopy(project)
    response = access.redact_project(copy.deepcopy(project), project, user)
    assert response["orders"] == []
    quotes = {row["id"]: row for row in response["quotation_versions"]}
    assert quotes["q1"]["order_bound"] is True
    assert quotes["q2"]["order_bound"] is False
    assert project == original
