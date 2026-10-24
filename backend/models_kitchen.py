"""Strict Kitchen commands and resolved-policy adoption contracts."""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator, model_validator

Stage = Literal["lead", "visit", "cad", "design", "quotation", "order", "production", "installation", "completed"]
STAGES = ("lead", "visit", "cad", "design", "quotation", "order", "production", "installation", "completed")
Text = Annotated[str, Field(max_length=4000)]
ShortText = Annotated[str, Field(max_length=250)]
Identifier = Annotated[str, Field(min_length=1, max_length=128)]
CommandKey = Annotated[str, Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")]


def date_only(value):
    if value is None:
        return value
    if not isinstance(value, str) or len(value) != 10:
        raise ValueError("Use YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("Use a valid YYYY-MM-DD date") from exc
    if parsed.isoformat() != value:
        raise ValueError("Use YYYY-MM-DD")
    return value


def money_text(value):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 32:
        raise ValueError("INR amounts must be decimal strings")
    try:
        amount = Decimal(value)
        if not amount.is_finite() or amount < 0 or amount > Decimal("1000000000000") or amount.as_tuple().exponent < -2:
            raise ValueError("Use a nonnegative INR amount with at most two decimal places")
        return format(amount.quantize(Decimal("0.01")), ".2f")
    except InvalidOperation as exc:
        raise ValueError("Invalid INR amount") from exc


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class LeadFields(StrictModel):
    site_location: Text | None = None
    lead_source: ShortText | None = None
    kitchen_type: Literal["New kitchen", "Renovation", "Other"] | None = None
    budget: str | None = None
    notes: Text | None = None
    lead_date: str | None = None
    status: Literal["New", "Contacted", "Qualified", "Lost"] = "New"
    lost_reason: Text | None = None

    _budget = field_validator("budget", mode="before")(money_text)
    _lead_date = field_validator("lead_date", mode="before")(date_only)


class VisitFields(StrictModel):
    visit_date: str | None = None
    display_model: ShortText | None = None
    requirements: Text | None = None
    budget_discussion: Text | None = None
    notes: Text | None = None
    status: Literal["Scheduled", "Visited", "Follow-up Required"] = "Scheduled"
    interested: StrictBool | None = None
    next_action: ShortText | None = None

    _visit_date = field_validator("visit_date", mode="before")(date_only)


class CadFields(StrictModel):
    received: StrictBool = False
    progress: Annotated[StrictInt, Field(ge=0, le=100)] = 0
    status: Literal["Not Started", "In Progress", "Completed"] = "Not Started"
    notes: Text | None = None
    ready: StrictBool = False


class LeadCustomer(StrictModel):
    name: Annotated[str, Field(min_length=1, max_length=250)]
    phone: Annotated[str, Field(min_length=1, max_length=80)]
    address: Text | None = None

    @field_validator("phone")
    @classmethod
    def contact_number(cls, value):
        import re
        digits = re.sub(r"\D", "", value)
        if not digits or len(digits) > 15:
            raise ValueError("Enter a valid phone number")
        return value


class CreateProject(StrictModel):
    customer_id: Identifier | None = None
    customer: LeadCustomer | None = None
    idempotency_key: CommandKey
    lead: LeadFields = Field(default_factory=LeadFields)
    assigned_to: Identifier | None = None

    @model_validator(mode="after")
    def one_customer_source(self):
        if (self.customer_id is None) == (self.customer is None):
            raise ValueError("Select an existing customer or enter the new customer's details")
        return self


class ProjectCommand(StrictModel):
    expected_version: Annotated[StrictInt, Field(ge=1)]
    idempotency_key: CommandKey
    command: Literal["edit_lead", "convert", "save_visit", "save_cad", "advance_stage", "assign", "metadata",
                     "design_present", "design_share", "design_response", "design_revision", "design_handoff",
                     "quotation_receive", "quotation_share", "quotation_response", "order_confirm", "order_advance",
                     "order_amend", "order_status", "order_document", "exception", "production_update", "installation_update", "site_visit", "approval", "review_duplicate"]
    payload: dict[str, Any] = Field(default_factory=dict)


class AssignmentPayload(StrictModel):
    stage: Stage
    user_id: Identifier | None


class AdvancePayload(StrictModel):
    target_stage: Stage


class MetadataPayload(StrictModel):
    next_action: ShortText | None = None
    deadline: str | None = None
    target_completion_date: str | None = None

    _target = field_validator("target_completion_date", mode="before")(date_only)

    @field_validator("deadline")
    @classmethod
    def timestamp(cls, value):
        if value is None:
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("Deadline must be an ISO timestamp with timezone") from exc
        if parsed.tzinfo is None:
            raise ValueError("Deadline must include timezone")
        return parsed.astimezone(timezone.utc).isoformat()


class ProductionPolicy(StrictModel):
    require_advance: StrictBool
    minimum_advance_amount: str | None = None
    minimum_advance_percent: Annotated[StrictInt, Field(ge=0, le=100)] | None = None
    require_confirmation_document: StrictBool
    require_manager_approval: StrictBool
    manager_user_ids: list[Identifier] = Field(max_length=100)
    _amount = field_validator("minimum_advance_amount", mode="before")(money_text)

    @model_validator(mode="after")
    def consistent(self):
        if self.require_manager_approval and not self.manager_user_ids:
            raise ValueError("Select a manager for required production approval")
        if not self.require_advance and (Decimal(self.minimum_advance_amount or "0") > 0 or self.minimum_advance_percent):
            raise ValueError("An advance minimum requires advance to be mandatory")
        return self


class ClosurePolicy(StrictModel):
    require_manager_approval: StrictBool
    manager_user_ids: list[Identifier] = Field(max_length=100)

    @model_validator(mode="after")
    def consistent(self):
        if self.require_manager_approval and not self.manager_user_ids:
            raise ValueError("Select a manager for required closure approval")
        return self


class ExceptionPolicy(StrictModel):
    allow_hold: StrictBool
    allow_cancel: StrictBool
    allow_reopen: StrictBool
    allow_return_to_design: StrictBool
    manager_user_ids: list[Identifier] = Field(max_length=100)


class MetricsPolicy(StrictModel):
    hold_is_active: StrictBool
    overdue_date: Literal["next_action", "target_completion", "either"]
    confirmed_value_include_completed: StrictBool
    confirmed_value_include_cancelled: StrictBool


class FilePolicy(StrictModel):
    allowed_types: list[Literal["application/pdf", "image/jpeg", "image/png", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]] = Field(min_length=1, max_length=5)
    max_bytes: Annotated[StrictInt, Field(ge=1, le=25_000_000)]
    single_request_max_bytes: Literal[786432] = 786432
    chunk_bytes: Literal[524288] = 524288


REQUIRED_FIELDS = {
    "lead": {"site_location", "lead_source", "kitchen_type", "budget", "notes", "lead_date", "assigned_to"},
    "visit": {"visit_date", "display_model", "requirements", "budget_discussion", "notes", "interested", "next_action", "assigned_to"},
    "cad": {"received", "progress", "status", "notes", "ready", "assigned_to"},
    "design": {"presentation_date", "attachment_id", "url", "notes", "assigned_to"},
    "quotation": {"received_date", "amount", "attachment_id", "url", "notes", "assigned_to"},
    "order": {"order_date", "confirmation_document_id", "notes", "assigned_to"},
    "production": {"start_date", "completion_date", "notes", "assigned_to"},
    "installation": {"start_date", "completion_date", "notes", "assigned_to"},
}


class PolicyFields(StrictModel):
    decision_contract: Literal["2026-10-20"] | None = None
    department_manager_user_ids: list[Identifier] = Field(default_factory=list, max_length=100)
    identity_timing: Literal["creation", "conversion"] | None = None
    cad_require_received: StrictBool | None = None
    cad_require_progress_100: StrictBool | None = None
    assignment_user_ids: list[Identifier] = Field(default_factory=list, max_length=100)
    unassigned_visibility: Literal["owner", "all_authorized"] | None = None
    production: ProductionPolicy | None = None
    closure: ClosurePolicy | None = None
    exceptions: ExceptionPolicy | None = None
    metrics: MetricsPolicy | None = None
    required_fields: dict[str, list[str]] | None = None
    history_corrections: dict[str, Any] | None = None
    files: FilePolicy | None = None

    @field_validator("required_fields")
    @classmethod
    def supported_fields(cls, value):
        if value is not None:
            for stage, fields in value.items():
                if stage not in REQUIRED_FIELDS or set(fields) - REQUIRED_FIELDS[stage] or len(fields) != len(set(fields)):
                    raise ValueError("Required fields must use supported stage fields without duplicates")
        return value


class ConfigurePolicy(PolicyFields):
    expected_version: Annotated[StrictInt, Field(ge=1)]


class DocumentPayload(StrictModel):
    attachment_id: Identifier | None = None
    url: Annotated[str, Field(max_length=2048)] | None = None
    notes: Text | None = None

    @field_validator("url")
    @classmethod
    def safe_link(cls, value):
        if value is None:
            return None
        from urllib.parse import urlsplit
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Use an HTTPS document link without embedded credentials")
        return value


class DesignPresentation(DocumentPayload):
    presentation_date: str
    _date = field_validator("presentation_date", mode="before")(date_only)


class VersionDate(StrictModel):
    version_id: Identifier
    date: str
    _date = field_validator("date", mode="before")(date_only)


class CustomerResponse(StrictModel):
    version_id: Identifier
    response: Literal["Pending", "Approved", "Changes Required", "Rejected"]
    notes: Text | None = None


class DesignRevision(StrictModel):
    version_id: Identifier
    reason: Annotated[str, Field(min_length=1, max_length=4000)]


class QuotationReceived(DocumentPayload):
    design_version_id: Identifier
    amount: str
    received_date: str
    _amount = field_validator("amount", mode="before")(money_text)
    _date = field_validator("received_date", mode="before")(date_only)


class OrderConfirmation(StrictModel):
    quotation_version_id: Identifier
    order_date: str
    confirmation_document_id: Identifier | None = None
    notes: Text | None = None
    _date = field_validator("order_date", mode="before")(date_only)


class AdvancePayment(StrictModel):
    received: StrictBool
    amount: str
    date: str | None = None
    _amount = field_validator("amount", mode="before")(money_text)
    _date = field_validator("date", mode="before")(date_only)


class OrderAmendment(StrictModel):
    amount: str
    customer_approved: StrictBool
    reason: Annotated[str, Field(min_length=1, max_length=4000)]
    date: str
    _amount = field_validator("amount", mode="before")(money_text)
    _date = field_validator("date", mode="before")(date_only)


class OrderDocument(StrictModel):
    attachment_id: Identifier


class WorkProgress(StrictModel):
    status: Literal["Not Started", "In Production", "In Progress", "Completed"]
    start_date: str | None = None
    completion_date: str | None = None
    notes: Text | None = None
    _dates = field_validator("start_date", "completion_date", mode="before")(date_only)


class SiteVisit(StrictModel):
    date: str
    actual: StrictBool
    notes: Text | None = None
    _date = field_validator("date", mode="before")(date_only)


class InternalApproval(StrictModel):
    scope: Literal["production", "closure"]
    decision: Literal["Approved", "Rejected"]
    reason: Text | None = None


class OrderStatusChange(StrictModel):
    status: Literal["Confirmed", "On Hold", "Cancelled"]
    reason: Annotated[str, Field(min_length=1, max_length=4000)]


class ExceptionCommand(StrictModel):
    action: Literal["reopen", "return_to_design"]
    reason: Annotated[str, Field(min_length=1, max_length=4000)]



class DuplicateReview(StrictModel):
    decision: Literal["distinct_project", "duplicate"]
    reason: Annotated[str, Field(min_length=1, max_length=4000)]
