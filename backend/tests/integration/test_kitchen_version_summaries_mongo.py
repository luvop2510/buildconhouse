"""Real Mongo list/metric projections retain an order's explicit older basis."""
import asyncio

from tests.integration.test_kitchen_projects_mongo import environment, configure, reach_stage, headers, accepted, command


def test_selected_older_basis_survives_summary_metrics_and_confirmation():
    async def run():
        async with environment() as env:
            await configure(env)
            project = await reach_stage(env, "order")
            original_design = project["design_versions"][-1]
            original_quote = project["quotation_versions"][-1]
            replacement_design = {**original_design, "id": "later-design", "number": 2}
            replacement_quote = {**original_quote, "id": "later-quote", "number": 2,
                                 "design_version_id": replacement_design["id"], "amount": "5000.00"}
            await env["db"].kitchen_projects.update_one({"id": project["id"]}, {"$push": {
                "design_versions": replacement_design, "quotation_versions": replacement_quote}})
            listing = await env["api"].get("/api/kitchen-projects?stage=order", headers=headers(env))
            assert listing.status_code == 200, listing.text
            row = next(row for row in listing.json()["rows"] if row["id"] == project["id"])
            assert row["current_design"]["id"] == original_design["id"]
            assert row["current_quotation"]["id"] == original_quote["id"]
            assert row["current_order"]["quotation_version_id"] == original_quote["id"]
            assert "design_versions" not in row and "quotation_versions" not in row
            dashboard = await env["api"].get("/api/kitchen-projects/dashboard", headers=headers(env))
            assert dashboard.status_code == 200, dashboard.text
            assert dashboard.json()["active_order_value"] == "1000.01"
            # Reconfirming a synthetic uncommitted order must authorize against
            # the chosen quote, never the newer quote's different price.
            await env["db"].kitchen_projects.update_one({"id": project["id"]}, {"$set": {"orders": [], "order_amount": None}})
            confirmed = await accepted(env, project, "order_confirm", {"quotation_version_id": original_quote["id"],
                "order_date": "2026-10-19", "final_amount": "1000.01"}, actor="worker")
            assert confirmed["orders"][-1]["quotation_version_id"] == original_quote["id"]
            assert confirmed["customer_order_confirmation"] == "Yes"
    asyncio.run(run())


def test_design_correction_authorizes_and_audits_selected_version():
    async def run():
        async with environment() as env:
            await configure(env)
            project = await reach_stage(env, "design")
            # Two synthetic versions; only the earlier one is approved.
            versions = [{"id": "approved-earlier", "number": 1, "workflow_cycle": 1,
                "presentation_date": "2026-10-18", "shared_date": "2026-10-18", "response": "Approved",
                "approval_date": "2026-10-18", "notes": "Original internal note"},
                {"id": "pending-later", "number": 2, "workflow_cycle": 1,
                 "presentation_date": "2026-10-19", "response": "Pending"}]
            await env["db"].kitchen_projects.update_one({"id": project["id"]}, {"$set": {"design_versions": versions}})
            body = {"version_id": versions[0]["id"], "presentation_date": "2026-10-18", "shared_date": "2026-10-18",
                "response": "Approved", "approval_date": "2026-10-18", "notes": "Corrected internal note", "reason": "Internal note correction"}
            denied = await command(env, project, "design_update", body, actor="worker")
            assert denied.status_code == 403
            saved = await accepted(env, project, "design_update", body)
            assert saved["design_versions"][0]["notes"] == "Corrected internal note"
            assert saved["design_versions"][1] == versions[1]
            changes = saved["activity"][-1]["payload"]["changes"]["design"]
            assert changes["before"]["id"] == changes["after"]["id"] == versions[0]["id"]
            assert changes["before"]["notes"] == "Original internal note"
    asyncio.run(run())


def test_quotation_queue_uses_quote_design_even_before_an_order_exists():
    async def run():
        async with environment() as env:
            await configure(env)
            project = await reach_stage(env, "order")
            await env["db"].kitchen_projects.update_one({"id": project["id"]}, {"$set": {"stage": "quotation", "orders": [], "order_amount": None}})
            original_design = project["design_versions"][-1]
            original_quote = project["quotation_versions"][-1]
            await env["db"].kitchen_projects.update_one({"id": project["id"]}, {"$push": {
                "design_versions": {**original_design, "id": "newer-unquoted-design", "number": 2}}})
            listing = await env["api"].get("/api/kitchen-projects?stage=quotation", headers=headers(env))
            assert listing.status_code == 200, listing.text
            row = next(row for row in listing.json()["rows"] if row["id"] == project["id"])
            assert row["current_quotation"]["id"] == original_quote["id"]
            assert row["current_design"]["id"] == original_design["id"]
            assert row["current_quotation"]["design_version_id"] == row["current_design"]["id"]
            assert "design_versions" not in row
    asyncio.run(run())
