from __future__ import annotations

import asyncio

from models import UserPublic
from routes import purchases_tracker as tracker


def _user(floor_id: str = "ground-floor") -> UserPublic:
    return UserPublic(
        email="sales@forge.app", full_name="Sales", role="sales",
        floor_ids=["ground-floor", "first-floor"], active_floor_id=floor_id,
    )


def test_page_pipeline_filters_after_unwind_and_pages_inside_mongo():
    pipeline = tracker._items_page_pipeline(
        view="stock", brand="brand-1", customer=None, stage="in_box",
        q="Tap (Chrome)", product_id=None, floor_ids=["ground-floor"],
        sla_days=7, skip=30, limit=30,
    )

    assert pipeline[0]["$match"]["floor_id"] == {"$in": ["ground-floor"]}
    unwind_index = next(i for i, stage in enumerate(pipeline) if "$unwind" in stage)
    item_match_index = next(i for i, stage in enumerate(pipeline) if stage.get("$match", {}).get("brand_id") == "brand-1")
    assert item_match_index > unwind_index
    item_match = pipeline[item_match_index]["$match"]
    assert item_match["stage"] == "in_box"
    assert item_match["$or"][0]["sku"]["$regex"] == r"Tap\ \(Chrome\)"

    facet = pipeline[-1]["$facet"]
    assert {"$skip": 30} in facet["items"]
    assert {"$limit": 30} in facet["items"]
    assert facet["total"] == [{"$count": "value"}]
    assert facet["blocked"][0] == {"$match": {"blocked": True}}
    assert facet["stages"][0]["$group"]["count"] == {"$sum": 1}


class _Cursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, _limit):
        return self.rows


class _PurchaseOrders:
    def __init__(self, rows):
        self.rows = rows
        self.pipeline = None
        self.calls = 0

    def aggregate(self, pipeline):
        self.pipeline = pipeline
        self.calls += 1
        return _Cursor(self.rows)


class _Settings:
    async def find_one(self, *_args, **_kwargs):
        return None


class _Db:
    def __init__(self, rows):
        self.purchase_orders = _PurchaseOrders(rows)
        self.settings = _Settings()


def test_page_endpoint_shape_floor_scope_and_next_skip(monkeypatch):
    fake_db = _Db([{
        "items": [{
            "item_id": "item-31", "po_id": "po-1", "name": "Basin",
            "sku": "B-1", "stage": "in_box", "qty": 2, "unit_cost": 100,
            "last_moved_at": "2026-08-12T00:00:00+00:00", "blocked": False,
        }],
        "total": [{"value": 61}],
        "blocked": [{"value": 5}],
        "stages": [{"_id": "in_box", "count": 61}],
    }])
    monkeypatch.setattr(tracker, "db", fake_db)

    response = asyncio.run(tracker.list_items_page(
        view="stock", skip=30, limit=30, user=_user(),
    ))

    assert fake_db.purchase_orders.calls == 1
    assert fake_db.purchase_orders.pipeline[0]["$match"]["floor_id"] == {"$in": ["ground-floor"]}
    assert response["total"] == 61
    assert response["has_more"] is True
    assert response["next_skip"] == 31
    assert response["summaries"] == {
        "sla_days": 7, "blocked_count": 5, "stage_counts": {"in_box": 61},
    }
    assert response["items"][0]["stage_label"] == "Inbox"


def test_page_endpoint_uses_thirty_row_default():
    route = next(route for route in tracker.router.routes if route.path == "/purchases/items/page")
    limit_parameter = next(parameter for parameter in route.dependant.query_params if parameter.name == "limit")
    assert limit_parameter.default == 30
