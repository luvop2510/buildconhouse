"""Round-trip the delivered workbook and prove scope before collecting records."""
import copy
import io
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from openpyxl import load_workbook

from models import UserPublic
from services.access_grants import build_grant
from services.kitchen_export import KitchenWorkbookExport, STAGE_SHEETS, build_kitchen_workbook
from services.kitchen_projects import KitchenProjectService
from tests.unit.test_kitchen_version_relationships import aggregate


def project(identity, stage="lead", **extra):
    return {**aggregate(stage), "id": identity, "reference": f"KIT-{identity}", "customer_id": f"customer-{identity}",
            "floor_id": "second-floor", "status": "New", "version": 1,
            "customer": {"name": "Saved snapshot", "phone": "0012345678"},
            "assignments": {}, "assignment_names": {}, "lead": {}, "visit": {}, "cad": {},
            "created_at": "2026-11-01T20:00:00+00:00", "updated_at": "2026-11-02T00:00:00+00:00", **extra}


def workbook(data):
    return load_workbook(io.BytesIO(data))


def records(sheet):
    rows = list(sheet.values)
    return [dict(zip(rows[0], row)) for row in rows[1:]]


def test_workbook_has_actual_eight_stage_sheets_and_each_project_once():
    projects = [project(str(index), stage) for index, (stage, _) in enumerate(STAGE_SHEETS)]
    projects.append(project("legacy", "production"))
    book = workbook(build_kitchen_workbook(projects, []))
    assert book.sheetnames == ["All Customers", *[title for _, title in STAGE_SHEETS], "Follow-Ups"]
    assert len(records(book["All Customers"])) == 9
    stages = [row for _, title in STAGE_SHEETS for row in records(book[title])]
    assert len(stages) == 9
    assert len({row["Project Record ID"] for row in stages}) == 9
    assert len(records(book["Order-Production"])) == 2
    assert all(row["Current Stage"] == "Order/Production" for row in records(book["Order-Production"]))


def test_excel_dates_phone_ids_formula_text_blanks_and_styles_survive_roundtrip():
    data = project("=1+1", customer={"name": "=HYPERLINK(\"https://example.test\")", "phone": "+00123", "alternate_phone": "00123"},
                   target_completion_date="2026-11-16", created_at="2026-11-01T20:00:00+00:00")
    book = workbook(build_kitchen_workbook([data], []))
    for sheet in book:
        assert sheet.freeze_panes == "A2"
        assert sheet.auto_filter.ref
        assert sheet["A1"].font.bold
        assert sheet.column_dimensions["A"].width >= 18
    row = records(book["All Customers"])[0]
    assert row["Project ID"] == "KIT-=1+1"
    assert row["Project Record ID"] == "=1+1"
    assert row["Phone Number"] == "+00123" and row["Alternate Phone"] == "00123"
    assert row["Assigned To"] is None and row["Email"] is None
    assert row["Target Completion Date"] == datetime(2026, 11, 16)
    assert row["Created Date"] == datetime(2026, 11, 2, 1, 30)
    assert book["All Customers"]["B2"].data_type == "s"
    assert book["All Customers"]["J2"].data_type == "s"
    assert book["All Customers"]["C2"].number_format == "@"


def test_followups_preserve_number_date_stage_and_project_references():
    followups = [{"project_id": "p", "stage": "lead", "number": number, "date": "2026-10-10", "notes": f"Note {number}", "interaction_type": "Visit"} for number in (3, 1, 2)]
    followups.append({"project_id": "unavailable", "stage": "lead", "number": 1})
    book = workbook(build_kitchen_workbook([project("p", "completed")], followups))
    rows = records(book["Follow-Ups"])
    assert [row["Follow-Up Number"] for row in rows] == [1, 2, 3]
    assert all(row["Stage"] == "Lead" and row["Project Record ID"] == "p" for row in rows)
    assert rows[0]["Follow-Up Date"] == datetime(2026, 10, 10)


def matches(row, query):
    for field, expected in query.items():
        if field == "$and":
            if not all(matches(row, item) for item in expected):
                return False
        elif isinstance(expected, dict):
            if "$in" in expected and row.get(field) not in expected["$in"]:
                return False
            if "$exists" in expected and (field in row) != expected["$exists"]:
                return False
        elif row.get(field) != expected:
            return False
    return True


class Cursor:
    def __init__(self, rows):
        self.rows = copy.deepcopy(rows)
    def sort(self, keys):
        self.rows.sort(key=lambda row: tuple(str(row.get(key) or "") for key, _ in keys))
        return self
    def skip(self, offset):
        self.rows = self.rows[offset:]
        return self
    def limit(self, count):
        self.rows = self.rows[:count]
        return self
    def max_time_ms(self, _):
        return self
    async def to_list(self, count):
        return self.rows[:count]


class Collection:
    def __init__(self, rows):
        self.rows = rows
    def find(self, query, projection=None):
        return Cursor([row for row in self.rows if matches(row, query)])
    def aggregate(self, pipeline, **_):
        # Real Mongo integration covers the commercial projection expressions.
        cursor = Cursor(self.rows)
        for item in pipeline:
            if "$match" in item:
                cursor.rows = [row for row in cursor.rows if matches(row, item["$match"])]
            elif "$sort" in item:
                cursor.sort(list(item["$sort"].items()))
            elif "$skip" in item:
                cursor.skip(item["$skip"])
            elif "$limit" in item:
                cursor.limit(item["$limit"])
        return cursor
    async def count_documents(self, query, **_):
        return sum(matches(row, query) for row in self.rows)
    async def find_one(self, query, projection=None):
        return next((copy.deepcopy(row) for row in self.rows if matches(row, query)), None)


def database(projects, followups=(), grants=()):
    return SimpleNamespace(kitchen_projects=Collection(projects), kitchen_stage_followups=Collection(followups),
        customers=Collection([{"id": row["customer_id"], "floor_id": row["floor_id"], "name": f"Current {row['id']}", "phone": "00123"} for row in projects]),
        users=Collection([{"id": "staff", "floor_ids": ["second-floor"], "delegation_grants": list(grants)}]))


@pytest.fixture(autouse=True)
def policy(monkeypatch):
    async def stored_policy(_):
        return {}
    monkeypatch.setattr(KitchenProjectService, "policy", stored_policy)


@pytest.mark.asyncio
async def test_export_collects_more_than_one_page_canonical_contacts_and_historical_followups():
    rows = [project(f"{index:03}", "completed") for index in range(125)]
    data = database(rows, [{"project_id": "000", "floor_id": "second-floor", "stage": "lead", "number": 1, "date": "2026-10-01", "notes": "Call again", "interaction_type": "Call"}])
    owner = UserPublic(id="owner", role="owner", full_name="Owner", active_floor_id="second-floor")
    book = workbook(await KitchenWorkbookExport(data).render(owner))
    all_rows = records(book["All Customers"])
    assert len(all_rows) == 125 and len(records(book["Completed"])) == 125
    assert all_rows[0]["Customer Name"] == "Current 000"
    assert len(records(book["Follow-Ups"])) == 1


@pytest.mark.asyncio
async def test_export_intersects_view_and_export_grants_and_hides_other_stage_history():
    def grant(stage, actions):
        return build_grant(user_id="staff", resource=f"kitchen_{stage}", actions=actions, floor_id="second-floor", expires_at=None, actor_id="owner", actor_name="Owner")
    grants = [grant("design", ["view", "export"]), grant("quotation", ["view"])]
    followups = [{"project_id": "d", "floor_id": "second-floor", "stage": stage, "number": 1, "notes": stage} for stage in ("lead", "design")]
    data = database([project("d", "design"), project("q", "quotation"), project("x", "design", floor_id="first-floor"), project("deleted", "design", deleted_at="2026-11-10")], followups, grants)
    staff = UserPublic(id="staff", role="worker", full_name="Staff", custom_access=True, floor_ids=["second-floor"], active_floor_id="second-floor")
    book = workbook(await KitchenWorkbookExport(data).render(staff))
    assert [row["Project Record ID"] for row in records(book["All Customers"])] == ["d"]
    assert [row["Notes"] for row in records(book["Follow-Ups"])] == ["design"]
    assert not records(book["Quotation"])


@pytest.mark.asyncio
async def test_restricted_export_does_not_reveal_money_or_followup_notes():
    grants = [build_grant(user_id="staff", resource=resource, actions=actions, floor_id="second-floor", expires_at=None, actor_id="owner", actor_name="Owner") for resource, actions in (("kitchen_projects", ["view", "export"]), ("kitchen_restricted", ["view"]))]
    data = database([project("q", "quotation", order_amount="999.00")], [{"project_id": "q", "floor_id": "second-floor", "stage": "quotation", "number": 1, "notes": "Sensitive quote"}], grants)
    staff = UserPublic(id="staff", role="worker", full_name="Staff", custom_access=True, floor_ids=["second-floor"], active_floor_id="second-floor")
    book = workbook(await KitchenWorkbookExport(data).render(staff))
    assert records(book["Quotation"])[0]["Quotation Amount INR"] is None
    assert records(book["Follow-Ups"])[0]["Notes"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("extra", [{"active_floor_id": "first-floor"}, {"active": False}])
async def test_direct_export_rejects_inactive_or_wrong_floor(extra):
    owner = UserPublic(id="owner", role="owner", full_name="Owner", **extra)
    with pytest.raises(HTTPException) as denied:
        await KitchenWorkbookExport(database([])).render(owner)
    assert denied.value.status_code == 403


@pytest.mark.asyncio
async def test_view_without_export_cannot_download():
    grant = build_grant(user_id="staff", resource="kitchen_lead", actions=["view"], floor_id="second-floor", expires_at=None, actor_id="owner", actor_name="Owner")
    staff = UserPublic(id="staff", role="worker", full_name="Staff", custom_access=True, floor_ids=["second-floor"], active_floor_id="second-floor")
    with pytest.raises(HTTPException) as denied:
        await KitchenWorkbookExport(database([], grants=[grant])).render(staff)
    assert denied.value.status_code == 403


@pytest.mark.asyncio
async def test_row_ceiling_fails_instead_of_returning_partial_workbook(monkeypatch):
    import services.kitchen_export as exports
    monkeypatch.setattr(exports, "MAX_PROJECTS", 1)
    owner = UserPublic(id="owner", role="owner", full_name="Owner", active_floor_id="second-floor")
    with pytest.raises(HTTPException) as oversized:
        await KitchenWorkbookExport(database([project("a"), project("b")])).render(owner)
    assert oversized.value.status_code == 413
