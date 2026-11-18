"""HTTP quotation lifecycle and real exports against a disposable Mongo replica."""
import asyncio
from datetime import date, datetime, timedelta
from io import BytesIO
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from openpyxl import load_workbook
from pypdf import PdfReader

from tests.integration.test_kitchen_projects_mongo import environment, headers


def test_saved_order_exports_and_explicit_send(monkeypatch):
    async def exercise():
        import db as connection
        from routes import quotation_routes
        from services import domain_outbox, followup_engine, sequence

        async with environment() as fixture:
            database = fixture["db"]
            for module in (quotation_routes, domain_outbox, followup_engine, sequence):
                monkeypatch.setattr(module, "db", database)
            monkeypatch.setattr(connection, "client", database.client)
            monkeypatch.setattr(domain_outbox, "client", database.client)
            for collection in ("settings", "quotations", "followups", "event_outbox", "activity_events"):
                await database.create_collection(collection, check_exists=False)
            fixture["app"].include_router(quotation_routes.router, prefix="/api")
            api = fixture["api"]
            actor = headers(fixture, floor="first-floor")
            viewer = headers(fixture, actor="denied", floor="first-floor")
            rooms = ["Master Bathroom", "Guest Bathroom", "Second Bathroom", "Third Bathroom"]
            names = [f"Bath Fixture {position}" for position in range(1, 8)]
            lines = [
                {"id": f"line-{index}", "product_id": f"fixture-{index}", "sku": f"QA-{index}",
                 "name": name, "qty": index, "unit_price": 100, "room": rooms[0], "sort_order": index}
                for index, name in enumerate(names, 1)
            ]
            lines.append({"id": "guest-line", "product_id": "guest", "sku": "QA-GUEST", "name": "Guest Sink",
                          "qty": 2, "unit_price": 400, "room": rooms[1], "sort_order": 8})
            temporary = {"id": "temporary-line", "product_id": "temporary", "sku": "QA-TEMP",
                         "name": "Temporary fixture", "qty": 2, "unit_price": 200, "room": rooms[0], "sort_order": 9}
            await database.products.insert_many([
                {"id": line["product_id"], "floor_id": "first-floor", "sku": line["sku"],
                 "name": line["name"], "price": line["unit_price"]}
                for line in [*lines, temporary]
            ])
            await database.customers.update_one(
                {"id": fixture["ids"]["other_customer"]},
                {"$set": {"name": "QA Sanitary Client", "phone": "990-995-575-5"}},
            )
            key = str(uuid4())
            body = {
                "customer_id": fixture["ids"]["other_customer"], "client_draft_id": key,
                "rooms": rooms, "items": lines, "project_discount_pct": 10,
                "ui_state": {"active_room": rooms[2]},
            }
            responses = await asyncio.gather(*[
                api.post("/api/quotations", json=body, headers=actor) for _ in range(3)
            ])
            assert all(response.status_code == 200 for response in responses), [r.text for r in responses]
            original = responses[0].json()
            assert {response.json()["number"] for response in responses} == {original["number"]}
            assert {response.json()["id"] for response in responses} == {original["id"]}
            assert original["status"] == "draft"
            assert original["ui_state"]["active_room"] == rooms[2]
            path = f"/api/quotations/{original['id']}"
            assert await database.quotations.count_documents({}) == 1
            assert await database.followups.count_documents({"quotation_id": original["id"]}) == 0
            assert (await api.get(path + "/pdf", headers=actor)).content.startswith(b"%PDF")
            assert (await api.get(path, headers=actor)).json()["status"] == "draft"
            assert await database.followups.count_documents({"quotation_id": original["id"]}) == 0

            # Reorder the seventh row to second and apply a bulk increase only
            # to Master Bathroom. An exact retry uses the old version token.
            order = [lines[0], lines[6], *lines[1:6], lines[7]]
            for index, line in enumerate(order):
                order[index] = {**line, "sort_order": index,
                                "qty": line["qty"] + (3 if line["room"] == rooms[0] else 0)}
            patch = {"items": order, "expected_updated_at": original["updated_at"], "silent": True}
            saved = await api.patch(path, json=patch, headers=actor)
            assert saved.status_code == 200, saved.text
            assert (await api.patch(path, json=patch, headers=actor)).status_code == 409
            refreshed = (await api.get(path, headers=actor)).json()
            assert refreshed["number"] == original["number"]
            assert [row["id"] for row in refreshed["items"]] == [row["id"] for row in order]
            assert [row["qty"] for row in refreshed["items"]] == [row["qty"] for row in order]
            assert refreshed["grand_total"] == 5130

            edited = {**order[0], "qty": 5, "finish": "Brushed Brass"}
            added = await api.patch(path, json={
                "items": [edited, *order[1:], temporary], "expected_updated_at": refreshed["updated_at"], "silent": True,
            }, headers=actor)
            assert added.status_code == 200, added.text
            assert added.json()["number"] == original["number"]
            assert added.json()["grand_total"] == 5580
            revised = [{**edited, "qty": 4}, *order[1:]]
            removed = await api.patch(path, json={
                "items": revised, "expected_updated_at": added.json()["updated_at"], "silent": True,
            }, headers=actor)
            assert removed.status_code == 200, removed.text
            refreshed = (await api.get(path, headers=actor)).json()
            assert refreshed["number"] == original["number"]
            assert [(row["id"], row["qty"], row["finish"]) for row in refreshed["items"]] == [
                (row["id"], row["qty"], row.get("finish")) for row in revised
            ]
            assert refreshed["subtotal"] == 5700
            assert refreshed["grand_total"] == 5130
            pdf = await api.get(path + "/pdf", headers=actor)
            xlsx = await api.get(path + "/xlsx", headers=actor)
            assert pdf.status_code == xlsx.status_code == 200
            text = " ".join(" ".join(page.extract_text().split()) for page in PdfReader(BytesIO(pdf.content)).pages)
            assert original["number"] in text
            assert "QA Sanitary Client" in text and "9909955755" in text
            first_line = text[text.index(names[0]):text.index(names[6])]
            assert "Brushed Brass" in first_line, first_line
            assert "Temporary fixture" not in text
            assert "5,130.00" in text
            assert text.index(names[6]) < text.index(names[1])
            workbook = load_workbook(BytesIO(xlsx.content), data_only=True)
            try:
                cover, master, guest = workbook.worksheets[:3]
                assert cover["A5"].value == f"Quotation {original['number']}"
                assert cover["D7"].value == "QA Sanitary Client"
                assert cover["D9"].value == "9909955755"
                assert "GST at 18%" in cover["A23"].value
                assert cover["K21"].value == refreshed["subtotal"]
                assert cover["K22"].value == refreshed["grand_total"]
                assert [master[f"C{row}"].value for row in range(3, 10)] == [item["name"] for item in revised[:7]]
                assert [master[f"F{row}"].value for row in range(3, 10)] == [item["qty"] for item in revised[:7]]
                assert master["E3"].value == 100
                assert master["H3"].value == pytest.approx(10)
                assert master["K3"].value == 360
                assert guest["K3"].value == 720
            finally:
                workbook.close()
            assert (await api.get(path, headers=actor)).json()["status"] == "draft"

            command = {"expected_updated_at": refreshed["updated_at"]}
            assert (await api.post(path + "/mark-sent", json=command, headers=viewer)).status_code in {403, 404}
            invalid = await api.post(path + "/mark-sent", json={**command, "followup_date": "2025-01-01"}, headers=actor)
            assert invalid.status_code == 422
            sent = await asyncio.gather(*[
                api.post(path + "/mark-sent", json=command, headers=actor) for _ in range(3)
            ])
            assert all(response.status_code == 200 for response in sent), [r.text for r in sent]
            pending = (await api.get(path, headers=actor)).json()
            assert pending["number"] == original["number"] and pending["status"] == "sent"
            assert pending["sent_by"] == fixture["ids"]["owner"]
            assert {response.json()["sent_at"] for response in sent} == {pending["sent_at"]}
            sent_day = datetime.fromisoformat(pending["sent_at"]).astimezone(ZoneInfo("Asia/Kolkata")).date()
            due_day = sent_day + timedelta(days=7)
            assert date.fromisoformat(pending["first_followup_due_date"]) == due_day
            followups = await database.followups.find({"quotation_id": original["id"]}).to_list(None)
            assert len(followups) == 1
            assert datetime.fromisoformat(followups[0]["due_at"]).astimezone(ZoneInfo("Asia/Kolkata")).date() == due_day
            notes = await api.patch(path, json={"notes": "Customer requested matte finish"}, headers=actor)
            assert notes.status_code == 200, notes.text
            assert notes.json()["number"] == original["number"] and notes.json()["status"] == "sent"

            empty = await api.post("/api/quotations", json={**body, "client_draft_id": str(uuid4()), "items": []}, headers=actor)
            assert empty.status_code == 200, empty.text
            empty_path = f"/api/quotations/{empty.json()['id']}"
            assert (await api.post(empty_path + "/mark-sent", json={}, headers=actor)).status_code == 422
            assert (await api.get(empty_path, headers=actor)).json()["status"] == "draft"

            # An explicit future date replaces the seven-day default.
            custom = await api.post("/api/quotations", json={**body, "client_draft_id": str(uuid4())}, headers=actor)
            assert custom.status_code == 200, custom.text
            custom_quote = custom.json()
            assert custom_quote["number"] not in {original["number"], empty.json()["number"]}
            custom_day = sent_day + timedelta(days=11)
            custom_send = await api.post(
                f"/api/quotations/{custom_quote['id']}/mark-sent",
                json={"followup_date": custom_day.isoformat(), "expected_updated_at": custom_quote["updated_at"]},
                headers=actor,
            )
            assert custom_send.status_code == 200, custom_send.text
            assert custom_send.json()["first_followup_due_date"] == custom_day.isoformat()
            custom_reminder = await database.followups.find_one({"quotation_id": custom_quote["id"]})
            assert datetime.fromisoformat(custom_reminder["due_at"]).astimezone(ZoneInfo("Asia/Kolkata")).date() == custom_day

    asyncio.run(exercise())
