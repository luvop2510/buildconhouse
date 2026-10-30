"""Company drilldowns retain the company identity recorded on order lines."""
import asyncio

from services.analytics import unified as sales
from services.analytics.unified_profiles import profile_history


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, length):
        return self.rows[:length]


def test_company_orders_load_saved_brand_names_after_product_reassignment():
    queries = {}
    saved = {"id": "order", "floor_id": "ground-floor", "status": "ordered", "ordered_at": "2026-10-10T00:00:00+00:00", "grand_total": 100,
             "items": [{"product_id": "moved-product", "brand_id": "original-company", "net_amount": 100, "qty": 1}]}

    class Products:
        def find(self, match, fields):
            if "brand_id" in match:
                assert match["brand_id"] == "original-company"
                return Cursor([])
            return Cursor([{"id": "moved-product", "brand_id": "new-company"}])

    class Brands:
        def find(self, match, fields):
            assert set(match["id"]["$in"]) == {"original-company", "new-company"}
            return Cursor([{"id": "original-company", "name": "Original company"}, {"id": "new-company", "name": "New company"}])

    class Quotations:
        def aggregate(self, pipeline, **options):
            queries["orders"] = pipeline[0]["$match"]
            return Cursor([saved])

    class Empty:
        def find(self, *args):
            return Cursor([])

    class DB:
        products, brands, quotations = Products(), Brands(), Quotations()
        payments = activity_events = Empty()

    query = sales.Query(preset="all", floor_id="ground-floor", company_id="original-company")
    rows = asyncio.run(sales.load_model(DB(), query, ["ground-floor"]))
    assert queries["orders"]["items"] == {"$elemMatch": {"$or": [
        {"brand_id": "original-company"}, {"brand_id": {"$in": [None, ""]}, "product_id": {"$in": []}},
    ]}}
    ranking = sales.ranking(rows, "companies")
    assert [(row["id"], row["name"], row["sales"]) for row in ranking] == [("original-company", "Original company", 100)]
    assert sales.dashboard(rows, query, ["ground-floor"])["kpis"]["sales"] == 100


def test_company_quote_history_uses_saved_identity_with_legacy_product_fallback():
    queries = {}

    class Products:
        def find(self, match, fields):
            return Cursor([{"id": "legacy-product"}])

    class Quotations:
        def find(self, match, fields):
            queries["history"] = match
            return Cursor([])

    class DB:
        products, quotations = Products(), Quotations()

    query = sales.Query(preset="all", floor_id="ground-floor", company_id="company", product_id="specific-product")
    assert asyncio.run(profile_history(DB(), query, ["ground-floor"]))["quotations"] == []
    assert queries["history"]["items"] == {"$elemMatch": {"$and": [
        {"product_id": "specific-product"},
        {"$or": [{"brand_id": "company"}, {"brand_id": {"$in": [None, ""]}, "product_id": {"$in": ["legacy-product"]}}]},
    ]}}
