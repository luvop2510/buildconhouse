import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from routes import quotation_routes
from services import sanitary_sales_pdf


@pytest.mark.parametrize("floor,should_archive", [("first-floor", True), ("ground-floor", False)])
def test_explicit_staff_pdf_starts_download_before_archiving(monkeypatch, floor, should_archive):
    async def run():
        document = {"id": "quote-1", "floor_id": floor, "customer_id": "customer-1", "doc_type": "standard"}
        pdf = b"%PDF-test"
        database = SimpleNamespace(
            quotations=SimpleNamespace(),
            customers=SimpleNamespace(find_one=AsyncMock(return_value={})),
            event_outbox=SimpleNamespace(find_one=AsyncMock(return_value={"id": "event-1"})),
        )
        archive = AsyncMock(side_effect=RuntimeError("Private store unavailable"))
        monkeypatch.setattr(quotation_routes, "db", database)
        monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", AsyncMock(return_value=document))
        monkeypatch.setattr(quotation_routes, "_build_quotation_file", AsyncMock(return_value=(pdf, "Customer quote.pdf")))
        monkeypatch.setattr(quotation_routes, "dispatch_event", AsyncMock())
        monkeypatch.setattr(sanitary_sales_pdf, "save_quotation_pdf", archive)

        response = await quotation_routes.quotation_pdf("quote-1", user=SimpleNamespace())
        assert await anext(response.body_iterator) == pdf
        archive.assert_not_awaited()
        with pytest.raises(StopAsyncIteration):
            await anext(response.body_iterator)

        if should_archive:
            assert response.headers["content-length"] == str(len(pdf))
            assert response.headers["content-encoding"] == "identity"
            archive.assert_awaited_once_with(database, document, pdf, "Customer quote.pdf")
        else:
            archive.assert_not_awaited()

    asyncio.run(run())
