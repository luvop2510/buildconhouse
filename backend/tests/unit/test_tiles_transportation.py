"""Billing and artifact contracts for saved Ground Floor Tiles transportation."""

from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock

from openpyxl import load_workbook
from pydantic import ValidationError
from pypdf import PdfReader
import pytest

from models import QuotationUpdate, TileTransportation, UserPublic
from routes import quotation_routes as routes


@pytest.mark.asyncio
@pytest.mark.parametrize(("status", "label", "entered", "amount", "note"), [
    ("pending", "Not Paid / Pending", 2500, 2500, ""),
    ("paid", "Paid", 1500, 1500, ""),
    ("to_be_decided", "Charges To Be Decided", 2500, None, "Charges will depend on the final delivery location."),
    ("customer_arranged", "Customer Will Arrange Transportation", 2500, None, "Customer will arrange the delivery."),
    ("custom", "Custom", None, None, "=Transport extra as per actual delivery charges & unloading <if required>"),
    ("custom", "Custom", 0, 0, "Transport included."),
])
async def test_saved_transportation_matches_pdf_and_excel(monkeypatch, caplog, status, label, entered, amount, note):
    item = {"id": "i1", "product_id": "p1", "sku": "TILE-1", "name": "Test Tile", "qty": 5,
            "unit_price": 1700, "net_amount": 8000, "quantity_unit": "Box"}
    doc = {"id": "q1", "doc_type": "tiles_quotation", "floor_id": "ground-floor", "number": "TQ1",
           "customer_id": "c1", "customer_name": "Customer", "address_snapshot": "12 Ring Road",
           "created_by": "u1", "created_by_name": "Sales", "subtotal": 8500, "discount_total": 500,
           "grand_total": 8100, "transportation_fee": 100, "items": [item]}

    async def update(_, operation):
        doc.update(operation["$set"])

    async def canonical(items, floor, *, include_candidates=False):
        assert floor == "ground-floor" and include_candidates
        return items

    db = SimpleNamespace(
        quotations=SimpleNamespace(find_one=AsyncMock(return_value=doc), update_one=update),
        customers=SimpleNamespace(find_one=AsyncMock(return_value={"name": "Customer"})),
    )
    monkeypatch.setattr(routes, "db", db)
    monkeypatch.setattr(routes, "_canonicalize_item_images", canonical)
    monkeypatch.setattr(routes, "_pdf_branding", AsyncMock(return_value={}))
    actor = UserPublic(id="u1", full_name="Sales", role="sales", floor_ids=["ground-floor"], active_floor_id="ground-floor")
    payload = QuotationUpdate(
        transportation=TileTransportation(status=status, amount=entered, note=note),
        transportation_fee=entered or 0,
        silent=True,
    )

    await routes.update_quotation("q1", payload, user=actor)
    await routes.update_quotation("q1", payload, user=actor)
    restored = await routes.get_quotation("q1", user=actor)
    assert restored.transportation == TileTransportation(status=status, amount=amount, note=note)
    assert restored.transportation_fee == (amount or 0)
    assert (restored.subtotal, restored.discount_total, restored.grand_total) == (8500, 500, 8000 + (amount or 0))
    assert doc["items"] == [item]

    pdf, _ = await routes._build_quotation_file(doc, {"name": "Customer"})
    pages = PdfReader(BytesIO(pdf)).pages
    assert len(pages) == 2
    assert "Freight follows the quoted transportation terms" in (pages[0].extract_text() or "")
    detail = " ".join((pages[1].extract_text() or "").split())
    assert detail.index("Test Tile") < detail.index("TRANSPORTATION") < detail.index("TOTAL QUOTE")
    assert label in detail and note in detail
    assert "Image unavailable" in detail and "product_id=p1 sku=TILE-1" in caplog.text
    if amount is None:
        assert "0.00" not in detail[detail.index(label):detail.index("SUBTOTAL")]

    response = await routes.quotation_xlsx("q1", user=actor)
    xlsx = b"".join([chunk async for chunk in response.body_iterator])
    sheet = load_workbook(BytesIO(xlsx)).active
    assert sheet["A6"].value == "Transportation"
    assert sheet["C6"].value == label
    assert sheet["E6"].value == (note or None)
    if note:
        assert sheet["E6"].data_type == "s"
    assert sheet["L6"].value == amount
    assert (sheet["L7"].value, sheet["L8"].value, sheet["L9"].value) == (8500, 500, 8000 + (amount or 0))


@pytest.mark.parametrize("amount", [-1, float("nan"), float("inf"), "1e999"])
def test_transportation_rejects_invalid_amounts(amount):
    with pytest.raises(ValidationError):
        TileTransportation(amount=amount)
