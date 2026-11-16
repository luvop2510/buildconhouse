"""Complete, permission-scoped Kitchen workbook; no client page is the dataset."""
from __future__ import annotations

import asyncio
import copy
import io
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from services import kitchen_access as access
from services.kitchen_projects import KitchenProjectService, READ_MAX_TIME_MS, bounded_read, order_basis_expression

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_PROJECTS = 10000
MAX_FOLLOWUPS = 100000
INDIA = timezone(timedelta(hours=5, minutes=30))
# Production is a preserved legacy state on the existing Order/Production page.
# '/' is forbidden in Excel worksheet names, hence its portable sheet spelling.
STAGE_SHEETS = (("lead", "Lead"), ("visit", "Visit"), ("cad", "CAD File"),
                ("design", "Design"), ("quotation", "Quotation"),
                ("order", "Order-Production"), ("installation", "Installation"),
                ("completed", "Completed"))
STAGE_LABELS = {key: value for key, value in STAGE_SHEETS}
STAGE_LABELS.update(order="Order/Production", production="Order/Production")
COMMON = ("Project ID", "Customer Name", "Phone Number", "Current Stage", "Status", "Assigned To",
          "Target Completion Date", "Created Date", "Last Updated Date", "Project Record ID", "Customer ID",
          "Alternate Phone", "Email", "Address", "Company", "Property", "City", "State", "Pincode", "GSTIN")
STAGE_COLUMNS = {
    "lead": ("Lead Date", "Architect / Interior", "Reference Company", "Kitchen Type", "Site Location", "Lead Notes", "Lost Reason"),
    "visit": ("Visit Date", "Visit Status", "Display / Model", "Visit Notes"),
    "cad": ("CAD Received", "CAD Progress %", "CAD Status", "CAD Notes"),
    "design": ("Design Number", "Customer Response", "Approval Date", "Sent To Company", "Company Handoff Date", "Design Notes"),
    "quotation": ("Quotation Number", "Related Design ID", "Quotation Received", "Received Date", "Kitchen Type", "PDF Upload Date", "Sent To Customer", "Date Sent", "Customer Response", "Quotation Amount INR", "Quotation Notes"),
    "order": ("Order Date", "Final Order Amount INR", "Advance Received", "Advance Amount INR", "Production Status", "Production Start Date", "Production Completion Date", "Production Notes"),
    "installation": ("Installation Status", "Installation Start Date", "Installation Completion Date", "Installation Notes", "Actual Site Visits"),
    "completed": ("Completion Date", "Final Order Amount INR", "Design Revisions", "Actual Site Visits"),
}


def _version_projection():
    """Select the exact commercial basis in Mongo instead of loading its ledger."""
    bound_order = {"$and": [{"$ne": ["$$order", {}]},
        {"$not": [{"$ifNull": ["$commercial_basis_invalidated", False]}]},
        {"$not": [{"$ifNull": ["$$order.authorization_invalidated", False]}]}]}
    finalized_design = {"$ifNull": [{"$arrayElemAt": [{"$filter": {
        "input": {"$ifNull": ["$design_versions", []]}, "as": "candidate",
        "cond": {"$eq": ["$$candidate.id", "$final_design_version_id"]}}}, 0]}, {}]}
    design = {"$cond": [{"$and": [{"$ne": ["$$quote", {}]},
        {"$or": [bound_order, {"$in": ["$stage", ["quotation", "order"]]}]}]}, "$$design", finalized_design]}
    result = {"orders": {"$slice": [{"$ifNull": ["$orders", []]}, -1]}}
    for ledger, selected in (("design_versions", design), ("quotation_versions", "$$quote")):
        result[ledger] = order_basis_expression({"$let": {"vars": {"selected": selected},
            "in": {"$cond": [{"$ne": ["$$selected", {}]}, ["$$selected"], []]}}}, fallback_quotation=True)
    return result


def excel_date(value):
    """Write real Excel dates; timestamps use the application's India calendar."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value.astimezone(INDIA).replace(tzinfo=None) if value.tzinfo else value
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(value) if len(value) == 10 else excel_date(datetime.fromisoformat(value.replace("Z", "+00:00")))
    except (TypeError, ValueError):
        # Do not invent a date for unavailable/inconsistent historical values.
        return None


def common_values(project):
    customer = project.get("customer") or {}
    return [project.get("project_reference") or project.get("reference"), customer.get("name"), customer.get("phone"),
            STAGE_LABELS.get(project.get("stage")), project.get("status"), project.get("assigned_to_name"),
            excel_date(project.get("target_completion_date")), excel_date(project.get("created_at")), excel_date(project.get("updated_at")),
            project.get("id"), project.get("customer_id"), customer.get("alternate_phone"), customer.get("email"), customer.get("address"),
            customer.get("company"), customer.get("property_name"), customer.get("city"), customer.get("state"), customer.get("pincode"), customer.get("gstin")]


def stage_values(project, stage):
    lead, visit, cad = (project.get(key) or {} for key in ("lead", "visit", "cad"))
    design, quote, order = (project.get(key) or {} for key in ("current_design", "current_quotation", "current_order"))
    production, installation = (project.get(key) or {} for key in ("production", "installation"))
    advance = order.get("advance") or {}
    values = {
        "lead": [excel_date(lead.get("lead_date")), lead.get("referrer_name"), lead.get("referrer_company"), lead.get("kitchen_type"), lead.get("site_location"), lead.get("notes"), lead.get("lost_reason")],
        "visit": [excel_date(visit.get("visit_date")), visit.get("status"), visit.get("display_model"), visit.get("notes")],
        "cad": [cad.get("received"), cad.get("progress"), cad.get("status"), cad.get("notes")],
        "design": [design.get("number"), design.get("response"), excel_date(design.get("approval_date")), design.get("handoff_status"), excel_date(design.get("handoff_date")), design.get("notes")],
        "quotation": [quote.get("number"), quote.get("design_version_id"), quote.get("received_status"), excel_date(quote.get("received_date")), quote.get("kitchen_type"), excel_date(quote.get("upload_date")), quote.get("sent_status"), excel_date(quote.get("shared_date")), quote.get("response"), quote.get("amount"), quote.get("notes")],
        "order": [excel_date(order.get("order_date")), project.get("order_amount"), advance.get("status"), advance.get("amount"), production.get("status"), excel_date(production.get("start_date")), excel_date(production.get("completion_date")), production.get("notes")],
        "installation": [installation.get("status"), excel_date(installation.get("start_date")), excel_date(installation.get("completion_date")), installation.get("notes"), project.get("site_visit_count")],
        "completed": [excel_date(project.get("completion_date")), project.get("order_amount"), project.get("design_revision_count"), project.get("site_visit_count")],
    }
    return values[stage]


def _sheet(workbook, title, headers, rows):
    sheet = workbook.create_sheet(title)
    sheet.append(list(headers))
    for cell in sheet[1]:
        cell.fill = PatternFill("solid", fgColor="30343B")
        cell.font = Font(color="FFFFFF", bold=True)
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    sheet.row_dimensions[1].height = 32
    for row in rows:
        sheet.append(row)
        for cell in sheet[sheet.max_row]:
            # Explicit strings preserve IDs, +phones and leading zeros verbatim,
            # while ensuring untrusted '=...' values can never execute as formulas.
            if isinstance(cell.value, str):
                cell.data_type = "s"
                cell.number_format = "@"
            elif isinstance(cell.value, (date, datetime)):
                cell.number_format = "dd mmm yyyy hh:mm" if isinstance(cell.value, datetime) else "dd mmm yyyy"
            cell.alignment = Alignment(vertical="top", wrap_text=True)
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    sheet.sheet_view.showGridLines = False
    for index, label in enumerate(headers, 1):
        sheet.column_dimensions[get_column_letter(index)].width = 42 if "Notes" in label or label == "Address" else min(32, max(18, len(label) + 3))
    return sheet


def build_kitchen_workbook(projects, followups):
    """Input is already redacted by the existing Kitchen public response policy."""
    workbook = Workbook()
    workbook.remove(workbook.active)
    workbook.properties.title = "Kitchen customers and stage follow-ups"
    workbook.properties.description = "All permitted Kitchen projects, created date ascending; Order/Production includes legacy Production records."
    projects = sorted(projects, key=lambda row: (str(row.get("created_at") or ""), row["id"]))
    _sheet(workbook, "All Customers", COMMON, [common_values(row) for row in projects])
    for stage, title in STAGE_SHEETS:
        selected = [row for row in projects if ("order" if row["stage"] == "production" else row["stage"]) == stage]
        _sheet(workbook, title, (*COMMON, *STAGE_COLUMNS[stage]), [common_values(row) + stage_values(row, stage) for row in selected])
    by_id = {row["id"]: row for row in projects}
    followup_rows = []
    for row in sorted(followups, key=lambda item: (item["project_id"], item["stage"], item["number"])):
        project = by_id.get(row["project_id"])
        if project:
            followup_rows.append([project.get("project_reference") or project.get("reference"), project.get("customer", {}).get("name"),
                                  project["id"], project.get("customer_id"), STAGE_LABELS.get(row["stage"]), row["number"],
                                  excel_date(row.get("date")), row.get("interaction_type"), row.get("notes"), row.get("actor_name"), excel_date(row.get("created_at"))])
    _sheet(workbook, "Follow-Ups", ("Project ID", "Customer Name", "Project Record ID", "Customer ID", "Stage", "Follow-Up Number", "Follow-Up Date", "Interaction Type", "Notes", "Recorded By", "Created Date"), followup_rows)
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


class KitchenWorkbookExport:
    def __init__(self, database):
        self.db = database

    async def render(self, user):
        await access.require_capability(self.db, user, "view")
        await access.require_capability(self.db, user, "export")
        permitted = set(access.allowed_stages(user)) & set(access.allowed_stages(user, "export"))
        if not permitted:
            raise HTTPException(403, "Kitchen export access is not permitted")
        service = KitchenProjectService(self.db)
        async with bounded_read():
            policy = await service.policy()
            query = {"$and": [access.scope_query(user, policy), {"stage": {"$in": sorted(permitted)}}]}
            total = await self.db.kitchen_projects.count_documents(query, maxTimeMS=READ_MAX_TIME_MS)
            if total > MAX_PROJECTS:
                raise HTTPException(413, "Kitchen workbook exceeds 10,000 projects; ask the owner for an archival export")
        projects, seen = [], set()
        for offset in range(0, total, 100):
            async with bounded_read():
                raw = await self.db.kitchen_projects.aggregate([
                    {"$match": query}, {"$sort": {"created_at": 1, "id": 1}}, {"$skip": offset}, {"$limit": 100},
                    {"$set": _version_projection()}, {"$project": {"_id": 0, "command_receipts": 0, "activity": 0,
                        "work_history": 0, "attachments": 0, "revision_events": 0, "site_visits": 0, "approvals": 0}}],
                    maxTimeMS=READ_MAX_TIME_MS).to_list(100)
                customers = await service._current_customers([row["customer_id"] for row in raw])
                for row in raw:
                    if row["id"] in seen:
                        raise HTTPException(409, "Kitchen data changed during export; export again")
                    seen.add(row["id"])
                    row["customer"] = customers.get(row["customer_id"], row.get("customer", {}))
                    public = await service.public(row, user, policy, summary=True, can_update=False)
                    # List summaries intentionally omit internal version notes;
                    # keep the selected version's notes only after the same
                    # historical-stage/commercial redaction as a detail read.
                    redacted = access.redact_project(copy.deepcopy(row), row, user, attachments=False)
                    for key, ledger in (("current_design", "design_versions"), ("current_quotation", "quotation_versions")):
                        selected = public.get(key)
                        if selected:
                            source = next((item for item in redacted.get(ledger, []) if item.get("id") == selected.get("id")), {})
                            selected["notes"] = source.get("notes")
                    projects.append(public)
        if len(projects) != total:
            raise HTTPException(409, "Kitchen data changed during export; export again")
        # Query only the exact exported project identities and permitted historical
        # stages. A grant to one stage never reveals another stage's notes.
        followups = []
        for offset in range(0, len(projects), 100):
            async with bounded_read():
                rows = await self.db.kitchen_stage_followups.find({"floor_id": access.KITCHEN_FLOOR,
                    "project_id": {"$in": [row["id"] for row in projects[offset:offset + 100]]},
                    "stage": {"$in": sorted(permitted & set(access.semantic_stages(user))) }},
                    {"_id": 0, "request_fingerprint": 0}).limit(MAX_FOLLOWUPS + 1).max_time_ms(READ_MAX_TIME_MS).to_list(MAX_FOLLOWUPS + 1)
                followups.extend(rows)
                if len(followups) > MAX_FOLLOWUPS:
                    raise HTTPException(413, "Kitchen workbook exceeds 100,000 follow-ups; ask the owner for an archival export")
        if access.restricted(user):
            followups = [{**row, "notes": None} for row in followups]
        # XLSX compression and cell construction must not block unrelated API I/O.
        return await asyncio.to_thread(build_kitchen_workbook, projects, followups)
