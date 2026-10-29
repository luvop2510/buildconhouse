"""Final commercial PDFs are owned, dated, explicit and preserved with their orders."""
import copy

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from models_kitchen import DesignPresentation, QuotationReceived
from services import kitchen_workflow as workflow
from services.kitchen_projects import validate, current_status, required_fields_error
from tests.unit.test_kitchen_projects import setup, cmd, create_request
from tests.unit.test_kitchen_version_relationships import aggregate

NOW = "2026-10-26T21:00:00+00:00"


def apply(project, command, fields, owner):
    return workflow.apply(project, command, fields, {}, owner, NOW, validate)


def design_fields(**fields):
    return {"attachment_ids": ["design-pdf"], "final_attachment_id": "design-pdf", **fields}


def quotation_fields(**fields):
    return {"design_version_id": "d1", "pdf_options": [{"attachment_id": "quote-pdf", "kitchen_type": "GI"}],
            "final_attachment_id": "quote-pdf", **fields}


@pytest.mark.parametrize("command,fields", [("design_present", {}), ("quotation_receive", {"design_version_id": "d1"})])
def test_creation_requires_upload_and_one_selected_pdf_before_mutation(setup, command, fields):
    _, _, owner = setup
    project = aggregate("design" if command.startswith("design") else "quotation")
    before = copy.deepcopy(project)
    with pytest.raises(HTTPException, match="finalized PDF"):
        apply(project, command, fields, owner)
    assert project == before


@pytest.mark.parametrize("case", ["foreign", "not-pdf", "undated", "duplicate", "missing-final", "unlisted-final"])
@pytest.mark.parametrize("quotation", [False, True])
def test_pdf_selection_rejects_invalid_owned_metadata_and_ambiguous_selection(setup, case, quotation):
    _, _, owner = setup
    project = aggregate("quotation" if quotation else "design")
    identity = "quote-pdf" if quotation else "design-pdf"
    file = next(row for row in project["attachments"] if row["id"] == identity)
    fields = quotation_fields() if quotation else design_fields()
    if case == "foreign":
        project["attachments"].remove(file)
    elif case == "not-pdf":
        file["content_type"] = "image/png"
    elif case == "undated":
        file.pop("uploaded_at")
    elif case == "duplicate":
        fields["pdf_options" if quotation else "attachment_ids"] *= 2
    elif case == "missing-final":
        fields["final_attachment_id"] = None
    else:
        fields["final_attachment_id"] = "other-file"
    before = copy.deepcopy(project)
    with pytest.raises(HTTPException):
        apply(project, "quotation_receive" if quotation else "design_present", fields, owner)
    assert project == before


def test_selected_file_date_uses_server_upload_and_india_day_not_client_date(setup):
    _, _, owner = setup
    project = aggregate("design")
    project["design_versions"] = []
    next(row for row in project["attachments"] if row["id"] == "design-pdf")["uploaded_at"] = "2026-10-25T21:00:00+00:00"
    apply(project, "design_present", design_fields(presentation_date="2000-01-01", handoff_status="No"), owner)
    design = project["design_versions"][-1]
    assert design["upload_date"] == design["presentation_date"] == "2026-10-26"
    assert design["attachment_id"] == design["final_attachment_id"] == "design-pdf"
    assert design["handoff_status"] == "No" and design["handoff_date"] is None
    assert design["url"] is None


def test_yes_handoff_uses_recorded_day_and_keeps_uploaded_day_separate(setup):
    _, _, owner = setup
    project = aggregate("design")
    project["design_versions"] = []
    apply(project, "design_present", design_fields(response="Approved", shared_date="2026-10-23",
        approval_date="2026-10-24", handoff_status="Yes"), owner)
    design = project["design_versions"][-1]
    assert design["handoff_date"] == "2026-10-27"
    assert design["upload_date"] == "2026-10-20"
    assert design["handoff_by"] == owner.id


def test_multiple_quote_types_select_only_one_with_its_own_upload_date(setup):
    _, _, owner = setup
    project = aggregate()
    project["attachments"] += [
        {"id": "ss", "content_type": "application/pdf", "uploaded_at": "2026-10-24T21:00:00+00:00"},
        {"id": "mix", "content_type": "application/pdf", "uploaded_at": "2026-10-26T00:00:00+00:00"}]
    options = [{"attachment_id": "quote-pdf", "kitchen_type": "GI"},
               {"attachment_id": "ss", "kitchen_type": "SS"}, {"attachment_id": "mix", "kitchen_type": "Mix"}]
    apply(project, "quotation_receive", quotation_fields(pdf_options=options, final_attachment_id="ss", received_date="2000-01-01"), owner)
    quote = project["quotation_versions"][-1]
    assert quote["pdf_options"] == options
    assert quote["final_attachment_id"] == quote["attachment_id"] == "ss"
    assert quote["kitchen_type"] == "SS"
    assert quote["upload_date"] == quote["received_date"] == "2026-10-25"
    assert quote["received_status"] == "Yes" and quote["amount"] is None
    apply(project, "quotation_update", {"version_id": quote["id"], "final_attachment_id": "mix"}, owner)
    assert quote["kitchen_type"] == "Mix" and quote["received_date"] == "2026-10-26"


def test_quote_type_is_mandatory_and_cannot_be_supplied_separately():
    with pytest.raises(ValidationError):
        QuotationReceived(**quotation_fields(pdf_options=[{"attachment_id": "quote-pdf"}]))
    with pytest.raises(ValidationError):
        QuotationReceived(**quotation_fields(kitchen_type="SS"))
    with pytest.raises(ValidationError):
        DesignPresentation(**design_fields(upload_date="2000-01-01"))


@pytest.mark.parametrize("status", [None, "No", "Not recorded"])
def test_new_quotation_cannot_bypass_yes_company_handoff(setup, status):
    _, _, owner = setup
    project = aggregate()
    project["design_versions"][0]["handoff_status"] = status
    with pytest.raises(HTTPException, match="Sent to company Yes"):
        apply(project, "quotation_receive", quotation_fields(), owner)


def test_changing_final_pdf_cannot_silently_change_existing_order_basis(setup):
    _, _, owner = setup
    project = aggregate("order")
    apply(project, "order_confirm", {"quotation_version_id": "q1", "order_date": "2026-10-25"}, owner)
    original = copy.deepcopy(project["orders"])
    project["stage"] = "quotation"
    with pytest.raises(HTTPException, match="linked to an order"):
        apply(project, "quotation_update", {"version_id": "q1", "pdf_options": [{"attachment_id": "design-pdf", "kitchen_type": "Mix"}], "final_attachment_id": "design-pdf"}, owner)
    assert project["orders"] == original
    with pytest.raises(HTTPException, match="kitchen type"):
        apply(project, "quotation_update", {"version_id": "q1", "pdf_options": [{"attachment_id": "quote-pdf", "kitchen_type": "SS"}]}, owner)
    assert project["orders"] == original
    project["stage"] = "design"
    with pytest.raises(HTTPException, match="own design version"):
        apply(project, "design_update", {"version_id": "d1", "reason": "Replace final", "response": "Approved",
            "attachment_ids": ["quote-pdf"], "final_attachment_id": "quote-pdf"}, owner)
    assert project["orders"] == original


@pytest.mark.asyncio
async def test_manual_next_cannot_bypass_final_design_or_quotation_and_failed_write_keeps_version(setup):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="final-pdf-gates"))
    stored = database.kitchen_projects.rows[0]
    stored["stage"] = "design"
    with pytest.raises(HTTPException):
        await service.command(owner, project["id"], cmd(project["version"], "move_stage", {"target_stage": "quotation"}))
    assert stored["stage"] == "design" and stored["version"] == project["version"]
    evidence = aggregate()
    stored.update({key: evidence[key] for key in ("design_versions", "quotation_versions", "attachments", "final_design_version_id")})
    project = await service.command(owner, project["id"], cmd(project["version"], "move_stage", {"target_stage": "quotation"}))
    latest = database.kitchen_projects.rows[0]
    latest["quotation_versions"][-1].pop("final_attachment_id")
    with pytest.raises(HTTPException):
        await service.command(owner, project["id"], cmd(project["version"], "move_stage", {"target_stage": "order"}))
    assert latest["stage"] == "quotation" and latest["version"] == project["version"]


def test_each_pdf_creates_one_version_without_example_four_cap_and_older_design_can_be_final(setup):
    _, _, owner = setup
    project = aggregate("design")
    project.update(design_versions=[], quotation_versions=[], final_design_version_id=None)
    for number in range(1, 6):
        identity = f"drawing-{number}"
        project["attachments"].append({"id": identity, "content_type": "application/pdf", "uploaded_at": "2026-10-24T00:00:00+00:00"})
        apply(project, "design_present", {"attachment_ids": [identity], "final_attachment_id": identity, "handoff_status": "No"}, owner)
        assert len(project["design_versions"]) == number
        assert project["design_versions"][-1]["number"] == number
        assert project["design_versions"][-1]["attachment_ids"] == [identity]
        assert project["final_design_version_id"] is None
    with pytest.raises(HTTPException, match="finalized design version"):
        workflow.finalized_design(project)
    chosen = project["design_versions"][1]
    apply(project, "design_update", {"version_id": chosen["id"], "response": "Approved", "shared_date": "2026-10-25",
        "approval_date": "2026-10-26", "handoff_status": "Yes", "finalize": True, "reason": "Customer chose Design 2"}, owner)
    assert project["final_design_version_id"] == chosen["id"]
    assert workflow.finalized_design(project) is chosen
    assert current_status(project) == "Approved"
    assert required_fields_error(project, "design", {"required_fields": {"design": ["handoff_date", "approval_date"]}}) is None
    assert project["design_versions"][-1]["response"] == "Pending"
    assert workflow.transition(project, "quotation", {}) is None
    project["stage"] = "quotation"
    next(row for row in project["attachments"] if row["id"] == "quote-pdf")["uploaded_at"] = "2026-10-27T00:00:00+00:00"
    apply(project, "quotation_receive", quotation_fields(design_version_id=chosen["id"]), owner)
    assert project["quotation_versions"][-1]["design_version_id"] == chosen["id"]
    before = copy.deepcopy(project)
    with pytest.raises(HTTPException):
        apply(project, "quotation_receive", quotation_fields(design_version_id=project["design_versions"][-1]["id"]), owner)
    assert project == before


@pytest.mark.asyncio
@pytest.mark.parametrize("navigation", ["move_stage", "advance_stage"])
@pytest.mark.parametrize("bound_order", [False, True])
async def test_quotation_next_requires_saved_current_design_except_preserved_order_basis(setup, navigation, bound_order):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="quotation-design-alignment"))
    evidence = aggregate("order" if bound_order else "quotation")
    if bound_order:
        apply(evidence, "order_confirm", {"quotation_version_id": "q1", "order_date": "2026-10-25"}, owner)
    evidence["quotation_versions"] = [evidence["quotation_versions"][0]]
    evidence.update(stage="quotation", final_design_version_id="d2")
    stored = database.kitchen_projects.rows[0]
    stored.update({key: evidence[key] for key in ("stage", "design_versions", "quotation_versions", "attachments", "orders", "final_design_version_id")})
    if not bound_order:
        before = copy.deepcopy(stored)
        with pytest.raises(HTTPException, match="Save quotation details.*current finalized design"):
            await service.command(owner, project["id"], cmd(project["version"], navigation, {"target_stage": "order"}))
        assert database.kitchen_projects.rows[0] == before
        project = await service.command(owner, project["id"], cmd(project["version"], "quotation_update", {"version_id": "q1", "design_version_id": "d2"}))
    advanced = await service.command(owner, project["id"], cmd(project["version"], navigation, {"target_stage": "order"}))
    assert advanced["stage"] == "order"
    assert advanced["quotation_versions"][0]["design_version_id"] == ("d1" if bound_order else "d2")
    assert advanced["orders"] == evidence["orders"]


def test_design_rejects_multiple_pdfs_duplicate_version_and_file_replacement(setup):
    _, _, owner = setup
    project = aggregate("design")
    before = copy.deepcopy(project)
    with pytest.raises(HTTPException, match="one design version"):
        apply(project, "design_present", design_fields(attachment_ids=["design-pdf", "quote-pdf"]), owner)
    with pytest.raises(HTTPException, match="already has a design version"):
        apply(project, "design_present", design_fields(), owner)
    with pytest.raises(HTTPException, match="own design version"):
        apply(project, "design_update", {"version_id": "d1", "response": "Approved", "reason": "Swap file",
            "attachment_ids": ["quote-pdf"], "final_attachment_id": "quote-pdf"}, owner)
    assert project == before


@pytest.mark.asyncio
async def test_final_design_identity_survives_reload_summary_and_idempotent_command(setup):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="final-design-choice"))
    stored = database.kitchen_projects.rows[0]
    evidence = aggregate("design")
    stored.update({key: evidence[key] for key in ("stage", "design_versions", "attachments")})
    request = cmd(project["version"], "design_update", {"version_id": "d1", "response": "Approved", "finalize": True, "reason": "Chosen Design 1"}, "persist-final-design")
    saved = await service.command(owner, project["id"], request)
    replay = await service.command(owner, project["id"], request)
    loaded = await service.get(owner, project["id"])
    summary = await service.public(database.kitchen_projects.rows[0], owner, await service.policy(), summary=True)
    assert saved["final_design_version_id"] == loaded["final_design_version_id"] == summary["final_design_version_id"] == "d1"
    assert summary["current_design"]["id"] == "d1"
    assert replay["replayed"] and replay["version"] == saved["version"]
    assert loaded["activity"][-1]["payload"]["changes"]["final_design_version_id"] == {"before": None, "after": "d1"}


def test_uploading_another_design_after_approval_does_not_replace_selection_or_need_owner(setup):
    _, _, owner = setup
    project = aggregate("design")
    worker = owner.model_copy(update={"id": "salesperson", "role": "sales"})
    apply(project, "design_present", {"attachment_ids": ["new-design-pdf"], "final_attachment_id": "new-design-pdf", "handoff_status": "No"}, worker)
    assert len(project["design_versions"]) == 3
    assert project["final_design_version_id"] == "d1"
    assert project["design_versions"][-1]["response"] == "Pending"
    project["production"] = {"status": "In Production", "start_date": "2026-10-25"}
    before = copy.deepcopy(project)
    with pytest.raises(HTTPException, match="Return to Design"):
        apply(project, "design_update", {"version_id": project["design_versions"][-1]["id"], "response": "Approved", "shared_date": "2026-10-21",
            "approval_date": "2026-10-22", "handoff_status": "Yes", "finalize": True, "reason": "Pick another"}, owner)
    assert project == before
