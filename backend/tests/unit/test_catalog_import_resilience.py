"""Catalog import per-row isolation + real rollback (BACKEND_AUDIT_2026-07-17.md
Critical #3) — one malformed row must not abort an otherwise-good batch, and
`rollback_job` must actually restore/remove what a job touched, not just flip
a status flag."""
from __future__ import annotations

import asyncio

import pytest

import catalog_pipeline.orchestrator as orchestrator


class _FakeCursor:
    def __init__(self, docs):
        self._docs = list(docs)

    async def to_list(self, _n):
        return list(self._docs)


class _FakeCollection:
    def __init__(self, docs=None):
        self.docs: dict[str, dict] = {d["id"]: d for d in (docs or [])}

    async def find_one(self, query, *_args, **_kwargs):
        for doc in self.docs.values():
            if all(doc.get(k) == v for k, v in query.items() if not isinstance(v, dict)):
                return dict(doc)
        return None

    def find(self, query=None, *_args, **_kwargs):
        return _FakeCursor(list(self.docs.values()))

    async def insert_one(self, doc):
        self.docs[doc["id"]] = dict(doc)

    async def insert_many(self, docs):
        for d in docs:
            d.setdefault("id", f"snap-{len(self.docs)}")
            self.docs[d["id"]] = dict(d)

    async def update_one(self, query, update):
        for doc in self.docs.values():
            if all(doc.get(k) == v for k, v in query.items() if not isinstance(v, dict)):
                doc.update(update.get("$set", {}))
                return
        raise AssertionError(f"update_one matched nothing for {query}")

    async def replace_one(self, query, replacement):
        for pid, doc in list(self.docs.items()):
            if all(doc.get(k) == v for k, v in query.items()):
                self.docs[pid] = dict(replacement)
                return type("R", (), {"modified_count": 1})()
        return type("R", (), {"modified_count": 0})()

    async def delete_one(self, query):
        for pid, doc in list(self.docs.items()):
            if all(doc.get(k) == v for k, v in query.items()):
                del self.docs[pid]
                return type("R", (), {"deleted_count": 1})()
        return type("R", (), {"deleted_count": 0})()

    async def delete_many(self, query):
        job_id = query.get("job_id")
        for pid, doc in list(self.docs.items()):
            if doc.get("job_id") == job_id:
                del self.docs[pid]


class _FakeDb:
    def __init__(self):
        self.brands = _FakeCollection([{"id": "brand-1", "name": "Grohe", "slug": "grohe", "floor_id": "first-floor"}])
        self.categories = _FakeCollection([{"id": "cat-1", "name": "Faucets", "slug": "faucets", "floor_id": "first-floor"}])
        self.products = _FakeCollection([{
            "id": "existing-product", "sku": "SKU-EXIST", "brand_id": "brand-1",
            "name": "Old Name", "mrp": 1000.0, "price": 800.0, "floor_id": "first-floor",
        }])
        self.catalog_import_snapshots = _FakeCollection()
        self.catalog_imports = _FakeCollection()


@pytest.fixture(autouse=True)
def _patch_db_and_uploads(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(orchestrator, "db", fake_db)

    async def _noop_upload(*_args, **_kwargs):
        return None

    monkeypatch.setattr(orchestrator, "_upload_supplier_images", _noop_upload)
    return fake_db


def _row(row_id, sku, mrp, *, category="Faucets"):
    return {
        "row_id": row_id, "status": "accepted", "sku": sku, "mrp": mrp,
        "category": category, "name": f"Product {sku}",
    }


def test_one_bad_row_does_not_abort_the_rest_of_the_batch(_patch_db_and_uploads):
    job = {
        "id": "job-1",
        "supplier_name": "Grohe",
        "rows": [
            _row("r1", "SKU-GOOD-1", 1500.0),
            _row("r2", "SKU-BAD", "not-a-number"),  # would crash float(r["mrp"]) uncaught
            _row("r3", "SKU-GOOD-2", 2500.0),
        ],
    }

    stats = asyncio.run(orchestrator.import_accepted(job, user_id="user-1"))

    assert stats["imported"] == 2
    assert stats["failed"] == 1
    assert len(stats["errors"]) == 1
    assert stats["errors"][0]["sku"] == "SKU-BAD"
    # The two good rows landed despite the bad one.
    fake_db = orchestrator.db
    assert any(p["sku"] == "SKU-GOOD-1" for p in fake_db.products.docs.values())
    assert any(p["sku"] == "SKU-GOOD-2" for p in fake_db.products.docs.values())


def test_rollback_restores_updated_products_and_removes_created_ones(_patch_db_and_uploads):
    fake_db = orchestrator.db
    job = {
        "id": "job-2",
        "supplier_name": "Grohe",
        "rows": [
            _row("r1", "SKU-EXIST", 9999.0),  # updates the pre-seeded existing product
            _row("r2", "SKU-NEW", 3000.0),  # creates a brand-new product
        ],
    }

    asyncio.run(fake_db.catalog_imports.insert_one({"id": "job-2", "status": "imported"}))
    asyncio.run(orchestrator.import_accepted(job, user_id="user-1"))
    assert fake_db.products.docs["existing-product"]["mrp"] == 9999.0
    new_product_id = next(
        pid for pid, p in fake_db.products.docs.items() if p["sku"] == "SKU-NEW"
    )

    result = asyncio.run(orchestrator.rollback_job("job-2"))

    assert result["products_restored"] == 1
    assert result["products_removed"] == 1
    assert fake_db.products.docs["existing-product"]["mrp"] == 1000.0  # real revert, not just reported
    assert new_product_id not in fake_db.products.docs  # actually removed, not just deactivated-and-fake-reported


def test_identical_company_update_preserves_ids_images_and_avoids_duplicate_history(_patch_db_and_uploads):
    fake_db = orchestrator.db
    fake_db.products.docs['existing-product'].update({'images': ['verified.png'], 'image_quality': 'excellent'})
    job = {'id': 'revision-job', 'supplier_name': 'Grohe', 'rows': [_row('r1', 'SKU-EXIST', 2000)]}
    asyncio.run(orchestrator.import_accepted(job, user_id='manager'))
    saved = dict(fake_db.products.docs['existing-product'])
    assert saved['catalog_version'] == 1
    assert saved['images'] == ['verified.png']
    assert saved['image_quality'] == 'excellent'
    assert saved['catalog_price_updated_at']
    count = len(fake_db.catalog_import_snapshots.docs)
    second = asyncio.run(orchestrator.import_accepted(job, user_id='manager'))
    assert second['unchanged'] == 1
    assert second['updated'] == 0
    assert fake_db.products.docs['existing-product'] == saved
    assert len(fake_db.catalog_import_snapshots.docs) == count

@pytest.mark.parametrize('value', [float('nan'), float('inf'), -1])
def test_invalid_prices_cannot_replace_catalog(_patch_db_and_uploads, value):
    original = dict(orchestrator.db.products.docs['existing-product'])
    result = asyncio.run(orchestrator.import_accepted({'supplier_name': 'Grohe', 'rows': [_row('r1', 'SKU-EXIST', value)]}, user_id='manager'))
    assert result['failed'] == 1
    assert orchestrator.db.products.docs['existing-product'] == original


def test_image_replacement_failure_keeps_prior_product_for_retry(_patch_db_and_uploads, monkeypatch):
    original = dict(orchestrator.db.products.docs['existing-product'])
    async def broken_upload(*args, **kwargs):
        raise ValueError('storage temporarily unavailable')
    monkeypatch.setattr(orchestrator, '_upload_supplier_images', broken_upload)
    result = asyncio.run(orchestrator.import_accepted({'id': 'image-job', 'supplier_name': 'Grohe', 'rows': [_row('r1', 'SKU-EXIST', 2500)]}, user_id='manager'))
    assert result['failed'] == 1
    assert orchestrator.db.products.docs['existing-product'] == original
    assert len(orchestrator.db.catalog_import_snapshots.docs) == 1  # recovery exists before mutation
