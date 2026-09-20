"""Ordered quotation edits stay on the quotation aggregate only."""
from __future__ import annotations

import asyncio

from models import QuotationUpdate, UserPublic
from routes import quotation_routes


class _Rows:
    async def to_list(self, _limit):
        return []


class _ProductMedia:
    def find(self, *_args, **_kwargs):
        return _Rows()


class _Products:
    async def find_one(self, *_args, **_kwargs):
        return {"id": "p-1", "category_id": "cat-1"}


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
