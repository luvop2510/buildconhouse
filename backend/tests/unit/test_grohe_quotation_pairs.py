from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import HTTPException
from openpyxl import load_workbook
from PIL import Image
from pypdf import PdfReader
from pptx import Presentation
import pytest

import pdf_generator
from models import UserPublic
from routes import quotation_routes as routes
from services import quotation_excel as excel, quotation_ppt


@pytest.fixture
def combination():
    wc = {"id": "wc", "product_id": "wc-product", "sku": "105536SH00",
          "name": "Essence Wall Hung WC", "description": "Rimless ceramic", "room": "Bathroom",
          "qty": 3, "mrp": 36270, "unit_price": 36270, "image": "https://example.test/wc.png"}
    seat = {"id": "seat", "product_id": "seat-product", "sku": "39577001",
            "name": "Essence Soft Close Seat Cover", "room": "Bathroom",
            "qty": 3, "mrp": 8730, "unit_price": 8730, "image": "https://example.test/seat.png",
            "included_for_line_id": "wc", "included_qty_per_parent": 1, "included_part_role": "seat_cover"}
    return [wc, seat]


def _test_png(color):
    output = BytesIO()
    Image.new("RGB", (60, 70), color=color).save(output, format="PNG")
    return output.getvalue()


def test_grohe_quote_exports_keep_both_articles_prices_and_photos(monkeypatch, combination):
    wc, seat = combination
    photos = {wc["image"]: _test_png("red"), seat["image"]: _test_png("blue")}
    monkeypatch.setattr(pdf_generator, "prefetch_product_images", lambda rows: photos)
    monkeypatch.setattr(excel, "remote_image_bytes", photos.get)
    doc = {"floor_id": "first-floor", "number": "QA-WC", "items": combination,
           "rooms": ["Bathroom"], "subtotal": 135000, "grand_total": 135000}
    customer = {"name": "Pair export QA"}
    sheet = load_workbook(BytesIO(excel.build_quotation_excel(doc, customer)), data_only=True)["BATHROOM 1"]
    assert [sheet[f"B{i}"].value for i in (3, 4)] == ["105536SH00", "39577001"]
    assert [sheet[f"E{i}"].value for i in (3, 4)] == [36270, 8730]
    assert [sheet[f"F{i}"].value for i in (3, 4)] == [3, 3]
    assert [sheet[f"K{i}"].value for i in (3, 4)] == [108810, 26190]
    assert sheet["K24"].value == 135000
    assert "Seat cover for 105536SH00" in sheet["C4"].value
    assert [Image.open(BytesIO(image._data())).convert("RGB").getpixel((20, 20)) for image in sheet._images] == [(255, 0, 0), (0, 0, 255)]

    page = PdfReader(BytesIO(pdf_generator.build_quotation_pdf(doc, customer))).pages[-1]
    content = " ".join(page.extract_text().split())
    assert content.index("105536SH00") < content.index("39577001")
    for value in ("36,270", "8,730", "1,35,000", "Seat cover for 105536SH00"):
        assert value in content
    pixels = {image.image.convert("RGB").getpixel((20, 20)) for image in page.images
              if image.image.width == 60 and image.image.height == 70}
    assert pixels == {(255, 0, 0), (0, 0, 255)}

    monkeypatch.setattr(quotation_ppt, "prefetch_urls", lambda urls: None)
    monkeypatch.setattr(quotation_ppt, "remote_image_bytes", photos.get)
    slide = Presentation(BytesIO(quotation_ppt.build_product_ppt({**doc, "customer_name": customer["name"]}))).slides[-1]
    assert {Image.open(BytesIO(shape.image.blob)).convert("RGB").getpixel((20, 20))
            for shape in slide.shapes if shape.shape_type == 13} == pixels


@pytest.mark.asyncio
async def test_saved_wc_cancellation_only_removes_its_linked_seat(monkeypatch, combination):
    wc, seat = combination
    independent = {**seat, "id": "independent", "included_for_line_id": None, "included_part_role": None}
    doc = {"id": "quote", "floor_id": "first-floor", "items": [wc, seat, independent],
           "updated_at": "2026-11-23T12:00:00Z"}
    command = AsyncMock(return_value="updated")
    monkeypatch.setattr(routes, "_apply_line_items_command", command)
    monkeypatch.setattr(routes, "log_event", AsyncMock())
    user = UserPublic(email="owner@example.com", full_name="Owner", role="owner")
    removal = routes.QuotationLineRemoval()
    with pytest.raises(HTTPException, match="Remove the WC"):
        await routes._remove_quotation_item("quote", seat["id"], removal, user, cancellation=True, document=doc)
    stale_client = routes.QuotationLineRemoval(expected_updated_at="2026-11-23T11:00:00Z")
    with pytest.raises(HTTPException, match="changed elsewhere"):
        await routes._remove_quotation_item("quote", wc["id"], stale_client, user, cancellation=True, document=doc)
    command.assert_not_awaited()
    assert await routes._remove_quotation_item("quote", wc["id"], removal, user, cancellation=True, document=doc) == "updated"
    assert command.await_args.args == ("quote", [independent])
    assert command.await_args.kwargs["expected_updated_at"] == doc["updated_at"]


@pytest.mark.asyncio
async def test_saved_wc_cancel_rejects_a_concurrent_edit_before_write(monkeypatch, combination):
    checked = {"id": "quote", "floor_id": "first-floor", "items": combination,
               "updated_at": "2026-11-23T12:00:00Z"}
    concurrent = {**checked, "updated_at": "2026-11-23T12:00:01Z"}
    write = AsyncMock()
    monkeypatch.setattr(routes, "db", SimpleNamespace(quotations=SimpleNamespace(update_one=write)))
    monkeypatch.setattr(routes, "get_floor_scoped_or_404", AsyncMock(return_value=concurrent))
    user = UserPublic(email="owner@example.com", full_name="Owner", role="owner")
    with pytest.raises(HTTPException, match="changed elsewhere") as caught:
        await routes._remove_quotation_item(
            "quote", "wc", routes.QuotationLineRemoval(), user, cancellation=True, document=checked,
        )
    assert caught.value.status_code == 409
    write.assert_not_awaited()


@pytest.mark.asyncio
async def test_quotation_copy_remaps_seat_links_and_preserves_the_pair_prices(monkeypatch, combination):
    original = {"id": "quote", "customer_id": "customer", "rooms": ["Bathroom"], "items": combination}
    create = AsyncMock()
    monkeypatch.setattr(routes, "create_quotation", create)
    monkeypatch.setattr(routes, "db", SimpleNamespace(quotations=SimpleNamespace(find_one=AsyncMock(return_value=original))))
    user = UserPublic(email="owner@example.com", full_name="Owner", role="owner")
    await routes.duplicate_quotation("quote", user)
    wc, seat = create.await_args.args[0].items
    assert wc.id != combination[0]["id"] and seat.id != combination[1]["id"]
    assert seat.included_for_line_id == wc.id
    assert seat.included_part_role == "seat_cover"
    assert wc.mrp + seat.mrp == 45000
