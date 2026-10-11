"""Regression test: create_product / create_custom_product / update_product
must scope their duplicate-SKU pre-check to (floor_id, brand_id), matching
migration 0006's compound unique index (products_floor_brand_sku_unique).

Root cause: all three duplicate-SKU checks in catalog_routes.py queried
`db.products.find_one({"sku": ...})` globally (or with only `id: {"$ne":
...}` added for update_product). Once 0006's per-floor-brand index is live,
a legitimate cross-floor/cross-brand SKU reuse would still be rejected with
a 409 by this pre-check before ever reaching the (now-relaxed) database
index.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

import routes.catalog_routes as catalog_routes
from models import ConcealedPart, ProductCreate, ProductPatch, UserPublic


def _user(role: str, floor_id: str) -> UserPublic:
    return UserPublic(
        email=f"{role}@forge.app", full_name=role.title(), role=role,
        floor_ids=["ground-floor", "first-floor"], active_floor_id=floor_id,
    )


class _FakeProducts:
    """Mimics enough of the (floor_id, brand_id, sku) + id `$ne` filter
    shape used by catalog_routes to make the duplicate-check queries behave
    like the real compound-indexed collection would."""

    def __init__(self, docs=None):
        self.docs = list(docs or [])
        self.inserted = []
        self.updated = None

    @staticmethod
    def _matches(doc: dict, query: dict) -> bool:
        for key, value in query.items():
            if key == "$and":
                return all(_FakeProducts._matches(doc, clause) for clause in value)
            if key == "id" and isinstance(value, dict) and "$ne" in value:
                if doc.get("id") == value["$ne"]:
                    return False
                continue
            if isinstance(value, dict) and "$ne" in value:
                if doc.get(key) == value["$ne"]:
                    return False
                continue
            if isinstance(value, dict) and "$in" in value:
                if doc.get(key) not in value["$in"]:
                    return False
                continue
            if doc.get(key) != value:
                return False
        return True

    async def find_one(self, query, *_args, **_kwargs):
        for doc in self.docs:
            if self._matches(doc, query):
                return doc
        return None

    def find(self, query, *_args, **_kwargs):
        rows = [doc for doc in self.docs if self._matches(doc, query)]

        class _Cursor:
            async def to_list(self, length):
                return rows[:length]

        return _Cursor()

    async def insert_one(self, doc):
        self.inserted.append(doc)
        self.docs.append(doc)

    async def update_one(self, filt, update):
        self.updated = (filt, update)
        for doc in self.docs:
            if self._matches(doc, filt):
                doc.update(update.get("$set", {}))


class _FakeDb:
    def __init__(self, docs=None):
        self.products = _FakeProducts(docs)
        self.brands = _FakeProducts([
            {"id": "brand-tile", "floor_id": "ground-floor"},
            {"id": "brand-sanitary", "floor_id": "first-floor"},
            {"id": "brand-A", "floor_id": "first-floor"},
            {"id": "brand-B", "floor_id": "first-floor"},
        ])
        self.categories = _FakeProducts([
            {"id": "cat-1", "floor_id": "ground-floor"},
            {"id": "cat-1", "floor_id": "first-floor"},
        ])


def _product_body(**overrides) -> ProductCreate:
    defaults = dict(
        name="Test Product", sku="SKU1", brand_id="brand-tile",
        category_id="cat-1", mrp=100.0, price=90.0,
    )
    defaults.update(overrides)
    return ProductCreate(**defaults)


# ---------- create_product ----------

def test_create_product_allows_same_sku_under_different_floor_brand(monkeypatch):
    existing = {"id": "p-existing", "sku": "SKU1", "floor_id": "first-floor", "brand_id": "brand-sanitary"}
    fake_db = _FakeDb([existing])
    monkeypatch.setattr(catalog_routes, "db", fake_db)
    monkeypatch.setattr(catalog_routes.catalog_service, "schedule_catalog_refresh", lambda: None)

    body = _product_body(sku="SKU1", brand_id="brand-tile")
    result = asyncio.run(catalog_routes.create_product(body, user=_user("purchase", "ground-floor")))

    assert result.sku == "SKU1"
    assert len(fake_db.products.inserted) == 1


def test_create_product_rejects_same_sku_under_same_floor_brand(monkeypatch):
    existing = {"id": "p-existing", "sku": "SKU1", "floor_id": "ground-floor", "brand_id": "brand-tile"}
    fake_db = _FakeDb([existing])
    monkeypatch.setattr(catalog_routes, "db", fake_db)
    monkeypatch.setattr(catalog_routes.catalog_service, "schedule_catalog_refresh", lambda: None)

    body = _product_body(sku="SKU1", brand_id="brand-tile")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(catalog_routes.create_product(body, user=_user("purchase", "ground-floor")))

    assert exc.value.status_code == 409
    assert not fake_db.products.inserted


# ---------- create_custom_product ----------

def test_create_custom_product_allows_same_sku_under_different_floor_brand(monkeypatch):
    existing = {"id": "p-existing", "sku": "SKU1", "floor_id": "first-floor", "brand_id": "brand-sanitary"}
    fake_db = _FakeDb([existing])
    monkeypatch.setattr(catalog_routes, "db", fake_db)
    monkeypatch.setattr(catalog_routes.catalog_service, "schedule_catalog_refresh", lambda: None)

    body = _product_body(sku="SKU1", brand_id="brand-tile", is_custom=False)
    result = asyncio.run(catalog_routes.create_custom_product(body, user=_user("sales", "ground-floor")))

    assert result.sku == "SKU1"
    assert len(fake_db.products.inserted) == 1


def test_create_custom_product_rejects_same_sku_under_same_floor_brand(monkeypatch):
    existing = {"id": "p-existing", "sku": "SKU1", "floor_id": "ground-floor", "brand_id": "brand-tile"}
    fake_db = _FakeDb([existing])
    monkeypatch.setattr(catalog_routes, "db", fake_db)
    monkeypatch.setattr(catalog_routes.catalog_service, "schedule_catalog_refresh", lambda: None)

    body = _product_body(sku="SKU1", brand_id="brand-tile", is_custom=False)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(catalog_routes.create_custom_product(body, user=_user("sales", "ground-floor")))

    assert exc.value.status_code == 409
    assert not fake_db.products.inserted


# ---------- update_product ----------

def _patch_setup(monkeypatch, docs):
    fake_db = _FakeDb(docs)
    monkeypatch.setattr(catalog_routes, "db", fake_db)
    monkeypatch.setattr(catalog_routes.catalog_service, "patch_product_in_snapshot", lambda *_a, **_kw: None)
    monkeypatch.setattr(catalog_routes.catalog_service, "product_by_id", AsyncMock(return_value={
        "id": "p1", "name": "Test Product", "sku": "OLD-SKU", "brand_id": "brand-A",
        "category_id": "cat-1", "floor_id": "first-floor", "mrp": 100.0, "price": 90.0,
    }))
    # catalog_routes imports log_event directly (`from services.activity_log
    # import log_event`), so patching catalog_routes.db does not reach it —
    # left unmocked it hits the real Motor client and can wedge later tests'
    # event loops (services/sequence.py does the same real-db thing).
    monkeypatch.setattr(catalog_routes, "log_event", AsyncMock(return_value=None))
    return fake_db


def test_update_product_allows_new_sku_that_collides_only_under_a_different_brand(monkeypatch):
    # p2 shares floor with p1 but is on a DIFFERENT brand — reusing its SKU
    # on p1 must be allowed once p1's brand_id stays "brand-A".
    docs = [
        {"id": "p1", "sku": "OLD-SKU", "floor_id": "first-floor", "brand_id": "brand-A"},
        {"id": "p2", "sku": "SKU-X", "floor_id": "first-floor", "brand_id": "brand-B"},
    ]
    fake_db = _patch_setup(monkeypatch, docs)

    asyncio.run(catalog_routes.update_product(
        "p1", ProductPatch(sku="SKU-X"), user=_user("purchase", "first-floor"),
    ))

    filt, update = fake_db.products.updated
    assert filt["$and"][0] == {"floor_id": {"$in": ["first-floor"]}}
    assert filt["$and"][1] == {"id": "p1"}
    assert update["$set"]["sku"] == "SKU-X"


def test_update_product_rejects_new_sku_that_collides_under_the_same_floor_and_brand(monkeypatch):
    # p3 shares BOTH floor and brand with p1 — reusing its SKU must still 409.
    docs = [
        {"id": "p1", "sku": "OLD-SKU", "floor_id": "first-floor", "brand_id": "brand-A"},
        {"id": "p3", "sku": "SKU-Y", "floor_id": "first-floor", "brand_id": "brand-A"},
    ]
    fake_db = _patch_setup(monkeypatch, docs)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(catalog_routes.update_product(
            "p1", ProductPatch(sku="SKU-Y"), user=_user("purchase", "first-floor"),
        ))

    assert exc.value.status_code == 409
    assert fake_db.products.updated is None


def test_update_product_scopes_check_to_the_new_brand_id_when_brand_is_changing(monkeypatch):
    # p1 keeps its own SKU, but moves to brand-B where p2 already has that
    # exact SKU on the same floor — must 409 against the NEW brand, not the
    # product's current (about-to-be-replaced) brand.
    docs = [
        {"id": "p1", "sku": "SHARED-SKU", "floor_id": "first-floor", "brand_id": "brand-A"},
        {"id": "p2", "sku": "SHARED-SKU", "floor_id": "first-floor", "brand_id": "brand-B"},
    ]
    fake_db = _patch_setup(monkeypatch, docs)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(catalog_routes.update_product(
            "p1", ProductPatch(brand_id="brand-B"), user=_user("purchase", "first-floor"),
        ))

    assert exc.value.status_code == 409
    assert fake_db.products.updated is None


def test_update_product_resolves_a_conceal_sku_to_its_catalog_snapshot(monkeypatch):
    docs = [
        {"id": "p1", "sku": "TRIM-1", "floor_id": "first-floor", "brand_id": "brand-A"},
        {"id": "body", "sku": "BODY-1", "name": "Concealed body", "price": 4000.0,
         "mrp": 4500.0, "floor_id": "first-floor", "brand_id": "brand-A", "active": True},
    ]
    fake_db = _patch_setup(monkeypatch, docs)

    asyncio.run(catalog_routes.update_product(
        "p1", ProductPatch(concealed_part={"sku": "  BODY-1  ", "qty": 1}),
        user=_user("purchase", "first-floor"),
    ))

    concealed = fake_db.products.updated[1]["$set"]["concealed_part"]
    assert concealed == {
        "sku": "BODY-1", "qty": 1.0, "product_id": "body", "name": "Concealed body",
        "description": None, "unit_price": 4000.0, "mrp": 4500.0, "image": None,
    }


def test_update_product_honours_a_preview_selected_conceal_part(monkeypatch):
    """A shared supplier SKU can be made unambiguous by the Catalog preview.

    The product id remains server-verified against the SKU and the active
    floor, so this is a selection aid rather than a client-trusted write.
    """
    docs = [
        {"id": "p1", "sku": "TRIM-1", "floor_id": "first-floor", "brand_id": "brand-A"},
        {"id": "body-a", "sku": "BODY-SHARED", "name": "Body A", "price": 4000.0,
         "mrp": 4500.0, "floor_id": "first-floor", "brand_id": "brand-A", "active": True},
        {"id": "body-b", "sku": "BODY-SHARED", "name": "Body B", "price": 5100.0,
         "mrp": 5600.0, "floor_id": "first-floor", "brand_id": "brand-B", "active": True},
    ]
    fake_db = _patch_setup(monkeypatch, docs)

    asyncio.run(catalog_routes.update_product(
        "p1", ProductPatch(concealed_part={"sku": "BODY-SHARED", "product_id": "body-b"}),
        user=_user("purchase", "first-floor"),
    ))

    concealed = fake_db.products.updated[1]["$set"]["concealed_part"]
    assert concealed["product_id"] == "body-b"
    assert concealed["name"] == "Body B"
    assert concealed["unit_price"] == 5100.0


def test_update_product_rejects_a_preview_selection_that_no_longer_matches(monkeypatch):
    docs = [
        {"id": "p1", "sku": "TRIM-1", "floor_id": "first-floor", "brand_id": "brand-A"},
        {"id": "body", "sku": "BODY-1", "floor_id": "first-floor", "brand_id": "brand-A", "active": True},
    ]
    _patch_setup(monkeypatch, docs)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(catalog_routes.update_product(
            "p1", ProductPatch(concealed_part={"sku": "BODY-OTHER", "product_id": "body"}),
            user=_user("purchase", "first-floor"),
        ))

    assert exc.value.status_code == 422


def test_update_product_rejects_missing_or_ambiguous_conceal_sku(monkeypatch):
    base = {"id": "p1", "sku": "TRIM-1", "floor_id": "first-floor", "brand_id": "brand-A"}
    fake_db = _patch_setup(monkeypatch, [base])
    with pytest.raises(HTTPException) as missing:
        asyncio.run(catalog_routes.update_product(
            "p1", ProductPatch(concealed_part={"sku": "MISSING"}), user=_user("purchase", "first-floor"),
        ))
    assert missing.value.status_code == 404

    fake_db = _patch_setup(monkeypatch, [
        base,
        {"id": "other-a", "sku": "BODY", "floor_id": "first-floor", "brand_id": "brand-B", "active": True},
        {"id": "other-b", "sku": "BODY", "floor_id": "first-floor", "brand_id": "brand-C", "active": True},
    ])
    with pytest.raises(HTTPException) as ambiguous:
        asyncio.run(catalog_routes.update_product(
            "p1", ProductPatch(concealed_part={"sku": "BODY"}), user=_user("purchase", "first-floor"),
        ))
    assert ambiguous.value.status_code == 409


def test_sales_picker_saves_only_a_validated_concealed_association(monkeypatch):
    docs = [
        {"id": "p1", "sku": "TRIM", "floor_id": "first-floor", "brand_id": "brand-A"},
        {"id": "body", "sku": "BODY", "name": "Concealed body", "price": 4000,
         "mrp": 4500, "floor_id": "first-floor", "brand_id": "brand-A", "active": True},
    ]
    fake_db = _patch_setup(monkeypatch, docs)
    asyncio.run(catalog_routes.save_product_concealed_part(
        "p1", ConcealedPart(sku="BODY", product_id="body", unit_price=1, qty=2),
        user=_user("sales", "first-floor"),
    ))
    updates = fake_db.products.updated[1]["$set"]
    assert updates["concealed_part"]["product_id"] == "body"
    assert updates["concealed_part"]["unit_price"] == 4000
    assert updates["concealed_part"]["qty"] == 2
    assert set(updates) == {"concealed_part", "updated_at", "catalog_version", "catalog_updated_by"}


@pytest.mark.parametrize("part_floor,active,self_link", [("ground-floor", True, False), ("first-floor", False, False), ("first-floor", True, True)])
def test_sales_picker_rejects_foreign_retired_or_self_linked_parts(monkeypatch, part_floor, active, self_link):
    docs = [
        {"id": "p1", "sku": "TRIM", "floor_id": "first-floor", "brand_id": "brand-A"},
        {"id": "body", "sku": "BODY", "floor_id": part_floor, "brand_id": "brand-A", "active": active},
    ]
    fake_db = _patch_setup(monkeypatch, docs)
    with pytest.raises(HTTPException) as rejected:
        asyncio.run(catalog_routes.save_product_concealed_part(
            "p1", ConcealedPart(sku="TRIM" if self_link else "BODY", product_id="p1" if self_link else "body"),
            user=_user("sales", "first-floor"),
        ))
    assert rejected.value.status_code == 422
    assert fake_db.products.updated is None
