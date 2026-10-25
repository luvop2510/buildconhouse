"""Every Referral Analytics read goes through build_match and reads only
quotations.referrer_* (spec §5.1 — Referrer itself carries zero metrics)."""
from __future__ import annotations

import asyncio

from services.analytics import gather_referrals
from services.analytics.filters import AnalyticsFilter
from tests.unit.test_gather_performance import _FakeDb

WINDOW = ("2026-07-01T00:00:00+00:00", "2026-07-31T23:59:59+00:00")


def test_gather_referrer_raw_is_floor_scoped():
    db = _FakeDb(quotations=[], payments=[], referrers=[])
    asyncio.run(gather_referrals.gather_referrer_raw(db, AnalyticsFilter(floor_id="all"), ["ground-floor"], WINDOW, None))
    scoped = [q for q in db.quotations.queries if isinstance(q, dict) and q.get("floor_id")]
    assert scoped


def test_gather_referrer_raw_filters_by_type_when_given():
    db = _FakeDb(quotations=[], payments=[], referrers=[])
    asyncio.run(gather_referrals.gather_referrer_raw(db, AnalyticsFilter(floor_id="all"), None, WINDOW, "architect"))
    typed = [q for q in db.quotations.queries if isinstance(q, dict) and q.get("referrer_type") == "architect"]
    assert typed


def test_gather_referrer_raw_includes_a_new_directory_person_with_zero_metrics():
    db = _FakeDb(
        quotations=[], payments=[],
        referrers=[{
            "id": "r-new", "name": "Studio Verve", "type": "interior_designer",
            "floor_id": "ground-floor",
        }],
    )

    rows = asyncio.run(gather_referrals.gather_referrer_raw(
        db, AnalyticsFilter(floor_id="all"), ["ground-floor"], WINDOW, "interior_designer",
    ))

    assert rows == [{
        "referrer_id": "r-new", "name": "Studio Verve", "type": "interior_designer",
        "customers_referred": 0, "quotations_total": 0, "quotations_approved": 0,
        "quotations_confirmed": 0, "revenue": 0.0, "pending_count": 0,
        "pending_value": 0.0, "pending_payments": 0.0, "first_referral_at": None,
        "last_referral_at": None, "repeat_customers": 0,
    }]


def test_gather_referrer_profile_directory_lookup_is_floor_scoped():
    class _FilteringCursor:
        def __init__(self, docs): self.docs = docs
        async def to_list(self, _limit): return self.docs

    class _FilteringReferrerCollection:
        def __init__(self, docs): self.docs, self.queries = docs, []
        def find(self, query=None, _projection=None):
            self.queries.append(query or {})
            def matches(doc):
                for key, value in (query or {}).items():
                    if isinstance(value, dict) and "$in" in value:
                        if doc.get(key) not in value["$in"]: return False
                    elif doc.get(key) != value: return False
                return True
            return _FilteringCursor([d for d in self.docs if matches(d)])

    db = _FakeDb(referrers=[], quotations=[])
    db.referrers = _FilteringReferrerCollection([{
        "id": "r-hidden", "name": "Other Floor Studio", "type": "architect", "floor_id": "first-floor",
    }])
    referrer, *_ = asyncio.run(gather_referrals.gather_referrer_profile_data(
        db, AnalyticsFilter(floor_id="all"), ["ground-floor"], "r-hidden", "month",
    ))

    assert referrer is None
    assert db.referrers.queries == [{"id": "r-hidden", "$or": [{"floor_id": {"$in": ["ground-floor"]}}, {"shared_across_floors": True}]}]


def test_gather_referrer_profile_data_returns_none_referrer_when_not_found():
    db = _FakeDb(referrers=[], quotations=[])
    referrer, trend, brands, products, floors = asyncio.run(
        gather_referrals.gather_referrer_profile_data(db, AnalyticsFilter(floor_id="all"), None, "missing-id", "month")
    )
    assert referrer is None
    assert trend == [] and brands == [] and products == []
    assert floors == {}
