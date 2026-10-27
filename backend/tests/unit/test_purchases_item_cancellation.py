from __future__ import annotations

import asyncio
import inspect

import pytest
from fastapi import HTTPException

from models import PurchaseOrderItem, UserPublic
from routes import purchases_tracker as tracker


def _user() -> UserPublic:
    return UserPublic(
        email="warehouse@forge.app", full_name="Warehouse", role="warehouse",
        floor_ids=["first-floor"], active_floor_id="first-floor",
    )


class _Result:
    def __init__(self, matched_count: int):
        self.matched_count = matched_count


class _Orders:
    def __init__(self, po: dict):
        self.po = po

    async def find_one(self, query, *_args, **_kwargs):
        if "$and" in query:
            query = {key: value for clause in query["$and"] for key, value in clause.items()}
        floor = query.get("floor_id")
        if isinstance(floor, dict) and self.po.get("floor_id") not in floor.get("$in", []):
            return None
        item_id = query.get("items.id")
        return self.po if any(item.get("id") == item_id for item in self.po["items"]) else None

    async def update_one(self, query, update):
        if query.get("id") != self.po["id"]:
            return _Result(0)
        if "items" in query and "$not" in query["items"]:
            if self.po.get("status") == "cancelled" or any(not item.get("cancelled") for item in self.po["items"]):
                return _Result(0)
            self.po.update(update["$set"])
            self.po.setdefault("status_history", []).append(update["$push"]["status_history"])
            return _Result(1)
        elem = query.get("items", {}).get("$elemMatch", {})
        item = next((item for item in self.po["items"] if item["id"] == elem.get("id")), None)
        if not item or item.get("cancelled") or item.get("stage") == "delivered":
            return _Result(0)
        for key, value in update["$set"].items():
            if key.startswith("items.$."):
                item[key.removeprefix("items.$.")] = value
            else:
                self.po[key] = value
        item.setdefault("cancellation_history", []).append(update["$push"]["items.$.cancellation_history"])
        return _Result(1)


class _Db:
    def __init__(self, po: dict):
        self.purchase_orders = _Orders(po)


def _po(*items: dict) -> dict:
    return {
        "id": "po-1", "number": "FPO-1", "floor_id": "first-floor", "status": "ordered",
        "customer_id": "cust-1", "items": list(items), "status_history": [],
    }


def _item(item_id: str, stage: str = "order_in_company") -> dict:
    return {"id": item_id, "name": f"Item {item_id}", "sku": item_id, "qty": 2, "stage": stage}


@pytest.fixture(autouse=True)
def _disable_audit(monkeypatch):
    async def no_log(*_args, **_kwargs):
        return None
    monkeypatch.setattr(tracker, "log_event", no_log)


def test_cancel_item_records_immutable_metadata_and_cancels_final_parent(monkeypatch):
    po = _po(_item("line-1"))
    monkeypatch.setattr(tracker, "db", _Db(po))

    result = asyncio.run(tracker._cancel_item("line-1", "customer changed plan", _user()))

    item = po["items"][0]
    assert result == {"po_id": "po-1", "item_id": "line-1", "cancelled": True, "parent_po_cancelled": True}
    assert item["cancelled"] is True
    assert item["cancellation_reason"] == "customer changed plan"
    assert item["cancellation_history"][0]["by_user_name"] == "Warehouse"
    assert po["status"] == "cancelled"
    assert po["status_history"][-1]["to_status"] == "cancelled"


def test_cancel_one_of_multiple_items_leaves_parent_active(monkeypatch):
    po = _po(_item("line-1"), _item("line-2"))
    monkeypatch.setattr(tracker, "db", _Db(po))

    result = asyncio.run(tracker._cancel_item("line-1", None, _user()))

    assert result["parent_po_cancelled"] is False
    assert po["status"] == "ordered"
    assert po["items"][1].get("cancelled") is not True


@pytest.mark.parametrize("stage, expected_status", [("delivered", 400), ("order_in_company", 409)])
def test_cancel_rejects_delivered_or_already_cancelled_items(monkeypatch, stage, expected_status):
    item = _item("line-1", stage)
    if expected_status == 409:
        item["cancelled"] = True
    monkeypatch.setattr(tracker, "db", _Db(_po(item)))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(tracker._cancel_item("line-1", None, _user()))

    assert exc.value.status_code == expected_status


def test_cancel_route_allows_warehouse_role_and_model_defaults_are_active():
    dependency = inspect.signature(tracker.cancel_item).parameters["user"].default.dependency
    assert asyncio.run(dependency(user=_user())).role == "warehouse"
    assert PurchaseOrderItem(product_id="p", sku="sku", name="Name").cancelled is False


def test_active_tracker_pipelines_exclude_cancelled_line_items():
    paged = tracker._items_page_pipeline(
        view="stock", brand=None, customer=None, stage=None, q=None, product_id=None,
        floor_ids=["first-floor"], sla_days=7, skip=0, limit=10,
    )
    assert {"$match": {"items.cancelled": {"$ne": True}}} in paged


def test_lent_source_cannot_be_cancelled_before_physical_return(monkeypatch):
    item = {**_item('source', 'in_box'), 'loaned_qty': 1}
    monkeypatch.setattr(tracker, 'db', _Db(_po(item)))
    with pytest.raises(HTTPException) as error:
        asyncio.run(tracker._cancel_item('source', 'Cancel', _user()))
    assert error.value.status_code == 409
    assert not item.get('cancelled')


def test_cancellation_cas_cannot_cancel_a_loan_created_after_the_read(monkeypatch):
    po = _po(_item('source', 'in_box'))
    class Race(_Orders):
        async def update_one(self, query, update):
            item = self.po['items'][0]
            item['loaned_qty'] = 1
            elem = query.get('items', {}).get('$elemMatch', {})
            if 'loaned_qty' in elem and elem['loaned_qty'] != item['loaned_qty']:
                return _Result(0)
            return await super().update_one(query, update)
    db = _Db(po)
    db.purchase_orders = Race(po)
    monkeypatch.setattr(tracker, 'db', db)
    with pytest.raises(HTTPException) as error:
        asyncio.run(tracker._cancel_item('source', 'Cancel', _user()))
    assert error.value.status_code == 409
    assert not po['items'][0].get('cancelled')
