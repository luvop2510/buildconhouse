"""Workbook HTTP acceptance on disposable loopback Mongo, including real queries."""
import asyncio
import copy
import importlib
import io
from collections import Counter
from datetime import datetime

from openpyxl import load_workbook

from models_kitchen import STAGES
from services.access_grants import build_grant
from services.kitchen_export import STAGE_SHEETS, XLSX_MEDIA_TYPE
from tests.integration.test_kitchen_projects_mongo import environment, configure, create_project, headers


def rows(sheet):
    values = list(sheet.values)
    return [dict(zip(values[0], row)) for row in values[1:]]


def test_workbook_download_has_all_pages_actual_stages_dates_phones_and_followup_history():
    async def run():
        async with environment() as env:
            await configure(env)
            migration = importlib.import_module("migrations.0045_kitchen_stage_followups")
            await migration.up(env["db"])
            await migration.up(env["db"])
            project, _ = await create_project(env)
            for index in range(3):
                response = await env["api"].post(f"/api/kitchen-projects/{project['id']}/follow-ups", headers=headers(env),
                    json={"stage": "lead", "date": f"2026-10-{index + 1:02}", "notes": f"Contact {index + 1}",
                          "interaction_type": "Call" if index % 2 else "Visit", "idempotency_key": f"export-followup-{index}"})
                assert response.status_code == 200, response.text
            await env["db"].customers.update_one({"id": env["ids"]["customer"]}, {"$set": {"name": "Current canonical customer", "phone": "+00123", "alternate_phone": "00098"}})
            template = await env["db"].kitchen_projects.find_one({"id": project["id"]}, {"_id": 0})
            await env["db"].kitchen_projects.delete_one({"id": project["id"]})
            documents = []
            for index in range(125):
                document = copy.deepcopy(template)
                document.update(id=project["id"] if index == 0 else f"export-project-{index:03}", reference=f"KIT-{index:04}", project_reference=f"KIT-{index:04}",
                    stage=STAGES[index % len(STAGES)], created_at=f"2026-11-{1 + index // 20:02}T20:00:00+00:00", updated_at="2026-11-10T00:00:00+00:00",
                    target_completion_date="2026-11-16", final_design_version_id="design-1",
                    design_versions=[{"id": f"design-{number}", "number": number, "response": "Approved", "notes": f"Design {number} note"} for number in (1, 2)],
                    quotation_versions=[{"id": f"quote-{number}", "number": number, "design_version_id": f"design-{number}", "amount": "100.00", "notes": f"Quote {number} note"} for number in (1, 2)],
                    orders=[])
                documents.append(document)
            documents.extend([{**copy.deepcopy(documents[0]), "id": "deleted", "reference": "KIT-deleted", "deleted_at": "2026-11-10"},
                              {**copy.deepcopy(documents[0]), "id": "foreign", "reference": "KIT-foreign", "floor_id": "first-floor"}])
            await env["db"].kitchen_projects.insert_many(documents)
            response = await env["api"].get("/api/kitchen-projects/export.xlsx", headers=headers(env))
            assert response.status_code == 200, response.text
            assert response.headers["content-type"] == XLSX_MEDIA_TYPE
            assert response.headers["cache-control"] == "no-store"
            assert response.content.startswith(b"PK")
            book = load_workbook(io.BytesIO(response.content))
            assert book.sheetnames == ["All Customers", *[title for _, title in STAGE_SHEETS], "Follow-Ups"]
            all_rows = rows(book["All Customers"])
            assert len(all_rows) == 125
            assert {row["Project Record ID"] for row in all_rows} == {row["id"] for row in documents[:125]}
            assert all(row["Customer Name"] == "Current canonical customer" and row["Phone Number"] == "+00123" for row in all_rows)
            assert all_rows[0]["Created Date"] == datetime(2026, 11, 2, 1, 30)
            assert all_rows[0]["Target Completion Date"] == datetime(2026, 11, 16)
            assert all_rows[0]["Alternate Phone"] == "00098"
            expected = Counter("order" if row["stage"] == "production" else row["stage"] for row in documents[:125])
            assert {stage: len(rows(book[title])) for stage, title in STAGE_SHEETS} == dict(expected)
            assert sum(len(rows(book[title])) for _, title in STAGE_SHEETS) == 125
            assert {row["Design Number"] for row in rows(book["Design"])} == {1}
            assert {row["Design Notes"] for row in rows(book["Design"])} == {"Design 1 note"}
            assert {row["Quotation Number"] for row in rows(book["Quotation"])} == {2}
            assert {row["Quotation Notes"] for row in rows(book["Quotation"])} == {"Quote 2 note"}
            assert [row["Follow-Up Number"] for row in rows(book["Follow-Ups"])] == [1, 2, 3]
            for sheet in book:
                assert sheet.freeze_panes == "A2" and sheet.auto_filter.ref
    asyncio.run(run())


def test_workbook_direct_http_rejects_missing_export_and_scopes_stage_history():
    async def run():
        async with environment() as env:
            await configure(env)
            project, _ = await create_project(env)
            await env["db"].kitchen_projects.update_one({"id": project["id"]}, {"$set": {"stage": "design"}})
            grants = [build_grant(user_id=env["ids"]["worker"], resource="kitchen_design", actions=["view", "export"], floor_id="second-floor",
                      expires_at=None, actor_id=env["ids"]["owner"], actor_name="Owner")]
            await env["db"].users.update_one({"id": env["ids"]["worker"]}, {"$set": {"delegation_grants": grants}})
            await env["db"].kitchen_stage_followups.insert_many([
                {"id": stage, "project_id": project["id"], "floor_id": "second-floor", "stage": stage, "number": 1,
                 "date": "2026-10-01", "notes": f"Private {stage}"} for stage in ("lead", "design")])
            import auth
            auth.invalidate_principal_cache("staff", env["ids"]["worker"])
            response = await env["api"].get("/api/kitchen-projects/export.xlsx", headers=headers(env, "worker"))
            assert response.status_code == 200, response.text
            book = load_workbook(io.BytesIO(response.content))
            assert len(rows(book["All Customers"])) == 1
            assert [row["Notes"] for row in rows(book["Follow-Ups"])] == ["Private design"]
            grants[0]["actions"] = ["view"]
            await env["db"].users.update_one({"id": env["ids"]["worker"]}, {"$set": {"delegation_grants": grants}})
            auth.invalidate_principal_cache("staff", env["ids"]["worker"])
            denied = await env["api"].get("/api/kitchen-projects/export.xlsx", headers=headers(env, "worker"))
            assert denied.status_code == 403
            anonymous = await env["api"].get("/api/kitchen-projects/export.xlsx")
            assert anonymous.status_code in {401, 403}
    asyncio.run(run())
