"""PPT downloads hydrate exact product parts and leave generation off the event loop."""
import asyncio
from io import BytesIO
from types import SimpleNamespace

from fastapi import HTTPException
import pytest
from pptx import Presentation

from routes import quotation_routes
from services import quotation_ppt


def test_ppt_endpoint_hydrates_parts_on_document_floor_before_threaded_render(monkeypatch):
    calls = []
    document = {"id": "q-ppt", "floor_id": "first-floor", "customer_name": "Review Customer", "items": [{"sku": "BODY-1"}]}

    async def lookup(*args, **kwargs):
        return document

    async def primary(items, floor_id):
        assert floor_id == "first-floor"
        calls.append("primary")
        return [{**item, "image": "https://test/body.png"} for item in items]

    async def parts(items, floor_id):
        calls.append(("parts", floor_id))
        return [{**item, "seat_cover_image_urls": ["https://test/seat.png"]} for item in items]

    async def threadpool(builder, enriched):
        calls.append(("threadpool", builder, enriched))
        return b"PK-test-ppt"

    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", lookup)
    monkeypatch.setattr(quotation_routes, "_canonicalize_item_images", primary)
    monkeypatch.setattr(quotation_routes, "_diagram_items", parts)
    monkeypatch.setattr(quotation_routes, "run_in_threadpool", threadpool)
    response = asyncio.run(quotation_routes.quotation_pptx("q-ppt", user=object()))
    assert calls[:2] == ["primary", ("parts", "first-floor")]
    assert calls[2][1] is quotation_routes.build_product_ppt
    assert calls[2][2]["items"][0]["seat_cover_image_urls"] == ["https://test/seat.png"]
    assert response.media_type == "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    assert "Review%20Customer%20PPT%20" in response.headers["Content-Disposition"]


def test_ppt_endpoint_rejects_empty_quotation_without_a_server_error(monkeypatch):
    async def lookup(*args, **kwargs):
        return {"id": "empty", "floor_id": "first-floor", "items": []}

    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", lookup)
    with pytest.raises(HTTPException) as error:
        asyncio.run(quotation_routes.quotation_pptx("empty", user=object()))
    assert error.value.status_code == 422
    assert "Add products" in error.value.detail


def test_ppt_endpoint_never_fetches_foreign_floor_hero_or_persisted_snapshot(monkeypatch):
    async def lookup(*args, **kwargs):
        return {"id": "bad-historical", "floor_id": "first-floor", "items": [
            {"product_id": "foreign", "sku": "F", "name": "Product", "room": "Bath", "image": "https://cdn.test/foreign-snapshot.png"},
        ]}

    async def snapshot():
        return SimpleNamespace(product_by_id={"foreign": {"id": "foreign", "floor_id": "ground-floor", "sku": "F"}},
                               media_rows_by_product={"foreign": [{"product_id": "foreign", "public_url": "https://cdn.test/foreign.png"}]})

    async def parts(items, floor_id):
        assert floor_id == "first-floor"
        return items

    fetched = []
    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", lookup)
    monkeypatch.setattr(quotation_routes.catalog_service, "get_catalog_snapshot", snapshot)
    monkeypatch.setattr(quotation_routes, "_diagram_items", parts)
    monkeypatch.setattr(quotation_ppt, "prefetch_urls", lambda urls: fetched.extend(urls))
    monkeypatch.setattr(quotation_ppt, "remote_image_bytes", lambda url: fetched.append(url))

    async def download():
        response = await quotation_routes.quotation_pptx("bad-historical", user=object())
        return b"".join([chunk async for chunk in response.body_iterator])

    deck = Presentation(BytesIO(asyncio.run(download())))
    assert len(deck.slides) == 2
    assert fetched == []
