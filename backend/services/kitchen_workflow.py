"""Kitchen commercial and installation rules, applied inside the aggregate CAS.

No I/O or staff identity is trusted here. The service authorizes commands and
configured internal approvers before invoking these strict domain operations.
"""
import copy
from decimal import Decimal
from uuid import uuid4

from fastapi import HTTPException

from models_kitchen import (AdvancePayment, CustomerResponse, DesignPresentation,
    DesignRevision, DesignUpdate, InternalApproval, OrderAmendment, OrderConfirmation,
    QuotationReceived, SiteVisit, VersionDate, WorkProgress, OrderStatusChange, ExceptionCommand, OrderDocument)

COMMANDS = {"design_present", "design_update", "design_share", "design_response", "design_revision", "design_handoff",
            "quotation_receive", "quotation_share", "quotation_response", "order_confirm", "order_advance",
            "order_amend", "order_status", "order_document", "exception", "production_update", "installation_update", "site_visit", "approval"}


def reject(message):
    raise HTTPException(422, message)


def current(project, key, version_id=None):
    rows = project.get(key, [])
    if not rows or version_id is not None and rows[-1]["id"] != version_id:
        reject("Select the current version; historical approval cannot approve a replacement")
    return rows[-1]


def document(project, body):
    if not body.attachment_id and not body.url:
        reject("Attach a project file or provide an HTTPS document link")
    if body.attachment_id and not any(a["id"] == body.attachment_id for a in project["attachments"]):
        reject("Select an attachment belonging to this project")
    return {"attachment_id": body.attachment_id, "url": body.url}


def approved_design(project):
    row = current(project, "design_versions")
    if row["response"] != "Approved" or project.get("design_revision_pending") or row.get("workflow_cycle", 1) != project.get("workflow_cycle", 1):
        reject("The current design needs customer approval")
    return row


def subject(project, scope):
    if scope == "production":
        order = current(project, "orders")
        if project.get("commercial_basis_invalidated") or order.get("authorization_invalidated"):
            return None
        return order.get("approval_identity") or (order.get("amendments", [{}])[-1].get("id", order["id"]) if order.get("amendments") else order["id"])
    return project.get("installation", {}).get("completion_identity")


def has_approval(project, scope, policy):
    matching = [a for a in project["approvals"] if a["scope"] == scope and a["subject_id"] == subject(project, scope)
                and a["policy_version"] == policy["version"]]
    return bool(matching and matching[-1]["decision"] == "Approved")


def transition(project, target, policy):
    """Return a human gate reason; earlier stages are checked by main service."""
    try:
        stage = project["stage"]
        if stage == "design":
            design = approved_design(project)
            if not design.get("handoff_date"):
                reject("Record the approved design sent to company and its date first")
        elif stage == "quotation":
            quote = current(project, "quotation_versions")
            if quote["response"] != "Approved" or not quote.get("shared_date"):
                reject("The current quotation must be shared and approved by the customer")
            design = approved_design(project)
            if quote["design_version_id"] != design["id"]:
                reject("Quotation must be based on the current approved design")
        elif stage == "order":
            rules = policy.get("production")
            if rules is None:
                reject("Department manager selection requires owner policy adoption")
            order = current(project, "orders")
            quote = current(project, "quotation_versions")
            design = approved_design(project)
            if project.get("commercial_basis_invalidated") or order.get("authorization_invalidated") or quote.get("design_version_id") != design["id"] or not quote.get("shared_date") or order["status"] != "Confirmed" or not order["confirmed"] or quote["response"] != "Approved" or order["quotation_version_id"] != quote["id"]:
                reject("Confirm the order against the current approved quotation first")
            advance = order.get("advance", {})
            if not advance.get("received") or Decimal(advance.get("amount") or "0") <= 0 or not advance.get("date"):
                reject("Record the required advance payment first")
            if not policy.get("department_manager_user_ids") or not has_approval(project, "production", policy):
                reject("Awaiting selected department manager production approval")
        elif stage == "production":
            if project.get("production", {}).get("status") != "Completed":
                reject("Mark production Completed first")
        elif stage == "installation":
            if project.get("installation", {}).get("status") != "Completed":
                reject("Mark installation Completed first")
            rules = policy.get("closure")
            if rules is None:
                reject("Adopt the resolved decisions and select the department manager for closure approval")
            if not policy.get("department_manager_user_ids") or not has_approval(project, "closure", policy):
                reject("Awaiting selected department manager closure approval")
        return None
    except HTTPException as exc:
        return exc.detail


def recompute_completion(project, policy):
    if project.get("manual_stage_navigation"):
        return
    if project["stage"] == "installation" and project.get("installation", {}).get("status") == "Completed":
        error = transition(project, "completed", policy)
        project["closure_pending_reason"] = error
        if not error:
            project["stage"] = "completed"
            project["completion_date"] = project["installation"]["completion_date"]


def apply(project, command, payload, policy, user, now, validate):
    stage = project["stage"]
    if project.get("lifecycle_status") in {"On Hold", "Cancelled"} and command not in {"order_status", "exception"}:
        reject("The owner must resume this held or cancelled project first")
    def require_stage(expected):
        if stage != expected:
            reject(f"This command is available only in {expected}")
    def record(row):
        return {**row, "id": str(uuid4()), "actor_id": user.id, "at": now}
    if command == "design_present":
        require_stage("design")
        body = validate(DesignPresentation, payload)
        if project.get("design_versions") and project["design_versions"][-1].get("response") == "Approved" and not project.get("design_revision_pending"):
            reject("Record an owner-authorized design change with its reason before replacing an approved design")
        project["design_versions"].append(record({**body.model_dump(), **(document(project, body) if body.attachment_id or body.url else {}), "workflow_cycle": project.get("workflow_cycle", 1),
            "number": len(project["design_versions"]) + 1, "response": "Pending", "shared_date": None, "handoff_date": None}))
        project["design_revision_pending"] = False
    elif command == "design_update":
        require_stage("design")
        body = validate(DesignUpdate, payload)
        row = current(project, "design_versions", body.version_id)
        if project.get("design_revision_pending") or row.get("workflow_cycle", 1) != project.get("workflow_cycle", 1):
            reject("Present the revised design before editing its details")
        if body.shared_date and body.shared_date < body.presentation_date:
            reject("Sharing date cannot precede presentation")
        if body.response != "Pending" and not body.shared_date:
            reject("Record the sharing date before the customer response")
        if body.handoff_date and (body.response != "Approved" or not body.shared_date or body.handoff_date < body.shared_date):
            reject("Company handoff requires approval and cannot precede customer sharing")
        row.update(body.model_dump(exclude={"version_id", "reason", "revision_count"}))
        row["corrected_by"], row["corrected_at"] = user.id, now
        if body.revision_count is not None:
            project["design_revision_count"] = body.revision_count
            project["known_design_revision_count"] = body.revision_count
        project["approvals"].append(record({"scope": "customer_design", "subject_id": row["id"],
            "decision": body.response, "notes": body.response_notes, "reason": body.reason}))
    elif command in {"design_share", "design_handoff", "quotation_share"}:
        is_design = command.startswith("design")
        require_stage("design" if is_design else "quotation")
        body = validate(VersionDate, payload)
        row = current(project, "design_versions" if is_design else "quotation_versions", body.version_id)
        if is_design and row.get("workflow_cycle", 1) != project.get("workflow_cycle", 1):
            reject("Present the revised design before sharing or handoff")
        earliest = row.get("presentation_date") or row.get("received_date")
        if body.date < earliest:
            reject("Sharing/handoff date cannot precede presentation/receipt")
        if command == "design_handoff":
            approved_design(project)
            if row.get("handoff_date"):
                reject("This approved design handoff is already recorded")
            row["handoff_date"] = body.date
            row["handoff_by"] = user.id
        else:
            if row.get("shared_date"):
                reject("Sharing is already recorded for this version")
            row["shared_date"] = body.date
            row["shared_by"] = user.id
    elif command in {"design_response", "quotation_response"}:
        is_design = command == "design_response"
        require_stage("design" if is_design else "quotation")
        body = validate(CustomerResponse, payload)
        if is_design and body.response == "Rejected":
            reject("Design response must be Pending, Approved or Changes Required")
        row = current(project, "design_versions" if is_design else "quotation_versions", body.version_id)
        if not row.get("shared_date"):
            reject("Record sharing this version with the customer first")
        if row["response"] == "Approved":
            reject("An approved response is immutable; record a revision or a new version")
        if is_design and (project.get("design_revision_pending") or row.get("workflow_cycle", 1) != project.get("workflow_cycle", 1)):
            reject("Present the revised design before recording its approval")
        row["response"] = body.response
        row["response_notes"] = body.notes
        project["approvals"].append(record({"scope": "customer_design" if is_design else "customer_quotation",
            "subject_id": row["id"], "decision": body.response, "notes": body.notes}))
    elif command == "design_revision":
        require_stage("design")
        body = validate(DesignRevision, payload)
        row = current(project, "design_versions", body.version_id)
        project["revision_events"].append(record({"version_id": row["id"], "reason": body.reason}))
        project["known_design_revision_count"] = project.get("known_design_revision_count", 0 if project.get("is_legacy") else project.get("design_revision_count") or 0) + 1
        if project.get("design_revision_count") is not None:
            project["design_revision_count"] += 1
        project["design_revision_pending"] = True
    elif command == "quotation_receive":
        require_stage("quotation")
        body = validate(QuotationReceived, payload)
        design = approved_design(project)
        if body.design_version_id != design["id"] or not design.get("handoff_date"):
            reject("Quotation must reference the current approved design sent to the company")
        if body.received_date < design["handoff_date"]:
            reject("Quotation receipt cannot precede design handoff")
        project["quotation_versions"].append(record({**body.model_dump(), **document(project, body),
            "number": len(project["quotation_versions"]) + 1, "response": "Pending", "shared_date": None}))
    elif command == "order_confirm":
        require_stage("order")
        body = validate(OrderConfirmation, payload)
        quote = current(project, "quotation_versions", body.quotation_version_id)
        if project["orders"] and not project.get("commercial_basis_invalidated"):
            reject("Order is already confirmed; changed terms require an owner amendment")
        design = approved_design(project)
        if quote.get("design_version_id") != design["id"]:
            reject("The current quotation must match the newly approved design")
        if quote["response"] != "Approved" or not quote["shared_date"]:
            reject("The current quotation needs sharing and customer approval")
        if body.order_date < quote["shared_date"]:
            reject("Order date cannot precede quotation sharing")
        if body.confirmation_document_id and not any(a["id"] == body.confirmation_document_id for a in project["attachments"]):
            reject("Confirmation document must belong to this project")
        project["orders"].append(record({**body.model_dump(), "confirmed": True, "status": "Confirmed",
            "workflow_cycle": project.get("workflow_cycle", 1), "approval_identity": str(uuid4()),
            "original_amount": quote["amount"], "final_amount": quote["amount"], "amendments": [],
            "advance": {"received": False, "amount": "0.00", "date": None}}))
        project["order_amount"] = quote["amount"]
        project["commercial_basis_invalidated"] = False
    elif command == "order_document":
        require_stage("order")
        body = validate(OrderDocument, payload)
        row = current(project, "orders")
        if project.get("commercial_basis_invalidated") or row.get("authorization_invalidated"):
            reject("Confirm a new order for the current approved quotation before changing its documents")
        if row.get("confirmation_document_id"):
            reject("Confirmation document is already recorded; replacement requires a correction policy")
        if not any(a["id"] == body.attachment_id for a in project["attachments"]):
            reject("Confirmation document must belong to this project")
        row["confirmation_document_id"] = body.attachment_id
        row.setdefault("document_history", []).append(record(body.model_dump()))
    elif command == "order_advance":
        require_stage("order")
        body = validate(AdvancePayment, payload)
        row = current(project, "orders")
        if project.get("commercial_basis_invalidated") or row.get("authorization_invalidated"):
            reject("Confirm a new order for the current approved quotation first")
        if row["status"] != "Confirmed":
            reject("Only confirmed orders can record an advance")
        if body.date and body.date < row["order_date"]:
            reject("Advance receipt cannot precede order confirmation")
        if body.received and (Decimal(body.amount) <= 0 or not body.date):
            reject("Received advance requires a positive amount and receipt date")
        if not body.received and (Decimal(body.amount) != 0 or body.date):
            reject("An unreceived advance must have zero amount and no receipt date")
        if Decimal(body.amount) > Decimal(row["final_amount"]):
            reject("Advance cannot exceed the approved final order amount")
        row["advance"] = body.model_dump()
        row["approval_identity"] = str(uuid4())
    elif command == "order_amend":
        require_stage("order")
        body = validate(OrderAmendment, payload)
        row = current(project, "orders")
        if project.get("commercial_basis_invalidated") or row.get("authorization_invalidated"):
            reject("Confirm a new order for the current approved quotation first")
        if row["status"] != "Confirmed":
            reject("Only confirmed orders can approve amended terms")
        if not body.customer_approved:
            reject("Changed commercial terms require explicit customer approval")
        if body.date < row["order_date"] or Decimal(body.amount) < Decimal(row["advance"]["amount"]):
            reject("Amendment date/amount conflicts with the confirmed order or advance")
        row["amendments"].append(record(body.model_dump()))
        row["approval_identity"] = str(uuid4())
        row["final_amount"] = body.amount
        project["order_amount"] = body.amount
    elif command == "order_status":
        if stage == "completed":
            reject("Reopen a completed project explicitly before changing its status")
        body = validate(OrderStatusChange, payload)
        project["lifecycle_status"] = body.status if body.status in {"On Hold", "Cancelled"} else None
        if project.get("orders") and not project.get("commercial_basis_invalidated"):
            row = current(project, "orders")
            row["status"] = body.status
            row["approval_identity"] = str(uuid4())
            row.setdefault("status_history", []).append(record(body.model_dump()))
        project.setdefault("exceptions", []).append(record({"action": "status_change", **body.model_dump()}))
    elif command == "exception":
        body = validate(ExceptionCommand, payload)
        if body.action == "return_to_design":
            if stage not in {"design", "quotation", "order", "production", "installation", "completed"}:
                reject("Only a downstream project can return to Design")
            project.setdefault("work_history", []).append(record({"workflow_cycle": project.get("workflow_cycle", 1),
                "from_stage": stage, "reason": body.reason, "production": copy.deepcopy(project.get("production")),
                "installation": copy.deepcopy(project.get("installation")), "completion_date": project.get("completion_date")}))
            project["workflow_cycle"] = project.get("workflow_cycle", 1) + 1
            project["stage"] = "design"
            project["design_revision_pending"] = True
            project["commercial_basis_invalidated"] = True
            project["order_amount"] = None
            if project.get("orders"):
                project["orders"][-1]["authorization_invalidated"] = True
            project["production"] = {"status": "Not Started", "start_date": None, "completion_date": None, "notes": None}
            project["installation"] = {"status": "Not Started", "start_date": None, "completion_date": None, "notes": None}
            project["completion_date"] = None
            project["closure_pending_reason"] = None
            project["lifecycle_status"] = None
        elif body.action == "reopen":
            if stage != "completed":
                reject("Only a completed project can reopen")
            project.setdefault("work_history", []).append(record({"workflow_cycle": project.get("workflow_cycle", 1),
                "from_stage": stage, "reason": body.reason, "installation": copy.deepcopy(project.get("installation")),
                "completion_date": project.get("completion_date")}))
            project["stage"] = "installation"
            project["installation"] = {**project["installation"], "status": "In Progress", "completion_date": None, "completion_identity": None}
            project["completion_date"] = None
            project["closure_pending_reason"] = None
        project.setdefault("exceptions", []).append(record(body.model_dump()))
    elif command in {"production_update", "installation_update"}:
        expected = "production" if command == "production_update" else "installation"
        require_stage(expected)
        body = validate(WorkProgress, payload)
        if body.status not in ({"Not Started", "In Production", "Completed"} if expected == "production" else {"Not Started", "In Progress", "Completed"}):
            reject("Invalid status for this stage")
        previous = project.get(expected, {})
        if previous.get("status") == "Completed":
            reject("The owner must explicitly reopen or return this project to Design before changing completed work")
        if body.status != "Not Started" and not body.start_date:
            reject("Record the start date")
        if body.status == "Not Started" and (body.start_date or body.completion_date):
            reject("Not Started work cannot have actual start or completion dates")
        earliest = (current(project, "orders")["order_date"] if expected == "production"
                    else project.get("production", {}).get("completion_date"))
        if body.start_date and earliest and body.start_date < earliest:
            reject("Work cannot start before the preceding stage's completion/confirmation")
        if body.status == "Completed" and not body.completion_date:
            reject("Record the completion date")
        if body.completion_date and (body.status != "Completed" or not body.start_date or body.completion_date < body.start_date):
            reject("Completion must follow start and have Completed status")
        project[expected] = body.model_dump()
        if body.status == "Completed":
            project[expected]["completion_identity"] = str(uuid4())
        recompute_completion(project, policy)
    elif command == "site_visit":
        require_stage("installation")
        body = validate(SiteVisit, payload)
        installation = project.get("installation", {})
        if body.actual and installation.get("start_date") and body.date < installation["start_date"]:
            reject("An actual installation visit cannot precede installation start")
        project["site_visits"].append(record(body.model_dump()))
        project["known_site_visit_count"] = project.get("known_site_visit_count", 0 if project.get("is_legacy") else project.get("site_visit_count") or 0) + int(body.actual)
        if project.get("site_visit_count") is not None:
            project["site_visit_count"] += int(body.actual)
    elif command == "approval":
        body = validate(InternalApproval, payload)
        require_stage("order" if body.scope == "production" else "installation")
        if not subject(project, body.scope):
            reject("Complete the approval subject first")
        project["approvals"].append(record({**body.model_dump(), "subject_id": subject(project, body.scope), "policy_version": policy["version"]}))
        recompute_completion(project, policy)
    else:
        reject("Unsupported workflow command")
