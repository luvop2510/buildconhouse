"""Sales Data dashboard aggregation — computed in Python over confirmed
quotations, matching the existing dashboard_routes.py convention. These
tests exercise the computation directly against a fake db, same pattern as
test_dashboard_floor_scoping.py."""
from __future__ import annotations

import asyncio
import pytest

from models import UserPublic
from routes import sales_data_routes as sd


def _owner():
    return UserPublic(id="u-owner", email="o@forge.app", full_name="Owner", role="owner")


def _admin_ground_only():
    return UserPublic(id="u-admin", email="a@forge.app", full_name="Admin", role="admin", floor_ids=["ground-floor"])


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    async def to_list(self, _n):
        return self._docs


class _Collection:
    def __init__(self, docs):
        self._docs = docs
        self.last_query = None

    def find(self, query, *_a, **_kw):
        self.last_query = query
        docs = self._docs
        # Minimal real filtering — just enough to prove confirmed-order
        # queries exclude drafts. Not a general Mongo query engine:
        # floor/date clauses are recorded into last_query for assertion.
        if query and "status" in query:
            expected = query["status"]
            if isinstance(expected, dict) and "$in" in expected:
                docs = [d for d in docs if d.get("status") in expected["$in"]]
            else:
                docs = [d for d in docs if d.get("status") == expected]
        return _Cursor(docs)


class _FakeDb:
    def __init__(self, docs):
        self.quotations = _Collection(docs)


def test_bucket_label_day():
    assert sd._bucket_label("2026-07-15T10:00:00+00:00", "day") == "2026-07-15"


def test_bucket_label_month():
    assert sd._bucket_label("2026-07-15T10:00:00+00:00", "month") == "2026-07"


def test_bucket_label_quarter():
    assert sd._bucket_label("2026-08-01T00:00:00+00:00", "quarter") == "2026-Q3"


def test_bucket_label_year():
    assert sd._bucket_label("2026-01-05T00:00:00+00:00", "year") == "2026"


def test_resolve_floor_ids_owner_both_means_no_restriction():
    assert sd._resolve_floor_ids(_owner(), "both") is None
    assert sd._resolve_floor_ids(_owner(), None) is None


def test_resolve_floor_ids_owner_picks_one_floor():
    assert sd._resolve_floor_ids(_owner(), "ground-floor") == ["ground-floor"]


@pytest.mark.parametrize("floor", [None, "both"])
def test_delegated_combined_sales_never_broadens_page_granted_floors(floor):
    user = UserPublic(email="worker@example.com", full_name="Worker", role="worker",
                      custom_access=True, floor_ids=["ground-floor", "first-floor"])
    object.__setattr__(user, "_custom_grant_floor_ids", ["ground-floor"])
    assert sd._resolve_floor_ids(user, floor) == ["ground-floor"]
    object.__setattr__(user, "_custom_grant_floor_ids", [])
    assert sd._resolve_floor_ids(user, floor) == []


def test_resolve_floor_ids_admin_cannot_request_a_floor_outside_their_access():
    import pytest
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        sd._resolve_floor_ids(_admin_ground_only(), "first-floor")
    assert exc.value.status_code == 403


def test_confirmed_quotations_query_includes_current_and_legacy_completed_states(monkeypatch):
    fake_db = _FakeDb([])
    monkeypatch.setattr(sd, "db", fake_db)

    asyncio.run(sd.sales_overview(
        floor_id=None, referrer_type=None, date_from=None, date_to=None,
        granularity="month", user=_owner(),
    ))

    assert fake_db.quotations.last_query["status"] == {"$in": ["ordered", "won"]}


def test_confirmed_quotations_query_includes_floor_scoping(monkeypatch):
    """An explicit floor filter is always pushed into the Mongo query.

    The Sales Data screens now default that filter to the business unit
    currently active in the shell rather than to the company-wide "Both"
    roll-up, so this — not the unset case — is the everyday path. The
    unset/"both" case stays unrestricted on purpose (see
    `_resolve_floor_ids`): it is an explicit owner/admin choice, and
    narrowing it by `accessible_floor_ids` silently shrank an admin's
    company-wide report to their own assignment.
    """
    fake_db = _FakeDb([])
    monkeypatch.setattr(sd, "db", fake_db)

    asyncio.run(sd.sales_overview(
        floor_id="ground-floor", referrer_type=None, date_from=None, date_to=None,
        granularity="month", user=_admin_ground_only(),
    ))

    assert fake_db.quotations.last_query["floor_id"] == {"$in": ["ground-floor"]}


def test_confirmed_quotations_query_unrestricted_only_when_no_floor_filter(monkeypatch):
    fake_db = _FakeDb([])
    monkeypatch.setattr(sd, "db", fake_db)

    asyncio.run(sd.sales_overview(
        floor_id="both", referrer_type=None, date_from=None, date_to=None,
        granularity="month", user=_admin_ground_only(),
    ))

    assert "floor_id" not in fake_db.quotations.last_query


def test_confirmed_quotations_query_dates_current_orders_by_ordered_at(monkeypatch):
    fake_db = _FakeDb([])
    monkeypatch.setattr(sd, "db", fake_db)

    asyncio.run(sd.sales_overview(
        floor_id=None, referrer_type=None, date_from="2026-01-01", date_to="2026-12-31",
        granularity="month", user=_owner(),
    ))

    assert fake_db.quotations.last_query["$or"] == [
        {"status": "ordered", "ordered_at": {"$gte": "2026-01-01", "$lte": "2026-12-31"}},
        {"status": "won", "updated_at": {"$gte": "2026-01-01", "$lte": "2026-12-31"}},
    ]


def test_confirmed_quotations_excludes_drafts_and_counts_current_orders(monkeypatch):
    fake_db = _FakeDb([
        {"status": "won", "floor_id": "first-floor", "grand_total": 100, "updated_at": "2026-07-01T00:00:00+00:00"},
        {"status": "ordered", "floor_id": "ground-floor", "grand_total": 250, "ordered_at": "2026-07-02T00:00:00+00:00", "updated_at": "2020-01-01T00:00:00+00:00"},
        {"status": "draft", "floor_id": "first-floor", "grand_total": 999999, "updated_at": "2026-07-01T00:00:00+00:00"},
    ])
    monkeypatch.setattr(sd, "db", fake_db)

    result = asyncio.run(sd.sales_overview(
        floor_id=None, referrer_type=None, date_from=None, date_to=None,
        granularity="month", user=_owner(),
    ))

    assert result["total_revenue"] == 350
    assert result["quotation_count"] == 2
    assert result["trend"] == [{"bucket": "2026-07", "revenue": 350.0}]


def test_overview_totals_revenue_and_splits_by_floor(monkeypatch):
    fake_db = _FakeDb([
        {"status": "won", "floor_id": "ground-floor", "grand_total": 100000, "updated_at": "2026-07-01T00:00:00+00:00"},
        {"status": "won", "floor_id": "first-floor", "grand_total": 50000, "updated_at": "2026-07-02T00:00:00+00:00"},
    ])
    monkeypatch.setattr(sd, "db", fake_db)

    result = asyncio.run(sd.sales_overview(
        floor_id=None, referrer_type=None, date_from=None, date_to=None,
        granularity="month", user=_owner(),
    ))

    assert result["total_revenue"] == 150000
    by_floor = {r["floor_id"]: r["revenue"] for r in result["revenue_by_floor"]}
    assert by_floor == {"ground-floor": 100000, "first-floor": 50000}
    assert result["trend"] == [{"bucket": "2026-07", "revenue": 150000}]
    assert result["referrers"] is None


def test_overview_referrer_type_filters_and_ranks(monkeypatch):
    fake_db = _FakeDb([
        {
            "status": "won", "floor_id": "first-floor", "grand_total": 80000,
            "updated_at": "2026-07-01T00:00:00+00:00",
            "referrer_type": "architect", "referrer_id": "r1", "referrer_name": "Rakesh Sharma",
        },
        {
            "status": "won", "floor_id": "first-floor", "grand_total": 40000,
            "updated_at": "2026-07-02T00:00:00+00:00",
            "referrer_type": "architect", "referrer_id": "r1", "referrer_name": "Rakesh Sharma",
        },
        {
            "status": "won", "floor_id": "first-floor", "grand_total": 20000,
            "updated_at": "2026-07-02T00:00:00+00:00",
            "referrer_type": "interior_designer", "referrer_id": "r2", "referrer_name": "Nikita Shah",
        },
    ])
    monkeypatch.setattr(sd, "db", fake_db)

    result = asyncio.run(sd.sales_overview(
        floor_id=None, referrer_type="architect", date_from=None, date_to=None,
        granularity="month", user=_owner(),
    ))

    assert result["total_revenue"] == 120000
    assert result["referrers"] == [{"referrer_id": "r1", "name": "Rakesh Sharma", "revenue": 120000}]


class _CollectionWithFindOne(_Collection):
    def __init__(self, docs, referrer_doc):
        super().__init__(docs)
        self._referrer_doc = referrer_doc

    async def find_one(self, query, *_a, **_kw):
        if self._referrer_doc and self._referrer_doc.get("id") == query.get("id"):
            return self._referrer_doc
        return None


class _FakeDbWithReferrer:
    def __init__(self, quotation_docs, referrer_doc):
        self.quotations = _Collection(quotation_docs)
        self.referrers = _CollectionWithFindOne([], referrer_doc)
        self.kitchen_projects = type("EmptyKitchen", (), {"aggregate": lambda self, pipeline: _Cursor([])})()


def test_referrer_detail_returns_trend_and_quotations(monkeypatch):
    fake_db = _FakeDbWithReferrer(
        quotation_docs=[
            {
                "id": "q1", "number": "FQ-1", "customer_name": "Amit", "status": "won",
                "floor_id": "first-floor", "grand_total": 80000, "updated_at": "2026-07-01T00:00:00+00:00",
                "referrer_id": "r1",
            },
            {
                "id": "q2", "number": "FQ-2", "customer_name": "Priya", "status": "won",
                "floor_id": "first-floor", "grand_total": 40000, "updated_at": "2026-08-01T00:00:00+00:00",
                "referrer_id": "r1",
            },
            {
                "id": "q3", "number": "FQ-3", "customer_name": "Other", "status": "won",
                "floor_id": "first-floor", "grand_total": 99999, "updated_at": "2026-07-01T00:00:00+00:00",
                "referrer_id": "r-someone-else",
            },
        ],
        referrer_doc={"id": "r1", "name": "Rakesh Sharma Architects", "type": "architect"},
    )
    monkeypatch.setattr(sd, "db", fake_db)

    result = asyncio.run(sd.referrer_detail(
        "r1", date_from=None, date_to=None, granularity="month", user=_owner(),
    ))

    assert result["referrer"]["name"] == "Rakesh Sharma Architects"
    assert result["total_revenue"] == 120000
    assert result["trend"] == [
        {"bucket": "2026-07", "revenue": 80000},
        {"bucket": "2026-08", "revenue": 40000},
    ]
    assert [q["number"] for q in result["quotations"]] == ["FQ-2", "FQ-1"]  # newest first


def test_referrer_detail_404s_for_unknown_referrer(monkeypatch):
    import pytest
    from fastapi import HTTPException

    fake_db = _FakeDbWithReferrer(quotation_docs=[], referrer_doc=None)
    monkeypatch.setattr(sd, "db", fake_db)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(sd.referrer_detail("missing", date_from=None, date_to=None, granularity="month", user=_owner()))
    assert exc.value.status_code == 404


class _FakeDbForBrands:
    def __init__(self, quotation_docs, product_docs, brand_docs):
        self.quotations = _Collection(quotation_docs)
        self.products = _Collection(product_docs)
        self.brands = _CollectionWithFindOne(brand_docs, brand_docs[0] if brand_docs else None)


_QUOTATIONS_TWO_BRANDS = [
    {
        "status": "won", "floor_id": "first-floor", "grand_total": 0, "updated_at": "2026-07-01T00:00:00+00:00",
        "items": [
            {"id": "li-1", "product_id": "p1", "name": "Basin A", "sku": "SKU-A", "qty": 2, "unit_price": 5000, "discount_pct": 10},
        ],
    },
    {
        "status": "won", "floor_id": "first-floor", "grand_total": 0, "updated_at": "2026-07-02T00:00:00+00:00",
        "items": [
            {"id": "li-2", "product_id": "p2", "name": "Tap B", "sku": "SKU-B", "qty": 1, "unit_price": 3000, "discount_pct": 0},
        ],
    },
]
_PRODUCTS = [{"id": "p1", "brand_id": "b-kohler"}, {"id": "p2", "brand_id": "b-jaguar"}]
_BRANDS = [{"id": "b-kohler", "name": "Kohler"}, {"id": "b-jaguar", "name": "Jaguar"}]

# Line item has NO product-level discount_pct override (None — "no
# override"), but the quotation carries a project_discount_pct. Proves
# brands_ranked/brand_detail honor the room/category/project discount chain
# via services.pricing.per_line_net_amounts, not just product overrides.
_QUOTATION_PROJECT_DISCOUNT = {
    "status": "won", "floor_id": "first-floor", "grand_total": 8000, "updated_at": "2026-07-03T00:00:00+00:00",
    "project_discount_pct": 20,
    "items": [
        {"id": "li-3", "product_id": "p1", "name": "Basin A", "sku": "SKU-A", "qty": 1, "unit_price": 10000, "discount_pct": None},
    ],
}


def test_brands_ranked_joins_items_to_products_to_brands(monkeypatch):
    fake_db = _FakeDbForBrands(_QUOTATIONS_TWO_BRANDS, _PRODUCTS, _BRANDS)
    monkeypatch.setattr(sd, "db", fake_db)

    result = asyncio.run(sd.brands_ranked(date_from=None, date_to=None, user=_owner()))

    # Basin A: 2 * 5000 * 0.9 = 9000. Tap B: 1 * 3000 = 3000.
    assert result["brands"][0] == {"brand_id": "b-kohler", "brand_name": "Kohler", "revenue": 9000.0}
    assert result["brands"][1] == {"brand_id": "b-jaguar", "brand_name": "Jaguar", "revenue": 3000.0}


def test_brand_detail_returns_trend_and_top_products(monkeypatch):
    fake_db = _FakeDbForBrands(
        _QUOTATIONS_TWO_BRANDS, _PRODUCTS, [{"id": "b-kohler", "name": "Kohler"}],
    )
    monkeypatch.setattr(sd, "db", fake_db)

    result = asyncio.run(sd.brand_detail("b-kohler", date_from=None, date_to=None, granularity="month", user=_owner()))

    assert result["brand"]["name"] == "Kohler"
    assert result["total_revenue"] == 9000.0
    assert result["top_products"] == [{"product_id": "p1", "name": "Basin A", "sku": "SKU-A", "revenue": 9000.0}]


def test_brands_ranked_honors_project_discount_not_just_product_override(monkeypatch):
    """Regression test: brand revenue must apply the Product > Room >
    Category > Project discount precedence chain (services.pricing.
    per_line_net_amounts), not just a product-level discount_pct override.
    Basin A here has no product override (discount_pct: None) but the
    quotation has project_discount_pct = 20, so the effective net must be
    1 * 10000 * 0.8 = 8000, not the full 10000."""
    fake_db = _FakeDbForBrands([_QUOTATION_PROJECT_DISCOUNT], _PRODUCTS, _BRANDS)
    monkeypatch.setattr(sd, "db", fake_db)

    result = asyncio.run(sd.brands_ranked(date_from=None, date_to=None, user=_owner()))

    by_brand = {b["brand_id"]: b["revenue"] for b in result["brands"]}
    assert by_brand["b-kohler"] == 8000.0


def test_brand_detail_404s_for_unknown_brand(monkeypatch):
    import pytest
    from fastapi import HTTPException

    fake_db = _FakeDbForBrands([], [], [])
    monkeypatch.setattr(sd, "db", fake_db)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(sd.brand_detail("missing", date_from=None, date_to=None, granularity="month", user=_owner()))
    assert exc.value.status_code == 404


def test_brands_ranked_excludes_items_with_unknown_product(monkeypatch):
    quotations = [
        {
            "status": "won", "floor_id": "first-floor", "grand_total": 0, "updated_at": "2026-07-01T00:00:00+00:00",
            "items": [
                # p-orphan is entirely absent from the products fixture (e.g. a
                # deleted product, or one with no brand_id) — must be silently
                # excluded, not crash and not get mislabeled into some brand.
                {"id": "li-orphan", "product_id": "p-orphan", "name": "Mystery Item", "sku": "SKU-X", "qty": 1, "unit_price": 1000, "discount_pct": None},
            ],
        },
    ]
    fake_db = _FakeDbForBrands(quotations, [], [])
    monkeypatch.setattr(sd, "db", fake_db)

    result = asyncio.run(sd.brands_ranked(date_from=None, date_to=None, user=_owner()))

    assert result["brands"] == []
