import pytest

from services.analytics.filters import AnalyticsFilter, FloorAccessError
from services.analytics.lead_referrals import acquisition_pipeline, merge_acquisitions


def test_preorder_interior_appears_and_existing_sales_keep_their_revenue():
    rows = merge_acquisitions(
        [{"id": "interior-a", "name": "A", "customers": 1, "revenue": 300, "orders": 2}],
        [{"id": "interior-a", "customers_acquired": 3}, {"id": "interior-b", "name": "B", "customers_acquired": 10}],
    )
    assert rows[0]["revenue"] == 300
    assert rows[0]["customers_acquired"] == 3
    assert rows[1]["customers_acquired"] == 10 and rows[1]["orders"] == 0


def test_every_source_is_floor_date_and_referrer_scoped_before_grouping():
    _, pipeline = acquisition_pipeline(AnalyticsFilter(floor_id="ground-floor", referrer_id="interior-a"), ["ground-floor"], ("start", "end"), "interior_designer")
    matches = [pipeline[0]["$match"]] + [stage["$unionWith"]["pipeline"][0]["$match"] for stage in pipeline if "$unionWith" in stage]
    assert len(matches) == 6
    for match in matches:
        assert match["floor_id"] == {"$in": ["ground-floor"]}
        assert match["created_at"] == {"$gte": "start", "$lt": "end"}
        assert match["referrer_id"] == "interior-a"
        assert match["referrer_type"] == "interior_designer"
        assert match["is_deleted"] == {"$ne": True}
        assert "status" not in match
    assert {"$limit": 100} in pipeline


def test_brand_scope_uses_the_filtered_order_cohort():
    match = {"status": "ordered", "items.product_id": {"$in": ["product-a"]}}
    collection, pipeline = acquisition_pipeline(AnalyticsFilter(brand_id="brand-a"), None, (None, None), order_match=match)
    assert collection == "quotations"
    assert pipeline[0]["$match"]["items.product_id"] == match["items.product_id"]
    assert not any("$unionWith" in stage for stage in pipeline)


def test_forbidden_floor_is_rejected_before_any_read():
    with pytest.raises(FloorAccessError):
        acquisition_pipeline(AnalyticsFilter(floor_id="first-floor"), ["ground-floor"], (None, None))
