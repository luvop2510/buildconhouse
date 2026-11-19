"""A discount-only edit re-prices every line, so items must be re-stamped
even when the request body carried no items at all."""
from __future__ import annotations

import pytest

from routes.quotation_routes import _stamped_items_for_update


def _raw(line_id: str, qty: float, price: float, **kw) -> dict:
    return {"id": line_id, "product_id": f"p-{line_id}", "sku": f"S-{line_id}", "name": line_id, "qty": qty, "unit_price": price, **kw}


def test_items_supplied_in_the_update_are_stamped():
    doc = {"items": [], "project_discount_pct": 0, "category_discounts": {}, "room_discounts": {}}
    update = {"items": [_raw("a", 1, 100.0)], "project_discount_pct": 10}
    result = _stamped_items_for_update(update, doc, 10, {}, {})
    assert [i["net_amount"] for i in result] == [90.0]


def test_discount_only_edit_restamps_the_existing_items():
    doc = {
        "items": [_raw("a", 1, 100.0, net_amount=100.0), _raw("b", 1, 200.0, net_amount=200.0)],
        "project_discount_pct": 0,
        "category_discounts": {},
        "room_discounts": {},
    }
    update = {"project_discount_pct": 25}  # no items in the body at all
    result = _stamped_items_for_update(update, doc, 25, {}, {})
    assert [i["net_amount"] for i in result] == [75.0, 150.0]


def test_falls_back_to_stored_discount_config_for_keys_not_being_updated():
    doc = {
        "items": [_raw("a", 1, 100.0)],
        "project_discount_pct": 10,
        "category_discounts": {},
        "room_discounts": {},
    }
    update = {"items": [_raw("a", 1, 100.0)]}  # discounts unchanged
    result = _stamped_items_for_update(update, doc, 10, {}, {})
    assert result[0]["net_amount"] == 90.0


def test_empty_quotation_returns_empty_list():
    doc = {"items": [], "project_discount_pct": 0, "category_discounts": {}, "room_discounts": {}}
    assert _stamped_items_for_update({"project_discount_pct": 5}, doc, 5, {}, {}) == []


def test_net_amount_list_keeps_duplicate_ids_separate():
    from models import QuotationLineItem
    from services.pricing import net_amount_list

    items = [
        QuotationLineItem(id="dup", product_id="p1", sku="S1", name="A", qty=1, unit_price=100.0),
        QuotationLineItem(id="dup", product_id="p2", sku="S2", name="B", qty=1, unit_price=300.0),
    ]
    assert net_amount_list(items, project_discount_pct=10) == [90.0, 270.0]


def test_tiles_legacy_unit_rate_fallback_preserves_explicit_zero():
    from routes.quotation_routes import _with_saved_tile_unit_price

    assert _with_saved_tile_unit_price({"rate_box": 1700, "offer_rate": 120, "box_sqft": 16})["unit_price"] == 1700
    assert _with_saved_tile_unit_price({"offer_rate": 120, "box_sqft": 16})["unit_price"] == 1920
    assert _with_saved_tile_unit_price({"unit_price": 0, "rate_box": 1700})["unit_price"] == 0


@pytest.mark.parametrize("scenario", ["standard_discount", "tiles_transport", "tiles_discount_and_transport"])
def test_update_quotation_restamps_items_via_the_real_route(monkeypatch, scenario):
    """Exercises the actual update_quotation handler end to end (fake db, no
    network) — would fail if `update["items"] = _stamped_items_for_update(...)`
    were ever deleted from the route, since update_calls[0]["update"]["items"]
    would then be missing net_amount entirely."""
    import asyncio

    import routes.quotation_routes as quotation_routes
    from models import QuotationUpdate, UserPublic

    doc = {
        "id": "q1", "floor_id": "ground-floor", "number": "FQ-2026-0001",
        "customer_id": "c1", "customer_name": "Test Customer",
        "created_by": "u1", "created_by_name": "Sales Rep",
        "created_at": "2026-07-26T00:00:00+00:00", "updated_at": "2026-07-26T00:00:00+00:00",
        "status": "draft", "project_discount_pct": 0, "category_discounts": {}, "room_discounts": {},
        "items": [_raw("a", 1, 100.0), _raw("b", 1, 200.0)],
    }
    if scenario.startswith("tiles_"):
        doc.update(doc_type="tiles_quotation", transportation_fee=100, subtotal=8500, discount_total=500, grand_total=8100,
                   items=[_raw("a", 5, 1700, net_amount=8000, rate_box=1700, rate_sqft=120, box_sqft=16)])

    update_calls = []

    class _FakeQuotations:
        async def find_one(self, query, projection=None, session=None):
            if query.get("id") == doc["id"]:
                return doc
            return None

        async def update_one(self, filter_dict, update_dict, session=None):
            update_calls.append(update_dict["$set"])
            return {"matched_count": 1, "modified_count": 1}

    class _FakeDb:
        def __init__(self):
            self.quotations = _FakeQuotations()

    monkeypatch.setattr(quotation_routes, "db", _FakeDb())

    async def _fake_log_event(*args, **kwargs):
        return None

    async def _fake_reconcile(*args, **kwargs):
        return None

    monkeypatch.setattr(quotation_routes, "log_event", _fake_log_event)
    monkeypatch.setattr(quotation_routes, "reconcile_followups", _fake_reconcile)

    user = UserPublic(
        email="sales@forge.app", full_name="Sales", role="sales",
        floor_ids=["ground-floor"], active_floor_id="ground-floor",
    )
    payload = QuotationUpdate(
        transportation_fee=240 if scenario.startswith("tiles_") else None,
        project_discount_pct=None if scenario == "tiles_transport" else 10,
        silent=True,
    )

    asyncio.run(quotation_routes.update_quotation("q1", payload, user=user))

    assert len(update_calls) == 1
    if scenario == "tiles_transport":
        assert update_calls[0]["transportation_fee"] == 240
        assert update_calls[0]["grand_total"] == 8240
        assert not {"items", "subtotal", "discount_total"}.intersection(update_calls[0])
        return
    persisted_items = update_calls[0]["items"]
    if scenario == "tiles_discount_and_transport":
        assert persisted_items[0]["unit_price"] == 1700
        assert persisted_items[0]["net_amount"] == 7650
        assert update_calls[0]["grand_total"] == 7890
        return
    assert [i["net_amount"] for i in persisted_items] == [90.0, 180.0]
