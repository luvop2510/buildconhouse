"""Remove the discontinued brand while preserving all Hansgrohe content."""
import asyncio
import io
from types import SimpleNamespace

import pytest
from openpyxl import Workbook

from catalog_policy import removed_brand_identity, removed_brand_document, removed_supplier_row
from catalog_pipeline.adapters import get_adapter
from catalog_pipeline.adapters.hansgrohe import HansgroheAdapter
from services.catalog_service import _build_snapshot


def test_supplier_identity_matches_exact_brand_only():
    assert removed_brand_identity(" AXOR ")
    assert removed_brand_document({"name": "Axor"})
    assert not removed_brand_document({"name": "Hansgrohe", "description": "Axor parent company"})
    assert not removed_supplier_row({"name": "AX One", "family_key": "hansgrohe_axor_one"})
    assert removed_supplier_row({"collection": "AXOR"})
    with pytest.raises(ValueError):
        get_adapter("Axor")


def test_hansgrohe_extraction_unchanged_and_classifies_mixed_workbook():
    wb = Workbook()
    ws = wb.active
    ws.append(["Article No.", "Description", "MRP"])
    ws.append(["48112000", "AX One Basin mixer", 50000])
    ws.append(["26456000", "HG Raindance overhead shower Chrome", 10000])
    buf = io.BytesIO()
    wb.save(buf)
    rows, _ = HansgroheAdapter().extract(buf.getvalue(), "Showers.xlsx")
    assert [row.sku for row in rows] == ["48112000", "26456000"]
    assert [row.collection for row in rows] == ["AXOR", "Hansgrohe"]


def test_snapshot_keeps_hansgrohe_mentions_and_shared_family_photos():
    from models import ProductMedia
    shared_media = ProductMedia(product_id=None, family_key="shared-family", public_url="https://example.com/image.jpg", floor_id="first-floor", bucket="forge-products", storage_key="shared.jpg", sha1="shared").model_dump()
    snapshot = _build_snapshot(
        [{"id": "removed", "brand_id": "a", "family_key": "shared-family"},
         {"id": "folded", "brand_id": "h", "family_key": "hansgrohe_axor_one", "collection": "AXOR"},
         {"id": "keep", "brand_id": "h", "family_key": "shared-family", "name": "AXOR compatible Raindance"}],
        [shared_media],
        [{"id": "a", "name": "Axor"}, {"id": "h", "name": "Hansgrohe"}], [], [],
    )
    assert set(snapshot.product_by_id) == {"keep", "folded"}
    assert [brand["name"] for brand in snapshot.brands] == ["Hansgrohe"]
    assert "shared-family" in snapshot.media_by_family


def test_existing_review_job_cannot_recreate_excluded_supplier(monkeypatch):
    from catalog_pipeline import orchestrator

    class NoDatabaseAccess:
        def __getattr__(self, name):
            raise AssertionError("Excluded supplier must be rejected before database writes")

    monkeypatch.setattr(orchestrator, "db", NoDatabaseAccess())
    with pytest.raises(ValueError, match="no longer distributed"):
        asyncio.run(orchestrator.import_accepted({"supplier_name": "Axor", "rows": []}, "u"))


def test_old_mixed_review_job_skips_classified_excluded_rows_before_media_upload(monkeypatch):
    from catalog_pipeline import orchestrator

    class Brands:
        async def find_one(self, *_args):
            return {"id": "h", "name": "Hansgrohe"}

    class Categories:
        def find(self, *_args):
            return self

        async def to_list(self, *_args):
            return []

    monkeypatch.setattr(orchestrator, "db", SimpleNamespace(brands=Brands(), categories=Categories()))
    stats = asyncio.run(orchestrator.import_accepted({"supplier_name": "Hansgrohe", "rows": [
        {"status": "accepted", "name": "AX One mixer", "collection": "AXOR", "row_id": "a", "sku": "48112000"},
    ]}, "u"))
    assert stats["skipped"] == 1
    assert stats["imported"] == 0
