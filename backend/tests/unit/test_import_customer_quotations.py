"""Reviewed workbooks remain prospective quotations, with atomic retry safety."""
import asyncio
import hashlib
import re
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from scripts import import_customer_quotations as importer


def manifest():
    return {"batch_id": "open-fixture", "floor_id": "first-floor", "actor_id": "owner", "quotations": [
        {"source_file": "/private/brand-a.xlsx", "source_sha256": "a" * 64,
         "customer": {"name": "Prospect", "phone": "9876543210"}, "date": None,
         "reference_source": "Reference Person", "referrer": {"name": "Interior A", "type": "interior_designer"},
         "notes": "Workbook cover total retained: 999; commercial rates preserved",
         "source_summary": {"cover_total": 999, "blank_template_rows": [{"sku": "UNQUANTIFIED", "description": "Preserved in notes"}]},
         "prepared_by": "Source employee", "attended_by": "Source attendant", "doc_number": "R3",
         "items": [{"sheet": "Bathroom", "row": 3, "sku": "A", "name": "Workbook description", "brand_name": "Brand A", "category_id": "category", "product_id": "product-a", "mrp": 123.45, "qty": 2, "unit_price": 123.45, "discount_pct": 40, "net_amount": 148.14, "room": "Master", "area": "Basin", "description": "Complete source specifications", "notes": "Source offer", "image": "https://images.example/a.png", "source_values": {"formula": "=A1*B1"}},
                   {"sheet": "Bathroom", "row": 4, "sku": "B", "name": "Pending rate", "brand_name": "Brand B", "category_id": "category", "product_id": "product-b", "mrp": 999, "qty": 3, "unit_price": 0, "discount_pct": 0, "net_amount": 0, "room": "Guest", "notes": "Offer rate not provided/invalid in source; rate pending"}],
         "subtotal": 246.9, "discount_total": 98.76, "grand_total": 148.14}]}


def _matches(doc, query):
    for key, expected in query.items():
        if key == "$or":
            if not any(_matches(doc, part) for part in expected): return False
            continue
        value = doc
        for part in key.split("."):
            value = value.get(part) if isinstance(value, dict) else None
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
    def __init__(self): self.docs = []; self.fail_insert = False
    def find(self, query, projection=None, **kwargs):
        docs = [deepcopy(row) for row in self.docs if _matches(row, query)]
        if projection and projection.get("_id") == 0:
            for row in docs: row.pop("_id", None)
        return Cursor(docs)
    async def find_one(self, query, projection=None, **kwargs):
        rows = await self.find(query, projection).to_list(None)
        return rows[0] if rows else None
    async def insert_one(self, document, **kwargs):
        if self.fail_insert: raise RuntimeError("insert failure")
        if any(row.get("_id") == document.get("_id") for row in self.docs):
            raise RuntimeError("duplicate _id")
        self.docs.append(deepcopy(document))
    async def update_one(self, query, update, **kwargs):
        found = next((row for row in self.docs if _matches(row, query)), None)
        if found is not None: found.update(deepcopy(update.get("$set", {})))


class Database:
    name = "fixture"
    def __init__(self): self.collections = {}
    def __getitem__(self, key): return self.collections.setdefault(key, Collection())
    def __getattr__(self, key): return self[key]


def database():
    db = Database()
    db.floors.docs = [{"id": "first-floor"}]
    db.users.docs = [{"id": "owner", "full_name": "Owner", "role": "owner", "active": True}]
    db.categories.docs = [{"id": "category", "floor_id": "first-floor"}]
    db.customers.docs = [{"id": "unrelated", "name": "Legacy Buyer", "floor_id": "first-floor"}]
    db.brands.docs = [{"id": f"brand-{s}", "name": f"Brand {s.upper()}", "slug": s, "floor_id": "first-floor"} for s in "ab"]
    db.products.docs = [{"id": f"product-{s}", "sku": s.upper(), "name": "Catalog name", "floor_id": "first-floor", "category_id": "category", "brand_id": f"brand-{s}", "mrp": 555, "price": 333, "active": True, "images": ["https://verified.example/hero.png"]} for s in "ab"]
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


def test_read_only_plan_preserves_all_source_fields_and_pending_rate():
    db, data = database(), manifest()
    before = deepcopy(db.collections)
    plan = asyncio.run(importer.prepare_plan(db, data, "hash"))
    quote = plan["quotations"][0]
    assert quote["status"] == "draft" and quote["ordered_at"] is None
    assert quote["doc_date"] is None and quote["doc_number"] == "R3"
    assert quote["reference_source"] == "Reference Person" and quote["referrer_name"] == "Interior A"
    assert quote["prepared_by"] == "Source employee" and quote["created_by"] == "owner"
    assert quote["rooms"] == ["Master", "Guest"]
    first, second = quote["items"]
    assert (first["name"], first["description"], first["notes"], first["area"], first["image"]) == ("Workbook description", "Complete source specifications", "Source offer", "Basin", "https://images.example/a.png")
    assert (first["mrp"], first["unit_price"], first["net_amount"], first["catalog_mrp"], first["catalog_price"]) == (123.45, 123.45, 148.14, 555, 333)
    assert second["qty"] == 3 and second["mrp"] == 999 and second["unit_price"] == 0 and second["net_amount"] == 0
    assert second["notes"].endswith("rate pending") and second["quantity_unit"] == "Pieces"
    assert first["import_source"]["source_values"]["formula"] == "=A1*B1"
    assert quote["quotation_import"]["source_summary"] == data["quotations"][0]["source_summary"]
    assert "email" not in plan["customers"][0]["document"]
    assert all(db[name].docs == collection.docs for name, collection in before.items())
    assert not db.quotations.docs and not db.activity_events.docs


def test_repeated_customer_across_brands_is_one_genuinely_new_customer():
    data = manifest()
    second = deepcopy(data["quotations"][0]); second.update(source_file="/private/brand-b.xlsx", source_sha256="b" * 64, date="2026-10-02")
    second["items"] = [second["items"][1]]
    second.update(subtotal=0, discount_total=0, grand_total=0)
    data["quotations"].append(second)
    plan = asyncio.run(importer.prepare_plan(database(), data, "hash"))
    assert len(plan["customers"]) == 1 and plan["customers"][0]["previous"] is None
    assert len(plan["referrers"]) == 1
    assert len({q["customer_id"] for q in plan["quotations"]}) == 1
    assert plan["quotations"][1]["doc_date"] == "2026-10-02"
    assert len({line["id"] for q in plan["quotations"] for line in q["items"]}) == 3


@pytest.mark.parametrize("outcome", ["won", "lost"])
def test_historical_outcome_groups_brand_quotes_and_preserves_commercial_source(outcome):
    db, data = database(), manifest()
    data["outcome_recorded_at"] = "2026-09-01T00:00:00+00:00"
    data["quotations"][0].update(customer_outcome=outcome, outcome_reason="Owner classified this customer")
    second = deepcopy(data["quotations"][0])
    second.update(source_file="/private/second.xlsx", source_sha256="b" * 64)
    data["quotations"].append(second)
    plan = asyncio.run(importer.prepare_plan(db, data, "hash"))
    assert len(plan["customers"]) == 1 and len(plan["followups"]) == 1
    row = plan["followups"][0]
    assert row["completed_outcome"] == outcome and row["status"] == "done"
    assert row["auto_resolved"] is (outcome == "won")
    assert row["assigned_to"] == "owner" and row["customer_phone"] == "9876543210"
    assert row["value"] == 296.28 and len(row["quotation_import"]["quotation_ids"]) == 2
    assert row["lost_reason"] == ("Owner classified this customer" if outcome == "lost" else None)
    assert all(q["customer_outcome"] == outcome and q["status"] == "draft" and q["ordered_at"] is None for q in plan["quotations"])
    again = asyncio.run(importer.prepare_plan(db, data, "hash"))
    assert plan["plan_fingerprint"] == again["plan_fingerprint"]
    assert not db.followups.docs


def test_conflicting_customer_outcomes_and_unspecified_lost_reason_are_refused():
    data = manifest()
    data["outcome_recorded_at"] = "2026-09-01T00:00:00+00:00"
    data["quotations"][0].update(customer_outcome="lost")
    with pytest.raises(importer.ImportConflict, match="reason"):
        importer.validate_manifest(data)
    data["quotations"][0]["outcome_reason"] = "Owner classified lost"
    second = deepcopy(data["quotations"][0])
    second.update(source_file="/private/second.xlsx", source_sha256="b" * 64, customer_outcome="won")
    data["quotations"].append(second)
    with pytest.raises(importer.ImportConflict, match="conflicting outcomes"):
        asyncio.run(importer.prepare_plan(database(), data, "hash"))


@pytest.mark.parametrize("failure", [None, "followups", "event_outbox"])
def test_outcome_import_is_atomic_replay_safe_and_has_no_financial_side_effects(monkeypatch, tmp_path, failure):
    from services.analytics import cache
    db, data = database(), manifest()
    data["outcome_recorded_at"] = "2026-09-01T00:00:00+00:00"
    data["quotations"][0].update(customer_outcome="won")
    client = SimpleNamespace(start_session=AsyncMock(side_effect=lambda: Session(db)))
    monkeypatch.setattr(cache, "bump", AsyncMock())
    if failure:
        db[failure].fail_insert = True
    async def scenario():
        plan = await importer.prepare_plan(db, data, "hash")
        if failure:
            with pytest.raises(RuntimeError, match="insert failure"):
                await importer.apply_plan(db, client, data, "hash", plan, tmp_path)
            assert not db.followups.docs and not db.quotations.docs and not db.event_outbox.docs
        else:
            await importer.apply_plan(db, client, data, "hash", plan, tmp_path)
            assert len(db.followups.docs) == 1
            retry = await importer.prepare_plan(db, data, "hash")
            assert retry["already_applied"]
            await importer.apply_plan(db, client, data, "hash", retry, tmp_path)
            assert len(db.followups.docs) == 1
            db.followups.docs[0]["completed_outcome"] = "lost"
            with pytest.raises(importer.ImportConflict, match="changed or is missing"):
                await importer.prepare_plan(db, data, "hash")
        assert all(not db[name].docs for name in ("purchase_orders", "payments", "customer_orders", "notifications", "counters"))
    asyncio.run(scenario())


def test_reviewed_customer_id_accepts_name_alias_only_with_exact_floor_phone():
    db, data = database(), manifest()
    db.customers.docs.append({"id": "reviewed", "name": "Existing spelling", "phone": "+91 9876543210", "floor_id": "first-floor"})
    data["quotations"][0]["customer"]["id"] = "reviewed"
    plan = asyncio.run(importer.prepare_plan(db, data, "hash"))
    assert plan["customers"][0]["previous"]["id"] == "reviewed"
    assert plan["customers"][0]["document"]["name"] == "Existing spelling"
    assert plan["quotations"][0]["customer_id"] == "reviewed"
    assert plan["quotations"][0]["customer_name"] == "Prospect"
    db.customers.docs[-1]["phone"] = "9999999999"
    with pytest.raises(importer.ImportConflict, match="exact floor-local phone"):
        asyncio.run(importer.prepare_plan(db, data, "hash"))
    db.customers.docs[-1].update(phone="9876543210", floor_id="ground-floor")
    with pytest.raises(importer.ImportConflict, match="exact floor-local phone"):
        asyncio.run(importer.prepare_plan(db, data, "hash"))


def test_shared_phone_separate_profile_requires_exact_reviewed_identity_decision():
    db, data = database(), manifest()
    db.customers.docs.append({"id": "shared", "floor_id": "first-floor", "name": "Different Person", "phone": "9876543210"})
    data["quotations"][0]["customer"]["approved_shared_phone_customer_ids"] = ["shared"]
    with pytest.raises(importer.ImportConflict, match="recorded user decision"):
        asyncio.run(importer.prepare_plan(db, data, "hash"))
    data["decisions"] = {"shared_phone_identity": "User confirmed these are separate customers sharing the supplied phone"}
    plan = asyncio.run(importer.prepare_plan(db, data, "hash"))
    assert plan["customers"][0]["document"]["id"] != "shared"
    assert plan["customers"][0]["document"]["phone"] == "9876543210"
    db.customers.docs.append({"id": "extra", "floor_id": "first-floor", "name": "Another Person", "phone": "9876543210"})
    with pytest.raises(importer.ImportConflict, match="exact reviewed"):
        asyncio.run(importer.prepare_plan(db, data, "hash"))


@pytest.mark.parametrize("mutate,match", [
    (lambda d: d.update(floor_id="ground-floor"), "first-floor"),
    (lambda d: d["quotations"][0].update(status="ordered"), "draft"),
    (lambda d: d["quotations"][0].update(ordered_at="2026-10-01"), "draft"),
    (lambda d: d["quotations"][0]["items"][1].update(row=3), "Duplicate"),
    (lambda d: d["quotations"][0].update(grand_total=148.15), "grand_total"),
    (lambda d: d["quotations"][0]["items"][1].update(net_amount=1), "net amount"),
    (lambda d: d["quotations"][0]["items"][0].update(unit_price=float("nan")), "finite"),
    (lambda d: d["quotations"][0].update(date="2026-02-30"), "date"),
])
def test_invalid_commercial_or_source_manifest_refused(mutate, match):
    data = manifest(); mutate(data)
    with pytest.raises(importer.ImportConflict, match=match): importer.validate_manifest(data)


@pytest.mark.parametrize("case", ["foreign-product", "wrong-brand", "inactive", "duplicate-source", "different-phone", "referrer-conflict", "restricted-actor"])
def test_ambiguous_or_foreign_identity_refused(case):
    db, data = database(), manifest()
    if case == "foreign-product": db.products.docs[0]["floor_id"] = "ground-floor"
    elif case == "wrong-brand": data["quotations"][0]["items"][0]["brand_name"] = "Brand B"
    elif case == "inactive": db.products.docs[0]["active"] = False
    elif case == "duplicate-source": db.quotations.docs = [{"id": "old", "quotation_import": {"source_file": data["quotations"][0]["source_file"]}}]
    elif case == "different-phone": db.customers.docs.append({"id": "old", "floor_id": "first-floor", "name": "Prospect", "phone": "9999999999"})
    elif case == "referrer-conflict": db.customers.docs.append({"id": "old", "floor_id": "first-floor", "name": "Prospect", "phone": "9876543210", "referrer_id": "other"})
    elif case == "restricted-actor": db.users.docs[0]["access_profile"] = "sanitary_quotations_followups"
    with pytest.raises(importer.ImportConflict): asyncio.run(importer.prepare_plan(db, data, "hash"))


def test_missing_catalog_product_added_without_mutating_existing_prices_or_images():
    db, data = database(), manifest(); old = deepcopy(db.products.docs)
    data["new_products"] = [{"id": "new", "sku": "NEW", "name": "Verified workbook product", "brand_id": "brand-b", "category_id": "category", "mrp": 999, "price": 999, "specs": {"source": "workbook"}, "images": ["https://verified.example/new.png"]}]
    data["quotations"][0]["items"][1].update(product_id="new", sku="NEW")
    plan = asyncio.run(importer.prepare_plan(db, data, "hash"))
    assert plan["new_products"][0]["specs"] == {"source": "workbook"}
    assert plan["new_products"][0]["images"] == ["https://verified.example/new.png"]
    assert "hero_image_url" not in plan["new_products"][0]
    assert db.products.docs == old
    data["new_products"][0]["category_id"] = "foreign-category"
    with pytest.raises(importer.ImportConflict, match="brand/category"): asyncio.run(importer.prepare_plan(db, data, "hash"))


def test_brand_specific_category_cannot_be_used_by_another_brand():
    db, data = database(), manifest()
    db.categories.docs[0]["brand_id"] = "brand-a"
    with pytest.raises(importer.ImportConflict, match="different brand"):
        asyncio.run(importer.prepare_plan(db, data, "hash"))
    data["new_products"] = [{"id": "new", "sku": "NEW", "name": "New product", "brand_id": "brand-b", "category_id": "category", "mrp": 999, "price": 999}]
    data["quotations"][0]["items"][1].update(product_id="new", sku="NEW")
    with pytest.raises(importer.ImportConflict, match="different brand"):
        asyncio.run(importer.prepare_plan(db, data, "hash"))


def test_new_media_cannot_attach_to_existing_or_foreign_products():
    db, data = database(), manifest()
    data["new_media"] = [{"product_id": "product-a", "floor_id": "first-floor", "brand_id": "brand-a", "bucket": "forge-products", "storage_key": "verified.png", "public_url": "https://verified.example/a.png", "sha1": "a" * 40}]
    with pytest.raises(importer.ImportConflict, match="new exact product"):
        asyncio.run(importer.prepare_plan(db, data, "hash"))
    data["new_products"] = [{"id": "new", "sku": "NEW", "name": "New product", "brand_id": "brand-a", "category_id": "category", "mrp": 123.45, "price": 123.45}]
    data["quotations"][0]["items"][0].update(product_id="new", sku="NEW")
    data["new_media"][0]["product_id"] = "new"
    plan = asyncio.run(importer.prepare_plan(db, data, "hash"))
    assert plan["new_media"][0]["product_id"] == "new" and plan["new_media"][0]["uploaded_by"] == "owner"
    data["new_media"][0]["floor_id"] = "ground-floor"
    with pytest.raises(importer.ImportConflict, match="new exact product"):
        asyncio.run(importer.prepare_plan(db, data, "hash"))


@pytest.mark.parametrize("failure", [None, "quotation", "receipt"])
def test_atomic_apply_and_replay_never_create_order_side_effects(monkeypatch, tmp_path, failure):
    from services.analytics import cache
    db, data = database(), manifest()
    duplicate = deepcopy(data["quotations"][0]); duplicate.update(source_file="/private/other.xlsx", source_sha256="b" * 64)
    data["quotations"].append(duplicate)
    old_products = deepcopy(db.products.docs)
    client = SimpleNamespace(start_session=AsyncMock(side_effect=lambda: Session(db)))
    monkeypatch.setattr(cache, "bump", AsyncMock())
    if failure: db["quotations" if failure == "quotation" else "event_outbox"].fail_insert = True
    async def scenario():
        plan = await importer.prepare_plan(db, data, "hash")
        if failure:
            with pytest.raises(RuntimeError, match="insert failure"):
                await importer.apply_plan(db, client, data, "hash", plan, tmp_path)
            assert len(db.customers.docs) == 1 and not db.referrers.docs and not db.quotations.docs and not db.activity_events.docs and not db.event_outbox.docs
        else:
            result = await importer.apply_plan(db, client, data, "hash", plan, tmp_path)
            assert result["quotations"] == 2
            assert len(db.customers.docs) == 2 and len(db.referrers.docs) == 1
            assert len(db.quotations.docs) == 2 and len(db.activity_events.docs) == 3
            assert all(q["status"] == "draft" and q["ordered_at"] is None for q in db.quotations.docs)
            assert all(a["floor_id"] == "first-floor" and a["actor_id"] == "owner" for a in db.activity_events.docs)
            assert len(db.event_outbox.docs) == 1 and db.event_outbox.docs[0]["event_type"] == "QuotationWorkbookImport"
            retry = await importer.prepare_plan(db, data, "hash")
            assert retry["already_applied"]
            applied = await importer.apply_plan(db, client, data, "hash", retry, tmp_path)
            assert applied["already_applied"] and len(db.quotations.docs) == 2
            db.quotations.docs[0]["items"][0]["qty"] += 1
            with pytest.raises(importer.ImportConflict, match="changed or is missing"):
                await importer.prepare_plan(db, data, "hash")
        assert db.products.docs == old_products
        assert all(not db[collection].docs for collection in ("purchase_orders", "payments", "customer_orders", "notifications", "followups", "counters"))
    asyncio.run(scenario())


def test_changed_target_between_plan_and_apply_refused(monkeypatch, tmp_path):
    db, data = database(), manifest()
    plan = asyncio.run(importer.prepare_plan(db, data, "hash"))
    db.products.docs[0]["mrp"] += 1
    client = SimpleNamespace(start_session=AsyncMock(side_effect=lambda: Session(db)))
    with pytest.raises(importer.ImportConflict, match="changed after dry-run"):
        asyncio.run(importer.apply_plan(db, client, data, "hash", plan, tmp_path))
    assert not db.quotations.docs


def test_source_hash_verification_and_private_path_protection(tmp_path):
    data = manifest(); source = tmp_path / "source.xlsx"; source.write_bytes(b"reviewed workbook")
    data["quotations"][0].update(source_file=str(source), source_sha256=hashlib.sha256(source.read_bytes()).hexdigest())
    importer.verify_source_files(data, tmp_path / "manifest.json")
    source.write_bytes(b"modified workbook")
    with pytest.raises(importer.ImportConflict, match="SHA256"):
        importer.verify_source_files(data, tmp_path / "manifest.json")


def test_apply_destination_and_hash_guards_refuse_before_reading_target(monkeypatch, tmp_path):
    import db as connection
    data = manifest(); source = tmp_path / "source.xlsx"; source.write_bytes(b"source")
    data["quotations"][0].update(source_file=str(source), source_sha256=hashlib.sha256(source.read_bytes()).hexdigest())
    path = tmp_path / "manifest.json"
    import json
    path.write_text(json.dumps(data))
    fake = database(); fake.name = "buildcon_house"
    monkeypatch.setattr(connection, "db", fake)
    args = SimpleNamespace(manifest=path, apply=True, expected_db="buildcon_house", manifest_sha="wrong", output_dir=tmp_path)
    with pytest.raises(importer.ImportConflict, match="exact --manifest-sha"):
        asyncio.run(importer.run(args))
    args.manifest_sha = hashlib.sha256(path.read_bytes()).hexdigest(); args.expected_db = "other"
    with pytest.raises(importer.ImportConflict, match="matching connection"):
        asyncio.run(importer.run(args))
    args.apply = False; args.output_dir = importer.ROOT / "private"
    with pytest.raises(importer.ImportConflict, match="outside the checkout"):
        asyncio.run(importer.run(args))
