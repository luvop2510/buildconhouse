"""Kitchen commercial and installation rules, applied inside the aggregate CAS.

No I/O or staff identity is trusted here. The service authorizes commands and
configured internal approvers before invoking these strict domain operations.
"""
import copy
from decimal import Decimal
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import HTTPException

from models_kitchen import (AdvancePayment, CustomerResponse, DesignPresentation,
    DesignRevision, DesignUpdate, InternalApproval, OrderAmendment, OrderConfirmation,
    QuotationReceived, QuotationUpdate, SiteVisit, VersionDate, WorkProgress, OrderStatusChange, ExceptionCommand, OrderDocument, OrderUpdate, OrderConfirmationValue)

COMMANDS = {"design_present", "design_update", "design_share", "design_response", "design_revision", "design_handoff",
            "quotation_receive", "quotation_update", "quotation_share", "quotation_response", "order_confirm", "order_confirmation", "order_update", "order_advance",
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


def selected(project, key, version_id):
    row = next((row for row in project.get(key, []) if row["id"] == version_id), None)
    if row is None:
        reject("Select a version belonging to this project")
    return row


def production_has_started(project):
    def started(work):
        return bool(work and (work.get("start_date") or work.get("completion_date") or work.get("status", "Not Started") != "Not Started"))
    if started(project.get("production")) or any(row.get("production_started") for row in project.get("orders", []) if not row.get("authorization_invalidated")):
        return True
    cycle = project.get("workflow_cycle", 1)
    if any(row.get("workflow_cycle", 1) == cycle and started(row.get("production")) for row in project.get("work_history", [])):
        return True
    for event in reversed(project.get("activity", [])):
        changes = event.get("payload", {}).get("changes", {})
        if "workflow_cycle" in changes:
            break
        if started(changes.get("production", {}).get("after")):
            return True
    return False


def recorded_day(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=5, minutes=30))).date().isoformat()
    except (AttributeError, TypeError, ValueError):
        return None


def design_approval_day(project, row):
    if row.get("approval_date"):
        return row["approval_date"]
    day = None
    for event in reversed(project.get("approvals", [])):
        if event.get("scope") != "customer_design" or event.get("subject_id") != row["id"]:
            continue
        if event.get("decision") != "Approved":
            break
        # Repeated corrections to approved details do not create a later customer approval.
        day = recorded_day(event.get("at")) or day
    return day


def validate_design_dates(project, row, *, presentation_date, shared_date, response, approval_date, handoff_date, approving=False, now=None):
    if shared_date and presentation_date and shared_date < presentation_date:
        reject("Sharing date cannot precede presentation")
    if response != "Pending" and not shared_date:
        reject("Record the sharing date before the customer response")
    known_approval = (approval_date or design_approval_day(project, row) or (recorded_day(now) if approving else None)) if response == "Approved" else None
    if approval_date and response != "Approved":
        reject("An approval date requires customer approval")
    if known_approval and shared_date and known_approval < shared_date:
        reject("Customer approval cannot precede customer sharing")
    if handoff_date:
        if response != "Approved" or not shared_date:
            reject("Company handoff requires customer approval")
        if not known_approval:
            reject("The historical approval date is unknown; record the actual approval date before company handoff")
        if handoff_date < known_approval:
            reject("Company handoff cannot precede customer approval")


def approved_design(project, version_id=False):
    row = current(project, "design_versions") if version_id is False else selected(project, "design_versions", version_id)
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
            approved_design(project, quote["design_version_id"])
        elif stage == "order":
            rules = policy.get("production")
            if rules is None:
                reject("Department manager selection requires owner policy adoption")
            order = current(project, "orders")
            quote = selected(project, "quotation_versions", order["quotation_version_id"])
            approved_design(project, quote["design_version_id"])
            if project.get("commercial_basis_invalidated") or order.get("authorization_invalidated") or not quote.get("shared_date") or order["status"] != "Confirmed" or not order["confirmed"] or quote["response"] != "Approved":
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
        if production_has_started(project):
            reject("Production has started; use the owner-authorized Return to Design workflow")
        latest = project.get("design_versions", [])[-1] if project.get("design_versions") else None
        if latest and latest.get("response") == "Approved" and latest.get("workflow_cycle", 1) == project.get("workflow_cycle", 1) and user.role != "owner":
            reject("Only the owner can create a new version after customer approval")
        version = record({**body.model_dump(exclude={"reason"}),
            **(document(project, body) if body.attachment_id or body.url else {}),
            "workflow_cycle": project.get("workflow_cycle", 1), "number": max((row.get("number") or 0 for row in project["design_versions"]), default=0) + 1})
        validate_design_dates(project, version, presentation_date=body.presentation_date, shared_date=body.shared_date,
            response=body.response, approval_date=body.approval_date, handoff_date=body.handoff_date,
            approving=body.response == "Approved", now=now)
        if body.shared_date:
            version["shared_by"] = user.id
        if body.handoff_date:
            version["handoff_by"] = user.id
        project["design_versions"].append(version)
        if body.response != "Pending":
            project["approvals"].append(record({"scope": "customer_design", "subject_id": version["id"],
                "decision": body.response, "approval_date": body.approval_date, "notes": body.notes,
                "reason": body.reason or "Created new design version"}))
        project["design_revision_pending"] = False
    elif command == "design_update":
        require_stage("design")
        body = validate(DesignUpdate, payload)
        row = selected(project, "design_versions", body.version_id)
        if production_has_started(project) and any(q.get("design_version_id") == row["id"] and any(o.get("quotation_version_id") == q["id"] and not o.get("authorization_invalidated") for o in project.get("orders", [])) for q in project.get("quotation_versions", [])):
            reject("Production has started; use the owner-authorized Return to Design workflow")
        if project.get("design_revision_pending") or row.get("workflow_cycle", 1) != project.get("workflow_cycle", 1):
            reject("Present the revised design before editing its details")
        approval_date = body.approval_date if "approval_date" in body.model_fields_set else row.get("approval_date")
        shared_date = body.shared_date if "shared_date" in body.model_fields_set else row.get("shared_date")
        handoff_date = body.handoff_date if "handoff_date" in body.model_fields_set else row.get("handoff_date")
        presentation_date = body.presentation_date if "presentation_date" in body.model_fields_set else row.get("presentation_date")
        validate_design_dates(project, row, presentation_date=presentation_date, shared_date=shared_date,
            response=body.response, approval_date=approval_date, handoff_date=handoff_date,
            approving=body.response == "Approved" and row.get("response") != "Approved", now=now)
        if handoff_date and any(q.get("design_version_id") == row["id"] and q.get("received_date") and q["received_date"] < handoff_date for q in project.get("quotation_versions", [])):
            reject("Company handoff cannot follow a related quotation receipt")
        if body.revision_count is not None and body.revision_count != project.get("design_revision_count"):
            reject("Design revisions are counted from customer revision requests; record a revision request instead")
        if shared_date and not row.get("shared_date"):
            row["shared_by"] = user.id
        if handoff_date and not row.get("handoff_date"):
            row["handoff_by"] = user.id
        row.update(body.model_dump(exclude_unset=True, exclude={"version_id", "reason", "revision_count", "approval_date", "response_notes"}))
        if "approval_date" in body.model_fields_set:
            row["approval_date"] = body.approval_date
        if "response_notes" in body.model_fields_set:
            row["response_notes"] = body.response_notes
        row["corrected_by"], row["corrected_at"] = user.id, now
        project["approvals"].append(record({"scope": "customer_design", "subject_id": row["id"],
            "decision": body.response, "notes": body.response_notes, "reason": body.reason}))
    elif command in {"design_share", "design_handoff", "quotation_share"}:
        is_design = command.startswith("design")
        require_stage("design" if is_design else "quotation")
        body = validate(VersionDate, payload)
        row = selected(project, "design_versions" if is_design else "quotation_versions", body.version_id)
        if not is_design:
            approved_design(project, row.get("design_version_id"))
        if is_design and row.get("workflow_cycle", 1) != project.get("workflow_cycle", 1):
            reject("Present the revised design before sharing or handoff")
        earliest = row.get("presentation_date") or row.get("received_date")
        if earliest and body.date < earliest:
            reject("Sharing/handoff date cannot precede presentation/receipt")
        if command == "design_handoff":
            approved_design(project, row["id"])
            validate_design_dates(project, row, presentation_date=row.get("presentation_date"), shared_date=row.get("shared_date"),
                response=row["response"], approval_date=row.get("approval_date"), handoff_date=body.date)
            if row.get("handoff_date"):
                reject("This approved design handoff is already recorded")
            row["handoff_date"] = body.date
            row["handoff_by"] = user.id
        else:
            if row.get("shared_date"):
                reject("Sharing is already recorded for this version")
            row["shared_date"] = body.date
            if not is_design:
                row["sent_status"] = "Yes"
            row["shared_by"] = user.id
    elif command in {"design_response", "quotation_response"}:
        is_design = command == "design_response"
        require_stage("design" if is_design else "quotation")
        body = validate(CustomerResponse, payload)
        if is_design and body.response == "Rejected":
            reject("Design response must be Pending, Approved or Changes Required")
        row = selected(project, "design_versions" if is_design else "quotation_versions", body.version_id)
        if not is_design:
            approved_design(project, row.get("design_version_id"))
        if not row.get("shared_date"):
            reject("Record sharing this version with the customer first")
        if is_design:
            validate_design_dates(project, row, presentation_date=row.get("presentation_date"), shared_date=row["shared_date"],
                response=body.response, approval_date=body.approval_date, handoff_date=row.get("handoff_date"),
                approving=body.response == "Approved", now=now)
        elif body.approval_date:
            reject("Approval dates belong to design approvals")
        if row["response"] == "Approved":
            reject("An approved response is immutable; record a revision or a new version")
        if is_design and (project.get("design_revision_pending") or row.get("workflow_cycle", 1) != project.get("workflow_cycle", 1)):
            reject("Present the revised design before recording its approval")
        row["response"] = body.response
        if "notes" in body.model_fields_set:
            row["response_notes"] = body.notes
        if is_design and body.approval_date:
            row["approval_date"] = body.approval_date
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
    elif command in {"quotation_receive", "quotation_update"}:
        require_stage("quotation")
        editing = command == "quotation_update"
        body = validate(QuotationUpdate if editing else QuotationReceived, payload)
        row = selected(project, "quotation_versions", body.version_id) if editing else {}
        if production_has_started(project):
            reject("Production has started; use the owner-authorized Return to Design workflow")
        if editing and row.get("response") == "Approved" and user.role != "owner":
            reject("Only the owner can correct an approved quotation")
        fields = body.model_dump(exclude_unset=True, exclude={"version_id"}) if editing else body.model_dump()
        proposed = {**row, **fields}
        design = approved_design(project, proposed.get("design_version_id"))
        if not design.get("handoff_date"):
            reject("Quotation must reference the current approved design sent to the company")
        bound_orders = [o for o in project.get("orders", []) if o.get("quotation_version_id") == row.get("id") and not o.get("authorization_invalidated")]
        if editing and bound_orders and proposed.get("design_version_id") != row.get("design_version_id"):
            reject("This quotation is linked to an order; choose another quotation explicitly in Order to change its design")
        for status, date in (("received_status", "received_date"), ("sent_status", "shared_date")):
            if proposed.get(status) is None:
                proposed[status] = "Yes" if proposed.get(date) else "Not recorded"
            if proposed.get(date) and proposed[status] != "Yes":
                reject("A quotation date requires its corresponding status to be Yes; edit the date or status explicitly")
        if proposed.get("received_date") and proposed["received_date"] < design["handoff_date"]:
            reject("Quotation receipt cannot precede design handoff")
        if proposed.get("shared_date") and any(proposed["shared_date"] > order["order_date"] for order in bound_orders):
            reject("Quotation sharing cannot follow an order linked to this quotation")
        if proposed.get("shared_date") and proposed.get("received_date") and proposed["shared_date"] < proposed["received_date"]:
            reject("Quotation sharing cannot precede receipt")
        if proposed.get("response", "Pending") != "Pending" and (proposed["sent_status"] != "Yes" or not proposed.get("shared_date")):
            reject("Record quotation sent to customer and its date before recording a customer response")
        before = copy.deepcopy(row)
        if editing:
            row.update(proposed)
            row["corrected_by"], row["corrected_at"] = user.id, now
            if bound_orders and before.get("response") != row.get("response"):
                for order in bound_orders:
                    order["approval_identity"] = str(uuid4())
        else:
            row = record({**proposed, **(document(project, body) if body.attachment_id or body.url else {}),
                "number": max((row.get("number") or 0 for row in project["quotation_versions"]), default=0) + 1, "workflow_cycle": project.get("workflow_cycle", 1)})
            project["quotation_versions"].append(row)
        if row.get("shared_date") and (not editing or before.get("shared_date") != row.get("shared_date")):
            row["shared_by"] = user.id
        if row.get("response") != before.get("response", "Pending"):
            project["approvals"].append(record({"scope": "customer_quotation", "subject_id": row["id"],
                "decision": row["response"], "notes": row.get("notes")}))
    elif command == "order_confirm":
        require_stage("order")
        body = validate(OrderConfirmation, payload)
        if production_has_started(project):
            reject("Production has started; use the owner-authorized Return to Design workflow")
        quote = selected(project, "quotation_versions", body.quotation_version_id)
        if project["orders"] and not project.get("commercial_basis_invalidated"):
            reject("Order is already confirmed; changed terms require an owner amendment")
        design = approved_design(project, quote.get("design_version_id"))
        if not design.get("handoff_date"):
            reject("The selected design must have company handoff recorded")
        if quote["response"] != "Approved" or not quote["shared_date"]:
            reject("The current quotation needs sharing and customer approval")
        if body.order_date < quote["shared_date"]:
            reject("Order date cannot precede quotation sharing")
        if body.confirmation_document_id and not any(a["id"] == body.confirmation_document_id for a in project["attachments"]):
            reject("Confirmation document must belong to this project")
        final_amount = body.final_amount if body.final_amount is not None else quote.get("amount")
        if final_amount is None:
            reject("Record the final order amount before confirming the order; the quotation amount can remain unspecified")
        changed_amount = quote.get("amount") is not None and Decimal(final_amount) != Decimal(quote["amount"])
        if changed_amount and not body.amount_customer_approved:
            reject("Changed final order amount requires explicit customer approval")
        amendments = [record({"amount": final_amount, "date": body.order_date, "customer_approved": True,
                              "reason": "Customer approved changed final amount at order confirmation"})] if changed_amount else []
        project["orders"].append(record({**body.model_dump(), "confirmed": True, "status": "Confirmed",
            "workflow_cycle": project.get("workflow_cycle", 1), "approval_identity": str(uuid4()),
            "original_amount": quote.get("amount"), "final_amount": final_amount, "amendments": amendments,
            "advance": {"status": "Not recorded", "received": False, "amount": "0.00", "date": None}}))
        project["order_amount"] = final_amount
        project["customer_order_confirmation"] = "Yes"
        project["commercial_basis_invalidated"] = False
    elif command == "order_confirmation":
        require_stage("order")
        body = validate(OrderConfirmationValue, payload)
        if production_has_started(project):
            reject("Production has started; use the owner-authorized Return to Design workflow")
        if project.get("orders") and not project.get("commercial_basis_invalidated"):
            row = current(project, "orders")
            if row.get("authorization_invalidated"):
                reject("Confirm a new order for the current approved quotation first")
            if body.value == "Yes":
                quote = selected(project, "quotation_versions", row.get("quotation_version_id"))
                design = approved_design(project, quote.get("design_version_id"))
                if quote.get("response") != "Approved" or not quote.get("shared_date") or not design.get("handoff_date"):
                    reject("The selected quotation and design must be approved before confirming this order")
            row.setdefault("confirmation_history", []).append(record({"before": row.get("confirmed"), "value": body.value}))
            row["confirmed"] = body.value == "Yes"
            row["approval_identity"] = str(uuid4())
        project["customer_order_confirmation"] = body.value
    elif command == "order_document":
        require_stage("order")
        body = validate(OrderDocument, payload)
        row = current(project, "orders")
        if project.get("commercial_basis_invalidated") or row.get("authorization_invalidated"):
            reject("Confirm a new order for the current approved quotation before changing its documents")
        if row.get("confirmation_document_id") == body.attachment_id:
            reject("This confirmation document is already selected")
        if not any(a["id"] == body.attachment_id for a in project["attachments"]):
            reject("Confirmation document must belong to this project")
        previous = row.get("confirmation_document_id")
        row["confirmation_document_id"] = body.attachment_id
        row.setdefault("document_history", []).append(record({**body.model_dump(), "previous_attachment_id": previous}))
    elif command == "order_update":
        require_stage("order")
        body = validate(OrderUpdate, payload)
        row = current(project, "orders")
        if project.get("commercial_basis_invalidated") or row.get("authorization_invalidated"):
            reject("Confirm a new order for the current approved quotation first")
        quote_id = body.quotation_version_id or row["quotation_version_id"]
        changed_quote = quote_id != row["quotation_version_id"]
        quote = selected(project, "quotation_versions", quote_id)
        if changed_quote:
            if production_has_started(project):
                reject("Production has started; use the owner-authorized Return to Design workflow")
            design = approved_design(project, quote.get("design_version_id"))
            if not design.get("handoff_date") or quote.get("response") != "Approved" or not quote.get("shared_date"):
                reject("Select a shared, approved quotation for an approved design sent to company")
            if quote.get("amount") is not None and Decimal(quote["amount"]) != Decimal(row["final_amount"]) and not body.amount_customer_approved:
                reject("Changing the quotation while retaining different final terms requires explicit customer approval")
        if not quote.get("shared_date") or body.order_date < quote["shared_date"]:
            reject("Order date cannot precede quotation sharing")
        following = [row.get("advance", {}).get("date"), project.get("production", {}).get("start_date"), *(amendment.get("date") for amendment in row.get("amendments", []))]
        if any(value and value < body.order_date for value in following):
            reject("Order date cannot follow an approved amendment, advance or production start")
        fields = {"order_date": body.order_date, "notes": body.notes}
        if changed_quote:
            fields["quotation_version_id"] = quote_id
            row["approval_identity"] = str(uuid4())
        row.setdefault("corrections", []).append(record({"before": {key: row.get(key) for key in fields}, "after": fields}))
        row.update(fields)
    elif command == "order_advance":
        require_stage("order")
        body = validate(AdvancePayment, payload)
        row = current(project, "orders")
        if project.get("commercial_basis_invalidated") or row.get("authorization_invalidated"):
            reject("Confirm a new order for the current approved quotation first")
        if row["status"] != "Confirmed" or not row.get("confirmed", True):
            reject("Only confirmed orders can record an advance")
        if body.date and body.date < row["order_date"]:
            reject("Advance receipt cannot precede order confirmation")
        if body.status is not None and body.received != (body.status == "Yes"):
            reject("Advance received must agree with the explicitly selected status")
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
            project["customer_order_confirmation"] = "Not recorded"
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
            project["installation"] = {**(project.get("installation") or {}), "status": "In Progress", "completion_date": None, "completion_identity": None}
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
        if expected == "production":
            if not project.get("orders") and not project.get("manual_stage_navigation"):
                current(project, "orders")
            earliest = project["orders"][-1]["order_date"] if project.get("orders") else None
        else:
            earliest = project.get("production", {}).get("completion_date")
        if body.start_date and earliest and body.start_date < earliest:
            reject("Work cannot start before the preceding stage's completion/confirmation")
        if body.status == "Completed" and not body.completion_date:
            reject("Record the completion date")
        if body.completion_date and (body.status != "Completed" or not body.start_date or body.completion_date < body.start_date):
            reject("Completion must follow start and have Completed status")
        if expected == "production" and body.status != "Not Started" and project.get("orders"):
            project["orders"][-1]["production_started"] = True
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
