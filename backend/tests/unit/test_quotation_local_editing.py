"""Ordered quotation edits stay on the quotation aggregate only."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

from models import QuotationUpdate, UserPublic
from routes import quotation_routes


class _Rows:
    async def to_list(self, _limit):
        return []


class _ProductMedia:
    def find(self, *_args, **_kwargs):
        return _Rows()


class _Products:
    def find(self, query, *_args, **_kwargs):
        async def to_list(limit):
            return [{"id": product_id, "category_id": "cat-1"}
                    for product_id in query["id"]["$in"]][:limit]
        return SimpleNamespace(to_list=to_list)


class _Quotations:
    def __init__(self, document: dict):
        self.document = document

    async def update_one(self, query, update):
        assert query == {"id": self.document["id"]}
        self.document.update(update["$set"])

    async def find_one(self, query, *_args, **_kwargs):
        assert query == {"id": self.document["id"]}
        return dict(self.document)


def _user() -> UserPublic:
    return UserPublic(
        id="sales-1", email="sales@example.com", full_name="Sales", role="sales",
        floor_ids=["first-floor"], active_floor_id="first-floor",
    )


def test_ordered_quote_product_edits_do_not_touch_operational_projections(monkeypatch):
    """No payments/PO/follow-up collection is available to this edit route.

    If a future change reintroduces lifecycle reconciliation, this test fails
    before a post-order quotation edit can mutate another module again.
    """
    document = {
        "id": "q-1", "floor_id": "first-floor", "number": "FQ-1",
        "customer_id": "c-1", "customer_name": "Customer", "status": "ordered",
        "created_by": "sales-1", "created_by_name": "Sales",
        "created_at": "2026-09-01T00:00:00+00:00", "updated_at": "2026-09-01T00:00:00+00:00",
        "items": [{"id": "line-1", "product_id": "p-1", "sku": "OLD", "name": "Old", "qty": 1, "unit_price": 100}],
        "rooms": ["Bath"], "project_discount_pct": 0, "category_discounts": {}, "room_discounts": {},
    }
    quotations = _Quotations(document)
    # Deliberately omit payments, purchase_orders and followups. The PATCH
    # must succeed without even reading these operational projections.
    monkeypatch.setattr(quotation_routes, "db", type("Db", (), {
        "quotations": quotations, "products": _Products(), "product_media": _ProductMedia(),
    })())

    async def scoped(collection, record_id, *_args, **_kwargs):
        assert collection is quotations
        assert record_id == "q-1"
        return document

    async def no_usage(*_args, **_kwargs):
        return None

    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", scoped)
    monkeypatch.setattr(quotation_routes, "_track_product_usage", no_usage)

    async def catalog():
        return quotation_routes.catalog_service._build_snapshot(
            [{"id": "p-1", "sku": "NEW", "floor_id": "first-floor"}],
            [], [], [], [],
        )
    monkeypatch.setattr(quotation_routes.catalog_service, "get_catalog_snapshot", catalog)

    edited = asyncio.run(quotation_routes.update_quotation(
        "q-1",
        QuotationUpdate(items=[{
            "id": "line-1", "product_id": "p-1", "sku": "NEW", "name": "Replacement",
            "qty": 2, "unit_price": 175, "room": "Bath",
        }], silent=True),
        user=_user(),
    ))

    assert edited.status == "ordered"
    assert edited.items[0].sku == "NEW"
    assert edited.grand_total == 350
    assert {change["type"] for change in quotations.document["po_final_changes"]} == {
        "product_adjusted", "amount_adjusted",
    }


def test_reordered_items_survive_patch_and_detail_without_cross_brand_sorting(monkeypatch):
    document = {
        "id": "q-1", "floor_id": "first-floor", "number": "FQ-1",
        "customer_id": "c-1", "customer_name": "Customer", "status": "draft",
        "created_by": "sales-1", "created_by_name": "Sales",
        "created_at": "2026-09-01T00:00:00+00:00", "updated_at": "2026-09-01T00:00:00+00:00",
        "items": [
            {"id": "line-1", "product_id": "p-1", "sku": "Z-BRAND", "name": "Basin", "qty": 1, "unit_price": 100, "room": "Bath"},
            {"id": "line-2", "product_id": "p-2", "sku": "A-BRAND", "name": "Shower", "qty": 1, "unit_price": 250, "room": "Bath"},
            {"id": "line-3", "product_id": "p-3", "sku": "HIDDEN", "name": "Hidden", "qty": 1, "unit_price": 50, "room": "Closed"},
        ],
        "rooms": ["Bath", "Closed"], "collapsed_rooms": ["Closed"],
        "project_discount_pct": 0, "category_discounts": {}, "room_discounts": {},
    }
    quotations = _Quotations(document)
    monkeypatch.setattr(quotation_routes, "db", type("Db", (), {
        "quotations": quotations, "products": _Products(), "product_media": _ProductMedia(),
    })())

    async def scoped(collection, record_id, *_args, **_kwargs):
        assert collection is quotations
        assert record_id == "q-1"
        return dict(document)

    async def no_usage(*_args, **_kwargs):
        return None

    async def catalog():
        return quotation_routes.catalog_service._build_snapshot(
            [{"id": f"p-{i}", "sku": str(i), "floor_id": "first-floor"} for i in range(1, 4)],
            [], [], [], [],
        )
    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", scoped)
    monkeypatch.setattr(quotation_routes, "_track_product_usage", no_usage)
    monkeypatch.setattr(quotation_routes.catalog_service, "get_catalog_snapshot", catalog)
    reordered = [document["items"][1], document["items"][0], document["items"][2]]
    result = asyncio.run(quotation_routes.update_quotation(
        "q-1", QuotationUpdate(items=reordered, silent=True), user=_user(),
    ))
    assert [line.id for line in result.items] == ["line-2", "line-1", "line-3"]
    assert [line["id"] for line in quotations.document["items"]] == ["line-2", "line-1", "line-3"]
    assert result.grand_total == 400
    assert result.collapsed_rooms == ["Closed"]
    fetched = asyncio.run(quotation_routes.get_quotation("q-1", user=_user()))
    assert [line.id for line in fetched.items] == ["line-2", "line-1", "line-3"]
