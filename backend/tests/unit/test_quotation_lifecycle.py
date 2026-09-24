"""Safety checks for post-order quotation product revisions."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import services.quotation_lifecycle as lifecycle
from models import PurchaseOrderItem, UserPublic


class _Rows:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, _limit):
        return self.rows


class _Payments:
    def aggregate(self, *_args, **_kwargs):
        return _Rows([])


class _PurchaseOrders:
    def __init__(self, rows):
        self.rows = rows

    def find(self, *_args, **_kwargs):
        return _Rows(self.rows)


def _quote(items: list[dict]) -> dict:
    return {
        "id": "q-1", "floor_id": "first-floor", "status": "ordered",
        "customer_id": "customer-1", "grand_total": 1000, "items": items,
    }


def test_post_order_swap_rejects_a_product_missing_from_the_current_floor(monkeypatch):
    previous = _quote([{"id": "line-1", "product_id": "old-product", "qty": 1, "unit_price": 1000}])
    proposed = _quote([{"id": "line-1", "product_id": "missing-product", "qty": 1, "unit_price": 1000}])
    products = SimpleNamespace(find=lambda *_args, **_kwargs: _Rows([]))
    monkeypatch.setattr(lifecycle, "db", SimpleNamespace(products=products))

    with pytest.raises(HTTPException, match="replacement products are no longer available"):
        asyncio.run(lifecycle.preflight_ordered_quotation_change(previous, proposed))


def test_post_order_quantity_edit_is_allowed_while_its_purchase_line_is_unfulfilled(monkeypatch):
    previous = _quote([{"id": "line-1", "product_id": "product-1", "qty": 1, "unit_price": 1000}])
    proposed = _quote([{"id": "line-1", "product_id": "product-1", "qty": 2, "unit_price": 500}])
    po_rows = [{"items": [{
        "quotation_line_id": "line-1", "product_id": "product-1", "stage": "order_in_company",
        "qty_received": 0, "godown_transferred_qty": 0,
    }]}]
    monkeypatch.setattr(
        lifecycle,
        "db",
        SimpleNamespace(payments=_Payments(), purchase_orders=_PurchaseOrders(po_rows)),
    )

    asyncio.run(lifecycle.preflight_ordered_quotation_change(previous, proposed))


def test_po_final_and_legacy_initial_items_remain_editable_before_fulfilment():
    base = {"qty_received": 0, "godown_transferred_qty": 0}
    assert lifecycle.purchase_item_is_mutable({**base, "stage": "po_final"})
    assert lifecycle.purchase_item_is_mutable({**base, "stage": "order_in_company"})
    assert not lifecycle.purchase_item_is_mutable({**base, "stage": "in_box"})


def test_quotation_revision_creates_po_final_purchase_item():
    user = UserPublic(email="sales@forge.app", full_name="Sales", role="sales")
    item = lifecycle._new_po_item(
        {"id": "line-2", "product_id": "product-2", "sku": "SKU-2", "name": "Basin", "qty": 2},
        unit_cost=100, product={"brand_id": "brand-1", "brand_name": "Brand"}, user=user,
    )
    assert item["stage"] == "po_final"
    assert item["stage_history"][0]["to_stage"] == "po_final"
    assert PurchaseOrderItem.model_validate({"product_id": "old", "sku": "OLD", "name": "Old", "stage": "order_in_company"}).stage == "order_in_company"
