"""Reference reports keep currencies separate and bind Furniture to final ledgers."""
import asyncio
from decimal import Decimal
from types import SimpleNamespace

import pytest
from bson import Decimal128
from fastapi import HTTPException

from services.analytics.filters import AnalyticsFilter, FloorAccessError
from services.analytics.furniture import furniture_match, gather_furniture_reference_rows, gather_furniture_reference_records
from services.analytics.workspaces import merge_reference_currencies, workspace_pipeline
from services.analytics.lead_referrals import acquisition_pipeline


def test_furniture_scope_requires_access_and_uses_finalization_exclusive_end():
    with pytest.raises(FloorAccessError):
        furniture_match(AnalyticsFilter(floor_id="third-floor"), ["first-floor"], (None, None))
    match = furniture_match(AnalyticsFilter(floor_id="all", referrer_id="reference"), ["third-floor"], ("2026-10-01", "2026-11-01"))
    assert match["floor_id"] == {"$in": ["third-floor"]}
    assert match["status"] == "final" and match["referrer_id"] == "reference"
    assert match["finalized_at"] == {"$gte": "2026-10-01", "$lt": "2026-11-01"}
    assert match["is_deleted"] == {"$ne": True} and match["is_archived"] == {"$ne": True}
    assert match["archived_at"] is None
    assert furniture_match(AnalyticsFilter(floor_id="all"), [], (None, None))["floor_id"] == {"$in": []}
    assert furniture_match(AnalyticsFilter(floor_id="first-floor"), None, (None, None))["floor_id"] == {"$in": []}
    assert furniture_match(AnalyticsFilter(brand_id="brand"), None, (None, None))["id"] == {"$in": []}


def test_reference_currencies_never_sum_and_furniture_is_not_lost_to_inr_top100():
    inr = [{"id": f"inr-{i}", "name": f"INR {i}", "type": "architect", "revenue": 99999, "orders": 1, "customers": 1} for i in range(110)]
    inr.append({"id": "shared", "name": "Shared", "type": "architect", "revenue": 25, "orders": 1, "customers": 1})
    furniture = [{"id": "shared", "name": "Shared", "type": "architect", "revenue_rnb": 10.20, "orders_rnb": 2},
                 {"id": "furniture", "name": "Furniture", "type": "architect", "revenue_rnb": 12.30, "orders_rnb": 1}]
    rows = merge_reference_currencies(inr, [{"id": "furniture", "name": "Furniture", "customers_acquired": 7}], furniture)
    assert len(rows) == 112 and rows[0]["id"] == "furniture"
    shared = next(row for row in rows if row["id"] == "shared")
    assert shared["revenue"] == 25 and shared["revenue_rnb"] == 10.20
    assert shared["orders"] == 1 and shared["orders_rnb"] == 2
    assert "customers_acquired" not in shared  # missing acquisition rows are not fabricated zeroes
    assert rows[0]["customers_acquired"] == 7 and rows[0]["revenue"] == 0


def test_reference_limits_apply_after_aggregation_and_catalog_scope_does_not_remove_kitchen():
    stages = workspace_pipeline({}, include_kitchen=True, reference_limit=2001)
    assert stages[1] == {"$match": {"floor_id": {"$in": ["ground-floor", "first-floor"]}}}
    assert stages[2]["$unionWith"]["coll"] == "kitchen_projects"
    assert {"$limit": 2001} in stages[-1]["$facet"]["relationships"]
    assert {"$limit": 100} in stages[-1]["$facet"]["customers"]
    _, acquisition = acquisition_pipeline(AnalyticsFilter(), None, (None, None), limit=2001)
    assert {"$limit": 2001} in acquisition
    assert any(stage.get("$unionWith", {}).get("coll") == "furniture_quotations" for stage in acquisition)


class Cursor:
    def __init__(self, data): self.data = data
    async def to_list(self, limit): return self.data


def test_furniture_reference_amounts_decode_decimal_and_invalid_money_fails():
    data = [{"rows": [{"id": "r", "name": "Reference", "revenue_rnb": Decimal128(Decimal("0.30")), "orders_rnb": 2}]}]
    db = SimpleNamespace(furniture_quotations=SimpleNamespace(aggregate=lambda pipeline: Cursor(data)))
    rows = asyncio.run(gather_furniture_reference_rows(db, AnalyticsFilter(), None, (None, None)))
    assert rows[0]["revenue_rnb"] == 0.30
    data[:] = [{"invalid": [{"count": 1}]}]
    with pytest.raises(HTTPException):
        asyncio.run(gather_furniture_reference_rows(db, AnalyticsFilter(), None, (None, None)))
    with pytest.raises(HTTPException):
        asyncio.run(gather_furniture_reference_records(db, AnalyticsFilter(), None, (None, None)))
