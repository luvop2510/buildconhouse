"""Historical imports preserve commercial snapshots and commit atomically."""
import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from scripts import import_customer_orders as importer


def manifest():
    def item(sku, brand, product, row, mrp, qty, discount):
        return dict(sheet="Bathroom", row=row, sku=sku, name=f"Source {sku}",
                    brand_name=brand, category_id="category", product_id=product,
                    mrp=mrp, qty=qty, unit_price=mrp, discount_pct=discount,
                    net_amount=mrp * qty * (1-discount/100), room="Master",
                    source_values={"original_offer": None})
    return dict(batch_id="fixture-import", floor_id="first-floor", actor_id="owner",
                orders=[dict(source_file="/private/fixture.xlsx", source_sha256="a"*64,
                             customer={"name":"Existing Buyer", "phone":"9876543210"},
                             date="2026-09-18", referrer={"name":"Interior A", "type":"interior_designer"},
                             items=[item("A", "Brand A", "product-a", 3, 123.45, 2, 40),
                                    item("B", "Brand B", "product-b", 4, 0, 3, 0)],
                             subtotal=246.9, discount_total=98.76, grand_total=148.14)])


def _value(doc, dotted):
    value = doc
    for key in dotted.split("."):
        value = value.get(key) if isinstance(value, dict) else None
    return value


def _matches(doc, query):
    import re
    for key, expected in query.items():
        if key == "$or":
            if not any(_matches(doc, part) for part in expected): return False
            continue
        value = _value(doc, key)
        if isinstance(expected, dict):
            for operator, operand in expected.items():
                if operator == "$in" and value not in operand: return False
                if operator == "$ne" and value == operand: return False
                if operator == "$regex" and not re.search(operand, str(value or "")): return False
        elif value != expected: return False
    return True


class Cursor:
    def __init__(self, docs): self.docs = docs
    async def to_list(self, _length): return deepcopy(self.docs)


class Collection:
    def __init__(self): self.docs = []
    def find(self, query, projection=None, **kwargs):
        docs = [deepcopy(doc) for doc in self.docs if _matches(doc, query)]
        if projection and projection.get("_id") == 0:
            for doc in docs: doc.pop("_id", None)
        return Cursor(docs)
    async def find_one(self, query, projection=None, **kwargs):
        docs = await self.find(query, projection).to_list(None)
        return docs[0] if docs else None
    async def insert_one(self, doc, **kwargs): self.docs.append(deepcopy(doc))
    async def update_one(self, query, update, upsert=False, **kwargs):
        found = next((doc for doc in self.docs if _matches(doc, query)), None)
        if found is None and upsert:
            found = deepcopy(update.get("$setOnInsert", query)); self.docs.append(found)
        if found is not None: found.update(deepcopy(update.get("$set", {})))


class Database:
    name = "fixture"
    def __init__(self): self.collections = {}
    def __getitem__(self, key): return self.collections.setdefault(key, Collection())
    def __getattr__(self, key): return self[key]


def database():
    db = Database()
    db.floors.docs = [{"id":"first-floor"}]
    db.users.docs = [{"id":"owner", "full_name":"Owner", "role":"owner", "active":True}]
    db.categories.docs = [{"id":"category", "floor_id":"first-floor"}]
    db.customers.docs = [{"id":"unrelated", "name":"Legacy Test", "phone":"123", "floor_id":"first-floor"}]
    db.brands.docs = [{"id":f"brand-{s}", "name":f"Brand {s.upper()}", "slug":s, "floor_id":"first-floor"} for s in "ab"]
    db.products.docs = [dict(id=f"product-{s}", sku=s.upper(), name="Catalog name", floor_id="first-floor",
                            category_id="category", brand_id=f"brand-{s}", mrp=999, price=999, active=True) for s in "ab"]
    return db


class Session:
    def __init__(self, db): self.db = db
    async def __aenter__(self): return self
    async def __aexit__(self, *_): pass
    def start_transaction(self):
        db = self.db
        class Transaction:
            async def __aenter__(self): self.before = deepcopy(db.collections)
            async def __aexit__(self, typ, *_):
                if typ: db.collections = self.before
        return Transaction()


def test_exact_source_arithmetic_and_zeros():
    data = manifest(); importer.validate_manifest(data)
    data["orders"][0]["items"][1]["net_amount"] = 0.01
    with pytest.raises(importer.ImportConflict, match="net amount"):
        importer.validate_manifest(data)


def test_duplicate_row_and_mismatched_total_refused():
    data = manifest(); data["orders"][0]["items"][1]["row"] = 3
    with pytest.raises(importer.ImportConflict, match="Duplicate"):
        importer.validate_manifest(data)
    data = manifest(); data["orders"][0]["grand_total"] = 148.15
    with pytest.raises(importer.ImportConflict, match="grand_total"):
        importer.validate_manifest(data)


def test_preflight_preserves_source_and_canonical_utc():
    plan = asyncio.run(importer.prepare_plan(database(), manifest(), "manifest-hash"))
    quote = plan["orders"][0]
    assert quote["ordered_at"] == "2026-09-17T18:30:00+00:00"
    assert quote["doc_date"] == "2026-09-18"
    assert plan["customers"][0]["document"]["created_at"] == quote["ordered_at"]
    assert quote["referrer_name"] == "Interior A"
    assert quote["items"][0]["name"] == "Source A"
    assert quote["items"][0]["mrp"] == 123.45
    assert quote["items"][0]["catalog_mrp"] == 999
    assert quote["items"][1]["net_amount"] == 0
    assert quote["items"][1]["qty"] == 3
    assert [line["sort_order"] for line in quote["items"]] == [0, 1]
    assert "email" not in plan["customers"][0]["document"]


def test_revised_source_and_brand_mismatch_refused():
    db = database(); data = manifest()
    db.quotations.docs = [{"id":"old", "historical_import":{"source_file":data["orders"][0]["source_file"], "source_sha256":"b"*64}}]
    with pytest.raises(importer.ImportConflict, match="outside this batch"):
        asyncio.run(importer.prepare_plan(db, data, "hash"))
    db.quotations.docs = []; data["orders"][0]["items"][0]["brand_name"] = "Brand B"
    with pytest.raises(importer.ImportConflict, match="brand"):
        asyncio.run(importer.prepare_plan(db, data, "hash"))


def test_new_brand_and_catalog_product_keep_exact_zero_price():
    db = database(); data = manifest()
    data["new_brands"] = [{"id":"brand-new", "name":"American Standard", "slug":"american-standard", "floor_id":"first-floor"}]
    data["new_products"] = [{"id":"new-product", "sku":"FFASS-EXACT", "name":"Body Shower", "brand_id":"brand-new", "category_id":"category", "floor_id":"first-floor", "mrp":0, "price":0}]
    data["orders"][0]["items"][1].update(product_id="new-product", brand_name="American Standard", sku="FFASS-EXACT")
    plan = asyncio.run(importer.prepare_plan(db, data, "hash"))
    assert plan["new_brands"][0]["name"] == "American Standard"
    assert plan["new_products"][0]["price"] == 0
    assert plan["orders"][0]["items"][1]["qty"] == 3


@pytest.mark.parametrize("fail_projection", [False, True])
def test_transaction_real_order_projections_and_replay(monkeypatch, tmp_path, fail_projection):
    from services import domain_outbox, sequence
    from services.analytics import cache
    from routes import quotation_routes
    db = database(); data = manifest()
    client = SimpleNamespace(start_session=AsyncMock(side_effect=lambda: Session(db)))
    monkeypatch.setattr(domain_outbox, "db", db)
    monkeypatch.setattr(sequence, "_seed_from_existing", AsyncMock())
    monkeypatch.setattr(domain_outbox, "_next_po_number", AsyncMock(side_effect=["FPO-1", "FPO-2"]))
    monkeypatch.setattr(domain_outbox, "_bump_analytics_versions", AsyncMock())
    monkeypatch.setattr(cache, "bump", AsyncMock())
    monkeypatch.setattr(quotation_routes, "_complete_order_notebook_followups", AsyncMock())
    monkeypatch.setattr(quotation_routes, "_complete_pre_confirmation_followups", AsyncMock())
    if fail_projection:
        monkeypatch.setattr(domain_outbox, "_handle_order_placed", AsyncMock(side_effect=RuntimeError("projection failure")))
    async def scenario():
        plan = await importer.prepare_plan(db, data, "manifest-hash")
        if fail_projection:
            with pytest.raises(RuntimeError, match="projection failure"):
                await importer.apply_plan(db, client, data, "manifest-hash", plan, tmp_path)
            assert not db.quotations.docs and not db.payments.docs and not db.referrers.docs
            assert len(db.customers.docs) == 1
            return
        result = await importer.apply_plan(db, client, data, "manifest-hash", plan, tmp_path)
        assert result["orders"] == 1
        assert len(db.purchase_orders.docs) == 2
        assert all(item["stage"] == "po_final" for po in db.purchase_orders.docs for item in po["items"])
        assert sorted(po["grand_total"] for po in db.purchase_orders.docs) == [0, 148.14]
        assert len(db.payments.docs) == 1
        assert db.payments.docs[0]["amount"] == 148.14
        assert db.payments.docs[0]["status"] == "pending"
        assert "idempotency_key" not in db.payments.docs[0]
        retry = await importer.prepare_plan(db, data, "manifest-hash")
        assert retry["already_applied"]
        assert len(db.quotations.docs) == 1
        db.quotations.docs[0]["grand_total"] += 1
        with pytest.raises(importer.ImportConflict, match="changed or is missing"):
            await importer.prepare_plan(db, data, "manifest-hash")
    asyncio.run(scenario())
