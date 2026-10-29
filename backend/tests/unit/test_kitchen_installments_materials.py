"""Kitchen-only payment receipts, material photos and automatic production dates."""
from decimal import Decimal

import pytest
from fastapi import HTTPException

from services import kitchen_workflow as workflow
from services.analytics.unified import normalize
from tests.unit.test_kitchen_projects import setup, cmd, create_request
from tests.unit.test_kitchen_version_relationships import aggregate


async def confirmed(setup):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="installments-create"))
    stored = database.kitchen_projects.rows[0]
    stored.update(aggregate("order"))
    stored["quotation_versions"][0]["amount"] = "1000000.00"
    project = await service.command(owner, project["id"], cmd(project["version"], "order_confirm", {"quotation_version_id": "q1", "order_date": "2026-10-25"}))
    return database, service, owner, project


@pytest.mark.asyncio
async def test_installments_are_dated_append_only_replay_safe_and_cannot_overpay(setup):
    database, service, owner, project = await confirmed(setup)
    order_id = project["orders"][-1]["id"]
    approval = project["orders"][-1]["approval_identity"]
    for index, amount in enumerate(["300000", "200000", "100000", "100000", "300000"]):
        request = cmd(project["version"], "order_installment", {"order_id": order_id, "amount": amount, "date": "2026-10-26"}, f"installment-{index}")
        project = await service.command(owner, project["id"], request)
        replay = await service.command(owner, project["id"], request)
        assert replay["replayed"] and len(replay["orders"][-1]["installments"]) == index + 1
    order = project["orders"][-1]
    assert workflow.order_paid(order) == Decimal("1000000.00")
    assert order["approval_identity"] == approval
    assert all(row["date"] == "2026-10-26" and row["actor_id"] == owner.id for row in order["installments"])
    with pytest.raises(HTTPException, match="remaining"):
        await service.command(owner, project["id"], cmd(project["version"], "order_installment", {"order_id": order_id, "amount": "0.01", "date": "2026-10-26"}))
    assert len(database.kitchen_projects.rows[0]["orders"][-1]["installments"]) == 5
    normalized = normalize("kitchen", {"id": project["id"], "floor_id": "second-floor", "_order": order}, {}, {}, [])
    assert normalized["collected"] == 1000000 and normalized["outstanding"] == 0
    assert len(normalized["payments"]) == 5


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [{"amount":"0", "date":"2026-10-26"}, {"amount":"-1", "date":"2026-10-26"}, {"amount":"1.001", "date":"2026-10-26"}, {"amount":"1", "date":"2026-10-24"}, {"amount":"1", "date":"9999-12-31"}, {"amount":"1", "date":""}])
async def test_invalid_installment_cannot_write(setup, payload):
    database, service, owner, project = await confirmed(setup)
    with pytest.raises(HTTPException):
        await service.command(owner, project["id"], cmd(project["version"], "order_installment", {"order_id": project["orders"][-1]["id"], **payload}))
    assert not database.kitchen_projects.rows[0]["orders"][-1]["installments"]


@pytest.mark.asyncio
async def test_arrival_and_installments_follow_current_order_and_stage(setup):
    database, service, owner, project = await confirmed(setup)
    order_id = project["orders"][-1]["id"]
    database.kitchen_projects.rows[0]["stage"] = "production"
    project = await service.command(owner, project["id"], cmd(project["version"], "order_material_arrived", {"order_id":order_id,"arrived":False}))
    assert project["orders"][-1]["material_arrived"] is False
    project = await service.command(owner, project["id"], cmd(project["version"], "order_installment", {"order_id":order_id,"amount":"100","date":"2026-10-26"}))
    project = await service.command(owner, project["id"], cmd(project["version"], "order_material_arrived", {"order_id":order_id,"arrived":True}))
    assert project["orders"][-1]["material_arrived"] is True
    with pytest.raises(HTTPException):
        await service.command(owner, project["id"], cmd(project["version"], "order_installment", {"order_id":"old-order","amount":"1","date":"2026-10-26"}))


@pytest.mark.parametrize("start,end", [("2026-10-20","2026-12-20"),("2026-10-29","2026-12-29"),("2026-12-31","2027-02-28"),("2023-12-31","2024-02-29"),("2026-01-31","2026-03-31")])
def test_exact_two_calendar_months(start, end):
    assert workflow.production_end_date(start) == end


@pytest.mark.asyncio
async def test_server_derives_completion_date_and_photos_survive_work_save(setup):
    database, service, owner, project = await confirmed(setup)
    stored = database.kitchen_projects.rows[0]
    stored["stage"] = "production"
    project = await service.command(owner, project["id"], cmd(project["version"], "production_update", {"status":"In Production","start_date":"2026-10-26","completion_date":"2026-10-27"}))
    assert project["production"]["completion_date"] == "2026-12-26"
    stored = database.kitchen_projects.rows[0]
    stored["stage"] = "installation"
    stored["attachments"] += [{"id":"photo1","content_type":"image/jpeg"},{"id":"photo2","content_type":"image/png"}]
    project = await service.command(owner, project["id"], cmd(project["version"], "installation_material_photos", {"attachment_ids":["photo1","photo2"]}))
    assert project["installation"]["material_photo_ids"] == ["photo1","photo2"]
    project = await service.command(owner, project["id"], cmd(project["version"], "installation_update", {"status":"Not Started","notes":"Material list retained"}))
    assert project["installation"]["material_photo_ids"] == ["photo1","photo2"]
    for identity in ["foreign-photo", "design-pdf"]:
        with pytest.raises(HTTPException):
            await service.command(owner, project["id"], cmd(project["version"], "installation_material_photos", {"attachment_ids":[identity]}))


def test_unknown_historical_advance_is_not_treated_as_zero():
    order = {"id":"order", "final_amount":"1000", "advance":{"received":True,"amount":None},"installments":[{"id":"paid","amount":"100","date":"2026-10-26"}]}
    row = normalize("kitchen", {"id":"project","floor_id":"second-floor","_order":order}, {}, {}, [])
    assert row["collected"] is None and row["outstanding"] is None
    with pytest.raises(HTTPException):
        workflow.order_paid(order)


@pytest.mark.asyncio
async def test_completed_order_can_receive_final_installment_without_reopening(setup):
    database, service, owner, project = await confirmed(setup)
    stored = database.kitchen_projects.rows[0]
    stored["stage"] = "completed"
    stored["completion_date"] = "2026-10-26"
    project = await service.command(owner, project["id"], cmd(project["version"], "order_installment", {"order_id":project["orders"][-1]["id"],"amount":"500000","date":"2026-10-26"}))
    assert project["stage"] == "completed" and project["completion_date"] == "2026-10-26"
    assert workflow.order_paid(project["orders"][-1]) == Decimal("500000.00")


@pytest.mark.asyncio
async def test_no_fixed_installment_or_material_photo_count_cap(setup):
    database, service, owner, project = await confirmed(setup)
    stored = database.kitchen_projects.rows[0]
    order = stored["orders"][-1]
    order["installments"] = [{"id":f"paid-{i}","amount":"0.01","date":"2026-10-26"} for i in range(1000)]
    project = await service.command(owner, project["id"], cmd(project["version"], "order_installment", {"order_id":order["id"],"amount":"1","date":"2026-10-26"}))
    assert len(project["orders"][-1]["installments"]) == 1001
    stored = database.kitchen_projects.rows[0]
    stored["stage"] = "installation"
    photos = [{"id":f"material-{i}","content_type":"image/png"} for i in range(101)]
    stored["attachments"] += photos
    project = await service.command(owner, project["id"], cmd(project["version"], "installation_material_photos", {"attachment_ids":[p["id"] for p in photos]}))
    assert len(project["installation"]["material_photo_ids"]) == 101
