# backend/tests/unit/test_catalog_import_qutone_floor_scoping.py
"""Qutone (Ground Floor Tiles) import integration — verifies the shared
orchestrator correctly floor-scopes brand/category creation and persists
the size/specs fields, with ZERO Qutone-specific code inside the
orchestrator itself (everything here is the same generic path every brand
already goes through)."""
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
        query = query or {}
        matched = [d for d in self.docs.values() if all(d.get(k) == v for k, v in query.items() if not isinstance(v, dict))]
        return _FakeCursor(matched)

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


class _FakeDb:
    def __init__(self):
        self.brands = _FakeCollection()
        self.categories = _FakeCollection()
        self.products = _FakeCollection()
        self.catalog_import_snapshots = _FakeCollection()


@pytest.fixture(autouse=True)
def _patch_db_and_uploads(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(orchestrator, "db", fake_db)

    async def _noop_upload(*_args, **_kwargs):
        return None

    monkeypatch.setattr(orchestrator, "_upload_supplier_images", _noop_upload)
    return fake_db


def _tile_row(row_id, sku, *, size="1200X2400", family_key="qutone:imarble-2-0:panama-dove"):
    return {
        "row_id": row_id, "status": "accepted", "sku": sku, "mrp": 225.0, "dealer_price": 225.0,
        "category": "Tiles", "name": f"Panama Dove - Matt ({size})", "series": "IMARBLE 2.0",
        "finish": "Matt", "size": size, "family_key": family_key,
        "specs": {"pcs_per_box": "1", "sqft_per_box": 31, "company_name": "QUTONE"},
    }


def test_brand_and_category_are_auto_created_scoped_to_ground_floor(_patch_db_and_uploads):
    fake_db = orchestrator.db
    job = {
        "id": "job-qutone-1", "supplier_name": "Qutone", "floor_id": "ground-floor",
        "rows": [_tile_row("r1", "QUTONE-IMARBLE20-PANAMADOVE-1200X2400-MT")],
    }

    asyncio.run(orchestrator.import_accepted(job, user_id="user-1", floor_id="ground-floor"))

    brand = next(iter(fake_db.brands.docs.values()))
    assert brand["name"] == "Qutone"
    assert brand["floor_id"] == "ground-floor"
    category = next(c for c in fake_db.categories.docs.values() if c["name"] == "Tiles")
    assert category["floor_id"] == "ground-floor"
    assert len(fake_db.categories.docs) == 1  # only Tiles — Task 2's pollution fix


def test_size_and_specs_fields_are_persisted_on_the_product(_patch_db_and_uploads):
    job = {
        "id": "job-qutone-2", "supplier_name": "Qutone", "floor_id": "ground-floor",
        "rows": [_tile_row("r1", "QUTONE-IMARBLE20-PANAMADOVE-1200X2400-MT")],
    }
    asyncio.run(orchestrator.import_accepted(job, user_id="user-1", floor_id="ground-floor"))
    fake_db = orchestrator.db
    product = next(iter(fake_db.products.docs.values()))
    assert product["size"] == "1200X2400"
    assert product["specs"]["pcs_per_box"] == "1"
    assert product["specs"]["sqft_per_box"] == 31
    assert product["floor_id"] == "ground-floor"


def test_rerunning_the_same_job_upserts_instead_of_duplicating(_patch_db_and_uploads):
    job = {
        "id": "job-qutone-3", "supplier_name": "Qutone", "floor_id": "ground-floor",
        "rows": [_tile_row("r1", "QUTONE-IMARBLE20-PANAMADOVE-1200X2400-MT")],
    }
    stats1 = asyncio.run(orchestrator.import_accepted(job, user_id="user-1", floor_id="ground-floor"))
    stats2 = asyncio.run(orchestrator.import_accepted(job, user_id="user-1", floor_id="ground-floor"))

    fake_db = orchestrator.db
    assert stats1["imported"] == 1 and stats1["updated"] == 0
    assert stats2["imported"] == 0 and stats2["updated"] == 0
    assert stats2["unchanged"] == 1
    assert len(fake_db.catalog_import_snapshots.docs) == 1  # no duplicate revision history
    assert len(fake_db.products.docs) == 1  # never duplicated


def test_different_sizes_of_the_same_family_create_separate_products(_patch_db_and_uploads):
    job = {
        "id": "job-qutone-4", "supplier_name": "Qutone", "floor_id": "ground-floor",
        "rows": [
            _tile_row("r1", "QUTONE-IMARBLE20-PANAMADOVE-1200X2400-MT", size="1200X2400"),
            _tile_row("r2", "QUTONE-IMARBLE20-PANAMADOVE-1200X1800-MT", size="1200X1800"),
        ],
    }
    stats = asyncio.run(orchestrator.import_accepted(job, user_id="user-1", floor_id="ground-floor"))
    fake_db = orchestrator.db
    assert stats["imported"] == 2
    sizes = {p["size"] for p in fake_db.products.docs.values()}
    assert sizes == {"1200X2400", "1200X1800"}
    family_keys = {p["family_key"] for p in fake_db.products.docs.values()}
    assert family_keys == {"qutone:imarble-2-0:panama-dove"}  # same family, different size variants
