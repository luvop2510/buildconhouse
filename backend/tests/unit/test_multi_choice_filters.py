import pytest
from fastapi import HTTPException, Query

from models import UserPublic
from services.multi_filters import filter_values, filter_condition
from services.analytics.filters import AnalyticsFilter, FloorAccessError, build_match
from routes.payment_routes import _resolve_history_floor_ids, _history_filter
from routes.purchases_tracker import _items_page_pipeline


def test_multi_values_keep_legacy_queries_and_deduplicate():
    assert filter_values(" a, b, a, all, ") == ["a", "b"]
    assert filter_values(Query(None)) == []
    assert filter_condition("cash") == "cash"
    assert filter_condition("cash,upi") == {"$in": ["cash", "upi"]}


def test_filter_values_are_bounded_and_enum_checked():
    with pytest.raises(HTTPException):
        filter_values(",".join(str(i) for i in range(101)))
    with pytest.raises(HTTPException):
        filter_values("pending,unknown", allowed={"pending"})


def test_analytics_multi_floor_and_entity_filters_keep_date_scope():
    query = build_match(AnalyticsFilter(floor_id="first-floor,ground-floor", customer_id="a,b"), ["first-floor", "ground-floor"], ("start", "end"))
    assert query["floor_id"] == {"$in": ["first-floor", "ground-floor"]}
    assert query["customer_id"] == {"$in": ["a", "b"]}
    assert query["ordered_at"] == {"$gte": "start", "$lt": "end"}
    with pytest.raises(FloorAccessError):
        build_match(AnalyticsFilter(floor_id="first-floor,ground-floor"), ["first-floor"], (None, None))


def test_payment_history_multi_selection_never_widens_floor_access():
    user = UserPublic(id="sales", email="sales@example.com", full_name="Sales", role="sales", floor_ids=["first-floor", "ground-floor"])
    floors = _resolve_history_floor_ids(user, "first-floor,ground-floor")
    query = _history_filter(floors, None, None, None, None, "cash,upi", "completed")
    assert query["floor_id"] == {"$in": ["first-floor", "ground-floor"]}
    assert query["mode"] == {"$in": ["cash", "upi"]}
    with pytest.raises(HTTPException) as error:
        _resolve_history_floor_ids(user, "first-floor,second-floor")
    assert error.value.status_code == 403


def test_purchases_multi_selection_applies_before_paging_and_totals():
    pipeline = _items_page_pipeline(view="stock", brand="brand-a,brand-b", customer="c1,c2", stage="po_final,in_box", q=None, product_id=None, floor_ids=["first-floor"], sla_days=7, skip=0, limit=30)
    assert pipeline[0]["$match"]["floor_id"] == {"$in": ["first-floor"]}
    matches = [step["$match"] for step in pipeline if "$match" in step]
    assert any(query.get("brand_id") == {"$in": ["brand-a", "brand-b"]} and query.get("stage") == {"$in": ["po_final", "in_box"]} and query.get("customer_id") == {"$in": ["c1", "c2"]} for query in matches)
    with pytest.raises(HTTPException):
        _items_page_pipeline(view="stock", brand=None, customer=None, stage="in_box,bogus", q=None, product_id=None, floor_ids=None, sla_days=7, skip=0, limit=30)
