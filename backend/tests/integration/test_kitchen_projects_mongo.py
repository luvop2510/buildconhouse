"""Independent kitchen acceptance: real Mongo, HTTP auth and domain commands.

Opt in with KITCHEN_TEST_MONGO_URL pointing at a run-owned loopback mongod.
Never collect the historical integration directory to run this file.

Acceptance map (API coverage is distinct from UI, remote storage and business UAT):
Q01/Q02/Q03/Q11: lead/visit persistence, retired assignments, retry and CAS tests below.
Q10/Q13/Q21/Q22: direct auth/floor/forged-command/transition negatives below.
Q04-Q09/Q14-Q16: full lifecycle plus independent race/authority/gate tests below.
Q12: strict field round trips and negative payloads below; UI audited separately.
Q17/Q19/Q20: labelled multi-page query/metrics/export/timezone fixtures below.
Q18/Q24: real exported UI in redesign-kitchen-projects.spec.ts plus release gates.
Q23: synthetic BSON restoration below; no legacy N/A or cloud restore claim.

The optional --serve harness is test-only. It mounts the actual kitchen router,
actual authentication dependency and real Mongo. Shell identity responses derive
from this run's synthetic principal; no business API is mocked. Production app
lifespan, migrations, workers and messaging are deliberately never started.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import importlib
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

import httpx
import pytest
from fastapi import Depends, FastAPI
from motor.motor_asyncio import AsyncIOMotorClient


def local_mongo_url() -> str:
    raw = os.environ.get("KITCHEN_TEST_MONGO_URL", "")
    if not raw:
        pytest.skip("Requires an explicitly selected run-owned loopback Mongo")
    try:
        parsed = urlparse(raw)
        port = parsed.port
    except ValueError:
        raise RuntimeError("Kitchen acceptance requires a single valid loopback Mongo endpoint") from None
    if (parsed.scheme != "mongodb" or parsed.hostname not in {"127.0.0.1", "localhost"}
            or not port or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise RuntimeError("Kitchen acceptance requires loopback Mongo with explicit port and no credentials/database")
    if os.environ.get("PYTHON_DOTENV_DISABLED") != "1":
        raise RuntimeError("Set PYTHON_DOTENV_DISABLED=1 and supply hermetic runtime settings")
    return raw


@pytest.mark.parametrize("uri", [
    "mongodb://127.0.0.1:52747/?replicaSet=production", "mongodb://127.0.0.1:52747/#fragment",
    "mongodb://127.0.0.1:52747,remote.example:27017/", "mongodb://127.0.0.1:52747/buildcon_house",
    "mongodb://user:password@127.0.0.1:52747", "mongodb+srv://127.0.0.1:52747",
])
def test_test_harness_rejects_nonisolated_mongo_uris(monkeypatch, uri):
    monkeypatch.setenv("KITCHEN_TEST_MONGO_URL", uri)
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    with pytest.raises(RuntimeError):
        local_mongo_url()


@asynccontextmanager
async def environment():
    url = local_mongo_url()
    import auth
    import db as connection
    from routes import customer_routes, kitchen_routes, referrer_routes, sales_data_routes
    from services.access_grants import build_grant
    from services import activity_log

    client = AsyncIOMotorClient(url, serverSelectionTimeoutMS=3000)
    database = client[f"forge_kitchen_acceptance_{uuid4().hex}"]
    patches = [(auth, "db", auth.db), (connection, "db", connection.db),
               (kitchen_routes, "db", kitchen_routes.db), (customer_routes, "db", customer_routes.db),
               (activity_log, "db", activity_log.db), (referrer_routes, "db", referrer_routes.db),
               (sales_data_routes, "db", sales_data_routes.db)]
    for module, name, _ in patches:
        setattr(module, name, database)
    ids = {key: str(uuid4()) for key in ("owner", "worker", "manager", "denied", "customer", "other_customer")}
    tokens = {}
    try:
        await client.admin.command("ping")
        migration = importlib.import_module("migrations.0036_kitchen_projects")
        await migration.up(database)
        await migration.up(database)  # actual index migration must be repeat-safe
        transfers = importlib.import_module("migrations.0037_kitchen_file_transfers")
        await transfers.up(database)
        await transfers.up(database)
        await database.floors.insert_many([
            {"id": floor, "name": label, "slug": floor, "active": True}
            for floor, label in (("second-floor", "Kitchen"), ("first-floor", "Sanitary"))
        ])
        for key, role, custom in (("owner", "owner", False), ("worker", "manager", True), ("manager", "sales", True), ("denied", "worker", True)):
            await database.users.insert_one({"id": ids[key], "email": f"{key}@example.test",
                "full_name": f"Kitchen acceptance {key}", "role": role, "active": True,
                "floor_ids": ["second-floor"], "custom_access": custom})
            sid = await auth.create_session("staff", ids[key], None)
            tokens[key] = auth.create_token(ids[key], "staff", {"session_id": sid})
        second_sid = await auth.create_session("staff", ids["owner"], None)
        tokens["owner_second"] = auth.create_token(ids["owner"], "staff", {"session_id": second_sid})
        worker_grant = build_grant(user_id=ids["worker"], resource="kitchen_projects",
            actions=["view", "create", "update", "export"], floor_id="second-floor",
            expires_at=None, actor_id=ids["owner"], actor_name="Kitchen acceptance owner")
        await database.users.update_one({"id": ids["worker"]}, {"$set": {"delegation_grants": [worker_grant]}})
        manager_grant = build_grant(user_id=ids["manager"], resource="kitchen_projects",
            actions=["view", "create", "update", "export"], floor_id="second-floor",
            expires_at=None, actor_id=ids["owner"], actor_name="Kitchen acceptance owner")
        await database.users.update_one({"id": ids["manager"]}, {"$set": {"delegation_grants": [manager_grant]}})
        await database.customers.insert_many([
            {"id": ids["customer"], "name": "Kitchen acceptance customer", "phone": "9900000031",
             "floor_id": "second-floor", "address": "Synthetic kitchen site", "tier": "retail"},
            {"id": ids["other_customer"], "name": "Wrong floor customer", "phone": "9900000032",
             "floor_id": "first-floor", "tier": "retail"},
        ])
        app = FastAPI()
        @app.get("/api/health/ready")
        async def ready():
            await database.command("ping")
            return {"status": "ok"}

        app.include_router(kitchen_routes.router, prefix="/api")
        app.include_router(customer_routes.router, prefix="/api")
        app.include_router(referrer_routes.router, prefix="/api")
        app.include_router(sales_data_routes.router, prefix="/api")

        @app.get("/api/auth/me")
        async def identity(user=Depends(auth.get_current_user)):
            return user

        @app.get("/api/settings/floor-access")
        async def floors(user=Depends(auth.get_current_user)):
            rows = await database.floors.find({}, {"_id": 0}).to_list(10)
            return {"all_floors": user.role == "owner", "floors": rows, "floor_ids": [row["id"] for row in rows]}

        @app.get("/api/settings/permission-matrix")
        async def permissions(user=Depends(auth.get_current_user)):
            return {"modules": [], "roles": [], "matrix": {"owner": {}}}

        @app.get("/api/settings/access-grants/me")
        async def personal_grants(user=Depends(auth.get_current_user)):
            from services.access_grants import grants_for_user
            return {"grants": await grants_for_user(database, user.id)}

        @app.get("/api/notifications")
        async def notifications(user=Depends(auth.get_current_user)):
            return []

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://acceptance") as api:
            yield {"app": app, "db": database, "api": api, "tokens": tokens, "ids": ids}
    finally:
        for key in ("owner", "worker", "manager", "denied"):
            auth.invalidate_principal_cache("staff", ids[key])
        for module, name, original in patches:
            setattr(module, name, original)
        await client.drop_database(database.name)
        client.close()


def headers(env, actor="owner", floor="second-floor"):
    return {"Authorization": f"Bearer {env['tokens'][actor]}", "X-Floor-Id": floor}


async def create_project(env, key=None, **overrides):
    body = {"customer_id": env["ids"]["customer"], "idempotency_key": key or str(uuid4()),
            "lead": {"site_location": "Synthetic site", "lead_source": "Referral", "budget": "250000.01",
                     "notes": "Acceptance lead note", "lead_date": "2026-10-19", "status": "New"}, **overrides}
    response = await env["api"].post("/api/kitchen-projects", json=body, headers=headers(env))
    assert response.status_code in {200, 201}, response.text
    return response.json(), body


async def command(env, project, name, payload=None, *, key=None, expected=None, actor="owner"):
    return await env["api"].post(f"/api/kitchen-projects/{project['id']}/commands", headers=headers(env, actor),
        json={"expected_version": expected if expected is not None else project["version"],
              "idempotency_key": key or str(uuid4()), "command": name, "payload": payload or {}})


async def fixture_pdf_payload(env, project, name, payload):
    """Positive historical domain fixtures use dated owned PDFs; upload paths have separate HTTP coverage."""
    payload = dict(payload or {})
    if name in {"design_present", "quotation_receive"} and "final_attachment_id" not in payload:
        identity = str(uuid4())
        day = payload.get("presentation_date" if name == "design_present" else "received_date") or "2026-10-19"
        attachment = {"id": identity, "filename": f"{name}-{identity}.pdf", "content_type": "application/pdf",
                      "uploaded_at": day + "T06:00:00+00:00", "size_bytes": 100, "sha256": identity,
                      "bucket": "private-fixture", "storage_key": identity}
        await env["db"].kitchen_projects.update_one({"id": project["id"]}, {"$push": {"attachments": attachment}})
        payload.update(final_attachment_id=identity)
        if name == "design_present":
            payload["attachment_ids"] = [identity]
        else:
            payload["pdf_options"] = [{"attachment_id": identity, "kitchen_type": "GI"}]
    return payload


async def accepted(env, project, name, payload=None, **options):
    payload = await fixture_pdf_payload(env, project, name, payload)
    response = await command(env, project, name, payload, **options)
    assert response.status_code == 200, (name, response.text)
    return response.json()


async def prepare_manual_pdf_gate(env, project, target):
    """Supply explicit commercial evidence for positive manual-work fixtures."""
    if project["stage"] == "design" and target == "quotation" and not project.get("final_design_version_id"):
        project = await accepted(env, project, "design_present", {
            "response": "Approved", "shared_date": "2026-10-19", "approval_date": "2026-10-19",
            "handoff_status": "Yes", "handoff_date": "2026-10-19"})
    if project["stage"] == "quotation" and target == "order" and not project.get("quotation_versions"):
        project = await accepted(env, project, "quotation_receive", {
            "design_version_id": project["final_design_version_id"], "response": "Approved",
            "sent_status": "Yes", "shared_date": "2026-10-19"})
    return project


async def configure(env, **policy):
    current = await env["api"].get("/api/kitchen-projects/configuration", headers=headers(env))
    response = await env["api"].put("/api/kitchen-projects/configuration", headers=headers(env),
        json={"expected_version": current.json()["version"], "decision_contract": "2026-10-20",
              "department_manager_user_ids": [env["ids"]["manager"]], **policy})
    assert response.status_code == 200, response.text
    return response.json()


async def reach_stage(env, target):
    """Build a real project through commands, stopping at the selected stage."""
    project, _ = await create_project(env)
    if project.get("duplicate_review", {}).get("status") == "pending":
        project = await accepted(env, project, "review_duplicate", {"decision": "distinct_project", "reason": "Synthetic legitimate additional project"})
    for name, payload in [
        ("convert", {}),
        ("save_visit", {"status": "Visited", "requirements": "Synthetic", "interested": True}),
        ("advance_stage", {"target_stage": "cad"}),
        ("save_cad", {"progress": 100, "ready": True, "received": True, "status": "Completed"}),
        ("advance_stage", {"target_stage": "design"}),
    ]:
        if project["stage"] == target:
            return project
        project = await accepted(env, project, name, payload)
    if target == "design":
        return project
    project = await accepted(env, project, "design_present", {"url": "https://example.test/synthetic-design.pdf", "presentation_date": "2026-10-19"})
    design_id = project["design_versions"][-1]["id"]
    for name, payload in [
        ("design_share", {"version_id": design_id, "date": "2026-10-19"}),
        ("design_response", {"version_id": design_id, "response": "Approved", "approval_date": "2026-10-19"}),
        ("design_handoff", {"version_id": design_id, "date": "2026-10-19"}),
        ("advance_stage", {"target_stage": "quotation"}),
        ("quotation_receive", {"url": "https://example.test/synthetic-quotation.pdf", "design_version_id": design_id, "received_date": "2026-10-19", "amount": "1000.01"}),
    ]:
        if project["stage"] == target:
            return project
        project = await accepted(env, project, name, payload)
    quote_id = project["quotation_versions"][-1]["id"]
    for name, payload in [
        ("quotation_share", {"version_id": quote_id, "date": "2026-10-19"}),
        ("quotation_response", {"version_id": quote_id, "response": "Approved"}),
        ("advance_stage", {"target_stage": "order"}),
        ("order_confirm", {"quotation_version_id": quote_id, "order_date": "2026-10-19"}),
        ("order_advance", {"received": True, "amount": "0.01", "date": "2026-10-19"}),
        ("approval", {"scope": "production", "decision": "Approved"}),
        ("advance_stage", {"target_stage": "production"}),
        ("production_update", {"status": "Completed", "start_date": "2026-10-19", "completion_date": "2026-10-20"}),
        ("advance_stage", {"target_stage": "installation"}),
    ]:
        if project["stage"] == target and (target != "order" or project["orders"]):
            return project
        project = await accepted(env, project, name, payload, actor="manager" if name == "approval" else "owner")
    assert project["stage"] == target
    return project


def test_inline_lead_intake_uses_one_floor_local_contact_and_retries_without_duplication():
    async def run():
        async with environment() as env:
            path = "/api/kitchen-projects"
            body = {"customer": {"name": "New inline enquiry", "phone": "+91 98888 00123", "address": "Inline site"},
                    "lead": {"site_location": "Inline site", "status": "New"}, "idempotency_key": str(uuid4())}
            for address in (None, "", "  "):
                missing = await env["api"].post(path, json={**body, "customer": {**body["customer"], "address": address}}, headers=headers(env))
                assert missing.status_code == 422 and "address" in missing.json()["detail"]
                assert await env["db"].customers.count_documents({"phone": body["customer"]["phone"]}) == 0
                assert await env["db"].kitchen_projects.count_documents({}) == 0
            forbidden = await env["api"].post(path, json=body, headers=headers(env, "denied"))
            assert forbidden.status_code in {403, 422}
            assert await env["db"].customers.count_documents({"phone": body["customer"]["phone"]}) == 0
            first = await env["api"].post(path, json=body, headers=headers(env))
            assert first.status_code == 200, first.text
            project = first.json()
            retry = await env["api"].post(path, json=body, headers=headers(env))
            assert retry.status_code == 200 and retry.json()["id"] == project["id"] and retry.json()["replayed"]
            assert await env["db"].customers.count_documents({"id": project["customer_id"]}) == 1
            second = await env["api"].post(path, json={**body, "customer": {"name": "Different typed name", "phone": "9888800123", "address": "Another inline site"},
                                                      "idempotency_key": str(uuid4())}, headers=headers(env))
            assert second.status_code == 200, second.text
            assert second.json()["customer_id"] == project["customer_id"]
            assert second.json()["customer"]["name"] == "New inline enquiry"
            assert second.json()["duplicate_review"]["status"] == "pending"
            assert await env["db"].customers.count_documents({"floor_id": "second-floor"}) == 2
            project = await accepted(env, project, "convert")
            assert project["stage"] == "visit" and project["customer"]["name"] == "New inline enquiry"
            # The directory's pre-existing formatted number is reused too.
            reused = await env["api"].post(path, json={**body, "customer": {"name": "Typed existing name", "phone": "+91 99000 00031", "address": "Another inline site"},
                                                      "idempotency_key": str(uuid4())}, headers=headers(env))
            assert reused.status_code == 200 and reused.json()["customer_id"] == env["ids"]["customer"]
            assert await env["db"].customers.count_documents({"floor_id": "second-floor"}) == 2
            # A contact in another department must never be linked across floors.
            scoped = await env["api"].post(path, json={**body, "customer": {"name": "Separate Kitchen contact", "phone": "9900000032", "address": "Another inline site"},
                                                      "idempotency_key": str(uuid4())}, headers=headers(env))
            assert scoped.status_code == 200 and scoped.json()["customer_id"] != env["ids"]["other_customer"]
    asyncio.run(run())


def test_stage_list_carries_latest_commercial_fields_without_exposing_history():
    async def run():
        async with environment() as env:
            await configure(env)
            project = await reach_stage(env, "order")
            response = await env["api"].get("/api/kitchen-projects?stage=order", headers=headers(env))
            assert response.status_code == 200, response.text
            row = next(value for value in response.json()["rows"] if value["id"] == project["id"])
            assert row["current_design"]["id"] == project["design_versions"][-1]["id"]
            assert row["current_design"]["response"] == "Approved" and row["current_design"]["handoff_date"]
            assert row["current_quotation"]["amount"] == "1000.01" and row["current_quotation"]["response"] == "Approved"
            assert row["current_order"]["confirmed"] and row["current_order"]["final_amount"] == "1000.01"
            assert row["current_order"]["advance"]["received"] is False
            assert "amendments" not in row["current_order"] and "actor_id" not in row["current_design"]
            assert not ({"design_versions", "quotation_versions", "orders", "activity", "attachments", "command_receipts"} & row.keys())
    asyncio.run(run())


def test_q01_q03_q11_customer_reuse_conversion_and_owner_assignment():
    async def run():
        async with environment() as env:
            project, body = await create_project(env)
            assert project["project_reference"] == project["reference"] and project["project_reference"]
            retry = await env["api"].post("/api/kitchen-projects", json=body, headers=headers(env))
            assert retry.status_code in {200, 201} and retry.json()["id"] == project["id"]
            assert await env["db"].customers.count_documents({"id": env["ids"]["customer"]}) == 1
            different, _ = await create_project(env)
            assert different["id"] != project["id"] and different["customer_id"] == project["customer_id"]
            project = await accepted(env, project, "assign", {"stage": "visit", "user_id": env["ids"]["worker"]})
            assert project["assignments"] == {"visit": env["ids"]["worker"]}
            project = await accepted(env, project, "review_duplicate", {"decision": "distinct_project", "reason": "Owner verified separate site"})
            conversion_key = str(uuid4())
            converted = await command(env, project, "convert", key=conversion_key)
            assert converted.status_code == 200, converted.text
            converted = converted.json()
            repeated = await command(env, project, "convert", key=conversion_key)
            assert repeated.status_code == 200, repeated.text
            assert repeated.json()["id"] == converted["id"] and repeated.json()["version"] == converted["version"]
            fetched = await env["api"].get(f"/api/kitchen-projects/{project['id']}", headers=headers(env))
            assert fetched.status_code == 200
            saved = fetched.json()
            assert saved["stage"] == "visit" and saved["customer_id"] == env["ids"]["customer"]
            assert saved["project_reference"] == project["project_reference"]
            stored = await env["db"].kitchen_projects.find_one({"id": saved["id"]})
            assert stored["version"] == saved["version"] and stored["stage"] == "visit"
            assert stored["assignments"] == {"visit": env["ids"]["worker"]}
            assert saved["lead"]["budget"] == "250000.01" and saved["lead"]["notes"] == "Acceptance lead note"
            assert saved["lead"]["lead_date"] == "2026-10-19"
            assert await env["db"].kitchen_projects.count_documents({}) == 2
    asyncio.run(run())


def test_q12_q13_showroom_transition_requires_actual_visit_without_retired_fields():
    async def run():
        async with environment() as env:
            project, _ = await create_project(env)
            converted = await command(env, project, "convert")
            assert converted.status_code == 200, converted.text
            project = converted.json()
            for missing in ({}, {"status": "Scheduled"}, {"status": "Follow-up Required"}):
                if missing:
                    result = await command(env, project, "save_visit", missing)
                    assert result.status_code == 200, result.text
                    project = result.json()
                before = await env["db"].kitchen_projects.find_one({"id": project["id"]})
                blocked = await command(env, project, "advance_stage", {"target_stage": "cad"})
                assert blocked.status_code in {409, 422}, blocked.text
                assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == before
            visited = await command(env, project, "save_visit", {"status": "Visited", "display_model": "GI",
                "visit_date": "2026-10-19", "notes": "Showroom, not installation"})
            assert visited.status_code == 200, visited.text
            advanced = await command(env, visited.json(), "advance_stage", {"target_stage": "cad"})
            assert advanced.status_code == 200, advanced.text
            saved = advanced.json()
            assert saved["stage"] == "cad" and not saved.get("site_visits")
            invalid = await command(env, saved, "save_cad", {"progress": 101})
            assert invalid.status_code == 422, invalid.text
            skip = await command(env, saved, "advance_stage", {"target_stage": "completed"})
            assert skip.status_code in {409, 422}, skip.text
    asyncio.run(run())


def test_q11_q21_concurrent_cas_and_idempotency_payload_conflicts_are_atomic():
    async def run():
        async with environment() as env:
            project, body = await create_project(env)
            body["lead"]["notes"] = "Changed request under reused identity"
            conflict = await env["api"].post("/api/kitchen-projects", json=body, headers=headers(env))
            assert conflict.status_code == 409, conflict.text
            results = await asyncio.gather(*[command(env, project, "edit_lead", {"notes": note}) for note in ("Concurrent A", "Concurrent B")])
            assert sorted(result.status_code for result in results) == [200, 409]
            saved = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            assert saved["version"] == project["version"] + 1
            winner = next(result.json() for result in results if result.status_code == 200)
            key = str(uuid4())
            first = await command(env, winner, "metadata", {"target_completion_date": "2026-10-23"}, key=key)
            assert first.status_code == 200, first.text
            changed = await command(env, winner, "metadata", {"target_completion_date": "2026-10-24"}, key=key)
            assert changed.status_code == 409, changed.text
            before = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            forged = await command(env, first.json(), "edit_lead", {"stage": "completed", "site_visit_count": 90, "actor_id": "forged"})
            assert forged.status_code == 422, forged.text
            assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == before
    asyncio.run(run())


def test_q10_q22_direct_requests_require_identity_floor_and_resource_grant():
    async def run():
        async with environment() as env:
            project, _ = await create_project(env)
            for path in ("/api/kitchen-projects", f"/api/kitchen-projects/{project['id']}",
                         "/api/kitchen-projects/dashboard", "/api/kitchen-projects/customers",
                         "/api/kitchen-projects/assignees", "/api/kitchen-projects/export"):
                for request_headers in ({}, headers(env, "denied"), headers(env, floor="first-floor")):
                    response = await env["api"].get(path, headers=request_headers)
                    assert response.status_code in {401, 403, 404}, (path, response.status_code, response.text)
            denied = await command(env, project, "convert", actor="denied")
            assert denied.status_code in {403, 404}, denied.text
            wrong_customer = {"customer_id": env["ids"]["other_customer"], "idempotency_key": str(uuid4()), "lead": {}}
            rejected = await env["api"].post("/api/kitchen-projects", json=wrong_customer, headers=headers(env))
            assert rejected.status_code in {403, 404, 422}, rejected.text
            assert await env["db"].kitchen_projects.count_documents({}) == 1
    asyncio.run(run())


def test_q19_query_pagination_and_filtered_totals_share_canonical_records():
    async def run():
        async with environment() as env:
            expected = []
            for index in range(5):
                row, _ = await create_project(env, lead={"site_location": f"Synthetic site {index}", "status": "New"})
                expected.append(row["id"])
            seen = []
            for page in (1, 2, 3):
                response = await env["api"].get(f"/api/kitchen-projects?page={page}&limit=2&stage=lead", headers=headers(env))
                assert response.status_code == 200, response.text
                result = response.json()
                assert result["total"] == 5
                seen.extend(row["id"] for row in result["rows"])
            assert len(seen) == len(set(seen)) == 5 and set(seen) == set(expected)
            empty = await env["api"].get("/api/kitchen-projects?stage=completed", headers=headers(env))
            assert empty.status_code == 200 and empty.json()["total"] == 0
    asyncio.run(run())


def test_q10_grant_scope_without_assignment_and_session_revocation():
    async def run():
        async with environment() as env:
            project, _ = await create_project(env)
            unrelated, _ = await create_project(env)
            for row in (project, unrelated):
                visible = await env["api"].get(f"/api/kitchen-projects/{row['id']}", headers=headers(env, "worker"))
                assert visible.status_code == 200 and visible.json()["permissions"]["can_update"]
            page = await env["api"].get("/api/kitchen-projects", headers=headers(env, "worker"))
            assert page.status_code == 200 and page.json()["total"] == 2
            retired = await command(env, project, "assign", {"stage": "visit", "user_id": env["ids"]["worker"]}, actor="worker")
            assert retired.status_code == 403
            edited = await command(env, unrelated, "edit_lead", {"notes": "Delegated without assignment"}, actor="worker")
            assert edited.status_code == 200
            denied = await command(env, unrelated, "edit_lead", {"notes": "No grant"}, actor="denied")
            assert denied.status_code == 403
            import auth
            await env["db"].user_sessions.update_many({"user_id": env["ids"]["owner"]}, {"$set": {"revoked": True}})
            auth.invalidate_principal_cache("staff", env["ids"]["owner"])
            assert (await command(env, project, "convert")).status_code == 401
    asyncio.run(run())


def test_q04_to_q09_versions_revisions_production_visits_and_late_closure(tmp_path):
    """Resolved policy on synthetic records; business UAT remains separate."""
    async def run():
        async with environment() as env:
            await configure(env)
            project, _ = await create_project(env)
            async def ok(name, payload=None, key=None):
                nonlocal project
                project = await accepted(env, project, name, payload, key=key, actor="manager" if name == "approval" else "owner")
                return project
            async def blocked(name, payload=None):
                before = await env["db"].kitchen_projects.find_one({"id": project["id"]})
                response = await command(env, project, name, payload)
                assert response.status_code in {403, 409, 422}, (name, response.text)
                assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == before
            await ok("convert")
            await ok("save_visit", {"status": "Visited", "visit_date": "2026-10-19", "requirements": "Synthetic", "interested": True})
            await ok("advance_stage", {"target_stage": "cad"})
            await ok("save_cad", {"received": True, "progress": 100, "status": "Completed"})
            await ok("advance_stage", {"target_stage": "design"})
            await ok("design_present", {"url": "https://example.test/synthetic-design.pdf", "presentation_date": "2026-10-19", "notes": "First"})
            v1 = project["design_versions"][-1]["id"]
            assert project["design_revision_count"] == 0
            await blocked("design_handoff", {"version_id": v1, "date": "2026-10-19"})
            revision_key = str(uuid4())
            await ok("design_revision", {"version_id": v1, "reason": "Customer requested cabinets"}, revision_key)
            await ok("design_revision", {"version_id": v1, "reason": "Customer requested cabinets"}, revision_key)
            assert project["design_revision_count"] == 1
            await ok("design_present", {"url": "https://example.test/synthetic-design.pdf", "presentation_date": "2026-10-19", "notes": "Internal correction"})
            assert project["design_revision_count"] == 1
            v2 = project["design_versions"][-1]["id"]
            await blocked("design_response", {"version_id": v1, "response": "Approved"})
            await ok("design_share", {"version_id": v2, "date": "2026-10-19"})
            await ok("design_response", {"version_id": v2, "response": "Approved", "approval_date": "2026-10-19"})
            await ok("design_handoff", {"version_id": v2, "date": "2026-10-19"})
            await ok("advance_stage", {"target_stage": "quotation"})
            await ok("quotation_receive", {"url": "https://example.test/synthetic-quotation.pdf", "design_version_id": v2, "received_date": "2026-10-19", "amount": "1000.01"})
            q1 = project["quotation_versions"][-1]["id"]
            await ok("quotation_share", {"version_id": q1, "date": "2026-10-19"})
            await ok("quotation_response", {"version_id": q1, "response": "Approved"})
            import copy
            frozen_quote = copy.deepcopy(project["quotation_versions"][-1])
            await ok("quotation_receive", {"url": "https://example.test/synthetic-quotation.pdf", "design_version_id": v2, "received_date": "2026-10-19", "amount": "1100.01"})
            q2 = project["quotation_versions"][-1]["id"]
            assert project["quotation_versions"][0] == frozen_quote
            await blocked("advance_stage", {"target_stage": "order"})
            await blocked("quotation_response", {"version_id": q1, "response": "Approved"})
            await ok("quotation_share", {"version_id": q2, "date": "2026-10-19"})
            await ok("quotation_response", {"version_id": q2, "response": "Approved"})
            await ok("advance_stage", {"target_stage": "order"})
            await blocked("order_confirm", {"quotation_version_id": "unrelated-quotation", "order_date": "2026-10-19"})
            await ok("order_confirm", {"quotation_version_id": q2, "order_date": "2026-10-19"})
            await blocked("advance_stage", {"target_stage": "production"})
            await ok("order_advance", {"received": True, "amount": "150.00", "date": "2026-10-19"})
            advance_audit = project["activity"][-1]["payload"]["changes"]["advance"]
            assert advance_audit["before"] == {"status": "Not recorded", "received": False, "amount": "0.00", "date": None}
            assert advance_audit["after"]["amount"] == "150.00"
            await ok("approval", {"scope": "production", "decision": "Approved"})
            await ok("order_amend", {"amount": "1200.01", "customer_approved": True, "reason": "Agreed extra work", "date": "2026-10-19"})
            assert project["orders"][0]["original_amount"] == "1100.01"
            await blocked("advance_stage", {"target_stage": "production"})
            await ok("approval", {"scope": "production", "decision": "Approved"})
            await ok("advance_stage", {"target_stage": "production"})
            await blocked("production_update", {"status": "Completed", "start_date": "2026-10-20", "completion_date": "2026-10-19"})
            await ok("production_update", {"status": "In Production", "start_date": "2026-10-19"})
            await ok("production_update", {"status": "Completed", "start_date": "2026-10-19", "completion_date": "2026-10-20"})
            production_audit = project["activity"][-1]["payload"]["changes"]["production"]
            assert production_audit["before"]["status"] == "In Production"
            assert production_audit["before"]["completion_date"] is None
            assert production_audit["after"]["completion_date"] == "2026-10-20"
            await ok("advance_stage", {"target_stage": "installation"})
            await ok("installation_update", {"status": "In Progress", "start_date": "2026-10-20"})
            await ok("site_visit", {"actual": False, "date": "2026-10-20"})
            assert project["site_visit_count"] == 0
            visit_key = str(uuid4())
            await ok("site_visit", {"actual": True, "date": "2026-10-20"}, visit_key)
            await ok("site_visit", {"actual": True, "date": "2026-10-20"}, visit_key)
            assert project["site_visit_count"] == 1
            await ok("site_visit", {"actual": True, "date": "2026-10-20"})
            assert project["site_visit_count"] == 2
            await ok("installation_update", {"status": "Completed", "start_date": "2026-10-20", "completion_date": "2026-10-21"})
            assert project["stage"] == "installation" and project["closure_pending_reason"]
            await ok("approval", {"scope": "closure", "decision": "Approved"})
            assert project["stage"] == "completed" and project["completion_date"] == "2026-10-21"
            assert project["order_amount"] == "1200.01" and project["site_visit_count"] == 2 and project["design_revision_count"] == 1
            completed = await env["api"].get("/api/kitchen-projects?completed=true", headers=headers(env))
            assert completed.json()["total"] == 1
            exported = await env["api"].get("/api/kitchen-projects/export", headers=headers(env))
            assert exported.status_code == 200 and "1200.01" in exported.text
            assert "Actual site visits" in exported.text
            await blocked("metadata", {"target_completion_date": "2026-10-23"})
            # Q23: actual BSON snapshot/restore into a distinct empty database.
            from scripts.recovery_snapshot import export_database, restore_database
            snapshot = tmp_path / "kitchen-synthetic-snapshot"
            manifest = await export_database(env["db"], snapshot)
            restored = env["db"].client[f"forge_kitchen_restored_{uuid4().hex}"]
            try:
                await restore_database(snapshot, restored, restored.name)
                original = await env["db"].kitchen_projects.find_one({"id": project["id"]})
                assert await restored.kitchen_projects.find_one({"id": project["id"]}) == original
                assert await restored.customers.count_documents({}) == await env["db"].customers.count_documents({})
                indexes = await restored.kitchen_projects.index_information()
                assert indexes["kitchen_projects_id_unique"]["unique"]
                assert manifest["collections"]["kitchen_projects"]["count"] == 1
                with pytest.raises(ValueError):
                    await restore_database(snapshot, restored, restored.name)
            finally:
                await env["db"].client.drop_database(restored.name)
    asyncio.run(run())


def test_independent_q11_q14_current_approvals_and_concurrent_revision_and_visit_commands():
    async def run():
        async with environment() as env:
            await configure(env)
            project = await reach_stage(env, "design")
            project = await accepted(env, project, "design_present", {"presentation_date": "2026-10-19", "url": "https://example.test/design-v1.pdf"})
            version_id = project["design_versions"][-1]["id"]
            project = await accepted(env, project, "design_share", {"version_id": version_id, "date": "2026-10-19"})
            replacement = await fixture_pdf_payload(env, project, "design_present", {"presentation_date": "2026-10-19", "notes": "Concurrent replacement"})
            requests = [command(env, project, "design_response", {"version_id": version_id, "response": "Approved"}),
                        command(env, project, "design_present", replacement)]
            results = await asyncio.gather(*requests)
            assert sorted(response.status_code for response in results) == [200, 409]
            project = next(response.json() for response in results if response.status_code == 200)
            if len(project["design_versions"]) == 1:
                project = await accepted(env, project, "exception", {"action": "return_to_design", "reason": "Owner authorizes internal correction after approval"})
                project = await accepted(env, project, "design_present", {"url": "https://example.test/synthetic-design.pdf", "presentation_date": "2026-10-19"})
            assert project["design_versions"][-1]["response"] == "Pending"
            stale_approval = await command(env, project, "design_response", {"version_id": version_id, "response": "Approved"})
            if project["design_versions"][0].get("workflow_cycle", 1) == project.get("workflow_cycle", 1) and project["design_versions"][0]["response"] != "Approved":
                assert stale_approval.status_code == 200, stale_approval.text
                project = stale_approval.json()
                assert project["design_versions"][0]["response"] == "Approved"
                assert project["design_versions"][-1]["response"] == "Pending"
            else:
                assert stale_approval.status_code == 422
            current_id = project["design_versions"][-1]["id"]
            revision_key = str(uuid4())
            results = await asyncio.gather(*[command(env, project, "design_revision", {"version_id": current_id, "reason": "One customer request"}, key=revision_key) for _ in range(2)])
            assert all(response.status_code == 200 for response in results)
            stored = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            assert stored["design_revision_count"] == len(stored["revision_events"]) == 1
            assert len([event for event in stored["activity"] if event["type"] == "design_revision"]) == 1
            installation = await reach_stage(env, "installation")
            visit_key = str(uuid4())
            visits = await asyncio.gather(*[command(env, installation, "site_visit", {"date": "2026-10-20", "actual": True}, key=visit_key) for _ in range(2)])
            assert all(response.status_code == 200 for response in visits)
            latest = visits[0].json()
            assert latest["site_visit_count"] == len(latest["site_visits"]) == 1
            distinct = await asyncio.gather(*[command(env, latest, "site_visit", {"date": "2026-10-20", "actual": True}) for _ in range(2)])
            assert sorted(response.status_code for response in distinct) == [200, 409]
            latest = next(response.json() for response in distinct if response.status_code == 200)
            assert latest["site_visit_count"] == 2
            assert all(row["actor_id"] == env["ids"]["owner"] and row["at"] for row in latest["site_visits"])
    asyncio.run(run())


def test_independent_q10_q16_unconfigured_manager_identity_and_subject_invalidation():
    """Owner role, generic manager role and selected department identity differ."""
    async def run():
        async with environment() as env:
            # No adoption/identity: resolved manager gate is never silently bypassed.
            order = await reach_stage(env, "order")
            unknown = await command(env, order, "advance_stage", {"target_stage": "production"})
            assert unknown.status_code == 422
            await configure(env)
            owner_approval = await command(env, order, "approval", {"scope": "production", "decision": "Approved"})
            assert owner_approval.status_code == 403
            role_manager_approval = await command(env, order, "approval", {"scope": "production", "decision": "Approved"}, actor="worker")
            assert role_manager_approval.status_code == 403
            manager_policy = await env["api"].put("/api/kitchen-projects/configuration", headers=headers(env, "manager"),
                json={"expected_version": 2, "decision_contract": "2026-10-20", "department_manager_user_ids": [env["ids"]["worker"]]})
            assert manager_policy.status_code == 403
            order = await accepted(env, order, "order_advance", {"received": True, "amount": "0.01", "date": "2026-10-19"})
            order = await accepted(env, order, "approval", {"scope": "production", "decision": "Rejected", "reason": "Check drawings"}, actor="manager")
            assert (await command(env, order, "advance_stage", {"target_stage": "production"})).status_code == 422
            order = await accepted(env, order, "approval", {"scope": "production", "decision": "Approved"}, actor="manager")
            approved_subject = order["approvals"][-1]["subject_id"]
            order = await accepted(env, order, "order_amend", {"amount": "1200.03", "customer_approved": True,
                "reason": "Customer-approved amendment", "date": "2026-10-19"})
            assert order["orders"][0]["approval_identity"] != approved_subject
            assert (await command(env, order, "advance_stage", {"target_stage": "production"})).status_code == 422
            order = await accepted(env, order, "approval", {"scope": "production", "decision": "Approved"}, actor="manager")
            await configure(env)  # A policy revision invalidates an old manager decision.
            assert (await command(env, order, "advance_stage", {"target_stage": "production"})).status_code == 422
            order = await accepted(env, order, "approval", {"scope": "production", "decision": "Approved"}, actor="manager")
            order = await accepted(env, order, "advance_stage", {"target_stage": "production"})
            assert order["orders"][-1]["advance"]["amount"] == "0.01"  # No minimum was invented.
            assert (await command(env, order, "advance_stage", {"target_stage": "installation"})).status_code == 422
            order = await accepted(env, order, "production_update", {"status": "Completed", "start_date": "2026-10-19", "completion_date": "2026-10-20"})
            order = await accepted(env, order, "advance_stage", {"target_stage": "installation"})
            order = await accepted(env, order, "installation_update", {"status": "Completed", "start_date": "2026-10-20", "completion_date": "2026-10-21"})
            assert order["stage"] == "installation" and order["closure_pending_reason"]
            assert (await env["api"].get("/api/kitchen-projects?completed=true", headers=headers(env))).json()["total"] == 0
            assert (await command(env, order, "approval", {"scope": "closure", "decision": "Approved"})).status_code == 403
            order = await accepted(env, order, "approval", {"scope": "closure", "decision": "Approved"}, actor="manager")
            assert order["stage"] == "completed" and order["completion_date"] == "2026-10-21"
    asyncio.run(run())


def test_independent_q17_q19_q20_numeric_sort_full_export_filters_and_ist_boundaries(monkeypatch):
    """Labelled projections seed only this disposable DB; no workflow claim."""
    import copy
    import csv
    import io
    from decimal import Decimal
    from datetime import datetime, timezone
    from services import kitchen_projects
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 10, 19, 20, 0, tzinfo=timezone.utc).astimezone(tz)
    monkeypatch.setattr(kitchen_projects, "datetime", Clock)
    async def run():
        async with environment() as env:
            await configure(env)
            project, _ = await create_project(env)
            template = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            await env["db"].kitchen_projects.delete_one({"id": project["id"]})
            rows = []
            for index in range(105):
                row = copy.deepcopy(template)
                row.pop("_id", None)
                row.update(id=f"completed-{index:03d}", reference=f"KP-{index:03d}", stage="completed", status="Completed",
                    completion_date="2026-10-20", order_amount=f"{index + 1}.01", order_amount_paise=(index + 1) * 100 + 1,
                    assignments={"lead": env["ids"]["worker"]}, assigned_to=env["ids"]["worker"])
                row["customer"]["name"] = '=HYPERLINK("https://example.test","unsafe")' if index == 0 else f"Customer {index}"
                rows.append(row)
            await env["db"].customers.update_one({"id": project["customer_id"], "floor_id": "second-floor"},
                {"$set": {"name": rows[0]["customer"]["name"]}})
            for index, (stage, status, amount, deadline, target) in enumerate([
                ("lead", "New", None, "2026-10-19T19:00:00+00:00", None),
                ("order", "Confirmed", "10.01", None, "2026-10-19"),
                ("order", "On Hold", "100.02", "2026-10-19T19:00:00+00:00", None),
                ("order", "Cancelled", "999.99", None, None),
                ("lead", "Lost", None, None, None),
                ("lead", "New", None, None, "2026-10-20"),
            ]):
                row = copy.deepcopy(template); row.pop("_id", None)
                row.update(id=f"active-{index}", reference=f"ACTIVE-{index}", stage=stage, status=status,
                    order_amount=amount, order_amount_paise=int(Decimal(amount or "0") * 100), deadline=deadline,
                    target_completion_date=target, created_at="2026-10-19T18:30:00+00:00",
                    assignments={"lead": env["ids"]["worker"]}, assigned_to=env["ids"]["worker"])
                if stage == "order":
                    row["design_versions"] = [{"id": f"design-{index}", "response": "Approved", "handoff_date": "2026-10-19"}]
                    row["quotation_versions"] = [{"id": f"quote-{index}", "response": "Approved", "shared_date": "2026-10-19", "design_version_id": f"design-{index}"}]
                    row["orders"] = [{"id": f"order-{index}", "confirmed": True, "status": status, "final_amount": amount, "quotation_version_id": f"quote-{index}"}]
                    if status in {"On Hold", "Cancelled"}:
                        row["lifecycle_status"] = status
                rows.append(row)
            await env["db"].kitchen_projects.insert_many(rows)
            dashboard = await env["api"].get("/api/kitchen-projects/dashboard", headers=headers(env))
            assert dashboard.status_code == 200, dashboard.text
            metrics = dashboard.json()
            assert metrics["active_projects"] == 3
            assert metrics["on_hold_projects"] == 1
            assert metrics["next_action_overdue_projects"] == 0
            assert metrics["completion_overdue_projects"] == 1
            assert metrics["active_order_value"] == "10.01"
            assert metrics["stage_counts"] == {"lead": 3, "visit": 0, "cad": 0, "design": 0,
                "quotation": 0, "order": 3, "production": 0, "installation": 0, "completed": 105}
            assert metrics["workload"] == [{"assignee_id": env["ids"]["worker"], "assignee_name": None, "project_count": 3}]
            for attention, expected in (("active", 3), ("on_hold", 1), ("pending_approval", 0),
                    ("next_action_overdue", 0), ("completion_overdue", 1), ("active_order", 1)):
                response = await env["api"].get(f"/api/kitchen-projects?attention={attention}", headers=headers(env))
                assert response.status_code == 200, response.text
                assert response.json()["total"] == expected, attention
            invalid = await env["api"].get("/api/kitchen-projects?attention=made_up", headers=headers(env))
            assert invalid.status_code == 422
            sorted_rows = await env["api"].get("/api/kitchen-projects?completed=true&sort=order_amount&direction=asc&limit=3", headers=headers(env))
            assert [row["order_amount"] for row in sorted_rows.json()["rows"]] == ["1.01", "2.01", "3.01"]
            filtered = await env["api"].get(f"/api/kitchen-projects?stage=order&status=Confirmed&assignee={env['ids']['worker']}&date_field=target_completion_date&date_from=2026-10-19&date_to=2026-10-19", headers=headers(env))
            assert filtered.json()["total"] == 1
            boundary = await env["api"].get("/api/kitchen-projects?search=ACTIVE-&date_field=created_at&date_from=2026-10-20&date_to=2026-10-20", headers=headers(env))
            assert boundary.json()["total"] == 6  # midnight IST included at 18:30 UTC
            previous = await env["api"].get("/api/kitchen-projects?search=ACTIVE-&date_field=created_at&date_from=2026-10-19&date_to=2026-10-19", headers=headers(env))
            assert previous.json()["total"] == 0
            exported = await env["api"].get("/api/kitchen-projects/export?date_from=2026-10-20&date_to=2026-10-20", headers=headers(env))
            assert exported.status_code == 200, exported.text
            records = list(csv.DictReader(io.StringIO(exported.text.lstrip('\ufeff'))))
            assert len(records) == 105  # all matching pages, including the final five
            assert any(row["Customer"].startswith("'=HYPERLINK") for row in records)
            assert len({row["Project ID"] for row in records}) == 105
            literal = await env["api"].get("/api/kitchen-projects?search=.*", headers=headers(env))
            assert literal.json()["total"] == 0
    asyncio.run(run())


def test_independent_q13_all_eight_transition_prerequisites_and_skips():
    """Synthetic valid stage snapshots isolate every missing transition input.

    Full command-built happy lifecycle is tested separately. Each negative
    request must leave the actual persisted aggregate byte-for-byte unchanged.
    """
    import copy
    async def run():
        async with environment() as env:
            policy = await configure(env)
            project, _ = await create_project(env)
            base = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            design = {"id": "design-current", "response": "Approved", "handoff_status": "Yes", "handoff_date": "2026-10-19", "attachment_ids": ["design-pdf"], "final_attachment_id": "design-pdf"}
            quote = {"id": "quote-current", "response": "Approved", "shared_date": "2026-10-19", "design_version_id": design["id"], "pdf_options": [{"attachment_id": "quote-pdf", "kitchen_type": "GI"}], "final_attachment_id": "quote-pdf"}
            order = {"id": "order-current", "status": "Confirmed", "confirmed": True, "quotation_version_id": quote["id"],
                     "final_amount": "1000.00", "advance": {"received": True, "amount": "0.01", "date": "2026-10-19"}, "confirmation_document_id": "file-current"}
            production_approval = {"id": "production-approval", "scope": "production", "subject_id": order["id"], "policy_version": policy["version"], "decision": "Approved", "actor_id": env["ids"]["manager"]}
            closure_approval = {"id": "closure-approval", "scope": "closure", "subject_id": "installation-completion", "policy_version": policy["version"], "decision": "Approved", "actor_id": env["ids"]["manager"]}
            def set_path(row, path, value):
                keys = path.split("."); current = row
                for key in keys[:-1]:
                    current = current[int(key)] if isinstance(current, list) else current[key]
                key = keys[-1]
                if isinstance(current, list): current[int(key)] = value
                else: current[key] = value
            cases = [
                ("lead", "visit", [("lead.status", "Lost")]),
                ("visit", "cad", [("visit.status", "Scheduled")]),
                ("cad", "design", [("cad.status", "In Progress"), ("cad.received", False), ("cad.progress", 99)]),
                ("design", "quotation", [("design_versions.0.response", "Pending"), ("design_versions.0.handoff_date", None), ("design_revision_pending", True)]),
                ("quotation", "order", [("quotation_versions.0.response", "Pending"), ("quotation_versions.0.shared_date", None), ("quotation_versions.0.design_version_id", "historical-design"), ("design_versions.0.response", "Pending")]),
                ("order", "production", [("orders.0.status", "On Hold"), ("orders.0.confirmed", False), ("orders.0.quotation_version_id", "historical-quote"), ("orders.0.advance.received", False), ("orders.0.advance.amount", "0.00"), ("approvals.0.decision", "Rejected")]),
                ("production", "installation", [("production.status", "In Production")]),
                ("installation", "completed", [("installation.status", "In Progress"), ("approvals.1.decision", "Rejected")]),
            ]
            for stage, target, missing in cases:
                valid = copy.deepcopy(base)
                valid.update(stage=stage, design_revision_pending=False, final_design_version_id=design["id"], attachments=[{"id": identity, "content_type": "application/pdf", "uploaded_at": "2026-10-19T06:00:00+00:00"} for identity in ("design-pdf", "quote-pdf")], design_versions=[copy.deepcopy(design)],
                    quotation_versions=[copy.deepcopy(quote)], orders=[copy.deepcopy(order)],
                    approvals=[copy.deepcopy(production_approval), copy.deepcopy(closure_approval)],
                    production={"status": "Completed", "start_date": "2026-10-19", "completion_date": "2026-10-20"},
                    installation={"status": "Completed", "start_date": "2026-10-20", "completion_date": "2026-10-21", "completion_identity": "installation-completion"})
                valid["visit"].update(status="Visited", requirements="Known customer requirements", interested=True)
                valid["cad"].update(status="Completed", progress=100, received=True, ready=True)
                for path, absent in missing:
                    invalid = copy.deepcopy(valid); set_path(invalid, path, absent)
                    await env["db"].kitchen_projects.replace_one({"id": project["id"]}, invalid)
                    rejected = await command(env, invalid, "advance_stage", {"target_stage": target})
                    assert rejected.status_code == 422, (stage, path, rejected.text)
                    assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == invalid
                await env["db"].kitchen_projects.replace_one({"id": project["id"]}, valid)
                nonadjacent = "completed" if stage != "installation" else "lead"
                skipped = await command(env, valid, "advance_stage", {"target_stage": nonadjacent})
                assert skipped.status_code == 422, (stage, skipped.text)
                assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == valid
                advanced = await command(env, valid, "advance_stage", {"target_stage": target})
                assert advanced.status_code == 200, (stage, advanced.text)
                assert advanced.json()["stage"] == target
    asyncio.run(run())


def test_independent_q01_q11_canonical_customer_create_delete_race_never_orphans_project():
    async def run():
        async with environment() as env:
            for iteration in range(8):
                customer_id = str(uuid4())
                await env["db"].customers.insert_one({"id": customer_id, "name": f"Race customer {iteration}",
                    "floor_id": "second-floor", "phone": f"99010000{iteration:02d}"})
                creation, deletion = await asyncio.gather(
                    env["api"].post("/api/kitchen-projects", headers=headers(env), json={"customer_id": customer_id, "idempotency_key": str(uuid4()), "lead": {"site_location": "Synthetic site"}}),
                    env["api"].delete(f"/api/customers/{customer_id}", headers=headers(env)))
                assert creation.status_code in {200, 201, 404, 409}, creation.text
                assert deletion.status_code in {200, 409}, deletion.text
                customer = await env["db"].customers.find_one({"id": customer_id})
                projects = await env["db"].kitchen_projects.count_documents({"customer_id": customer_id})
                assert not projects or customer is not None
                if creation.status_code in {200, 201}:
                    assert deletion.status_code == 409 and projects == 1 and customer["kitchen_reference_reserved"] is True
                if deletion.status_code == 200:
                    assert customer is None and projects == 0
            # Deterministic deletion-wins interleaving blocks create even before
            # the customer's final removal; no lookup-only race is accepted.
            customer_id = str(uuid4())
            await env["db"].customers.insert_one({"id": customer_id, "name": "Claimed deletion",
                "floor_id": "second-floor", "phone": "9901000019", "kitchen_delete_token": "owned-deletion-in-flight"})
            blocked = await env["api"].post("/api/kitchen-projects", headers=headers(env), json={"customer_id": customer_id, "idempotency_key": str(uuid4()), "lead": {"site_location": "Synthetic site"}})
            assert blocked.status_code == 409, blocked.text
            assert await env["db"].kitchen_projects.count_documents({"customer_id": customer_id}) == 0
    asyncio.run(run())


def test_independent_q12_q15_q16_dates_required_fields_and_audited_exceptions():
    async def run():
        async with environment() as env:
            await configure(env)
            missing = await env["api"].post("/api/kitchen-projects", headers=headers(env),
                json={"customer_id": env["ids"]["customer"], "idempotency_key": str(uuid4()), "lead": {}})
            assert missing.status_code == 422
            project, _ = await create_project(env)
            project = await accepted(env, project, "convert")
            project = await accepted(env, project, "save_visit", {"status": "Visited", "requirements": "Known requirements", "interested": True})
            missing_date = await command(env, project, "advance_stage", {"target_stage": "cad"})
            assert missing_date.status_code == 200  # Unknown optional historical/visit dates remain blank.
            order = await reach_stage(env, "order")
            for payload in ({"received": True, "amount": "0.00", "date": "2026-10-19"},
                            {"received": False, "amount": "1.00"},
                            {"received": True, "amount": "1001.00", "date": "2026-10-19"},
                            {"received": True, "amount": "100.00", "date": "2026-10-18"}):
                before = await env["db"].kitchen_projects.find_one({"id": order["id"]})
                invalid = await command(env, order, "order_advance", payload)
                assert invalid.status_code == 422, invalid.text
                assert await env["db"].kitchen_projects.find_one({"id": order["id"]}) == before
            order = await accepted(env, order, "order_status", {"status": "On Hold", "reason": "Awaiting customer"})
            blocked_hold = await command(env, order, "advance_stage", {"target_stage": "production"})
            assert blocked_hold.status_code == 422
            order = await accepted(env, order, "order_status", {"status": "Cancelled", "reason": "Customer cancelled"})
            order = await accepted(env, order, "order_status", {"status": "Confirmed", "reason": "Customer reconfirmed"})
            assert [row["status"] for row in order["orders"][0]["status_history"]] == ["On Hold", "Cancelled", "Confirmed"]
            assert order["orders"][0]["original_amount"] == "1000.01"
            order = await accepted(env, order, "order_advance", {"received": True, "amount": "0.01", "date": "2026-10-19"})
            order = await accepted(env, order, "approval", {"scope": "production", "decision": "Approved"}, actor="manager")
            order = await accepted(env, order, "advance_stage", {"target_stage": "production"})
            bad_start = await command(env, order, "production_update", {"status": "In Production", "start_date": "2026-10-18"})
            assert bad_start.status_code == 422
            order = await accepted(env, order, "production_update", {"status": "Completed", "start_date": "2026-10-19", "completion_date": "2026-10-20"})
            order = await accepted(env, order, "advance_stage", {"target_stage": "installation"})
            bad_install = await command(env, order, "installation_update", {"status": "In Progress", "start_date": "2026-10-19"})
            assert bad_install.status_code == 422
            order = await accepted(env, order, "installation_update", {"status": "In Progress", "start_date": "2026-10-20"})
            early_visit = await command(env, order, "site_visit", {"date": "2026-10-19", "actual": True})
            assert early_visit.status_code == 422
            order = await accepted(env, order, "installation_update", {"status": "Completed", "start_date": "2026-10-20", "completion_date": "2026-10-21"})
            assert order["stage"] == "installation"
            order = await accepted(env, order, "approval", {"scope": "closure", "decision": "Approved"}, actor="manager")
            assert order["stage"] == "completed"
            original_history_length = len(order["activity"])
            order = await accepted(env, order, "exception", {"action": "reopen", "reason": "Customer requested installation adjustment"})
            assert order["stage"] == "installation" and order["completion_date"] is None
            assert order["installation"]["completion_date"] is None
            assert len(order["activity"]) == original_history_length + 1
            completed = await env["api"].get("/api/kitchen-projects?completed=true", headers=headers(env))
            assert completed.json()["total"] == 0
    asyncio.run(run())


def test_q22_private_attachment_bytes_permissions_and_failed_upload(monkeypatch, tmp_path):
    """Actual local bytes test storage. Remote provider acceptance stays separate."""
    from media_storage import factory
    class LocalPrivateStorage:
        failed = False
        hold = False
        directory = tmp_path / "source-bytes"
        async def require_private_bucket(self, bucket):
            assert bucket == "forge-private"
        async def exists(self, *, bucket, key):
            return (self.directory / key).is_file()
        async def upload(self, *, bucket, key, data, **kwargs):
            if self.hold:
                self.started.set()
                await self.release.wait()
            if self.failed:
                raise RuntimeError("synthetic provider upload failure")
            path = self.directory / key
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        async def download(self, *, bucket, key):
            return (self.directory / key).read_bytes()
    storage = LocalPrivateStorage()
    monkeypatch.setattr(factory, "get_media_storage", lambda: storage)
    async def run():
        async with environment() as env:
            storage.started, storage.release = asyncio.Event(), asyncio.Event()
            project, _ = await create_project(env)
            data = b"%PDF-1.4\nSynthetic private document"
            path = f"/api/kitchen-projects/{project['id']}/attachments"
            fields = {"expected_version": str(project["version"]), "idempotency_key": str(uuid4())}
            blocked = await env["api"].post(path, headers=headers(env, "denied"), data=fields,
                files={"file": ("synthetic.pdf", data, "application/pdf")})
            assert blocked.status_code == 403
            policy = await env["api"].put("/api/kitchen-projects/configuration", headers=headers(env),
                json={"expected_version": 1, "decision_contract": "2026-10-20", "files": {"allowed_types": ["application/pdf"], "max_bytes": 100000}})
            assert policy.status_code == 200
            for filename, content, mime, expected_status in [
                ("payload.html", b"<script>test</script>", "text/html", 415),
                ("fake.pdf", b"Not a PDF", "application/pdf", 415),
                ("too-large.pdf", b"%PDF-" + b"x" * (768 * 1024), "application/pdf", 413),
                ("empty.pdf", b"", "application/pdf", 413),
            ]:
                rejected = await env["api"].post(path, headers=headers(env), data=fields,
                    files={"file": (filename, content, mime)})
                assert rejected.status_code == expected_status, (filename, rejected.text)
            unauthorized_upload = await env["api"].post(path, headers=headers(env, "denied"), data=fields,
                files={"file": ("synthetic.pdf", data, "application/pdf")})
            assert unauthorized_upload.status_code == 403
            assert not (await env["db"].kitchen_projects.find_one({"id": project["id"]}))["attachments"]
            response = await env["api"].post(path, headers=headers(env), data=fields,
                files={"file": ("synthetic.pdf", data, "application/pdf")})
            assert response.status_code == 200, response.text
            saved = response.json()
            attachment = saved["attachments"][0]
            assert "storage_key" not in attachment and "bucket" not in attachment
            assert saved["stage"] == "lead" and not saved["quotation_versions"]
            replay = await env["api"].post(path, headers=headers(env), data=fields,
                files={"file": ("synthetic.pdf", data, "application/pdf")})
            assert replay.status_code == 200 and replay.json()["version"] == saved["version"]
            changed_retry = await env["api"].post(path, headers=headers(env), data=fields,
                files={"file": ("synthetic.pdf", data+b"changed", "application/pdf")})
            assert changed_retry.status_code == 409
            download = f"{path}/{attachment['id']}"
            authorized = await env["api"].get(download, headers=headers(env))
            assert authorized.status_code == 200 and authorized.content == data
            for request_headers in ({}, headers(env, "denied"), headers(env, floor="first-floor")):
                denied = await env["api"].get(download, headers=request_headers)
                assert denied.status_code in {401, 403, 404}
            # A policy edit cannot cross an in-flight upload using prior rules.
            storage.hold = True
            held = asyncio.create_task(env["api"].post(path, headers=headers(env),
                data={"expected_version": str(saved["version"]), "idempotency_key": str(uuid4())},
                files={"file": ("held.pdf", data+b"held", "application/pdf")}))
            try:
                await asyncio.wait_for(storage.started.wait(), timeout=3)
                pending_policy = await env["api"].put("/api/kitchen-projects/configuration", headers=headers(env),
                    json={"expected_version": policy.json()["version"], "files": {"allowed_types": ["application/pdf"], "max_bytes": 90000}})
                assert pending_policy.status_code == 409, pending_policy.text
            finally:
                storage.release.set()
                result = await held
                storage.hold = False
            assert result.status_code == 200, result.text
            saved = result.json()
            policy_after = await env["api"].put("/api/kitchen-projects/configuration", headers=headers(env),
                json={"expected_version": policy.json()["version"], "files": {"allowed_types": ["application/pdf"], "max_bytes": 90000}})
            assert policy_after.status_code == 200
            internal_policy = await env["db"].kitchen_configuration.find_one({"_id": "kitchen-policy"})
            assert internal_policy.get("active_command_count", 0) == 0 and internal_policy.get("command_admissions", {}) == {}
            invalid_command = await command(env, saved, "advance_stage", {"target_stage": "completed"})
            assert invalid_command.status_code == 422
            internal_policy = await env["db"].kitchen_configuration.find_one({"_id": "kitchen-policy"})
            assert internal_policy["active_command_count"] == 0 and internal_policy["command_admissions"] == {}
            before = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            # Q23: restore metadata AND private bytes into separate local targets,
            # then reauthenticate a new session and exercise actual download.
            from scripts.recovery_snapshot import export_database, restore_database
            import auth
            import db as connection
            from routes import kitchen_routes
            snapshot = tmp_path / "attachment-db-snapshot"
            await export_database(env["db"], snapshot)
            restored = env["db"].client[f"forge_kitchen_file_restore_{uuid4().hex}"]
            source_directory = storage.directory
            restored_directory = tmp_path / "restored-private-bytes"
            raw = before["attachments"][0]
            restored_path = restored_directory / raw["storage_key"]
            restored_path.parent.mkdir(parents=True, exist_ok=True)
            restored_path.write_bytes((source_directory / raw["storage_key"]).read_bytes())
            try:
                await restore_database(snapshot, restored, restored.name)
                assert await restored.user_sessions.count_documents({}) == 0
                for module in (auth, connection, kitchen_routes):
                    module.db = restored
                auth.invalidate_principal_cache("staff", env["ids"]["owner"])
                auth.invalidate_principal_cache("staff", env["ids"]["denied"])
                restored_sid = await auth.create_session("staff", env["ids"]["owner"], None)
                restored_token = auth.create_token(env["ids"]["owner"], "staff", {"session_id": restored_sid})
                restored_headers = {"Authorization": f"Bearer {restored_token}", "X-Floor-Id": "second-floor"}
                storage.directory = restored_directory
                restored_read = await env["api"].get(download, headers=restored_headers)
                assert restored_read.status_code == 200 and restored_read.content == data
                assert restored_read.headers["cache-control"] == "no-store"
                guessed = await env["api"].get(f"{path}/guessed-attachment", headers=restored_headers)
                assert guessed.status_code == 404
                wrong_floor = await env["api"].get(download, headers={**restored_headers, "X-Floor-Id": "first-floor"})
                assert wrong_floor.status_code in {403, 404}
                old_session = await env["api"].get(download, headers=headers(env))
                assert old_session.status_code == 401
            finally:
                for module in (auth, connection, kitchen_routes):
                    module.db = env["db"]
                auth.invalidate_principal_cache("staff", env["ids"]["owner"])
                storage.directory = source_directory
                await env["db"].client.drop_database(restored.name)
            storage.failed = True
            with pytest.raises(RuntimeError, match="synthetic provider upload failure"):
                await env["api"].post(path, headers=headers(env),
                    data={"expected_version": str(saved["version"]), "idempotency_key": str(uuid4())},
                    files={"file": ("second.pdf", data+b"new", "application/pdf")})
            assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == before
            # Stored-file corruption must fail even for an authorized caller.
            raw = before["attachments"][0]
            (storage.directory / raw["storage_key"]).write_bytes(b"tampered")
            corrupt = await env["api"].get(download, headers=headers(env))
            assert corrupt.status_code == 409
    asyncio.run(run())


def test_resolved_d04_d08_mandatory_fields_duplicate_owner_review_and_delegation():
    async def run():
        async with environment() as env:
            await configure(env)
            # Canonical contact is required, never silently written or repaired.
            original = await env["db"].customers.find_one({"id": env["ids"]["customer"]})
            for field, invalid_value in (("name", "  "), ("phone", " -- ")):
                await env["db"].customers.update_one({"id": env["ids"]["customer"]}, {"$set": {field: invalid_value}})
                invalid = await env["api"].post("/api/kitchen-projects", headers=headers(env), json={
                    "customer_id": env["ids"]["customer"], "idempotency_key": str(uuid4()), "lead": {"site_location": "Synthetic"}})
                assert invalid.status_code == 422
                assert await env["db"].kitchen_projects.count_documents({}) == 0
                await env["db"].customers.replace_one({"id": env["ids"]["customer"]}, original)
            for location in (None, "", "  "):
                invalid = await env["api"].post("/api/kitchen-projects", headers=headers(env), json={
                    "customer_id": env["ids"]["customer"], "idempotency_key": str(uuid4()), "lead": {"site_location": location}})
                assert invalid.status_code == 422
            first, _ = await create_project(env)
            assert first["project_reference"] == first["reference"]
            # A different canonical customer with the same normalized phone is
            # still a possible duplicate, never silently merged.
            second_customer = str(uuid4())
            await env["db"].customers.insert_one({"id": second_customer, "name": "Second canonical customer",
                "phone": "+91 99000 00031", "floor_id": "second-floor"})
            second, _ = await create_project(env, customer_id=second_customer, lead={"site_location": "Another site"})
            assert second["customer_id"] == second_customer and second["duplicate_review"]["status"] == "pending"
            assert first["id"] in second["duplicate_review"]["candidate_ids"]
            queue = await env["api"].get("/api/kitchen-projects?duplicate_review=pending", headers=headers(env))
            assert queue.status_code == 200 and second["id"] in {r["id"] for r in queue.json()["rows"]}
            # Delegated staff see work without assignment; selected managers
            # do not inherit owner exception or duplicate decision authority.
            managed = await env["api"].get(f"/api/kitchen-projects/{second['id']}", headers=headers(env, "manager"))
            assert managed.status_code == 200 and not managed.json()["permissions"]["can_assign"]
            worker_read = await env["api"].get(f"/api/kitchen-projects/{second['id']}", headers=headers(env, "worker"))
            assert worker_read.status_code == 200 and "candidate_ids" not in worker_read.json()["duplicate_review"]
            assert "candidate_ids" not in json.dumps(worker_read.json()["activity"])
            assert not worker_read.json()["permissions"]["can_review_duplicate"]
            for actor in ("worker", "manager"):
                denied = await command(env, second, "review_duplicate", {"decision": "distinct_project", "reason": "Not owner"}, actor=actor)
                assert denied.status_code == 403
            blocked = await command(env, second, "convert")
            assert blocked.status_code == 422
            second = await accepted(env, second, "review_duplicate", {"decision": "distinct_project", "reason": "Owner reviewed separate address"})
            second = await accepted(env, second, "convert")
            assert second["stage"] == "visit" and second["project_reference"] == second["reference"]
            third, _ = await create_project(env)
            third = await accepted(env, third, "review_duplicate", {"decision": "duplicate", "reason": "Owner confirmed duplicate intake"})
            assert third["lead"]["status"] == "Lost" and third["lead"]["lost_reason"] == "Owner confirmed duplicate intake"
            assert (await command(env, third, "convert")).status_code == 422
            assert await env["db"].kitchen_projects.count_documents({}) == 3
            assert await env["db"].customers.find_one({"id": env["ids"]["customer"]}) == {**original, "kitchen_reference_reserved": True}
    asyncio.run(run())


def test_resolved_d05_cad_readiness_is_derived_and_all_three_prerequisites_are_mandatory():
    async def run():
        async with environment() as env:
            await configure(env)
            project = await reach_stage(env, "cad")
            for fields in ({"received": False, "progress": 100, "status": "Completed", "ready": True},
                           {"received": True, "progress": 99, "status": "Completed", "ready": True}):
                project = await accepted(env, project, "save_cad", fields)
                assert project["cad"]["ready"] is False
                assert (await command(env, project, "advance_stage", {"target_stage": "design"})).status_code == 422
            project = await accepted(env, project, "save_cad", {"received": True, "progress": 100, "status": "In Progress", "ready": False})
            assert project["cad"]["ready"] is True  # No contradictory extra readiness gate.
            project = await accepted(env, project, "advance_stage", {"target_stage": "design"})
            assert project["stage"] == "design"
    asyncio.run(run())


def test_resolved_d06_late_design_return_requires_owner_reason_and_renews_full_commercial_authority():
    import copy
    async def run():
        async with environment() as env:
            await configure(env)
            project = await reach_stage(env, "installation")
            project = await accepted(env, project, "installation_update", {"status": "In Progress", "start_date": "2026-10-20"})
            project = await accepted(env, project, "site_visit", {"actual": True, "date": "2026-10-20"})
            history = {key: copy.deepcopy(project[key]) for key in ("design_versions", "quotation_versions", "orders", "approvals", "production", "installation", "site_visits")}
            for command_name, payload in (("exception", {"action": "return_to_design", "reason": "Customer changed cabinets"}),
                                          ("order_status", {"status": "On Hold", "reason": "Wait"}),
                                          ("order_status", {"status": "Cancelled", "reason": "Cancel"})):
                before = await env["db"].kitchen_projects.find_one({"id": project["id"]})
                denied = await command(env, project, command_name, payload, actor="manager")
                assert denied.status_code == 403
                assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == before
            for payload in ({"action": "return_to_design", "reason": ""}, {"action": "return_to_design"}):
                assert (await command(env, project, "exception", payload)).status_code == 422
            project = await accepted(env, project, "exception", {"action": "return_to_design", "reason": "Owner authorized changed cabinets"})
            assert project["stage"] == "design" and project["commercial_basis_invalidated"]
            assert project["status"] == "Pending"
            listed = await env["api"].get("/api/kitchen-projects?stage=design&status=Pending", headers=headers(env))
            assert project["id"] in {row["id"] for row in listed.json()["rows"]}
            assert project["design_versions"] == history["design_versions"]
            assert project["quotation_versions"] == history["quotation_versions"]
            assert project["orders"][0]["original_amount"] == history["orders"][0]["original_amount"]
            assert project["orders"][0]["authorization_invalidated"] is True
            assert project["approvals"] == history["approvals"] and project["site_visits"] == history["site_visits"]
            assert project["work_history"][-1]["production"] == history["production"]
            assert project["work_history"][-1]["installation"] == history["installation"]
            assert project["production"]["status"] == project["installation"]["status"] == "Not Started"
            assert (await command(env, project, "advance_stage", {"target_stage": "quotation"})).status_code == 422
            project = await accepted(env, project, "design_present", {"url": "https://example.test/synthetic-design.pdf", "presentation_date": "2026-10-21"})
            design = project["design_versions"][-1]["id"]
            project = await accepted(env, project, "design_share", {"version_id": design, "date": "2026-10-21"})
            project = await accepted(env, project, "design_response", {"version_id": design, "response": "Approved", "approval_date": "2026-10-21"})
            project = await accepted(env, project, "design_handoff", {"version_id": design, "date": "2026-10-21"})
            project = await accepted(env, project, "advance_stage", {"target_stage": "quotation"})
            assert project["status"] == "Pending"
            assert (await command(env, project, "advance_stage", {"target_stage": "order"})).status_code == 422
            project = await accepted(env, project, "quotation_receive", {"url": "https://example.test/synthetic-quotation.pdf", "design_version_id": design, "received_date": "2026-10-21", "amount": "2000.02"})
            quote = project["quotation_versions"][-1]["id"]
            assert project["quotation_versions"][-1]["response"] == "Pending"
            project = await accepted(env, project, "quotation_share", {"version_id": quote, "date": "2026-10-21"})
            project = await accepted(env, project, "quotation_response", {"version_id": quote, "response": "Approved"})
            project = await accepted(env, project, "advance_stage", {"target_stage": "order"})
            assert project["status"] == "Pending"
            assert (await command(env, project, "advance_stage", {"target_stage": "production"})).status_code == 422
            project = await accepted(env, project, "order_confirm", {"quotation_version_id": quote, "order_date": "2026-10-21"})
            assert len(project["orders"]) == 2 and project["orders"][0]["original_amount"] == "1000.01"
            assert project["orders"][1]["original_amount"] == "2000.02" and not project["commercial_basis_invalidated"]
            assert (await command(env, project, "advance_stage", {"target_stage": "production"})).status_code == 422
            project = await accepted(env, project, "order_advance", {"received": True, "amount": "0.01", "date": "2026-10-21"})
            assert (await command(env, project, "advance_stage", {"target_stage": "production"})).status_code == 422
            project = await accepted(env, project, "approval", {"scope": "production", "decision": "Approved"}, actor="manager")
            project = await accepted(env, project, "advance_stage", {"target_stage": "production"})
            assert project["stage"] == "production" and project["site_visit_count"] == 1
            assert any(a["type"] == "exception" and a["actor_id"] == env["ids"]["owner"] for a in project["activity"])
    asyncio.run(run())


def test_resolved_d09_legacy_unknown_counts_remain_null_after_new_events_and_export():
    import csv
    import io
    async def run():
        async with environment() as env:
            await configure(env)
            project = await reach_stage(env, "installation")
            await env["db"].kitchen_projects.update_one({"id": project["id"]}, {"$set": {
                "is_legacy": True, "source_reference": "Notebook row 17", "project_reference": None, "design_revision_count": None,
                "site_visit_count": None, "known_design_revision_count": 0, "known_site_visit_count": 0,
                "lead.lead_date": None, "legacy_data": {"historical_counts_known": False}}})
            project = (await env["api"].get(f"/api/kitchen-projects/{project['id']}", headers=headers(env))).json()
            assert project["site_visit_count"] is None and project["design_revision_count"] is None
            assert project["lead"]["lead_date"] is None and project["source_reference"] == "Notebook row 17"
            assert project["project_reference"] == project["reference"]
            project = await accepted(env, project, "site_visit", {"actual": True, "date": "2026-10-20"})
            assert project["site_visit_count"] is None and project["known_site_visit_count"] == 1
            project = await accepted(env, project, "installation_update", {"status": "Completed", "start_date": "2026-10-20", "completion_date": "2026-10-21"})
            project = await accepted(env, project, "approval", {"scope": "closure", "decision": "Approved"}, actor="manager")
            page = await env["api"].get("/api/kitchen-projects?completed=true", headers=headers(env))
            row = next(r for r in page.json()["rows"] if r["id"] == project["id"])
            assert row["site_visit_count"] is None and row["design_revision_count"] is None
            exported = await env["api"].get("/api/kitchen-projects/export", headers=headers(env))
            record = next(csv.DictReader(io.StringIO(exported.text.lstrip('\ufeff'))))
            assert record["Design revisions"] == record["Actual site visits"] == "Historical count unavailable"
            for forbidden in ({"is_legacy": True}, {"source_reference": "Invented source"}, {"site_visit_count": None}):
                response = await env["api"].post("/api/kitchen-projects", headers=headers(env), json={
                    "customer_id": env["ids"]["customer"], "idempotency_key": str(uuid4()), "lead": {"site_location": "Synthetic"}, **forbidden})
                assert response.status_code == 422
    asyncio.run(run())


def test_cad_formats_rejected_but_pdf_uploads_allowed_with_history_preserved(monkeypatch):
    import hashlib
    from media_storage import factory
    class HistoryStorage:
        calls = 0
        async def require_private_bucket(self, bucket):
            assert bucket == "forge-private"
        objects = {}
        async def download(self, **kwargs):
            return self.objects.get(kwargs["key"], b"AC1032 historical drawing bytes")
        async def exists(self, **kwargs):
            self.calls += 1
            return kwargs["key"] in self.objects
        async def upload(self, *, key, data, **kwargs):
            self.objects[key] = data
    storage = HistoryStorage()
    monkeypatch.setattr(factory, "get_media_storage", lambda: storage)
    async def run():
        async with environment() as env:
            project, _ = await create_project(env)
            route = f"/api/kitchen-projects/{project['id']}"
            snapshot = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            for filename, mime in (("drawing.dwg", "image/vnd.dwg"), ("drawing.dxf", "image/vnd.dxf"),
                                    ("drawing.DWG", "application/octet-stream"), ("drawing.dxf", "application/octet-stream"),
                                    ("drawing.dwg", "application/pdf"), ("drawing.pdf", "application/acad"),
                                    ("drawing.pdf", "application/x-dxf")):
                ordinary = await env["api"].post(route + "/attachments", headers=headers(env),
                    data={"expected_version": str(project["version"]), "idempotency_key": str(uuid4())},
                    files={"file": (filename, b"AC1032" + b"x" * 94, mime)})
                chunked = await env["api"].post(route + "/file-transfers", headers=headers(env),
                    json={"expected_version": project["version"], "idempotency_key": str(uuid4()),
                          "filename": filename, "content_type": mime, "size_bytes": 100})
                assert ordinary.status_code == chunked.status_code == 415, (ordinary.text, chunked.text)
            assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == snapshot
            assert await env["db"].kitchen_file_transfers.count_documents({}) == 0
            # An unfinished pre-change transfer cannot continue sending CAD
            # parts or publish a new attachment after the format is retired.
            from datetime import datetime, timedelta, timezone
            transfer_id = str(uuid4())
            await env["db"].kitchen_file_transfers.insert_one({"_id": env["ids"]["owner"], "project_id": project["id"],
                "transfer_id": transfer_id, "filename": "staged.dwg", "content_type": "image/vnd.dwg", "state": "open",
                "size_bytes": 1, "expires_at": datetime.now(timezone.utc) + timedelta(hours=1)})
            root = route + "/file-transfers/" + transfer_id
            part = await env["api"].put(root + "/parts/0", headers=headers(env), json={"data_base64": "eA=="})
            finish = await env["api"].post(root + "/finish", headers=headers(env), json={"expected_version": project["version"]})
            assert part.status_code == finish.status_code == 415
            assert await env["db"].kitchen_file_parts.count_documents({}) == 0
            await env["db"].kitchen_file_transfers.delete_many({})
            project = await reach_stage(env, "cad")
            route = f"/api/kitchen-projects/{project['id']}"
            historical = {"id": "historical-cad", "filename": "earlier.dwg", "content_type": "image/vnd.dwg",
                          "bucket": "forge-private", "storage_key": "old-private-object",
                          "sha256": hashlib.sha256(b"AC1032 historical drawing bytes").hexdigest(), "size_bytes": 30}
            await env["db"].kitchen_projects.update_one({"id": project["id"]}, {"$set": {"attachments": [historical]}})
            saved = (await env["api"].get(route, headers=headers(env))).json()
            assert saved["attachments"][0]["filename"] == "earlier.dwg" and "storage_key" not in saved["attachments"][0]
            download = await env["api"].get(route + "/attachments/historical-cad", headers=headers(env))
            assert download.status_code == 200 and download.content == b"AC1032 historical drawing bytes"
            ordinary = await env["api"].post(route + "/attachments", headers=headers(env),
                data={"expected_version": str(project["version"]), "idempotency_key": str(uuid4())},
                files={"file": ("new.pdf", b"%PDF-1.4 synthetic", "application/pdf")})
            chunked = await env["api"].post(route + "/file-transfers", headers=headers(env),
                json={"expected_version": project["version"], "idempotency_key": str(uuid4()),
                      "filename": "new.pdf", "content_type": "application/pdf", "size_bytes": 100})
            assert ordinary.status_code == 200, ordinary.text
            assert ordinary.json()["stage"] == "cad"
            assert ordinary.json()["attachments"][0]["filename"] == "earlier.dwg"
            # A stale begin remains rejected after the successful append.
            assert chunked.status_code == 409
            chunked = await env["api"].post(route + "/file-transfers", headers=headers(env),
                json={"expected_version": ordinary.json()["version"], "idempotency_key": str(uuid4()),
                      "filename": "new.pdf", "content_type": "application/octet-stream", "size_bytes": 100})
            assert chunked.status_code == 200, chunked.text
            assert storage.calls == 1
    asyncio.run(run())


def test_resolved_d10_all_formats_private_roundtrip_and_rejected_content_leave_no_success(monkeypatch, tmp_path):
    import io
    import zipfile
    import struct
    from media_storage import factory
    binary_dxf = b"AutoCAD Binary DXF\r\n\x1a\x00" + b"".join(struct.pack("<H", code) + value + b"\0"
        for code, value in ((0, b"SECTION"), (2, b"HEADER"), (9, b"$ACADVER"), (1, b"AC1032"), (0, b"ENDSEC"), (0, b"EOF")))
    class OwnedStorage:
        async def require_private_bucket(self, bucket):
            assert bucket == "forge-private"
        async def exists(self, *, bucket, key):
            return (tmp_path / key).is_file()
        async def upload(self, *, bucket, key, data, **kwargs):
            assert kwargs["upsert"] is False and kwargs["cache_control"] == "private, no-store"
            destination = tmp_path / key
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        async def download(self, *, bucket, key):
            return (tmp_path / key).read_bytes()
    monkeypatch.setattr(factory, "get_media_storage", lambda: OwnedStorage())
    def office(ext, print_settings=False):
        part, root, ns, kind = (("word/document.xml", "document", "http://schemas.openxmlformats.org/wordprocessingml/2006/main", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")
            if ext == "docx" else ("xl/workbook.xml", "workbook", "http://schemas.openxmlformats.org/spreadsheetml/2006/main", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"))
        result = io.BytesIO()
        with zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as package:
            package.writestr("[Content_Types].xml", f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/{part}" ContentType="{kind}"/></Types>')
            package.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
            package.writestr(part, f'<{root} xmlns="{ns}"/>')
        if print_settings:
            source = zipfile.ZipFile(io.BytesIO(result.getvalue()))
            values = {name: source.read(name) for name in source.namelist()}
            source.close()
            settings_mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"
            values["[Content_Types].xml"] = values["[Content_Types].xml"].replace(b"</Types>", f'<Default Extension="bin" ContentType="{settings_mime}"/></Types>'.encode())
            devmode = bytearray(220)
            struct.pack_into("<HH", devmode, 68, 220, 0)
            values["xl/printerSettings/printerSettings1.bin"] = bytes(devmode)
            result = io.BytesIO()
            with zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as package:
                for name, content in values.items():
                    package.writestr(name, content)
        return result.getvalue()
    async def run():
        async with environment() as env:
            await configure(env)
            project, _ = await create_project(env)
            route = f"/api/kitchen-projects/{project['id']}/attachments"
            for filename, mime, content in [
                ("synthetic.pdf", "application/pdf", b"%PDF-1.4\nSynthetic"),
                ("synthetic.jpg", "image/jpeg", b"\xff\xd8\xff\xe0Synthetic"),
                ("synthetic.png", "image/png", b"\x89PNG\r\n\x1a\nSynthetic"),
                ("synthetic.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", office("docx")),
                ("synthetic.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", office("xlsx")),
                ("print-settings.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", office("xlsx", print_settings=True)),
            ]:
                response = await env["api"].post(route, headers=headers(env), data={
                    "expected_version": str(project["version"]), "idempotency_key": str(uuid4())},
                    files={"file": (filename, content, mime)})
                assert response.status_code == 200, (filename, response.text)
                project = response.json()
                attachment = project["attachments"][-1]
                assert attachment["filename"] == filename and attachment["uploaded_by"] == env["ids"]["owner"]
                assert "storage_key" not in attachment and "bucket" not in attachment
                download = await env["api"].get(f"{route}/{attachment['id']}", headers=headers(env))
                assert download.status_code == 200 and download.content == content
                assert download.headers["cache-control"] == "no-store"
                hidden = await env["api"].get(f"{route}/{attachment['id']}", headers=headers(env, "denied"))
                assert hidden.status_code == 403
            assert len(project["attachments"]) == 6
            before = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            for filename, mime, content, code in [
                ("malformed.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", b"PK\x03\x04broken", 415),
                ("forged.dwg", "image/vnd.dwg", b"MZ" + b"\0" * 100, 415),
                ("incomplete.dxf", "image/vnd.dxf", b"0\nSECTION\n0\nENDSEC\n", 415),
                ("truncated-binary.dxf", "image/vnd.dxf", binary_dxf[:-1], 415),
                ("oversized.pdf", "application/pdf", b"%PDF-1.4" + b"\0" * (768 * 1024), 413),
            ]:
                failed = await env["api"].post(route, headers=headers(env), data={
                    "expected_version": str(project["version"]), "idempotency_key": str(uuid4())},
                    files={"file": (filename, content, mime)})
                assert failed.status_code == code, (filename, failed.text)
                assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == before
            deleted = await env["api"].delete(f"{route}/{project['attachments'][0]['id']}", headers=headers(env))
            assert deleted.status_code == 405
            assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == before
    asyncio.run(run())


def test_resolved_d09_migration_preview_real_mongo_is_repeatable_preserves_sources_and_never_imports():
    from scripts.kitchen_reconciliation import preview
    async def run():
        async with environment() as env:
            rows = [
                {"id": "source-unknown", "floor_id": "second-floor", "customer_id": env["ids"]["customer"],
                 "reference": "NOTEBOOK-17", "status": "won", "created_at": "2026-10-19T12:00:00Z",
                 "notes": "SHOULD_NOT_APPEAR", "phone": "SHOULD_NOT_APPEAR", "name": "SHOULD_NOT_APPEAR"},
                {"id": "source-known", "floor_id": "second-floor", "customer_id": env["ids"]["customer"],
                 "reference": "NOTEBOOK-18", "visit_date": "2026-01-02", "completion_date": "invalid",
                 "order_amount": "125.10", "design_revision_count": 3, "site_visit_count": 0},
                {"id": "other-floor", "floor_id": "first-floor", "customer_id": env["ids"]["other_customer"]},
            ]
            await env["db"].followups.insert_many(rows)
            before = await env["db"].followups.find({}).sort("id", 1).to_list(10)
            original_customers = await env["db"].customers.find({}).sort("id", 1).to_list(10)
            first = await preview(env["db"])
            second = await preview(env["db"])
            assert first == second and first["mode"] == "read_only_migration_preview"
            assert not first["migration_applied"] and not first["import_authorized"]
            assert first["summary"]["source_rows"] == 2 and first["summary"]["stage_mapped"] == 0
            assert "SHOULD_NOT_APPEAR" not in json.dumps(first)
            unknown = next(r for r in first["rows"] if r["source_id"] == "source-unknown")
            assert unknown["source_key"] == "followups:source-unknown" and unknown["source_reference"] == "NOTEBOOK-17"
            candidate = unknown["candidate"]
            assert candidate["is_legacy"] and candidate["stage"] is None
            assert all(value is None for value in candidate["dates"].values())
            assert candidate["design_revision_count"] is None and candidate["site_visit_count"] is None
            mapped = await preview(env["db"], {"entries": {"followups:source-known": {
                "stage": "visit", "evidence": "Synthetic owner source review proves showroom visit only",
                "counter_evidence": {"design_revision_count": "Synthetic source ledger proves three requests"}}}})
            known = next(r for r in mapped["rows"] if r["source_id"] == "source-known")
            assert known["candidate"]["stage"] == "visit" and known["candidate"]["design_revision_count"] == 3
            assert known["candidate"]["site_visit_count"] is None  # Raw zero alone is not historical proof.
            assert known["candidate"]["dates"]["visit_date"] == "2026-01-02"
            assert known["candidate"]["dates"]["completion_date"] is None
            assert known["candidate"]["known_order_amount"] == "125.10"
            assert "unverified" in known["candidate"]["order_confirmation"]
            assert "historical_site_visit_count_unavailable" in known["unresolved_codes"]
            assert mapped["source_fingerprint"] == first["source_fingerprint"]
            assert mapped["mapping_fingerprint"] != first["mapping_fingerprint"]
            assert await env["db"].kitchen_projects.count_documents({}) == 0
            assert await env["db"].followups.find({}).sort("id", 1).to_list(10) == before
            assert await env["db"].customers.find({}).sort("id", 1).to_list(10) == original_customers
    asyncio.run(run())


def test_resolved_d07_active_order_value_uses_current_confirmed_basis_and_grant_scope_once():
    async def run():
        async with environment() as env:
            await configure(env)
            project = await reach_stage(env, "order")
            async def metrics(actor="owner"):
                response = await env["api"].get("/api/kitchen-projects/dashboard", headers=headers(env, actor))
                assert response.status_code == 200
                return response.json()
            assert (await metrics())["active_order_value"] == "1000.01"
            project = await accepted(env, project, "order_amend", {"amount": "1500.03", "customer_approved": True,
                "reason": "Owner authorized customer-approved terms", "date": "2026-10-19"})
            assert (await metrics())["active_order_value"] == "1500.03"  # One current amount, not original + amendment.
            project = await accepted(env, project, "order_status", {"status": "On Hold", "reason": "Owner wait"})
            held = await metrics()
            assert held["active_projects"] == 0 and held["on_hold_projects"] == 1 and held["active_order_value"] == "0.00"
            project = await accepted(env, project, "order_status", {"status": "Confirmed", "reason": "Owner resumed"})
            assert (await metrics())["active_order_value"] == "1500.03"
            project = await accepted(env, project, "exception", {"action": "return_to_design", "reason": "Owner approved design change"})
            assert (await metrics())["active_order_value"] == "0.00"  # Historical confirmed order cannot remain current value.
            # Kitchen grants cover the workspace throughout its lifecycle.
            other = await reach_stage(env, "order")
            own = await metrics("worker")
            assert own["active_projects"] == 2 and own["active_order_value"] == "1000.01"
            all_rows = await metrics("manager")
            assert all_rows["active_projects"] == 2 and all_rows["active_order_value"] == "1000.01"
            direct = await env["api"].get(f"/api/kitchen-projects/{other['id']}", headers=headers(env, "worker"))
            assert direct.status_code == 200
    asyncio.run(run())


def test_delegated_stage_updates_and_upload_cas_survive_assignment_retirement(monkeypatch):
    from media_storage import factory
    class OwnedStorage:
        calls = 0
        hold = False
        objects = {}
        async def require_private_bucket(self, bucket):
            self.calls += 1
            assert bucket == "forge-private"
        async def exists(self, *, bucket, key):
            return key in self.objects
        async def upload(self, *, bucket, key, data, **kwargs):
            self.calls += 1
            if self.hold:
                self.started.set()
                await self.release.wait()
            self.objects[key] = data
        async def download(self, *, bucket, key):
            return self.objects[key]
    storage = OwnedStorage()
    monkeypatch.setattr(factory, "get_media_storage", lambda: storage)
    async def run():
        async with environment() as env:
            await configure(env)
            project, _ = await create_project(env)
            original_lead = project
            conversion_key = str(uuid4())
            project = await accepted(env, project, "convert", key=conversion_key, actor="worker")
            replay = await command(env, original_lead, "convert", key=conversion_key, actor="worker")
            assert replay.status_code == 200 and replay.json()["version"] == project["version"] and replay.json()["replayed"]
            route = f"/api/kitchen-projects/{project['id']}"
            history = await env["api"].get(route, headers=headers(env, "worker"))
            assert history.status_code == 200 and history.json()["permissions"]["can_update"]
            project = await accepted(env, project, "save_visit", {"status": "Visited", "requirements": "Own task", "interested": True}, actor="worker")
            assert project["permissions"]["can_update"]
            uploaded = await env["api"].post(f"{route}/attachments", headers=headers(env, "worker"),
                data={"expected_version": str(project["version"]), "idempotency_key": str(uuid4())},
                files={"file": ("own-task.pdf", b"%PDF-1.4\nOwn synthetic file", "application/pdf")})
            assert uploaded.status_code == 200, uploaded.text
            project = uploaded.json()
            storage.hold = True
            storage.started, storage.release = asyncio.Event(), asyncio.Event()
            pending = asyncio.create_task(env["api"].post(f"{route}/attachments", headers=headers(env, "worker"),
                data={"expected_version": str(project["version"]), "idempotency_key": str(uuid4())},
                files={"file": ("revoked-task.pdf", b"%PDF-1.4\nRevoked while upload pending", "application/pdf")}))
            try:
                await asyncio.wait_for(storage.started.wait(), timeout=3)
                project = await accepted(env, project, "metadata", {"target_completion_date": "2026-10-23"})
            finally:
                storage.release.set()
                result = await pending
            assert result.status_code in {403, 409}, result.text
            stored = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            assert len(stored["attachments"]) == 1
            assert (await env["api"].get(route, headers=headers(env, "worker"))).status_code == 200
    asyncio.run(run())


def test_design_and_quotation_require_pdf_and_final_selection_but_not_amount():
    async def run():
        async with environment() as env:
            for stage, name in (("design", "design_present"), ("quotation", "quotation_receive")):
                project = await reach_stage(env, stage)
                payload = {} if stage == "design" else {"design_version_id": project["final_design_version_id"]}
                before = await env["db"].kitchen_projects.find_one({"id": project["id"]})
                rejected = await command(env, project, name, payload)
                assert rejected.status_code == 422
                assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == before
                project = await accepted(env, project, name, payload)
                row = project["design_versions" if stage == "design" else "quotation_versions"][-1]
                assert row["final_attachment_id"] == row["attachment_id"]
                assert row["upload_date"] == "2026-10-19"
                if stage == "quotation":
                    assert row["amount"] is None
    asyncio.run(run())


def test_attention_drilldowns_share_metrics_dates_approval_subjects_and_role_scope(monkeypatch):
    """A count must open the same authorized records, including stale approvals."""
    import copy
    from datetime import datetime, timezone
    from services import kitchen_projects

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 10, 19, 20, 0, tzinfo=timezone.utc).astimezone(tz)

    monkeypatch.setattr(kitchen_projects, "datetime", Clock)

    async def run():
        async with environment() as env:
            policy = await configure(env)
            project, _ = await create_project(env)
            template = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            await env["db"].kitchen_projects.delete_many({})
            fixtures = []
            for index, (stage, deadline, target, assignment, decision) in enumerate([
                ("lead", "2026-10-20T01:00:00+05:30", None, "worker", None),  # 19:30 UTC, overdue
                ("lead", "2026-10-19T19:30:00-01:00", None, "worker", None),  # 20:30 UTC, not overdue
                ("lead", "invalid legacy date", None, "worker", None),
                ("order", None, "2026-10-19", "worker", {"subject_id": "old", "decision": "Approved"}),
                ("installation", None, None, None, {"subject_id": "current", "decision": "Approved", "policy_version": -1}),
                ("order", None, None, None, {"subject_id": "current", "decision": "Approved", "policy_version": policy["version"]}),
                ("order", None, None, None, None),
            ]):
                row = copy.deepcopy(template)
                row.pop("_id", None)
                row.update(id=f"attention-{index}", reference=f"ATTENTION-{index}", stage=stage,
                    deadline=deadline, target_completion_date=target, assigned_to=env["ids"][assignment] if assignment else None,
                    assigned_to_name=f"Synthetic {assignment}" if assignment else None,
                    assignments={stage: env["ids"][assignment]} if assignment else {})
                scope = "closure" if stage == "installation" else "production"
                row["approval_subjects"] = {scope: "current"} if index in {3, 4, 5} else {}
                row["approval_decisions"] = {scope: {"policy_version": policy["version"], **decision}} if decision else {}
                fixtures.append(row)
            # An inaccessible floor can never enter counts, even for the owner.
            hidden = copy.deepcopy(fixtures[0])
            hidden.update(id="other-floor", reference="OTHER-FLOOR", floor_id="first-floor")
            await env["db"].kitchen_projects.insert_many([*fixtures, hidden])
            for actor, active, pending in (("owner", 7, 2), ("manager", 7, 2), ("worker", 7, 2)):
                response = await env["api"].get("/api/kitchen-projects/dashboard", headers=headers(env, actor))
                assert response.status_code == 200, response.text
                metrics = response.json()
                assert metrics["active_projects"] == active
                assert metrics["pending_approvals"] == pending
                assert metrics["next_action_overdue_projects"] == 0
                assert metrics["completion_overdue_projects"] == 1
                for attention, expected in (("active", active), ("pending_approval", pending),
                        ("next_action_overdue", 0), ("completion_overdue", 1), ("active_order", 0), ("on_hold", 0)):
                    listed = await env["api"].get(f"/api/kitchen-projects?attention={attention}", headers=headers(env, actor))
                    assert listed.status_code == 200, listed.text
                    assert listed.json()["total"] == expected, (actor, attention)
                    assert "other-floor" not in [row["id"] for row in listed.json()["rows"]]
                assert sum(metrics["stage_counts"].values()) == active
                assert sum(row["project_count"] for row in metrics["workload"]) == active
            unassigned = await env["api"].get("/api/kitchen-projects?attention=active&assignee=unassigned", headers=headers(env))
            assert unassigned.status_code == 200 and unassigned.json()["total"] == 3
            denied = await env["api"].get("/api/kitchen-projects?attention=active", headers=headers(env, "denied"))
            assert denied.status_code == 403
            anonymous = await env["api"].get("/api/kitchen-projects?attention=active")
            assert anonymous.status_code == 401
    asyncio.run(run())


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="Run-owned Kitchen browser acceptance API")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    options = parser.parse_args()

    @asynccontextmanager
    async def lifespan(app):
        # Test-only real local bytes; never contacts a configured cloud provider.
        from media_storage import factory
        import re
        directory = options.manifest.parent / "private-bytes"
        directory.mkdir(mode=0o700)
        class PilotPrivateStorage:
            async def require_private_bucket(self, bucket):
                if bucket != "forge-private":
                    raise ValueError("Synthetic private bucket required")
            def path(self, bucket, key):
                if bucket != "forge-private" or not re.fullmatch(r"kitchen/second-floor/[a-f0-9-]{36}/[a-f0-9]{64}", key):
                    raise ValueError("Unexpected synthetic private object identity")
                return directory / key
            async def exists(self, *, bucket, key):
                return self.path(bucket, key).is_file()
            async def upload(self, *, bucket, key, data, **kwargs):
                path = self.path(bucket, key)
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(data)
            async def download(self, *, bucket, key):
                return self.path(bucket, key).read_bytes()
        original_storage = factory.get_media_storage
        factory.get_media_storage = lambda: PilotPrivateStorage()
        async with environment() as env:
            await configure(env)  # Test-only browser/pilot identities, never production configuration.
            legacy, _ = await create_project(env, lead={"site_location": "Synthetic legacy site"})
            await env["db"].kitchen_projects.update_one({"id": legacy["id"]}, {"$set": {
                "stage": "completed", "status": "Completed", "completion_date": None,
                "is_legacy": True, "source_reference": "SYNTHETIC-NOTEBOOK-17", "project_reference": None,
                "design_revision_count": None, "site_visit_count": None,
                "known_design_revision_count": 0, "known_site_visit_count": 0, "lead.lead_date": None,
                "installation": {"status": "Completed", "start_date": None, "completion_date": None, "notes": None},
                "legacy_data": {"historical_counts_known": False}}})
            app.mount("/", env["app"])
            payload = {"token": env["tokens"]["owner"], "second_token": env["tokens"]["owner_second"], "customer_id": env["ids"]["customer"],
                       "worker_id": env["ids"]["worker"], "manager_id": env["ids"]["manager"], "manager_token": env["tokens"]["manager"], "worker_token": env["tokens"]["worker"], "denied_token": env["tokens"]["denied"], "legacy_project_id": legacy["id"], "database": env["db"].name}
            options.manifest.write_text(json.dumps(payload))
            options.manifest.chmod(0o600)
            try:
                yield
            finally:
                factory.get_media_storage = original_storage

    uvicorn.run(FastAPI(lifespan=lifespan), host="127.0.0.1", port=options.port, access_log=False, log_level="warning")


def test_10mb_pdf_transfer_boundary_retry_integrity_and_bounded_download(monkeypatch):
    import base64
    import hashlib
    from media_storage import factory
    from services.kitchen_file_transfers import CHUNK_BYTES
    from services.kitchen_attachments import MAX_PDF_UPLOAD_BYTES

    class PrivateBytes:
        def __init__(self):
            self.objects = {}
            self.uploads = self.reads = 0
        async def require_private_bucket(self, bucket):
            assert bucket == 'forge-private'
        async def exists(self, *, bucket, key):
            return key in self.objects
        async def upload(self, *, bucket, key, data, **kwargs):
            assert kwargs['upsert'] is False
            self.uploads += 1
            self.objects[key] = data
        async def download(self, *, bucket, key):
            self.reads += 1
            return self.objects[key]
    storage = PrivateBytes()
    monkeypatch.setattr(factory, 'get_media_storage', lambda: storage)

    async def run():
        async with environment() as env:
            await configure(env)
            project, _ = await create_project(env)
            path = f"/api/kitchen-projects/{project['id']}"
            content = b'%PDF-1' + b'Synthetic private PDF bytes ' * ((MAX_PDF_UPLOAD_BYTES // 28) + 10)
            content = (content + b'x' * MAX_PDF_UPLOAD_BYTES)[:MAX_PDF_UPLOAD_BYTES]
            checksum = hashlib.sha256(content).hexdigest()
            key = str(uuid4())
            body = {'expected_version': project['version'], 'idempotency_key': key, 'filename': 'synthetic-10mb.pdf',
                    'content_type': 'application/pdf', 'size_bytes': len(content), 'sha256': checksum}
            oversize = await env['api'].post(path + '/file-transfers', headers=headers(env), json={**body, 'size_bytes': MAX_PDF_UPLOAD_BYTES + 1})
            assert oversize.status_code == 413
            denied = await env['api'].post(path + '/file-transfers', headers=headers(env, 'denied'), json=body)
            assert denied.status_code == 403
            ordinary = await env['api'].post(path + '/attachments', headers=headers(env), data={'expected_version': str(project['version']), 'idempotency_key': str(uuid4())},
                files={'file': ('large.pdf', content[:800000], 'application/pdf')})
            assert ordinary.status_code == 413  # ordinary request limit did not grow
            started = await env['api'].post(path + '/file-transfers', headers=headers(env), json=body)
            assert started.status_code == 200, started.text
            transfer = started.json()
            assert transfer['chunk_bytes'] == CHUNK_BYTES
            root = path + '/file-transfers/' + transfer['transfer_id']
            incomplete = await env['api'].post(root + '/finish', headers=headers(env), json={'expected_version': project['version']})
            assert incomplete.status_code == 409
            assert storage.uploads == 0
            # Resume with a new browser command key but the same original checksum.
            resumed = await env['api'].post(path + '/file-transfers', headers=headers(env), json={**body, 'idempotency_key': str(uuid4())})
            assert resumed.json()['transfer_id'] == transfer['transfer_id']
            for index in range(transfer['part_count']):
                part = content[index * CHUNK_BYTES:(index + 1) * CHUNK_BYTES]
                response = await env['api'].put(root + f'/parts/{index}', headers=headers(env), json={'data_base64': base64.b64encode(part).decode()})
                assert response.status_code == 200, response.text
                if index == 0:
                    retried = await env['api'].put(root + '/parts/0', headers=headers(env), json={'data_base64': base64.b64encode(part).decode()})
                    assert retried.status_code == 200
                    changed = await env['api'].put(root + '/parts/0', headers=headers(env), json={'data_base64': base64.b64encode(b'z' * len(part)).decode()})
                    assert changed.status_code == 409
            stale = await env['api'].post(root + '/finish', headers=headers(env), json={'expected_version': project['version'] + 1})
            assert stale.status_code == 409 and storage.uploads == 0
            saved = await env['api'].post(root + '/finish', headers=headers(env), json={'expected_version': project['version']})
            assert saved.status_code == 200, saved.text
            final = saved.json()
            assert final['version'] == project['version'] + 1 and len(final['attachments']) == 1
            attachment = final['attachments'][0]
            assert attachment['size_bytes'] == MAX_PDF_UPLOAD_BYTES and attachment['sha256'] == checksum
            assert storage.uploads == 1
            replay = await env['api'].post(root + '/finish', headers=headers(env), json={'expected_version': project['version']})
            assert replay.status_code == 200 and replay.json()['version'] == final['version']
            assert storage.uploads == 1
            assert await env['db'].kitchen_file_parts.count_documents({}) == 0
            cancel = await env['api'].delete(root, headers=headers(env))
            assert cancel.status_code == 409 and len(storage.objects) == 1
            downloaded = bytearray()
            for index in range(transfer['part_count']):
                response = await env['api'].get(path + f"/attachments/{attachment['id']}/parts/{index}", headers=headers(env))
                assert response.status_code == 200
                assert len(response.content) < 1024 * 1024
                value = response.json()
                part = base64.b64decode(value['data_base64'])
                assert hashlib.sha256(part).hexdigest() == value['sha256']
                downloaded.extend(part)
            assert hashlib.sha256(downloaded).hexdigest() == checksum
            assert storage.reads == 1  # bounded immutable cache avoids repeated full provider reads
            forbidden = await env['api'].get(path + f"/attachments/{attachment['id']}/parts/0", headers=headers(env, 'denied'))
            assert forbidden.status_code == 403
            other_floor = await env['api'].get(path + f"/attachments/{attachment['id']}/parts/0", headers={**headers(env), 'X-Floor-Id': 'first-floor'})
            assert other_floor.status_code == 403
    asyncio.run(run())


def test_large_transfer_cancel_expiry_corruption_and_permission_revocation(monkeypatch):
    import base64
    from datetime import datetime, timedelta, timezone
    from media_storage import factory
    from services.kitchen_file_transfers import CHUNK_BYTES
    class NeverUpload:
        async def require_private_bucket(self, bucket):
            raise AssertionError('Unverified bytes must never reach storage')
    monkeypatch.setattr(factory, 'get_media_storage', lambda: NeverUpload())
    async def run():
        async with environment() as env:
            await configure(env)
            project, _ = await create_project(env)
            path = f"/api/kitchen-projects/{project['id']}/file-transfers"
            body = {'expected_version': project['version'], 'idempotency_key': str(uuid4()), 'filename': 'synthetic.pdf', 'content_type': 'application/pdf', 'size_bytes': CHUNK_BYTES, 'sha256': '0' * 64}
            started = await env['api'].post(path, headers=headers(env), json=body)
            assert started.status_code == 200
            tid = started.json()['transfer_id']
            other = await env['api'].post(path, headers=headers(env), json={**body, 'idempotency_key': str(uuid4()), 'filename': 'different.pdf'})
            assert other.status_code == 409  # one bounded staging slot per actor
            root = path + '/' + tid
            malformed = await env['api'].put(root + '/parts/0', headers=headers(env), json={'data_base64': 'not-base64!'})
            assert malformed.status_code == 422
            data = b'%PDF-1' + b'x' * (CHUNK_BYTES - 6)
            valid = await env['api'].put(root + '/parts/0', headers=headers(env), json={'data_base64': base64.b64encode(data).decode()})
            assert valid.status_code == 200
            wrong_checksum = await env['api'].post(root + '/finish', headers=headers(env), json={'expected_version': project['version']})
            assert wrong_checksum.status_code == 409
            assert (await env['db'].kitchen_projects.find_one({'id': project['id']}))['attachments'] == []
            forbidden_cancel = await env['api'].delete(root, headers=headers(env, 'worker'))
            assert forbidden_cancel.status_code in {403, 404}
            canceled = await env['api'].delete(root, headers=headers(env))
            assert canceled.status_code == 200
            assert await env['db'].kitchen_file_parts.count_documents({}) == 0
            assert (await env['api'].get(path, headers=headers(env))).json()['transfer'] is None
            begun = await env['api'].post(path, headers=headers(env), json={**body, 'idempotency_key': str(uuid4())})
            expired_id = begun.json()['transfer_id']
            await env['db'].kitchen_file_transfers.update_one({'transfer_id': expired_id}, {'$set': {'expires_at': datetime.now(timezone.utc) - timedelta(seconds=1)}})
            expired = await env['api'].put(path + '/' + expired_id + '/parts/0', headers=headers(env), json={'data_base64': base64.b64encode(data).decode()})
            assert expired.status_code == 410
            await env['api'].delete(path + '/' + expired_id, headers=headers(env))
            worker = await env['api'].post(path, headers=headers(env, 'worker'), json={**body, 'expected_version': project['version'], 'idempotency_key': str(uuid4())})
            assert worker.status_code == 200
            worker_id = worker.json()['transfer_id']
            await env['db'].users.update_one({'id': env['ids']['worker']}, {'$set': {'delegation_grants': []}})
            import auth
            auth.invalidate_principal_cache('staff', env['ids']['worker'])
            lost = await env['api'].put(path + '/' + worker_id + '/parts/0', headers=headers(env, 'worker'), json={'data_base64': base64.b64encode(data).decode()})
            assert lost.status_code in {403, 404}
    asyncio.run(run())


def test_checksum_free_new_key_does_not_replay_different_same_size_file(monkeypatch):
    import base64
    import hashlib
    from media_storage import factory

    class PrivateBytes:
        def __init__(self):
            self.objects = {}
        async def require_private_bucket(self, bucket):
            assert bucket == "forge-private"
        async def exists(self, *, bucket, key):
            return key in self.objects
        async def upload(self, *, bucket, key, data, **kwargs):
            assert kwargs["upsert"] is False
            self.objects[key] = data
        async def download(self, *, bucket, key):
            return self.objects[key]
    storage = PrivateBytes()
    monkeypatch.setattr(factory, "get_media_storage", lambda: storage)

    async def run():
        async with environment() as env:
            project, _ = await create_project(env)
            route = f"/api/kitchen-projects/{project['id']}/file-transfers"
            contents = [b"%PDF-1" + b"a" * 94, b"%PDF-1" + b"b" * 94]
            transfer_ids = []
            first_key = str(uuid4())
            for index, data in enumerate(contents):
                body = {"expected_version": project["version"], "idempotency_key": first_key if index == 0 else str(uuid4()),
                    "filename": "same.pdf", "content_type": "application/pdf", "size_bytes": len(data)}
                begun = await env["api"].post(route, headers=headers(env), json=body)
                assert begun.status_code == 200, begun.text
                tid = begun.json()["transfer_id"]
                transfer_ids.append(tid)
                assert begun.json()["state"] == "open"
                root = f"{route}/{tid}"
                put = await env["api"].put(root + "/parts/0", headers=headers(env), json={"data_base64": base64.b64encode(data).decode()})
                assert put.status_code == 200, put.text
                finish = await env["api"].post(root + "/finish", headers=headers(env), json={"expected_version": project["version"]})
                assert finish.status_code == 200, finish.text
                project = finish.json()
                replay = await env["api"].post(route, headers=headers(env), json=body)
                assert replay.status_code == 200 and replay.json()["state"] == "completed"
            assert len(set(transfer_ids)) == 2
            assert {row["sha256"] for row in project["attachments"]} == {hashlib.sha256(data).hexdigest() for data in contents}
            assert len(storage.objects) == 2
    asyncio.run(run())


def test_expired_finish_lease_recovers_dead_worker_and_live_claim_cannot_be_stolen(monkeypatch):
    import base64
    from datetime import datetime, timedelta, timezone
    from media_storage import factory
    from services import kitchen_file_transfers
    monkeypatch.setattr(kitchen_file_transfers, "FINISH_LEASE_SECONDS", 3)

    class PrivateBytes:
        def __init__(self):
            self.objects = {}
            self.started = asyncio.Event()
            self.release = asyncio.Event()
        async def require_private_bucket(self, bucket):
            assert bucket == "forge-private"
        async def exists(self, *, bucket, key):
            return key in self.objects
        async def upload(self, *, bucket, key, data, **kwargs):
            self.started.set()
            await self.release.wait()
            self.objects[key] = data
        async def download(self, *, bucket, key):
            return self.objects[key]

    async def run():
        async with environment() as env:
            storage = PrivateBytes()
            monkeypatch.setattr(factory, "get_media_storage", lambda: storage)
            project, _ = await create_project(env)
            route = f"/api/kitchen-projects/{project['id']}/file-transfers"
            body = {"expected_version": project["version"], "idempotency_key": str(uuid4()),
                "filename": "recovery.pdf", "content_type": "application/pdf", "size_bytes": 100}
            begun = await env["api"].post(route, headers=headers(env), json=body)
            tid = begun.json()["transfer_id"]
            root = f"{route}/{tid}"
            await env["api"].put(root + "/parts/0", headers=headers(env), json={"data_base64": base64.b64encode(b"%PDF-1" + b"a" * 94).decode()})
            # Durable state of a process killed before its first attachment
            # receipt. No actual configured worker is stopped by this test.
            await env["db"].kitchen_file_transfers.update_one({"transfer_id": tid}, {"$set": {
                "state": "finishing", "finish_token": "dead-worker",
                "finish_lease_until": datetime.now(timezone.utc) - timedelta(seconds=1)}})
            pending = asyncio.create_task(env["api"].post(root + "/finish", headers=headers(env), json={"expected_version": project["version"]}))
            try:
                await asyncio.wait_for(storage.started.wait(), 3)
                # Provider I/O outlives the original short test lease; renewal
                # must preserve the live claim rather than allow a takeover.
                await asyncio.sleep(3.2)
                claimed = await env["db"].kitchen_file_transfers.find_one({"transfer_id": tid})
                assert claimed["finish_token"] != "dead-worker" and claimed["state"] == "finishing"
                duplicate = await env["api"].post(root + "/finish", headers=headers(env), json={"expected_version": project["version"]})
                assert duplicate.status_code == 409
                canceled = await env["api"].delete(root, headers=headers(env))
                assert canceled.status_code == 409
            finally:
                storage.release.set()
                result = await pending
            assert result.status_code == 200, result.text
            assert len(result.json()["attachments"]) == len(storage.objects) == 1
            assert await env["db"].kitchen_file_parts.count_documents({}) == 0
            # A completed attachment with a stale finishing marker is reconciled
            # from its canonical receipt without publishing a second event.
            await env["db"].kitchen_file_transfers.update_one({"transfer_id": tid}, {"$set": {"state": "finishing", "finish_token": "after-commit-crash"}})
            replay = await env["api"].post(root + "/finish", headers=headers(env), json={"expected_version": project["version"]})
            assert replay.status_code == 200 and replay.json()["version"] == result.json()["version"]
            assert len(storage.objects) == 1
    asyncio.run(run())


@pytest.mark.parametrize("write_replacement_before_late_part", [False, True])
def test_late_part_after_cancel_is_removed_without_overwriting_new_transfer(monkeypatch, write_replacement_before_late_part):
    import base64
    from services.kitchen_file_transfers import KitchenFileTransfers, TransferStart, TransferChunk

    async def run():
        async with environment() as env:
            project, _ = await create_project(env)
            from models import UserPublic
            user = UserPublic(**(await env["db"].users.find_one({"id": env["ids"]["owner"]}, {"_id": 0})), active_floor_id="second-floor")
            original = env["db"].kitchen_file_parts
            entered, release = asyncio.Event(), asyncio.Event()

            class PausedParts:
                def __init__(self):
                    self.pause = True
                def __getattr__(self, name):
                    return getattr(original, name)
                async def insert_one(self, row):
                    if self.pause:
                        self.pause = False
                        entered.set()
                        await release.wait()
                    return await original.insert_one(row)
            parts = PausedParts()

            class Database:
                kitchen_file_parts = parts
                def __getattr__(self, name):
                    return getattr(env["db"], name)
            service = KitchenFileTransfers(Database())
            body = {"expected_version": project["version"], "filename": "race.pdf", "content_type": "application/pdf", "size_bytes": 100}
            first = await service.begin(user, project["id"], TransferStart(**body, idempotency_key=str(uuid4())))
            pending = asyncio.create_task(service.put_part(user, project["id"], first["transfer_id"], 0,
                TransferChunk(data_base64=base64.b64encode(b"%PDF-1" + b"a" * 94).decode())))
            try:
                await asyncio.wait_for(entered.wait(), 3)
                assert (await service.cancel(user, project["id"], first["transfer_id"]))["discarded"]
                second = await service.begin(user, project["id"], TransferStart(**body, idempotency_key=str(uuid4())))
                if write_replacement_before_late_part:
                    await service.put_part(user, project["id"], second["transfer_id"], 0,
                        TransferChunk(data_base64=base64.b64encode(b"%PDF-1" + b"b" * 94).decode()))
            finally:
                release.set()
                from fastapi import HTTPException
                with pytest.raises(HTTPException) as late:
                    await pending
                assert late.value.status_code == 409
            assert await original.count_documents({"transfer_id": first["transfer_id"]}) == 0
            if not write_replacement_before_late_part:
                assert await original.count_documents({}) == 0
                await service.put_part(user, project["id"], second["transfer_id"], 0,
                    TransferChunk(data_base64=base64.b64encode(b"%PDF-1" + b"b" * 94).decode()))
            assert await original.count_documents({}) == 1
            saved = await original.find_one({"transfer_id": second["transfer_id"]})
            assert saved["data"] == b"%PDF-1" + b"b" * 94
            await service.cancel(user, project["id"], second["transfer_id"])
            assert await original.count_documents({}) == 0
    asyncio.run(run())


def test_late_old_finalizer_cannot_duplicate_attachment_or_reset_new_claim(monkeypatch):
    import base64
    from datetime import datetime, timedelta, timezone
    from media_storage import factory

    async def run():
        async with environment() as env:
            entered, release = asyncio.Event(), asyncio.Event()
            class PrivateBytes:
                def __init__(self):
                    self.objects = {}
                    self.uploads = 0
                async def require_private_bucket(self, bucket):
                    assert bucket == "forge-private"
                async def exists(self, *, bucket, key):
                    return key in self.objects
                async def upload(self, *, bucket, key, data, **kwargs):
                    assert kwargs["upsert"] is False and key not in self.objects
                    self.objects[key] = data
                    self.uploads += 1
                    entered.set()
                    await release.wait()
                async def download(self, *, bucket, key):
                    return self.objects[key]
            storage = PrivateBytes()
            monkeypatch.setattr(factory, "get_media_storage", lambda: storage)
            project, _ = await create_project(env)
            route = f"/api/kitchen-projects/{project['id']}/file-transfers"
            body = {"expected_version": project["version"], "idempotency_key": str(uuid4()),
                "filename": "late-finalize.pdf", "content_type": "application/pdf", "size_bytes": 100}
            begun = await env["api"].post(route, headers=headers(env), json=body)
            tid = begun.json()["transfer_id"]
            root = f"{route}/{tid}"
            await env["api"].put(root + "/parts/0", headers=headers(env), json={"data_base64": base64.b64encode(b"%PDF-1" + b"a" * 94).decode()})
            old = asyncio.create_task(env["api"].post(root + "/finish", headers=headers(env), json={"expected_version": project["version"]}))
            try:
                await asyncio.wait_for(entered.wait(), 3)
                initial_claim = await env["db"].kitchen_file_transfers.find_one({"transfer_id": tid})
                # Simulate a paused old process past its lease. The replacement
                # sees immutable provider bytes, then uses the same command key.
                await env["db"].kitchen_file_transfers.update_one({"transfer_id": tid}, {"$set": {
                    "finish_lease_until": datetime.now(timezone.utc) - timedelta(seconds=1)}})
                replacement = await env["api"].post(root + "/finish", headers=headers(env), json={"expected_version": project["version"]})
                assert replacement.status_code == 200, replacement.text
                saved_claim = await env["db"].kitchen_file_transfers.find_one({"transfer_id": tid})
                assert saved_claim["state"] == "completed" and saved_claim["finish_token"] != initial_claim["finish_token"]
            finally:
                release.set()
                resumed = await old
            assert resumed.status_code == 200, resumed.text
            assert resumed.json()["version"] == replacement.json()["version"] == project["version"] + 1
            final = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            assert len(final["attachments"]) == storage.uploads == 1
            assert len([row for row in final["activity"] if row["type"] == "attachment.added"]) == 1
            current_claim = await env["db"].kitchen_file_transfers.find_one({"transfer_id": tid})
            assert current_claim["state"] == "completed" and current_claim["finish_token"] == saved_claim["finish_token"]
    asyncio.run(run())


@pytest.mark.parametrize("held_status", ["On Hold", "Cancelled"])
@pytest.mark.parametrize("stage,edit,payload", [
    ("lead", "edit_lead", {"notes": "Authorized current task update"}),
    ("visit", "save_visit", {"notes": "Authorized showroom update"}),
    ("cad", "save_cad", {"notes": "Authorized CAD update"}),
])
def test_held_early_tasks_block_routine_writes_but_preserve_replay_history_and_owner_resume(held_status, stage, edit, payload):
    async def run():
        async with environment() as env:
            project = await reach_stage(env, stage)
            replay_key = str(uuid4())
            project = await accepted(env, project, edit, payload, actor="worker", key=replay_key)
            project = await accepted(env, project, "order_status", {"status": held_status, "reason": "Owner paused this work"})
            snapshot = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            for name, fields in ((edit, {**payload, "notes": "Should be rejected"}), ("metadata", {"target_completion_date": "2026-10-23"})):
                rejected = await command(env, project, name, fields, actor="worker")
                assert rejected.status_code == 422 and "resume" in rejected.text
                assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == snapshot
            replayed = await command(env, project, edit, payload, actor="worker", key=replay_key, expected=1)
            assert replayed.status_code == 200 and replayed.json()["replayed"]
            assert replayed.json()["version"] == project["version"]
            assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == snapshot
            assert (await env["api"].get(f"/api/kitchen-projects/{project['id']}", headers=headers(env, "worker"))).status_code == 200
            if stage == "lead":
                project = await accepted(env, project, "review_duplicate", {"decision": "distinct_project", "reason": "Owner reviewed while paused"})
            project = await accepted(env, project, "order_status", {"status": "Confirmed", "reason": "Owner resumes current task"})
            project = await accepted(env, project, edit, {**payload, "notes": "Saved after owner resume"}, actor="worker")
            project = await accepted(env, project, "metadata", {"target_completion_date": "2026-10-23"}, actor="worker")
            assert project[stage]["notes"] == "Saved after owner resume"
            assert project["target_completion_date"] == "2026-10-23"
    asyncio.run(run())


def test_retired_kitchen_writes_reject_before_persistence_but_delegated_intake_works():
    async def run():
        async with environment() as env:
            body = {"customer_id": env["ids"]["customer"], "idempotency_key": str(uuid4()),
                    "lead": {"site_location": "Delegated site"}}
            retired_create = await env["api"].post("/api/kitchen-projects", headers=headers(env, "worker"),
                json={**body, "assigned_to": env["ids"]["worker"]})
            assert retired_create.status_code == 403
            assert await env["db"].kitchen_projects.count_documents({}) == 0
            created = await env["api"].post("/api/kitchen-projects", headers=headers(env, "worker"), json=body)
            assert created.status_code == 200, created.text
            project = created.json()
            assert project["assignments"] == {} and project["permissions"]["can_update"]
            project = await accepted(env, project, "convert", actor="worker")
            before = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            for name, payload in (("save_visit", {"next_action": "Retired"}),
                                  ("metadata", {"next_action": "Retired"}),
                                  ("metadata", {"deadline": "2026-10-23T09:00:00Z"})):
                rejected = await command(env, project, name, payload, actor="worker")
                assert rejected.status_code == 422, (name, rejected.text)
                assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == before
            project = await accepted(env, project, "save_visit", {"visit_date": "2026-10-23"}, actor="worker")
            changed = await accepted(env, project, "save_visit", {"visit_date": "2026-10-24"}, actor="worker")
            assert changed["visit"]["visit_date"] == "2026-10-24"
    asyncio.run(run())


def test_kitchen_assignment_retirement_preserves_view_only_grant_and_floor_limits():
    async def run():
        async with environment() as env:
            project, _ = await create_project(env)
            worker = await env["db"].users.find_one({"id": env["ids"]["worker"]})
            grants = worker["delegation_grants"]
            grants[0]["actions"] = ["view"]
            await env["db"].users.update_one({"id": env["ids"]["worker"]}, {"$set": {"delegation_grants": grants}})
            import auth
            auth.invalidate_principal_cache("staff", env["ids"]["worker"])
            visible = await env["api"].get(f"/api/kitchen-projects/{project['id']}", headers=headers(env, "worker"))
            assert visible.status_code == 200 and not visible.json()["permissions"]["can_update"]
            assert not visible.json()["permissions"]["can_assign"]
            before = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            edited = await command(env, project, "edit_lead", {"notes": "View cannot write"}, actor="worker")
            assert edited.status_code == 403
            assert await env["db"].kitchen_projects.find_one({"id": project["id"]}) == before
            other_floor = await env["api"].get(f"/api/kitchen-projects/{project['id']}", headers=headers(env, "worker", floor="first-floor"))
            assert other_floor.status_code == 403
            exported = await env["api"].get("/api/kitchen-projects/export", headers=headers(env, "worker"))
            assert exported.status_code == 403
    asyncio.run(run())


def test_kitchen_references_customer_details_and_sales_metrics_use_current_authorized_records():
    async def scenario():
        from services.analytics.filters import AnalyticsFilter, build_match
        from services.analytics.gather_referrals import gather_referrer_raw
        from services.analytics.kitchen_referrals import kitchen_referral_records
        from services.analytics.lead_referrals import gather_acquired_customers
        from services.analytics.workspaces import gather_workspace
        async with environment() as env:
            rid = str(uuid4())
            await env['db'].referrers.insert_one({'id': rid, 'name': 'Synthetic architect', 'company': 'Synthetic studio', 'type': 'architect', 'floor_id': 'second-floor', 'active': True})
            await env['db'].customers.update_one({'id': env['ids']['customer']}, {'$set': {'email': 'customer@example.test', 'city': 'Ahmedabad', 'state': 'Gujarat', 'pincode': '380001', 'property_name': 'Synthetic apartment'}})
            project, _ = await create_project(env, lead={'site_location': 'Synthetic referred site', 'referrer_id': rid, 'referrer_name': 'Forged name'})
            assert project['lead']['referrer_name'] == 'Synthetic architect'
            assert project['referrer_company'] == 'Synthetic studio'
            assert project['customer']['city'] == 'Ahmedabad'
            assert project['customer']['address'] == 'Synthetic kitchen site'
            assert project['lead']['lead_date']
            await env['db'].referrers.update_one({'id': rid}, {'$set': {'active': False}})
            project = await accepted(env, project, 'edit_lead', {'notes': 'Unrelated correction after archive', 'referrer_name': 'Forged replacement'})
            assert project['lead']['referrer_name'] == 'Synthetic architect'
            assert project['lead']['notes'] == 'Unrelated correction after archive'
            await env['db'].referrers.update_one({'id': rid}, {'$set': {'active': True}})
            f = AnalyticsFilter(floor_id='second-floor', referrer_id=rid)
            rows = await gather_referrer_raw(env['db'], f, ['second-floor'], (None, None), 'architect')
            assert rows[0]['customers_referred'] == 1
            assert rows[0]['quotations_total'] == 0
            assert rows[0]['revenue'] == 0
            acquisitions = await gather_acquired_customers(env['db'], f, ['second-floor'], (None, None), 'architect')
            assert acquisitions[0]['customers_acquired'] == 1
            await configure(env)
            order_project = await reach_stage(env, 'production')
            await env['db'].kitchen_projects.update_one({'id': order_project['id']}, {'$set': {'referrer_id': rid, 'referrer_name': 'Synthetic architect', 'referrer_type': 'architect'}})
            match = build_match(f, ['second-floor'], (None, None))
            metrics = await gather_workspace(env['db'], match, 'architect', include_kitchen=True)
            assert metrics['kpis'] == {'revenue': 1000.01, 'orders': 1, 'outstanding': 1000.0}
            rows = await gather_referrer_raw(env['db'], f, ['second-floor'], (None, None), 'architect')
            assert rows[0]['revenue'] == 1000.01
            assert rows[0]['pending_payments'] == 1000.0
            records = await kitchen_referral_records(env['db'], {'floor_id': 'second-floor', 'referrer_id': rid})
            assert len(records) == 2
            assert sorted(row['status'] for row in records) == ['lead', 'ordered']
            excluded = await gather_workspace(env['db'], {'floor_id': 'first-floor', 'status': 'ordered'}, include_kitchen=True)
            assert excluded['kpis']['orders'] == 0
            await env['db'].kitchen_projects.update_one({'id': order_project['id']}, {'$set': {'commercial_basis_invalidated': True}})
            invalidated = await gather_workspace(env['db'], match, include_kitchen=True)
            assert invalidated['kpis']['revenue'] == 0
            inactive = await gather_referrer_raw(env['db'], f, ['second-floor'], (None, None), 'architect')
            assert inactive[0]['pending_count'] == 0
            assert inactive[0]['pending_value'] == 0
            assert inactive[0]['pending_payments'] == 0
            for lifecycle in ['Cancelled', 'On Hold']:
                await env['db'].kitchen_projects.update_one({'id': order_project['id']}, {'$set': {'commercial_basis_invalidated': False, 'lifecycle_status': lifecycle}})
                inactive = await gather_referrer_raw(env['db'], f, ['second-floor'], (None, None), 'architect')
                assert inactive[0]['pending_count'] == 0
                assert inactive[0]['revenue'] == 0
    asyncio.run(scenario())


def test_manual_stage_navigation_http_preserves_incomplete_project_and_history():
    async def scenario():
        async with environment() as env:
            project, _ = await create_project(env)
            original = {key: project.get(key) for key in ('lead','visit','cad','orders','approvals','design_versions','quotation_versions','installation','production')}
            stages = ['lead','visit','cad','design','quotation','order','production','installation','completed']
            for target in [*stages[1:], *reversed(stages[:-1])]:
                before = project['stage']
                if before == 'design' and target == 'quotation' or before == 'quotation' and target == 'order':
                    project = await prepare_manual_pdf_gate(env, project, target)
                    original = {key: project.get(key) for key in original}
                project = await accepted(env, project, 'move_stage', {'target_stage': target})
                assert project['stage'] == target
                assert project['activity'][-1]['payload']['from_stage'] == before
                assert project['activity'][-1]['payload']['to_stage'] == target
                assert all(project.get(key) == value for key,value in original.items())
            response = await command(env, project, 'move_stage', {'target_stage':'visit'}, expected=project['version']-1)
            assert response.status_code == 409
            response = await command(env, project, 'move_stage', {'target_stage':'visit'}, actor='denied')
            assert response.status_code == 403
            assert project['completion_date']
            assert not (project.get('installation') or {}).get('completion_date')
    asyncio.run(scenario())


def test_returning_to_quotation_keeps_confirmed_order_terms_and_navigation_available():
    async def scenario():
        async with environment() as env:
            await configure(env)
            project = await reach_stage(env, 'production')
            original = project['orders']
            project = await accepted(env, project, 'move_stage', {'target_stage':'order'})
            project = await accepted(env, project, 'move_stage', {'target_stage':'quotation'})
            project = await accepted(env, project, 'quotation_receive', {'design_version_id':project['design_versions'][-1]['id'], 'received_date':'2026-10-26', 'amount':'1200.00', 'sent_status':'Yes', 'shared_date':'2026-10-26', 'response':'Approved'})
            assert project['quotation_versions'][-1]['amount'] == '1200.00'
            assert project['orders'] == original
            assert project['orders'][-1]['quotation_version_id'] != project['quotation_versions'][-1]['id']
            project = await accepted(env, project, 'move_stage', {'target_stage':'order'})
            assert project['orders'] == original
    asyncio.run(scenario())


def test_universal_search_and_distinct_customer_stage_counts_use_authorized_current_records(monkeypatch):
    import copy
    from models_kitchen import STAGES
    from services import kitchen_access
    capability_calls = []
    original_capability = kitchen_access.capability

    async def capability(database, user, action):
        capability_calls.append(action)
        return await original_capability(database, user, action)

    monkeypatch.setattr(kitchen_access, "capability", capability)

    async def run():
        async with environment() as env:
            migration = importlib.import_module("migrations.0039_kitchen_global_search_page")
            await migration.up(env["db"])
            await migration.up(env["db"])
            await configure(env)
            project, _ = await create_project(env)
            template = await env["db"].kitchen_projects.find_one({"id": project["id"]})
            await env["db"].kitchen_projects.delete_many({})
            rows = []
            for index, stage in enumerate([*STAGES, "lead"]):
                row = copy.deepcopy(template)
                row.pop("_id", None)
                row.update(id=f"global-{index}", reference=f"GLOBAL-{index}", stage=stage)
                row["customer"].update(email="Literal.+[search]@example.test", alternate_phone="9988776655",
                    property_name="Synthetic Property", company="Synthetic Company", city="Vadodara")
                rows.append(row)
            hidden = copy.deepcopy(rows[0])
            hidden.update(id="hidden-global", reference="HIDDEN-GLOBAL", floor_id="first-floor")
            await env["db"].kitchen_projects.insert_many([*rows, hidden])
            await env["db"].customers.update_one({"id": project["customer_id"], "floor_id": "second-floor"},
                {"$set": {key: rows[0]["customer"][key] for key in ("email", "alternate_phone", "property_name", "company", "city")}})
            for actor in ("owner", "worker"):
                dashboard = await env["api"].get("/api/kitchen-projects/dashboard", headers=headers(env, actor))
                assert dashboard.status_code == 200, dashboard.text
                metrics = dashboard.json()
                assert dashboard.headers["Cache-Control"] == "no-store"
                assert metrics["total_projects"] == 10
                assert metrics["total_customers"] == 1
                assert metrics["stage_customer_counts"] == {stage: 1 for stage in STAGES}
                assert metrics["stage_counts"] == {stage: 2 if stage == "lead" else 1 for stage in STAGES}
                for stage in STAGES:
                    listed = await env["api"].get("/api/kitchen-projects", params={"stage": stage}, headers=headers(env, actor))
                    assert listed.status_code == 200, listed.text
                    data = listed.json()
                    assert listed.headers["Cache-Control"] == "no-store"
                    assert data["total"] == metrics["stage_counts"][stage]
                    assert len({row["customer_id"] for row in data["rows"]}) == metrics["stage_customer_counts"][stage]
                for term in ("Literal.+[search]", "9988776655", "Synthetic Property", "Synthetic Company", "vadodara"):
                    listed = await env["api"].get("/api/kitchen-projects", params={"search": term, "limit": 3}, headers=headers(env, actor))
                    assert listed.status_code == 200, listed.text
                    assert listed.json()["total"] == 10
                    assert len(listed.json()["rows"]) == 3
                    assert "hidden-global" not in [row["id"] for row in listed.json()["rows"]]
                punctuation = await env["api"].get("/api/kitchen-projects", params={"search": ".*"}, headers=headers(env, actor))
                assert punctuation.json()["total"] == 0
            capability_calls.clear()
            listed = await env["api"].get("/api/kitchen-projects", params={"limit": 100}, headers=headers(env, "worker"))
            assert listed.status_code == 200 and len(listed.json()["rows"]) == 10
            assert capability_calls.count("update") == 1  # One permission read for the entire page.
            plan = await env["db"].command("explain", {"find": "kitchen_projects", "filter": {"floor_id": "second-floor"},
                "sort": {"updated_at": -1, "id": 1}, "limit": 25})
            assert "kitchen_projects_global_page" in json.dumps(plan["queryPlanner"]["winningPlan"])
            assert '"stage": "SORT"' not in json.dumps(plan["queryPlanner"]["winningPlan"])
            # Reads are authoritative: out-of-band removal cannot leave a cached count.
            await env["db"].kitchen_projects.delete_one({"id": "global-9"})
            current = (await env["api"].get("/api/kitchen-projects/dashboard", headers=headers(env))).json()
            assert current["total_projects"] == 9 and current["stage_counts"]["lead"] == 1
            # The editable customer directory is current identity; project history stays unchanged.
            changed = await env["api"].patch(f"/api/customers/{env['ids']['customer']}", headers=headers(env),
                json={"name": "Current Contact Name", "email": "changed.current@example.com", "notes": "Current internal customer note"})
            assert changed.status_code == 200, changed.text
            for field, term in (("name", "Current Contact Name"), ("email", "changed.current"), ("notes", "Current internal customer note")):
                latest = await env["api"].get("/api/kitchen-projects", params={"search": term}, headers=headers(env, "worker"))
                assert latest.status_code == 200, latest.text
                assert latest.json()["total"] == 9
                assert all(row["customer"][field].startswith(term) for row in latest.json()["rows"])
            detail = await env["api"].get("/api/kitchen-projects/global-0", headers=headers(env, "worker"))
            assert detail.status_code == 200, detail.text
            assert detail.headers["Cache-Control"] == "no-store"
            assert detail.json()["customer"]["email"] == "changed.current@example.com"
            obsolete = await env["api"].get("/api/kitchen-projects", params={"search": "Literal.+[search]"}, headers=headers(env))
            assert obsolete.status_code == 200 and obsolete.json()["total"] == 0
            stored = await env["db"].kitchen_projects.find_one({"id": "global-0"})
            assert stored["customer"]["email"] == "Literal.+[search]@example.test"
            assert stored["version"] == template["version"] and stored["activity"] == template["activity"]
            saved = await env["api"].post("/api/kitchen-projects/global-0/commands", headers=headers(env),
                json={"expected_version": stored["version"], "idempotency_key": str(uuid4()), "command": "metadata",
                      "payload": {"target_completion_date": "2027-01-01"}})
            assert saved.status_code == 200, saved.text
            assert saved.json()["customer"]["email"] == "changed.current@example.com"
            denied = await env["api"].get("/api/kitchen-projects/dashboard", headers=headers(env, "denied"))
            assert denied.status_code == 403
    asyncio.run(run())
