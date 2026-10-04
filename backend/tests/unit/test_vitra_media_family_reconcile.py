"""Curated Vitra rekeys preserve the exact product's photograph and audit it."""
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from scripts.reconcile_supplier_workbooks import apply_product_media_family_updates, product_media_family_updates
from scripts.reconcile_vitra_2026_27 import _payload, _source_rows
from services.catalog_media_integrity import find_media_integrity_issues


@pytest.mark.parametrize("sku,old_family", [
    ("7231B403H6216", "vitra:csw:v-care-prime:rim-ex-smart-wc"),
    ("7870B403H0075", "vitra:csw:quantum:rim-ex-wc"),
    ("7484B003H0075", "vitra:csw:zentrum-square:rim-ex-wc"),
    ("8300B003-6402", "vitra:csw:m60:smoothflush-wc"),
    ("8302B003-6404", "vitra:csw:m50:aquavortex-wc"),
])
def test_curated_source_rekeys_product_owned_media_without_image_substitution(sku, old_family):
    rows = _source_rows()
    source = next(row for row in rows if row["code"] == sku)
    product = {"id": "vitra-product", "sku": sku, "mrp": 100, "family_key": old_family,
               "brand_id": "vitra", "floor_id": "first-floor"}
    payload = _payload(source, "category", product, {row["code"] for row in rows}, set())
    media = {"id": "owned-photo", "product_id": product["id"], "brand_id": "vitra", "floor_id": "first-floor",
             "family_key": old_family, "sha1": "original-bytes", "storage_key": "vitra/exact-photo.webp", "width": 300, "height": 200}
    before = deepcopy(media)
    changes = product_media_family_updates([(product, payload)], [media, {**media, "id": "unowned", "product_id": None}])
    assert len(changes) == 1
    assert changes[0]["after"] == {"family_key": payload["family_key"]}
    assert media == before
    assert find_media_integrity_issues([{**product, **payload}], [{**media, **changes[0]["after"]}]) == []
    assert product_media_family_updates([({**product, **payload}, payload)], [{**media, **changes[0]["after"]}]) == []


@pytest.mark.asyncio
async def test_common_reconciliation_media_writer_uses_exact_owner_cas_and_same_transaction_for_audit():
    session = object()
    media = SimpleNamespace(bulk_write=AsyncMock(return_value=SimpleNamespace(matched_count=1)))
    audits = SimpleNamespace(insert_many=AsyncMock())
    change = {"media_id": "photo", "product_id": "product", "brand_id": "vitra", "floor_id": "first-floor",
              "before": {"family_key": "old", "storage_key": "same-photo", "sha1": "same-hash", "width": 300, "height": 200},
              "after": {"family_key": "new"}}
    await apply_product_media_family_updates(SimpleNamespace(product_media=media, media_repair_audits=audits), [change], session=session, actor="source-reconciliation", created_at="now")
    operations = media.bulk_write.call_args.args[0]
    assert operations[0]._filter == {"id": "photo", "product_id": "product", "brand_id": "vitra", "floor_id": "first-floor", "family_key": "old"}
    assert operations[0]._doc == {"$set": {"family_key": "new"}}
    assert media.bulk_write.call_args.kwargs["session"] is session
    assert audits.insert_many.call_args.kwargs["session"] is session
    assert audits.insert_many.call_args.args[0][0]["before"] == change["before"]
    media.bulk_write.return_value = SimpleNamespace(matched_count=0)
    audits.insert_many.reset_mock()
    with pytest.raises(RuntimeError, match="aborting transaction"):
        await apply_product_media_family_updates(SimpleNamespace(product_media=media, media_repair_audits=audits), [change], session=session, actor="source-reconciliation", created_at="now")
    audits.insert_many.assert_not_called()
