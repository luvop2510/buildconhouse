"""Summary/list search must retain exact floor, lifecycle and row identity."""
import asyncio
import copy
import gzip
import json
import re
from types import SimpleNamespace

from models import UserPublic
from routes import quotation_routes
from services.quotation_list import SUMMARY_FIELDS, list_projection, list_search


def test_literal_search_keeps_nested_floor_and_outcome_scope():
    scope = {"$and": [{"floor_id": "ground-floor"}, {"$or": [
        {"customer_outcome": "lost"}, {"status": "rejected"},
    ]}]}
    original = copy.deepcopy(scope)
    result = list_search(scope, "  A[1].*  ")
    assert result["$and"][0] == original
    assert scope == original
    alternatives = result["$and"][1]["$or"]
    assert len(alternatives) == 4
    for clause in alternatives:
        pattern = next(iter(clause.values()))
        assert pattern == {"$regex": r"A\[1\]\.\*", "$options": "i"}
        assert re.search(pattern["$regex"], "Customer A[1].*", re.I)
        assert not re.search(pattern["$regex"], "Customer A1anything", re.I)
    assert list_search(scope, "  ") is scope


def test_projection_omits_private_and_heavy_history_and_counts_empty_lines():
    assert list_projection(False) == {"_id": 0}
    projection = list_projection(True)
    assert projection["_id"] == 0
    assert projection["item_count"] == {"$size": {"$ifNull": ["$items", []]}}
    assert all(projection[field] == 1 for field in SUMMARY_FIELDS)
    assert not {"items", "revisions", "payments", "phone_snapshot", "address_snapshot"} & projection.keys()


def test_summary_route_pages_before_return_and_never_loads_catalog(monkeypatch):
    rows = [{"id": f"q-{index}", "customer_id": "c", "floor_id": "ground-floor",
             "number": f"TQ-{index}", "customer_name": "A[1]", "status": "draft",
             "created_at": "2026-10-30T00:00:00+00:00", "item_count": index}
            for index in range(31)]
    seen = {}

    class Cursor:
        def sort(self, value):
            seen["sort"] = value
            return self

        def skip(self, value):
            seen["skip"] = value
            return self

        def limit(self, value):
            seen["limit"] = value
            return self

        async def to_list(self, value):
            assert value == 31
            return rows

    class Quotations:
        def find(self, query, projection):
            seen["query"] = query
            seen["projection"] = projection
            return Cursor()

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("List summaries must not load product/media snapshots")

    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(quotations=Quotations()))
    monkeypatch.setattr(quotation_routes, "_canonicalize_item_images", forbidden)
    user = UserPublic(id="owner", email="owner@example.test", full_name="Owner", role="owner", active_floor_id="ground-floor")
    result = asyncio.run(quotation_routes.list_quotations(
        doc_type="tiles_quotation", view="pending", summary=True, q="A[1]",
        skip=30, limit=31, user=user,
    ))
    assert result == rows
    assert seen["projection"] == list_projection(True)
    assert seen["sort"] == [("created_at", -1), ("id", -1)]
    assert seen["skip"] == 30 and seen["limit"] == 31
    def scopes(query):
        if "$and" in query:
            return [part for clause in query["$and"] for part in scopes(clause)]
        return [query]
    scoped = scopes(seen["query"]["$and"][0])
    assert any(clause.get("floor_id") == "ground-floor" for clause in scoped)
    assert any(clause.get("status") == {"$in": ["draft", "pending_approval", "sent"]} for clause in scoped)
    assert seen["query"]["$and"][1]["$or"][0]["number"]["$regex"] == r"A\[1\]"


def test_summary_payload_preserves_visible_records_without_lines():
    documents = [{
        "id": f"q-{index}", "number": f"TQ-{index}", "floor_id": "ground-floor",
        "customer_id": f"c-{index}", "customer_name": f"Customer {index}",
        "doc_type": "tiles_quotation", "status": "draft", "grand_total": 12000,
        "created_at": "2026-10-30T00:00:00+00:00", "updated_at": "2026-10-30T00:00:00+00:00",
        "items": [{"id": f"line-{line}", "product_id": f"p-{line}", "sku": f"SKU-{line}",
                   "name": "Porcelain floor tile", "qty": 10, "price": 1200,
                   "image": f"https://cdn.example.test/products/{line}.jpg"} for line in range(30)],
        "revisions": [{"reason": "Saved price correction", "items": list(range(30))}],
    } for index in range(31)]
    summaries = [{**{key: row[key] for key in SUMMARY_FIELDS if key in row},
                  "item_count": len(row["items"])} for row in documents]
    assert [row["id"] for row in summaries] == [row["id"] for row in documents]
    assert all(summary["grand_total"] == full["grand_total"] and summary["item_count"] == len(full["items"])
               for summary, full in zip(summaries, documents))
    full_bytes = json.dumps(documents, separators=(",", ":")).encode()
    summary_bytes = json.dumps(summaries, separators=(",", ":")).encode()
    assert len(summary_bytes) < len(full_bytes) / 10
    print(json.dumps({"benchmark": "same-31-quotation-page", "records": len(documents),
                      "lines_per_quotation": 30, "full_json_bytes": len(full_bytes),
                      "summary_json_bytes": len(summary_bytes),
                      "full_gzip_bytes": len(gzip.compress(full_bytes, mtime=0)),
                      "summary_gzip_bytes": len(gzip.compress(summary_bytes, mtime=0))}))
