from __future__ import annotations

import asyncio
import copy
from types import SimpleNamespace

import pytest

from scripts import godown_workbook_intake as intake
from scripts import replace_godown_stock as replace


def source(file="STOCK GROHE.xlsx", row=3):
    return {"file": file, "sheet": "Stock", "row": row, "section": None, "embedded_images": []}


def raw(sku="11111111", qty=1, *, file="STOCK GROHE.xlsx", row=3):
    return {"brand": "Grohe", "sku": sku, "raw_article": sku, "qty": qty, "quantity_missing": qty is None, "quantity_notes": [], "kind": "product", "sources": [source(file, row)]}


def snapshot():
    return {"brands": [{"id": "grohe", "name": "Grohe", "floor_id": "first-floor"}], "categories": [{"id": "cat", "name": "Accessories", "floor_id": "first-floor"}], "products": [{"id": "p", "sku": "11111111", "brand_id": "grohe", "category_id": "cat", "floor_id": "first-floor", "name": "Mixer", "mrp": 100}], "product_media": [], "godown_stock": [{"id": "old", "floor_id": "first-floor", "available_qty": 5, "qty_received": 7, "allocations": [{"quote": "history"}], "source_purchase_order_id": "real-po"}]}


def manifest(rows=None, snap=None):
    return intake.build_manifest({"files": [], "rows": rows or [raw()]}, snap or snapshot(), actor_id="owner", batch_id="test-stock", source_root="/tmp")


def matches(row, query):
    for key, value in query.items():
        if key == "$or":
            if not any(matches(row, q) for q in value):
                return False
        elif isinstance(value, dict):
            if "$ne" in value and row.get(key) == value["$ne"]:
                return False
            if "$in" in value and row.get(key) not in value["$in"]:
                return False
        elif row.get(key) != value:
            return False
    return True


class Collection:
    def __init__(self, rows):
        self.rows = copy.deepcopy(rows)

    def find(self, query, **kwargs):
        selected = [copy.deepcopy(r) for r in self.rows if matches(r, query)]
        async def to_list(_):
            return selected
        return SimpleNamespace(to_list=to_list)

    async def find_one(self, query, **kwargs):
        return next((copy.deepcopy(r) for r in self.rows if matches(r, query)), None)

    async def insert_one(self, doc, **kwargs):
        if any(r.get("id") == doc.get("id") for r in self.rows):
            raise ValueError("Duplicate id")
        self.rows.append(copy.deepcopy(doc))

    async def insert_many(self, documents, **kwargs):
        for document in documents:
            await self.insert_one(document, **kwargs)

    async def update_one(self, query, update, **kwargs):
        row = next((r for r in self.rows if matches(r, query)), None)
        if row:
            row.update(update["$set"])
        return SimpleNamespace(modified_count=1 if row else 0)


class Database:
    name = "test-stock"

    def __init__(self):
        self.collections = {k: Collection(v) for k, v in snapshot().items()}
        self.collections["godown_stock"].rows.append({"id": "other-floor", "floor_id": "ground-floor", "available_qty": 9})
        self.collections["users"] = Collection([{"id": "owner", "role": "owner", "active": True, "full_name": "Stock Owner"}])
        self.collections["event_outbox"] = Collection([])

    def __getitem__(self, name):
        return self.collections.setdefault(name, Collection([]))

    def __getattr__(self, name):
        return self[name]


class Session:
    def __init__(self, db):
        self.db = db

    async def __aenter__(self):
        self.saved = copy.deepcopy(self.db.collections)
        return self

    async def __aexit__(self, exc_type, exc, tb):
        if exc:
            self.db.collections = self.saved

    def start_transaction(self):
        return self


class Client:
    def __init__(self, db):
        self.db = db

    async def start_session(self):
        return Session(self.db)


def test_blank_formula_quantity_is_unknown_and_explicit_zero_is_known():
    assert intake.quantity({"G": "=D3-F3"}, {"G": 0}, qty_col="D")[0] is None
    assert intake.quantity({"D": 0, "G": "=D3-F3"}, {"G": 0}, qty_col="D")[0] == 0
    assert intake.quantity({"D": 3, "F": 1, "G": "=D3-F3"}, {}, qty_col="D")[0] == 2


def test_formula_missing_out_uses_recorded_movement_with_explicit_correction():
    qty, notes = intake.quantity({"D": 18, "F": 1, "G": "=D236+E236"}, {"G": 18}, qty_col="D")
    assert qty == 17 and any("subtracted recorded OUT" in note for note in notes)


def test_explicit_total_preserves_supplier_annotations_and_wc_photo_notes():
    qty, notes = intake.quantity({"D": 56, "F": "4 (customer)/5", "G": 47}, {}, qty_col="D")
    assert qty == 47 and "explicit recorded TOTAL" in notes[0]
    assert intake.quantity({"B": 1, "E": "return note"}, {}, qty_col="B", in_col=None)[0] == 1


def test_split_seats_on_same_row_have_distinct_stable_lot_ids():
    a, b = raw("131-483-209", 3, row=24), raw("131-083H019", 1, row=24)
    a["kind"] = b["kind"] = "seat"
    lots = manifest([a, b])["lots"]
    assert lots[0]["id"] != lots[1]["id"]
    assert manifest([a, b])["lots"][0]["id"] == lots[0]["id"]


def test_verified_mirrors_collapse_without_summing_independent_rows():
    rows = [raw("39231000", None, row=354), raw("39231000", 2, row=617), raw("39231000", 2, file="GROHE BASIN-WC  STOCK.xlsx", row=4), raw("27513001", 24, row=196), raw("27513001", 1, row=616)]
    result, decisions = intake.deduplicate_mirrors(rows)
    assert len(result) == 3 and len(decisions) == 2
    assert result[0]["qty"] == 2 and len(result[0]["sources"]) == 3
    assert [r["qty"] for r in result[1:]] == [24, 1]


def test_match_is_brand_and_floor_exact_without_ocr_guess():
    snap = snapshot()
    snap["products"].append({**snap["products"][0], "id": "wrong", "sku": "22222222", "floor_id": "ground-floor"})
    result = manifest([raw("22222222", None)], snap)["lots"][0]
    assert result["product_id"].startswith("godown:")
    assert result["quantity_missing"] and result["available_qty"] == 0
    assert result["unit_price"] is None


def test_media_requires_correct_brand_and_raster_mime():
    snap = snapshot()
    snap["product_media"] = [{"product_id": "p", "floor_id": "first-floor", "brand_id": "other", "role": "hero", "public_url": "https://wrong/image", "mime": "image/jpeg"}, {"product_id": "p", "floor_id": "first-floor", "brand_id": "grohe", "role": "hero", "public_url": "https://good/image", "mime": "image/jpeg"}]
    assert manifest(snap=snap)["lots"][0]["image"] == "https://good/image"


@pytest.mark.parametrize("change", [{"available_qty": 1, "quantity_missing": True}, {"unit_price": -1}, {"unit_price": float("inf")}, {"source_type": "catalog"}, {"floor_id": "ground-floor"}, {"image": "https://user:password@example.com/x"}])
def test_validation_rejects_unsafe_manifest_states(change):
    m = manifest()
    m["lots"][0].update(change)
    with pytest.raises(replace.ImportConflict):
        replace.validate_manifest(m)


def test_stale_stock_snapshot_is_rejected():
    db = Database()
    db.godown_stock.rows[0]["available_qty"] = 4
    with pytest.raises(replace.ImportConflict, match="changed"):
        asyncio.run(replace.prepare_plan(db, manifest(), "sha"))


def test_outstanding_loans_block_archive():
    snap = snapshot()
    snap["godown_stock"][0]["loaned_out_qty"] = 1
    db = Database()
    db.godown_stock.rows[0]["loaned_out_qty"] = 1
    with pytest.raises(replace.ImportConflict, match="loans"):
        asyncio.run(replace.prepare_plan(db, manifest(snap=snap), "sha"))


def test_replace_archives_only_old_floor_lot_and_retry_preserves_edits(monkeypatch, tmp_path):
    db, m = Database(), manifest()
    old = copy.deepcopy(db.godown_stock.rows[0])
    async def backup(*args):
        return tmp_path / "private-backup.json"
    async def staging(*args):
        return {}
    monkeypatch.setattr(replace, "backup_before_apply", backup)
    monkeypatch.setattr(replace, "stage_media", staging)
    result = asyncio.run(replace.apply_plan(db, Client(db), m, "sha", tmp_path))
    assert result["archived"] == 1
    archived = db.godown_stock.rows[0]
    assert archived == {**old, "archived": True}
    assert db.godown_stock.rows[1] == {"id": "other-floor", "floor_id": "ground-floor", "available_qty": 9}
    db.godown_stock.rows[2]["unit_price"] = 123
    retry = asyncio.run(replace.apply_plan(db, Client(db), m, "sha", tmp_path))
    assert retry["already_applied"] and len(db.godown_stock.rows) == 3
    assert db.godown_stock.rows[2]["unit_price"] == 123
    with pytest.raises(replace.ImportConflict, match="another manifest"):
        asyncio.run(replace.apply_plan(db, Client(db), m, "different", tmp_path))


def test_staging_failure_leaves_old_inventory_visible(monkeypatch, tmp_path):
    db = Database()
    old = copy.deepcopy(db.godown_stock.rows)
    async def backup(*args):
        return tmp_path / "backup.json"
    async def staging(*args):
        raise RuntimeError("storage unavailable")
    monkeypatch.setattr(replace, "backup_before_apply", backup)
    monkeypatch.setattr(replace, "stage_media", staging)
    with pytest.raises(RuntimeError, match="storage"):
        asyncio.run(replace.apply_plan(db, Client(db), manifest(), "sha", tmp_path))
    assert db.godown_stock.rows == old and db.event_outbox.rows == []


def test_concurrent_quantity_change_during_staging_blocks_apply(monkeypatch, tmp_path):
    db = Database()
    async def backup(*args):
        return tmp_path / "backup.json"
    async def staging(*args):
        db.godown_stock.rows[0]["available_qty"] = 2
        return {}
    monkeypatch.setattr(replace, "backup_before_apply", backup)
    monkeypatch.setattr(replace, "stage_media", staging)
    with pytest.raises(replace.ImportConflict, match="changed"):
        asyncio.run(replace.apply_plan(db, Client(db), manifest(), "sha", tmp_path))
    assert not db.godown_stock.rows[0].get("archived") and len(db.godown_stock.rows) == 2
