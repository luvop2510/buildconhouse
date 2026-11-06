"""Historical Kitchen orders use business dates, independently of data entry."""
import copy

import pytest
from fastapi import HTTPException

from services import kitchen_workflow as workflow
from services.kitchen_projects import validate
from tests.unit.test_kitchen_projects import setup, cmd, create_request
from tests.unit.test_kitchen_version_relationships import aggregate


@pytest.mark.asyncio
@pytest.mark.parametrize("order_date", ["2024-05-17", "2020-01-31", "1999-12-31"])
async def test_historical_order_confirmation_and_production_default_persist(setup, order_date):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="legacy-dates-create"))
    database.kitchen_projects.rows[0].update(aggregate("order"))

    project = await service.command(owner, project["id"], cmd(project["version"], "order_confirm", {
        "quotation_version_id": "q1", "order_date": order_date,
    }))

    assert project["orders"][-1]["order_date"] == order_date
    assert not project["production"].get("start_date")
    assert not workflow.production_has_started(project)
    project = await service.command(owner, project["id"], cmd(project["version"], "production_update", {
        "status": "In Production", "notes": "Historical production entry",
    }))
    reloaded = await service.get(owner, project["id"])
    for saved in (project, reloaded):
        assert saved["production"]["start_date"] == order_date
        assert saved["production"]["completion_date"] == workflow.production_end_date(order_date)
        assert saved["orders"][-1]["production_started"] is True


@pytest.mark.parametrize("order_date", ["2024-05-17", "2020-01-31", "1999-12-31"])
def test_existing_order_can_be_corrected_to_historical_business_date(setup, order_date):
    _, _, owner = setup
    project = aggregate("order")
    workflow.apply(project, "order_confirm", {"quotation_version_id": "q1", "order_date": "2026-10-25"}, {}, owner, "now", validate)
    original = copy.deepcopy(project["orders"][-1])

    workflow.apply(project, "order_update", {"order_date": order_date}, {}, owner, "now", validate)

    saved = project["orders"][-1]
    assert saved["order_date"] == order_date
    assert saved["final_amount"] == original["final_amount"]
    assert saved["quotation_version_id"] == original["quotation_version_id"]
    assert saved["corrections"][-1]["after"]["order_date"] == order_date


def test_production_manual_date_is_preserved_by_later_progress_save(setup):
    _, _, owner = setup
    project = aggregate("order")
    project["orders"] = [{"id": "order", "order_date": "2024-01-01"}]
    workflow.apply(project, "production_update", {"status": "In Production", "start_date": "2024-01-03"}, {}, owner, "now", validate)
    workflow.apply(project, "production_update", {"status": "In Production", "notes": "Progress note"}, {}, owner, "now", validate)

    assert project["production"]["start_date"] == "2024-01-03"
    assert project["production"]["completion_date"] == "2024-03-03"


@pytest.mark.parametrize("stage,command", [("production", "production_update"), ("installation", "installation_update")])
def test_missing_date_without_order_or_existing_start_still_requires_entry(setup, stage, command):
    _, _, owner = setup
    project = aggregate(stage)
    project["manual_stage_navigation"] = True
    with pytest.raises(HTTPException, match="Record the start date"):
        workflow.apply(project, command, {"status": "In Production" if stage == "production" else "In Progress"}, {}, owner, "now", validate)
