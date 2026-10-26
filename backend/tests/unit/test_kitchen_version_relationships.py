"""Commercial selectors preserve explicit relationships and persisted confirmation."""
import copy

import pytest
from fastapi import HTTPException

from models_kitchen import QuotationReceived
from services import kitchen_workflow as workflow
from services.kitchen_projects import validate, resolved_policy
from tests.unit.test_kitchen_projects import setup, cmd, create_request

NOW = "2026-10-26T03:00:00+00:00"


def aggregate(stage="quotation"):
    designs = [{"id": f"d{i}", "number": i, "workflow_cycle": 1, "presentation_date": "2026-10-20",
        "shared_date": "2026-10-21", "approval_date": "2026-10-22", "handoff_date": "2026-10-23",
        "response": "Approved", "notes": f"Internal design {i}"} for i in (1, 2)]
    quotes = [{"id": f"q{i}", "number": i, "design_version_id": f"d{i}", "received_date": "2026-10-23",
        "shared_date": "2026-10-24", "response": "Approved", "amount": "100.00"} for i in (1, 2)]
    return {"stage": stage, "workflow_cycle": 1, "design_versions": designs, "quotation_versions": quotes,
        "orders": [], "attachments": [{"id": "old-file"}], "approvals": [], "activity": [],
        "production": {"status": "Not Started"}, "installation": {"status": "Not Started"}}


def apply(project, command, fields, owner):
    workflow.apply(project, command, fields, {}, owner, NOW, validate)


@pytest.mark.parametrize("amount", [None, "", "   "])
def test_quotation_missing_amount_is_none_and_document_optional(setup, amount):
    _, _, owner = setup
    project = aggregate()
    before = copy.deepcopy(project)
    fields = {"design_version_id": "d1", "received_date": "2026-10-24", "amount": amount, "notes": "Internal only"}
    apply(project, "quotation_receive", fields, owner)
    assert project["quotation_versions"][-1]["amount"] is None
    assert project["quotation_versions"][-1]["design_version_id"] == "d1"
    assert project["quotation_versions"][-1]["number"] == 3
    assert project["quotation_versions"][:2] == before["quotation_versions"]
    assert project["attachments"] == before["attachments"]
    assert QuotationReceived(design_version_id="d1", received_date="2026-10-24").amount is None
    assert QuotationReceived(design_version_id="d1", received_date="2026-10-24", amount="0").amount == "0.00"


def test_order_uses_selected_older_quote_and_missing_quote_amount_requires_final_amount(setup):
    _, _, owner = setup
    project = aggregate("order")
    before = copy.deepcopy(project)
    apply(project, "order_confirm", {"quotation_version_id": "q1", "order_date": "2026-10-25"}, owner)
    order = project["orders"][-1]
    assert order["confirmed"] and order["quotation_version_id"] == "q1"
    assert project["customer_order_confirmation"] == "Yes"
    assert project["design_versions"] == before["design_versions"]
    assert project["quotation_versions"] == before["quotation_versions"]
    project = aggregate("order")
    project["quotation_versions"][0]["amount"] = None
    with pytest.raises(HTTPException, match="final order amount"):
        apply(project, "order_confirm", {"quotation_version_id": "q1", "order_date": "2026-10-25"}, owner)
    apply(project, "order_confirm", {"quotation_version_id": "q1", "order_date": "2026-10-25", "final_amount": "125.00"}, owner)
    assert project["orders"][-1]["original_amount"] is None
    assert project["orders"][-1]["final_amount"] == "125.00"


@pytest.mark.parametrize("value", ["Not recorded", "Yes", "No"])
@pytest.mark.asyncio
async def test_confirmation_persists_and_reloads_without_creating_financial_order(setup, value):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="tri-state-test"))
    database.kitchen_projects.rows[0]["stage"] = "order"
    saved = await service.command(owner, project["id"], cmd(project["version"], "order_confirmation", {"value": value}))
    reloaded = await service.get(owner, project["id"])
    assert saved["customer_order_confirmation"] == reloaded["customer_order_confirmation"] == value
    assert not saved["orders"] and saved["order_amount"] is None


def test_confirmation_revokes_effective_approval_without_deleting_order(setup):
    _, _, owner = setup
    project = aggregate("order")
    apply(project, "order_confirm", {"quotation_version_id": "q1", "order_date": "2026-10-25"}, owner)
    original = copy.deepcopy(project["orders"][0])
    apply(project, "order_confirmation", {"value": "No"}, owner)
    assert not project["orders"][0]["confirmed"]
    assert project["orders"][0]["quotation_version_id"] == "q1"
    assert project["orders"][0]["final_amount"] == original["final_amount"]
    assert project["orders"][0]["approval_identity"] != original["approval_identity"]
    assert project["orders"][0]["confirmation_history"][-1]["value"] == "No"


def test_design_edit_targets_selected_version_and_preserves_old_response_notes(setup):
    _, _, owner = setup
    project = aggregate("design")
    newer = copy.deepcopy(project["design_versions"][1])
    project["design_versions"][0]["response_notes"] = "Historical customer response"
    apply(project, "design_update", {"version_id": "d1", "presentation_date": "2026-10-20", "shared_date": "2026-10-21",
        "approval_date": "2026-10-22", "handoff_date": "2026-10-23", "response": "Approved", "notes": "Revised internal note", "reason": "Internal clarification"}, owner)
    assert project["design_versions"][0]["notes"] == "Revised internal note"
    assert project["design_versions"][0]["response_notes"] == "Historical customer response"
    assert project["design_versions"][1] == newer
    assert project["approvals"][-1]["subject_id"] == "d1"


@pytest.mark.parametrize("date", ["2026-10-20", "2026-10-21"])
def test_handoff_cannot_precede_selected_design_approval(setup, date):
    _, _, owner = setup
    project = aggregate("design")
    project["design_versions"][0]["handoff_date"] = None
    with pytest.raises(HTTPException):
        apply(project, "design_handoff", {"version_id": "d1", "date": date}, owner)
    assert project["design_versions"][0]["handoff_date"] is None
    apply(project, "design_handoff", {"version_id": "d1", "date": "2026-10-24"}, owner)
    assert project["design_versions"][0]["handoff_date"] == "2026-10-24"


def test_handoff_uses_recorded_india_approval_day_and_unknown_history_is_not_fabricated(setup):
    _, _, owner = setup
    project = aggregate("design")
    design = project["design_versions"][0]
    design.pop("approval_date")
    design["handoff_date"] = None
    with pytest.raises(HTTPException, match="unknown"):
        apply(project, "design_handoff", {"version_id": "d1", "date": "2026-10-26"}, owner)
    project["approvals"].append({"scope": "customer_design", "subject_id": "d1", "decision": "Approved", "at": "2026-10-24T21:00:00+00:00"})
    assert workflow.design_approval_day(project, design) == "2026-10-25"
    with pytest.raises(HTTPException, match="precede customer approval"):
        apply(project, "design_handoff", {"version_id": "d1", "date": "2026-10-24"}, owner)
    apply(project, "design_handoff", {"version_id": "d1", "date": "2026-10-26"}, owner)
    assert "approval_date" not in design


@pytest.mark.parametrize("started", ["current", "history", "activity", "order_flag"])
def test_order_version_cannot_change_after_actual_production_even_back_in_order(setup, started):
    _, _, owner = setup
    project = aggregate("order")
    apply(project, "order_confirm", {"quotation_version_id": "q1", "order_date": "2026-10-25"}, owner)
    if started == "current":
        project["production"] = {"status": "In Production", "start_date": "2026-10-25"}
    elif started == "history":
        project["work_history"] = [{"workflow_cycle": 1, "production": {"status": "In Production", "start_date": "2026-10-25"}}]
    elif started == "activity":
        project["activity"] = [{"payload": {"changes": {"production": {"after": {"status": "In Production", "start_date": "2026-10-25"}}}}}]
    else:
        project["orders"][0]["production_started"] = True
    with pytest.raises(HTTPException, match="Return to Design"):
        apply(project, "order_update", {"quotation_version_id": "q2", "order_date": "2026-10-25"}, owner)
    with pytest.raises(HTTPException, match="Return to Design"):
        apply(project, "order_confirmation", {"value": "No"}, owner)
    assert project["orders"][0]["quotation_version_id"] == "q1"


def test_order_can_select_another_approved_quote_before_production_and_gate_follows_its_chain(setup):
    _, _, owner = setup
    project = aggregate("order")
    apply(project, "order_confirm", {"quotation_version_id": "q2", "order_date": "2026-10-25"}, owner)
    apply(project, "order_update", {"quotation_version_id": "q1", "order_date": "2026-10-25", "notes": "Internal"}, owner)
    order = project["orders"][0]
    order["advance"] = {"received": True, "amount": "10.00", "date": "2026-10-25"}
    policy = resolved_policy({"version": 1, "decision_contract": "2026-10-20", "department_manager_user_ids": ["owner"]})
    project["approvals"].append({"scope": "production", "subject_id": order["approval_identity"], "decision": "Approved", "policy_version": 1})
    assert workflow.transition(project, "production", policy) is None
    assert order["quotation_version_id"] == "q1"
    assert order["corrections"][-1]["before"]["quotation_version_id"] == "q2"
    project["design_versions"][0]["response"] = "Pending"
    assert workflow.transition(project, "production", policy) is not None


def test_internal_note_correction_does_not_shift_recorded_approval_or_clear_other_fields(setup):
    _, _, owner = setup
    project = aggregate("design")
    design = project["design_versions"][0]
    design.pop("approval_date")
    design["requirements"] = "Stored requirements"
    project["approvals"] = [{"scope": "customer_design", "subject_id": "d1", "decision": "Approved", "at": "2026-10-22T03:00:00+00:00"}]
    apply(project, "design_update", {"version_id": "d1", "presentation_date": "2026-10-20", "response": "Approved", "notes": "Internal corrected", "reason": "Internal correction"}, owner)
    assert workflow.design_approval_day(project, design) == "2026-10-22"
    assert design["handoff_date"] == "2026-10-23"
    assert design["shared_date"] == "2026-10-21"
    assert design["requirements"] == "Stored requirements"
    assert "approval_date" not in design


@pytest.mark.asyncio
async def test_older_quotation_order_relationship_persists_through_service_reload_and_status(setup):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="older-order-chain"))
    database.kitchen_projects.rows[0].update(aggregate("order"))
    saved = await service.command(owner, project["id"], cmd(project["version"], "order_confirm", {"quotation_version_id": "q1", "order_date": "2026-10-25"}))
    reloaded = await service.get(owner, project["id"])
    assert saved["orders"][-1]["quotation_version_id"] == reloaded["orders"][-1]["quotation_version_id"] == "q1"
    assert reloaded["customer_order_confirmation"] == "Yes" and reloaded["status"] == "Confirmed"
    unconfirmed = await service.command(owner, project["id"], cmd(saved["version"], "order_confirmation", {"value": "No"}))
    assert unconfirmed["status"] == "Pending" and not unconfirmed["orders"][-1]["confirmed"]
    assert unconfirmed["orders"][-1]["quotation_version_id"] == "q1"


@pytest.mark.parametrize("invalid", ["foreign", "unapproved", "old_cycle"])
def test_order_selection_rejects_invalid_commercial_basis_without_changes(setup, invalid):
    _, _, owner = setup
    project = aggregate("order")
    if invalid == "unapproved":
        project["quotation_versions"][0]["response"] = "Pending"
    elif invalid == "old_cycle":
        project["design_versions"][0]["workflow_cycle"] = 0
    original = copy.deepcopy(project)
    with pytest.raises(HTTPException):
        apply(project, "order_confirm", {"quotation_version_id": "foreign" if invalid == "foreign" else "q1", "order_date": "2026-10-25"}, owner)
    assert project == original
