"""End-to-end Sanitary sales arithmetic and exports on disposable local Mongo."""
from __future__ import annotations

import asyncio
import os
import re
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal
from io import BytesIO
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorClient
from openpyxl import load_workbook

FLOOR = "first-floor"
BASE = "/api/sanitary-sales"
START = "2026-10-09T18:30:00+00:00"
END = "2026-10-10T18:29:59.999000+00:00"
OUTSIDE = "2026-10-10T18:30:00+00:00"
CUSTOM = {"preset": "custom", "date_from": "2026-10-10", "date_to": "2026-10-10"}
REPORTS = (
    "pending-company", "pending-interior", "placed-company",
    "placed-interior", "products", "interior-orders",
)


def _line(id, product, qty, mrp, offer, *, size="310 mm", finish="Chrome"):
    sku, name = {
        "rain": ("R310", "Rainshower"),
        "thermostat": ("T20", "Thermostat"),
        "elbow": ("E52", "Wall elbow"),
        "basin": ("B60", "Countertop basin"),
    }[product]
    return {
        "id": id, "product_id": product, "sku": sku, "name": name,
        "qty": qty, "quantity_unit": "Pieces", "unit_price": 999.99,
        "net_amount": offer, "mrp": mrp, "size": size, "finish": finish,
    }


def _quote(id, customer, items, *, status="draft", created_at=START, ordered_at=None, **extra):
    return {
        "id": id, "number": id.upper(), "floor_id": FLOOR, "doc_type": "standard",
        "customer_id": customer, "customer_name": {"c1": "Aarav Desai", "c2": "Riya Mehta", "c3": "Ishaan Shah"}[customer],
        "status": status, "created_at": created_at, "updated_at": "2026-11-04T07:00:00+00:00",
        "ordered_at": ordered_at, "items": items,
        "grand_total": sum(item["net_amount"] for item in items), **extra,
    }


async def _seed(db):
    await db.brands.insert_many([
        {"id": "grohe", "name": "Grohe", "floor_id": FLOOR},
        {"id": "hansgrohe", "name": "Hansgrohe", "floor_id": FLOOR},
        {"id": "vitra", "name": "Vitra", "floor_id": FLOOR},
        {"id": "foreign-company", "name": "Ground catalogue", "floor_id": "ground-floor"},
    ])
    await db.products.insert_many([
        {"id": id, "brand_id": brand, "floor_id": FLOOR, "mrp": 999_999}
        for id, brand in (("rain", "grohe"), ("thermostat", "hansgrohe"), ("elbow", "hansgrohe"), ("basin", "vitra"))
    ])
    await db.customers.insert_many([
        {"id": "c1", "name": "Aarav Desai", "phone": "9000000001", "floor_id": FLOOR, "referrer_id": "r1"},
        {"id": "c2", "name": "Riya Mehta", "phone": "9000000002", "floor_id": FLOOR, "referrer_id": "r1"},
        {"id": "c3", "name": "Ishaan Shah", "phone": "9000000003", "floor_id": FLOOR},
        {"id": "c1", "name": "Ground contact", "phone": "9000000009", "floor_id": "ground-floor"},
    ])
    # Two distinct architects have the same display name.
    await db.referrers.insert_many([
        {"id": id, "name": "Nisha Shah", "type": "architect", "floor_id": FLOOR}
        for id in ("r1", "r2")
    ])
    r1 = {"referrer_id": "r1", "referrer_name": "Nisha Shah", "referrer_type": "architect"}
    r2 = {**r1, "referrer_id": "r2"}
    draft_lines = [
        _line("a", "rain", 2, 150_000.05, 200_000.01),
        _line("b", "thermostat", 1, 399_999.11, 300_000.02),
    ]
    first_order_lines = [
        _line("r-a", "rain", 60, 3_000, 60_000.01),
        _line("r-b", "rain", 40, 3_000, 40_000),
        _line("elbow-a", "elbow", 2, 50, 50.01, size="52 mm"),
    ]
    await db.quotations.insert_many([
        _quote("draft-1", "c1", draft_lines, **r1, revisions=[
            {"revision_no": 1, "snapshot": {"items": [_line("old", "rain", 2, 1_000_000, 2_000_000)]}},
        ]),
        _quote("pending-2", "c2", [_line("c", "rain", 1, 150.11, 99.97)], **r1,
               status="pending_approval", created_at=END),
        _quote("earlier-draft", "c3", [_line("earlier", "basin", 1, 8, 5)],
               created_at="2026-10-09T18:29:59.999000+00:00"),
        _quote("future-draft", "c3", [_line("future", "basin", 1, None, 21)], created_at=OUTSIDE),
        _quote("placed-1", "c1", first_order_lines, **r1, status="ordered",
               created_at="2026-08-11T03:00:00+00:00", ordered_at=START),
        _quote("placed-2", "c1", [_line("thermo-a", "thermostat", 10, 27_000, 250_000.02)],
               **r2, status="ordered", ordered_at=END),
        _quote("placed-3", "c2", [_line("r-matt", "rain", 1, 200, 112.03, size="240 mm", finish="Matt")],
               **r1, status="ordered", ordered_at=OUTSIDE),
        _quote("lost", "c1", [_line("lost-line", "rain", 7, 1_000_000, 7_000_000)], customer_outcome="lost"),
        _quote("cancelled", "c2", [_line("cancelled-line", "rain", 4, 1_000_000, 4_000_000)],
               status="cancelled", ordered_at=END),
        _quote("ground-draft", "c1", draft_lines, floor_id="ground-floor"),
        _quote("ground-order", "c2", first_order_lines, floor_id="ground-floor", status="ordered", ordered_at=START),
    ])
    # Multiple supplier POs are projections of one placed customer order.
    await db.purchase_orders.insert_many([
        {"id": id, "floor_id": FLOOR, "quotation_id": "placed-1", "status": "ordered", "grand_total": 999_999}
        for id in ("supplier-a", "supplier-b")
    ])


@asynccontextmanager
async def _fixture(monkeypatch):
    uri = os.environ.get("SALES_TEST_MONGO_URL")
    if not uri:
        pytest.skip("Requires an explicitly selected disposable localhost Mongo")
    assert re.fullmatch(r"mongodb://127\.0\.0\.1:\d+", uri), "Explicit disposable local Mongo required"
    assert os.environ.get("PYTHON_DOTENV_DISABLED") == "1"
    from auth import get_current_user
    from models import UserPublic
    from routes import sanitary_sales_routes as routes

    client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=3000)
    db = client["sanitary_sales_qa_" + uuid4().hex]
    monkeypatch.setattr(routes, "db", db)
    app = FastAPI()

    async def actor(request: Request):
        role = request.headers.get("QA-Role", "owner")
        if role == "signed-out":
            raise HTTPException(401, "Missing bearer token")
        return UserPublic(
            id="fixture-staff", full_name="Sanitary QA", role=role,
            active_floor_id=request.headers.get("X-Floor-Id", FLOOR),
            custom_access=request.headers.get("QA-Custom") == "yes",
            floor_ids=[FLOOR],
        )

    app.dependency_overrides[get_current_user] = actor
    app.include_router(routes.router, prefix="/api")
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://sanitary-qa") as http:
            yield http, db
    finally:
        await client.drop_database(db.name)
        client.close()


async def _report(http, report, **params):
    response = await http.get(f"{BASE}/{report}", params=params)
    assert response.status_code == 200, response.text
    assert "no-store" in response.headers["cache-control"]
    return response.json()


def _value(row):
    return Decimal(str(row["value"]))


async def _reconcile(http, report, compare, **params):
    top = await _report(http, report, **params)
    groups = top["items"]
    assert [Decimal(str(x)) for x in compare] == [_value(group) for group in groups]
    assert _value(top["totals"]) == sum(_value(group) for group in groups)
    for group in groups:
        child = await _report(http, report, **params, group_id=group["id"])
        assert _value(child["totals"]) == _value(group)
        assert _value(child["totals"]) == sum(_value(row) for row in child["items"])
        if child["level"] == "customers":
            for customer in child["items"]:
                docs = await _report(http, report, **params, group_id=group["id"], customer_id=customer["id"])
                assert docs["level"] == "documents"
                assert _value(customer) == sum(_value(row) for row in docs["items"])
                assert customer["document_count"] == len({row["id"] for row in docs["items"]})
                for row in docs["items"]:
                    assert _value(row) == sum(_value(item) for item in row["items"])
        else:
            for row in child["items"]:
                assert _value(row) == sum(_value(item) for item in row["items"])
    return top


def test_sanitary_report_reconciles_from_distinct_records_and_brand_lines(monkeypatch):
    async def run():
        async with _fixture(monkeypatch) as (http, db):
            await _seed(db)
            before = await db.quotations.find({}, {"_id": 0}).sort("id", 1).to_list(100)
            brands = (await http.get(f"{BASE}/brands")).json()["items"]
            assert {row["id"] for row in brands} == {"grohe", "hansgrohe", "vitra"}

            pending = await _reconcile(http, "pending-company", ["500000.03", "99.97"], **CUSTOM)
            assert [row["statuses"] for row in pending["items"]] == [["draft"], ["pending_approval"]]
            grohe = await _reconcile(http, "pending-interior", ["200099.98"], **CUSTOM, brand_id="grohe")
            hansgrohe = await _reconcile(http, "pending-interior", ["300000.02"], **CUSTOM, brand_id="hansgrohe")
            assert _value(grohe["totals"]) + _value(hansgrohe["totals"]) == _value(pending["totals"])
            assert grohe["items"][0]["customer_count"] == 2
            mrp = await _reconcile(http, "pending-interior", ["300150.21"], **CUSTOM, brand_id="grohe", value_basis="mrp")
            assert mrp["items"][0]["customer_count"] == 2
            unassigned = await _report(http, "pending-interior", brand_id="vitra", value_basis="mrp")
            assert unassigned["items"][0]["name"] == "Unassigned"
            assert unassigned["totals"]["value"] == 8
            assert unassigned["totals"]["missing_mrp_lines"] == 1 and unassigned["notes"]
            missing = await _report(http, "pending-company", preset="custom", date_from="2026-10-11",
                                    date_to="2026-10-11", value_basis="mrp")
            assert missing["items"][0]["value"] is None

            placed = await _reconcile(http, "placed-company", ["350050.04"], **CUSTOM)
            assert placed["totals"]["document_count"] == 2
            documents = await _report(http, "placed-company", **CUSTOM, group_id=placed["items"][0]["id"])
            assert {row["id"] for row in documents["items"]} == {"placed-1", "placed-2"}
            assert {row["id"]: row["contact"] for row in documents["items"]} == {
                "placed-1": "9000000001", "placed-2": "9000000001",
            }
            assert len(next(row for row in documents["items"] if row["id"] == "placed-1")["items"]) == 3
            assert all(row["quotation_id"] == row["id"] for row in documents["items"])

            interior = await _reconcile(http, "placed-interior", ["250000.02", "100162.05"])
            assert len({row["id"] for row in interior["items"]}) == 2
            assert {row["name"] for row in interior["items"]} == {"Nisha Shah"}
            assert interior["totals"]["customer_count"] == 2
            leaders = await _reconcile(http, "interior-orders", ["100162.05", "250000.02"])
            assert [(row["customer_count"], row["document_count"]) for row in leaders["items"]] == [(2, 2), (1, 1)]
            scoped = await _reconcile(http, "interior-orders", ["250000.02", "50.01"], brand_id="hansgrohe", sort="value")
            assert [(row["customer_count"], row["document_count"]) for row in scoped["items"]] == [(1, 1), (1, 1)]

            quantity = await _reconcile(http, "products", ["100000.01", "250000.02", "50.01", "112.03"])
            assert [row["quantity"] for row in quantity["items"]] == [100, 10, 2, 1]
            rain = [row for row in quantity["items"] if row["sku"] == "R310"]
            assert {(row["size"], row["finish"]) for row in rain} == {("310 mm", "Chrome"), ("240 mm", "Matt")}
            assert len({row["id"] for row in rain}) == 2
            offer = await _reconcile(http, "products", ["250000.02", "100000.01", "112.03", "50.01"], sort="value")
            mrp = await _reconcile(http, "products", ["300000", "270000", "200", "100"], sort="value", value_basis="mrp")
            assert offer["items"][0]["name"] == "Thermostat"
            assert mrp["items"][0]["name"] == "Rainshower"
            assert mrp["totals"]["document_count"] == offer["totals"]["document_count"] == 3
            assert await db.quotations.find({}, {"_id": 0}).sort("id", 1).to_list(100) == before

    asyncio.run(run())


def test_sanitary_relative_dates_pagination_and_permissions(monkeypatch):
    async def run():
        async with _fixture(monkeypatch) as (http, db):
            today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
            dated = [(today - timedelta(days=offset)).isoformat() for offset in (0, 6, 7, 29, 30)]
            await db.quotations.insert_many([
                _quote(f"dated-{index}", "c1", [_line("date", "rain", 1, 10, 5)], created_at=day + "T08:00:00+00:00")
                for index, day in enumerate(dated)
            ])
            for preset, count, first in (("last_7_days", 2, dated[1]), ("last_30_days", 4, dated[3]), ("all_time", 5, None)):
                report = await _report(http, "pending-company", preset=preset)
                assert report["totals"]["document_count"] == count
                assert report["date_from"] == first
                assert report["date_to"] == (dated[0] if first else None)
            assert (await http.get(f"{BASE}/pending-company", params={"preset": "custom", "date_from": "2026-10-11", "date_to": "2026-10-10"})).status_code == 422
            assert (await http.get(f"{BASE}/pending-company", params={"preset": "custom", "date_from": date.max.isoformat(), "date_to": date.max.isoformat()})).status_code == 422

            await db.quotations.insert_many([
                {**_quote(f"page-{index:03d}", "c1", [_line("page-line", "rain", 1, 10, 5)]),
                 "customer_id": f"page-c{index}", "customer_name": f"Page Customer {index:03d}"}
                for index in range(125)
            ])
            page1 = await _report(http, "pending-company", page=1)
            page2 = await _report(http, "pending-company", page=2)
            last = await _report(http, "pending-company", page=6)
            assert page1["total"] == page2["total"] == last["total"] == 126
            assert (len(page1["items"]), len(page2["items"]), len(last["items"])) == (25, 25, 1)
            assert {row["id"] for row in page1["items"]}.isdisjoint(row["id"] for row in page2["items"])
            assert _value(page1["totals"]) == _value(page2["totals"]) == _value(last["totals"]) == 650

            for suffix in ("brands", *REPORTS, "products/export", "quotation-pdfs/dated-0"):
                for headers in (
                    {"QA-Role": "manager"}, {"QA-Role": "admin"}, {"QA-Role": "worker", "QA-Custom": "yes"},
                    {"X-Floor-Id": "ground-floor"},
                ):
                    assert (await http.get(f"{BASE}/{suffix}", headers=headers)).status_code == 403
                assert (await http.get(f"{BASE}/{suffix}", headers={"QA-Role": "signed-out"})).status_code == 401

    asyncio.run(run())


def _workbook_rows(sheet):
    header, *rows = sheet.iter_rows()
    return [dict(zip((cell.value for cell in header), row, strict=True)) for row in rows]


@pytest.mark.parametrize("report", REPORTS)
def test_sanitary_exports_match_the_filtered_report_and_full_details(monkeypatch, report):
    async def run():
        async with _fixture(monkeypatch) as (http, db):
            await _seed(db)
            sort = "customers" if report == "interior-orders" else "value"
            params = {**CUSTOM, "brand_id": "hansgrohe", "value_basis": "mrp", "sort": sort}
            page = await _report(http, report, **params, page_size=1)
            assert page["totals"]["document_count"] == (1 if report.startswith("pending") else 2)
            all_groups = await _report(http, report, **params)
            response = await http.get(f"{BASE}/{report}/export", params=params)
            assert response.status_code == 200, response.text
            assert "no-store" in response.headers["cache-control"]
            assert response.headers["content-type"].endswith("spreadsheetml.sheet")
            assert f"Sanitary_{report}_Hansgrohe_2026-10-10_2026-10-10_mrp.xlsx" in response.headers["content-disposition"]
            book = load_workbook(BytesIO(response.content))
            assert book.sheetnames == ["Summary", "Details", "Filters"]
            assert book["Summary"].freeze_panes == "A2"
            assert book["Details"].column_dimensions["A"].width > 20
            summary = _workbook_rows(book["Summary"])
            details = _workbook_rows(book["Details"])
            selected = "Selected value (INR)"
            count = "Quotations" if report.startswith("pending") else "Placed orders"
            assert [row["Report group ID"].value for row in summary] == [row["id"] for row in all_groups["items"]]
            assert len(summary) == page["total"]
            assert {row["Brand"].value for row in details} == {"Hansgrohe"}
            assert len({(row["Document ID"].value, row["Line ID"].value) for row in details}) == len(details)
            assert len({row["Document ID"].value for row in details}) == page["totals"]["document_count"]
            for row, expected in zip(summary, all_groups["items"], strict=True):
                assert row[count].value == expected["document_count"]
                assert row["Customers"].value == expected["customer_count"]
                assert row[selected].value == expected["value"]
                assert row[selected].data_type == "n" and "₹" in row[selected].number_format
                underlying = [d for d in details if d["Report group ID"].value == expected["id"]]
                assert sum(Decimal(str(detail[selected].value)) for detail in underlying) == _value(expected)
            assert all(row["Report date"].is_date and row["Report date"].value.date().isoformat() == CUSTOM["date_from"] for row in details)

            filters = dict(book["Filters"].values)
            assert filters["Company"] == "Hansgrohe"
            assert filters["Start date"].date().isoformat() == CUSTOM["date_from"]
            assert filters["End date"].date().isoformat() == CUSTOM["date_to"]
            assert filters["Value basis"] == "MRP"
            assert filters["Sorted by"] == sort.title()
            assert filters["Total selected value (inr)"] == page["totals"]["value"]
            assert filters["Total " + count.lower()] == page["totals"]["document_count"]
            book.close()

    asyncio.run(run())


def test_sanitary_latest_saved_pdf_matches_current_revision_and_floor(monkeypatch):
    from reportlab.pdfgen.canvas import Canvas

    def pdf(label):
        buffer = BytesIO()
        canvas = Canvas(buffer)
        canvas.drawString(72, 700, label)
        canvas.save()
        return buffer.getvalue()

    class PrivateStorage:
        def __init__(self):
            self.files = {}

        async def require_private_bucket(self, bucket):
            assert bucket == "fixture-private"

        async def upload(self, *, bucket, key, data, **options):
            assert bucket == "fixture-private" and not options["upsert"] and key not in self.files
            self.files[key] = data

        async def download(self, *, bucket, key):
            assert bucket == "fixture-private"
            return self.files[key]

    async def run():
        async with _fixture(monkeypatch) as (http, db):
            from services import sanitary_sales_pdf
            await _seed(db)
            storage = PrivateStorage()
            monkeypatch.setattr(sanitary_sales_pdf, "private_bucket", lambda: "fixture-private")
            monkeypatch.setattr(sanitary_sales_pdf, "get_media_storage", lambda: storage)

            earlier, latest = pdf("Earlier saved drawing"), pdf("Latest saved drawing")
            doc = await db.quotations.find_one({"id": "draft-1", "floor_id": FLOOR})
            await sanitary_sales_pdf.save_quotation_pdf(db, doc, earlier, "DRAFT-1.pdf")
            await sanitary_sales_pdf.save_quotation_pdf(db, doc, latest, "DRAFT-1.pdf")

            sales = await _report(http, "pending-company", **CUSTOM)
            details = await _report(http, "pending-company", **CUSTOM, group_id=sales["items"][0]["id"])
            assert details["items"][0]["pdf_available"]
            response = await http.get(f"{BASE}/quotation-pdfs/draft-1")
            assert response.status_code == 200
            assert response.headers["content-type"] == "application/pdf"
            assert 'filename="DRAFT-1.pdf"' in response.headers["content-disposition"]
            assert "no-store" in response.headers["cache-control"]
            assert response.content == latest
            assert (await http.get(f"{BASE}/quotation-pdfs/pending-2")).status_code == 404
            assert (await http.get(f"{BASE}/quotation-pdfs/ground-draft")).status_code == 404

            await db.quotations.update_one({"id": "draft-1", "floor_id": FLOOR},
                                          {"$set": {"updated_at": "2026-11-04T08:00:00+00:00"}})
            edited = await _report(http, "pending-company", **CUSTOM, group_id=sales["items"][0]["id"])
            assert not edited["items"][0]["pdf_available"]
            assert (await http.get(f"{BASE}/quotation-pdfs/draft-1")).status_code == 404

    asyncio.run(run())


def test_sanitary_uses_recorded_quotation_date_and_placed_date_separately(monkeypatch):
    async def run():
        async with _fixture(monkeypatch) as (http, db):
            await db.quotations.insert_many([
                _quote("imported", "c1", [_line("imported-line", "rain", 2, 20, 25)],
                       created_at="2026-11-02T09:00:00+00:00", doc_date="2026-10-10"),
                _quote("later-document", "c1", [_line("later-line", "rain", 1, 100, 75)],
                       created_at=START, doc_date="2026-10-11"),
                _quote("converted-import", "c2", [_line("converted-line", "rain", 1, 14, 12)],
                       status="ordered", ordered_at=END, doc_date="2026-09-01", created_at=OUTSIDE),
            ])
            pending = await _report(http, "pending-company", **CUSTOM)
            assert _value(pending["totals"]) == 25 and pending["totals"]["document_count"] == 1
            pending_records = await _report(http, "pending-company", **CUSTOM, group_id=pending["items"][0]["id"])
            assert [(row["id"], row["date"]) for row in pending_records["items"]] == [("imported", "2026-10-10")]
            placed = await _report(http, "placed-company", **CUSTOM)
            assert _value(placed["totals"]) == 12 and placed["totals"]["document_count"] == 1
            order_records = await _report(http, "placed-company", **CUSTOM, group_id=placed["items"][0]["id"])
            assert [(row["id"], row["date"], row["quotation_date"]) for row in order_records["items"]] == [
                ("converted-import", "2026-10-10", "2026-09-01"),
            ]

    asyncio.run(run())
