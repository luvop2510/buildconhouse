import asyncio
from types import SimpleNamespace

from models import UserPublic
from routes import tile_orders


class Purchases:
    def __init__(self):
        self.pipeline = None
        self.calls = 0
    def aggregate(self, pipeline):
        self.calls += 1
        self.pipeline = pipeline
        class Cursor:
            async def to_list(self, limit):
                assert limit == 1
                return [{"orders": [{
                    "id": "po31", "created_at": "2026-10-01T00:00:00+00:00", "items": [{"qty": 3, "boxes_ready": 1, "boxes_pending": 2}],
                }], "metrics": [{"orders": 90, "pending": 30, "ready": 20, "partially_dispatched": 10, "completed": 30,
                    "other": 4, "boxes_pending": 120, "boxes_ready": 50, "boxes_dispatched": 180, "oldest_pending_at": "2026-10-01T00:00:00+00:00"}]}]
        return Cursor()
    def find(self, *_args):
        raise AssertionError("paged list must not retrieve all purchase orders")


def _user():
    return UserPublic(email="sales@example.com", full_name="Sales", role="sales", floor_ids=["ground-floor"], active_floor_id="ground-floor")


def _query_parts(query):
    return [part for term in query.get("$and", [query]) for part in term.get("$and", [term])]


def test_supplier_page_is_bounded_with_full_result_kpis_and_literal_search(monkeypatch):
    purchases = Purchases()
    monkeypatch.setattr(tile_orders, "db", SimpleNamespace(purchase_orders=purchases))
    response = asyncio.run(tile_orders.supplier_orders("supplier1", page=2, page_size=30, search="Tap (Chrome)", user=_user()))
    assert purchases.calls == 1
    parts = _query_parts(purchases.pipeline[0]["$match"])
    assert any(part.get("floor_id") == "ground-floor" for part in parts)
    assert any(part.get("supplier_id") == "supplier1" for part in parts)
    assert next(part["$or"] for part in parts if "$or" in part)[0]["customer_name"]["$regex"] == r"Tap\ \(Chrome\)"
    page_steps = purchases.pipeline[1]["$facet"]["orders"]
    assert {"$skip": 30} in page_steps and {"$limit": 30} in page_steps
    assert response["total"] == response["kpi"]["orders"] == 90
    assert response["kpi"]["boxes_pending"] == 120
    assert response["kpi"]["pending"] == 34
    assert response["orders"][0]["total_boxes"] == 3
    assert response["next_page"] == 3


def test_brand_page_retains_existing_kpi_names(monkeypatch):
    purchases = Purchases()
    monkeypatch.setattr(tile_orders, "db", SimpleNamespace(purchase_orders=purchases))
    response = asyncio.run(tile_orders.brand_orders("brand1", page=2, page_size=30, user=_user()))
    assert purchases.calls == 1
    assert any(part.get("brand_id") == "brand1" for part in _query_parts(purchases.pipeline[0]["$match"]))
    assert response["kpi"]["boxes_remaining"] == 120
    assert response["kpi"]["boxes_released"] == 50
    assert response["kpi"]["pending"] == 30
    assert response["orders"][0]["boxes_released"] == 1
    assert response["total"] == 90
