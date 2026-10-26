"""Customer purchase workspace filters must compose on the backend while
continuing to use the existing floor-scoped Purchases tracker item traversal.
The workspace summary/facets should always describe the same filtered item set
returned in `products`/`outstanding_items`, without adding per-row DB lookups.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy

import pytest
import routes.payment_routes as payment_routes

from models import UserPublic
from routes import purchases_tracker as tracker


def _user(floor_id: str = "first-floor") -> UserPublic:
    return UserPublic(
        email="sales@forge.app",
        full_name="Sales",
        role="sales",
        floor_ids=["ground-floor", "first-floor"],
        active_floor_id=floor_id,
    )


def _row(
    item_id: str,
    *,
    brand_id: str,
    brand_name: str,
    stage: str,
    name: str,
    sku: str,
    qty: float,
    unit_cost: float,
    blocked: bool = False,
    po_number: str = "PO-1",
) -> dict:
    return {
        "id": item_id,
        "po_id": f"po-{po_number.lower()}",
        "po_number": po_number,
        "customer_id": "cust-1",
        "customer_name": "Aarav Residency",
        "brand_id": brand_id,
        "brand_name": brand_name,
        "stage": stage,
        "stage_label": tracker.STAGE_LABELS[stage],
        "stage_tone": tracker.STAGE_TONES[stage],
        "qty": qty,
        "unit_cost": unit_cost,
        "room": "Master Bath",
        "name": name,
        "sku": sku,
        "blocked": blocked,
        "age_days": 0,
        "last_moved_at": "2026-08-04T10:00:00+00:00",
        "created_at": "2026-08-01T10:00:00+00:00",
    }


def _workspace_rows() -> list[dict]:
    return [
        _row(
            "item-1", brand_id="grohe", brand_name="Grohe", stage="order_in_company",
            name="Grohe Rain Shower", sku="GR-SH-1", qty=2, unit_cost=1000, blocked=True, po_number="PO-1",
        ),
        _row(
            "item-2", brand_id="grohe", brand_name="Grohe", stage="dispatched",
            name="Grohe Basin Mixer", sku="GR-BM-1", qty=1, unit_cost=1500, po_number="PO-1",
        ),
        _row(
            "item-3", brand_id="vitra", brand_name="Vitra", stage="company_billing",
            name="Vitra Wall Hung WC", sku="VT-WC-1", qty=1, unit_cost=7000, po_number="PO-2",
        ),
        _row(
            "item-4", brand_id="vitra", brand_name="Vitra", stage="dispatched",
            name="Vitra Flush Plate", sku="VT-FP-1", qty=3, unit_cost=1200, po_number="PO-2",
        ),
        _row(
            "item-5", brand_id="geberit", brand_name="Geberit", stage="dispatched",
            name="Geberit Concealed Cistern", sku="GB-CC-1", qty=1, unit_cost=8000, po_number="PO-3",
        ),
    ]


class _Cursor:
    def __init__(self, rows: list[dict], calls: dict[str, int], key: str):
        self._rows = deepcopy(rows)
        self._calls = calls
        self._key = key

    def sort(self, *_args, **_kwargs):
        return self

    async def to_list(self, _n):
        self._calls[self._key] = self._calls.get(self._key, 0) + 1
        return deepcopy(self._rows)


class _Collection:
    def __init__(self, rows: list[dict], calls: dict[str, int], find_key: str):
        self._rows = deepcopy(rows)
        self._calls = calls
        self._find_key = find_key
        self.last_query: dict | None = None

    async def find_one(self, query, *_args, **_kwargs):
        self.last_query = deepcopy(query)
        self._calls[f"{self._find_key}.find_one"] = self._calls.get(f"{self._find_key}.find_one", 0) + 1
        return deepcopy(self._rows[0]) if self._rows else None

    def find(self, query, *_args, **_kwargs):
        self.last_query = deepcopy(query)
        self._calls[f"{self._find_key}.find"] = self._calls.get(f"{self._find_key}.find", 0) + 1
        return _Cursor(self._rows, self._calls, f"{self._find_key}.to_list")

    def aggregate(self, pipeline):
        self.last_query = deepcopy(pipeline[0]["$match"])
        self._calls[f"{self._find_key}.aggregate"] = self._calls.get(f"{self._find_key}.aggregate", 0) + 1
        qids = set(self.last_query.get("quotation_id", {}).get("$in", []))
        totals: dict[str, float] = {}
        for po in self._rows:
            qid = po.get("quotation_id")
            if qid not in qids:
                continue
            totals[qid] = totals.get(qid, 0.0) + sum(
                float(item.get("godown_transferred_qty") or 0) * float(item.get("unit_cost") or 0)
                for item in po.get("items") or [] if not item.get("cancelled")
            )
        return _Cursor([{"_id": qid, "total": total} for qid, total in totals.items()], self._calls, f"{self._find_key}.aggregate.to_list")


class _AggregatePurchaseOrders:
    def __init__(self, aggregate_rows: list[dict], po_rows: list[dict], calls: dict[str, int]):
        self._aggregate_rows = deepcopy(aggregate_rows)
        self._po_rows = deepcopy(po_rows)
        self._calls = calls
        self.last_pipeline: list[dict] | None = None
        self.last_find_query: dict | None = None

    def aggregate(self, pipeline):
        self._calls["purchase_orders.aggregate"] = self._calls.get("purchase_orders.aggregate", 0) + 1
        if "quotation_id" in pipeline[0]["$match"]:
            qids = set(pipeline[0]["$match"]["quotation_id"]["$in"])
            totals: dict[str, float] = {}
            for po in self._po_rows:
                if po.get("quotation_id") in qids:
                    qid = po["quotation_id"]
                    totals[qid] = totals.get(qid, 0.0) + sum(
                        float(item.get("godown_transferred_qty") or 0) * float(item.get("unit_cost") or 0)
                        for item in po.get("items") or [] if not item.get("cancelled")
                    )
            return _Cursor([{"_id": qid, "total": total} for qid, total in totals.items()], self._calls, "purchase_orders.aggregate.to_list")
        self.last_pipeline = deepcopy(pipeline)
        return _Cursor(self._aggregate_rows, self._calls, "purchase_orders.aggregate.to_list")

    def find(self, query, *_args, **_kwargs):
        self.last_find_query = deepcopy(query)
        self._calls["purchase_orders.find"] = self._calls.get("purchase_orders.find", 0) + 1
        return _Cursor(self._po_rows, self._calls, "purchase_orders.to_list")


class _Db:
    def __init__(
        self,
        calls: dict[str, int],
        *,
        pos: list[dict] | None = None,
        purchase_orders=None,
    ):
        self.customers = _Collection([{"id": "cust-1", "name": "Aarav Residency"}], calls, "customers")
        self.purchase_orders = purchase_orders or _Collection(pos or [
            {"id": "po-1", "number": "PO-1", "status": "open", "brand_name": "Grohe", "supplier_name": "Supplier A", "grand_total": 3500, "created_at": "2026-08-01T10:00:00+00:00", "expected_delivery_at": "2026-08-07T10:00:00+00:00", "items": [{}, {}]},
            {"id": "po-2", "number": "PO-2", "status": "open", "brand_name": "Vitra", "supplier_name": "Supplier B", "grand_total": 10600, "created_at": "2026-08-02T10:00:00+00:00", "expected_delivery_at": "2026-08-08T10:00:00+00:00", "items": [{}, {}]},
            {"id": "po-3", "number": "PO-3", "status": "cancelled", "brand_name": "Geberit", "supplier_name": "Supplier C", "grand_total": 8000, "created_at": "2026-08-03T10:00:00+00:00", "expected_delivery_at": None, "items": [{}]},
        ], calls, "purchase_orders")
        self.purchase_shortages = _Collection([], calls, "purchase_shortages")
        self.quotations = _Collection([{"id": "quote-1", "grand_total": 12000}], calls, "quotations")
        self.payments = _Collection([], calls, "payments")
        self.followups = _Collection([], calls, "followups")


async def _fake_timeline_for_factory(calls: dict[str, int], **_expected_kwargs):
    calls["timeline_for"] = calls.get("timeline_for", 0) + 1
    return []


def _fake_iter_items_factory(source_rows: list[dict], calls: dict[str, int]):
    async def _fake_iter_items(view, brand, customer, stage, q, sla_days, limit=2000, product_id=None, floor_ids=None):
        calls["iter_items"] = calls.get("iter_items", 0) + 1
        calls["iter_items.args"] = {
            "view": view,
            "brand": brand,
            "customer": customer,
            "stage": stage,
            "q": q,
            "sla_days": sla_days,
            "limit": limit,
            "product_id": product_id,
            "floor_ids": floor_ids,
        }
        if stage and stage not in tracker.PURCHASE_STAGES:
            raise tracker.HTTPException(status_code=400, detail=f"Unknown stage '{stage}'")

        rows = deepcopy(source_rows)
        if brand and brand.lower() != "all":
            rows = [r for r in rows if r.get("brand_id") == brand]
        if stage:
            rows = [r for r in rows if r.get("stage") == stage]
        if q:
            term = q.lower()
            rows = [
                r for r in rows
                if any(term in str(r.get(k) or "").lower() for k in ("sku", "name", "customer_name", "po_number", "brand_name"))
            ]
        return rows[:limit]

    return _fake_iter_items


def _assert_workspace_matches_rows(workspace: dict, rows: list[dict]) -> None:
    assert workspace["products"] == rows

    expected_total_value = round(sum(r["qty"] * r["unit_cost"] for r in rows), 2)
    expected_outstanding = [r for r in rows if r["stage"] != "dispatched"]
    expected_outstanding_value = round(sum(r["qty"] * r["unit_cost"] for r in expected_outstanding), 2)
    expected_blocked = sum(1 for r in rows if r["blocked"])
    expected_delivered = sum(1 for r in rows if r["stage"] == "dispatched")

    assert workspace["summary"]["total_items"] == len(rows)
    assert workspace["summary"]["total_value"] == expected_total_value
    assert workspace["summary"]["outstanding_count"] == len(expected_outstanding)
    assert workspace["summary"]["outstanding_value"] == expected_outstanding_value
    assert workspace["summary"]["blocked_count"] == expected_blocked
    assert workspace["summary"]["delivered_count"] == expected_delivered
    assert workspace["outstanding_items"] == expected_outstanding

    expected_brand_counts: dict[tuple[str | None, str], int] = {}
    for row in rows:
        key = (row.get("brand_id"), row.get("brand_name") or "Unbranded")
        expected_brand_counts[key] = expected_brand_counts.get(key, 0) + 1
    actual_brand_counts = {(brand["id"], brand["name"]): brand["count"] for brand in workspace["brands"]}
    assert actual_brand_counts == expected_brand_counts

    actual_stage_counts = {stage["key"]: stage["count"] for stage in workspace["stages"]}
    for stage in tracker.PURCHASE_STAGES:
        expected = sum(1 for row in rows if row["stage"] == stage)
        assert actual_stage_counts[stage] == expected


def _set_common_patches(monkeypatch, rows: list[dict], calls: dict[str, int]) -> None:
    monkeypatch.setattr(tracker, "db", _Db(calls))
    monkeypatch.setattr(tracker, "_iter_items", _fake_iter_items_factory(rows, calls))
    monkeypatch.setattr(tracker, "_hydrate_workspace_images", lambda _rows: asyncio.sleep(0))
    monkeypatch.setattr(tracker, "_load_settings", lambda: asyncio.sleep(0, result=tracker.TrackerSettings(sla_days=7)))
    monkeypatch.setattr(tracker, "timeline_for", lambda **kwargs: _fake_timeline_for_factory(calls, **kwargs))
    monkeypatch.setattr(payment_routes, "_paid_by_quotation", lambda ids, **_kwargs: asyncio.sleep(0, result={quote_id: 2000.0 for quote_id in ids}))


def test_workspace_without_filters_preserves_existing_shape(monkeypatch):
    rows = _workspace_rows()
    calls: dict[str, int] = {}
    _set_common_patches(monkeypatch, rows, calls)

    workspace = asyncio.run(tracker.customer_workspace("cust-1", user=_user()))

    _assert_workspace_matches_rows(workspace, rows)
    assert calls["iter_items.args"]["brand"] is None
    assert calls["iter_items.args"]["stage"] is None
    assert calls["iter_items.args"]["q"] is None
    assert calls["iter_items.args"]["floor_ids"] == ["first-floor"]


def test_order_value_keeps_loan_replacement_and_subtracts_godown_once(monkeypatch):
    """Physical return of a borrowed product must not erase the sale."""
    calls: dict[str, int] = {}
    rows = [{**row, "qty": 1, "unit_cost": 100} for row in _workspace_rows()[:1]]
    _set_common_patches(monkeypatch, rows, calls)
    monkeypatch.setattr(payment_routes, "_paid_by_quotation", lambda ids, **kwargs: asyncio.sleep(
        0, result={quote_id: 300.0 if kwargs.get("cash_only") else 320.0 for quote_id in ids},
    ))
    fake_db = tracker.db
    fake_db.quotations = _Collection([
        {"id": "quote-vitra", "grand_total": 300, "payment_extra_amount": 20},
    ], calls, "quotations")
    fake_db.purchase_orders = _Collection([
        {"id": "original", "number": "PO-1", "status": "open", "quotation_id": "quote-vitra", "grand_total": 300,
         "items": [
             {"id": "returned", "qty": 1, "unit_cost": 100, "loan_replenishment_returned_qty": 1},
             {"id": "kept", "qty": 1, "unit_cost": 100},
             {"id": "godown", "qty": 1, "unit_cost": 100, "godown_transferred_qty": 1},
         ]},
        {"id": "borrowed", "number": "PO-2", "status": "draft", "grand_total": 0,
         "items": [{"id": "loan", "qty": 1, "unit_cost": 0, "loan_transfer_id": "loan-1"}]},
    ], calls, "purchase_orders")

    workspace = asyncio.run(tracker.customer_workspace("cust-1", user=_user()))

    assert workspace["summary"]["total_value"] == 100  # visible stock only
    assert workspace["summary"]["order_value"] == 220  # sale + extra - godown
    assert workspace["summary"]["outstanding_balance"] == 0
    assert workspace["summary"]["refund_due"] == 80
    assert workspace["purchase_orders"][0]["grand_total"] == 300  # historical PO amount
    assert workspace["purchase_orders"][0]["current_order_value"] == 200
    assert workspace["purchase_orders"][1]["current_order_value"] == 0


def test_order_value_includes_godown_move_beyond_visible_po_page(monkeypatch):
    calls: dict[str, int] = {}
    _set_common_patches(monkeypatch, [], calls)
    fake_db = tracker.db
    fake_db.quotations = _Collection([{"id": "quote-1", "grand_total": 1000}], calls, "quotations")
    pos = [
        {"id": f"po-{idx}", "number": f"PO-{idx}", "status": "open", "quotation_id": "quote-1",
         "grand_total": 0, "items": [{"id": f"item-{idx}", "qty": 1, "unit_cost": 0}]}
        for idx in range(200)
    ]
    pos.append({"id": "old-godown-po", "number": "PO-old", "status": "open", "quotation_id": "quote-1",
                "grand_total": 100, "items": [{"id": "old-item", "qty": 1, "unit_cost": 100, "godown_transferred_qty": 1}]})

    class _PagedPurchaseOrders(_Collection):
        def find(self, query, *_args, **_kwargs):
            self.last_query = deepcopy(query)
            parent = self

            class _Page:
                def sort(self, *_sort_args):
                    return self

                async def to_list(self, limit):
                    parent._calls["purchase_orders.to_list"] = parent._calls.get("purchase_orders.to_list", 0) + 1
                    return deepcopy(parent._rows[:limit])

            return _Page()

    fake_db.purchase_orders = _PagedPurchaseOrders(pos, calls, "purchase_orders")
    monkeypatch.setattr(payment_routes, "_paid_by_quotation", lambda ids, **_kwargs: asyncio.sleep(
        0, result={quote_id: 1000.0 for quote_id in ids},
    ))

    workspace = asyncio.run(tracker.customer_workspace("cust-1", user=_user()))

    assert len(workspace["purchase_orders"]) == 200
    assert workspace["summary"]["order_value"] == 900
    assert workspace["summary"]["refund_due"] == 100
    assert calls["purchase_orders.aggregate"] == 1


def test_workspace_unfiltered_compatibility_retains_legacy_response_keys(monkeypatch):
    rows = _workspace_rows()
    calls: dict[str, int] = {}
    _set_common_patches(monkeypatch, rows, calls)

    workspace = asyncio.run(tracker.customer_workspace("cust-1", user=_user()))

    expected_keys = {
        "customer",
        "summary",
        "shortages",
        "payments",
        "followups",
        "products",
        "brands",
        "stages",
        "purchase_orders",
        "outstanding_items",
        "recent_activity",
        "expected_delivery",
    }
    assert expected_keys.issubset(workspace.keys())
    assert {"total_items", "total_value", "outstanding_count", "outstanding_value", "blocked_count", "delivered_count"}.issubset(
        workspace["summary"].keys()
    )
    assert {"next_at", "purchase_orders"}.issubset(workspace["expected_delivery"].keys())


def test_workspace_brand_filter(monkeypatch):
    rows = _workspace_rows()
    calls: dict[str, int] = {}
    _set_common_patches(monkeypatch, rows, calls)

    workspace = asyncio.run(tracker.customer_workspace("cust-1", brand="vitra", user=_user()))

    expected = [row for row in rows if row["brand_id"] == "vitra"]
    _assert_workspace_matches_rows(workspace, expected)
    assert all(product["brand_id"] == "vitra" for product in workspace["products"])


def test_workspace_stage_filter(monkeypatch):
    rows = _workspace_rows()
    calls: dict[str, int] = {}
    _set_common_patches(monkeypatch, rows, calls)

    workspace = asyncio.run(tracker.customer_workspace("cust-1", stage="dispatched", user=_user()))

    expected = [row for row in rows if row["stage"] == "dispatched"]
    _assert_workspace_matches_rows(workspace, expected)
    assert all(product["stage"] == "dispatched" for product in workspace["products"])


def test_workspace_brand_and_stage_filters_compose(monkeypatch):
    rows = _workspace_rows()
    calls: dict[str, int] = {}
    _set_common_patches(monkeypatch, rows, calls)

    workspace = asyncio.run(tracker.customer_workspace("cust-1", brand="grohe", stage="order_in_company", user=_user()))

    expected = [row for row in rows if row["brand_id"] == "grohe" and row["stage"] == "order_in_company"]
    _assert_workspace_matches_rows(workspace, expected)
    assert all(product["brand_id"] == "grohe" and product["stage"] == "order_in_company" for product in workspace["products"])


def test_workspace_search_brand_and_stage_filters_compose(monkeypatch):
    rows = _workspace_rows()
    calls: dict[str, int] = {}
    _set_common_patches(monkeypatch, rows, calls)

    workspace = asyncio.run(
        tracker.customer_workspace("cust-1", q="concealed", brand="geberit", stage="dispatched", user=_user())
    )

    expected = [
        row for row in rows
        if row["brand_id"] == "geberit" and row["stage"] == "dispatched" and "concealed" in row["name"].lower()
    ]
    _assert_workspace_matches_rows(workspace, expected)
    assert all("concealed" in product["name"].lower() for product in workspace["products"])


def test_workspace_clearing_filters_matches_unfiltered(monkeypatch):
    rows = _workspace_rows()
    calls: dict[str, int] = {}
    _set_common_patches(monkeypatch, rows, calls)

    unfiltered = asyncio.run(tracker.customer_workspace("cust-1", user=_user()))
    cleared = asyncio.run(tracker.customer_workspace("cust-1", q="", brand="all", stage="", user=_user()))

    assert cleared["products"] == unfiltered["products"]
    assert cleared["outstanding_items"] == unfiltered["outstanding_items"]
    assert cleared["brands"] == unfiltered["brands"]
    assert cleared["stages"] == unfiltered["stages"]
    assert cleared["summary"]["total_items"] == unfiltered["summary"]["total_items"]
    assert cleared["summary"]["total_value"] == unfiltered["summary"]["total_value"]


def test_workspace_large_history_avoids_per_item_queries(monkeypatch):
    calls: dict[str, int] = {}
    po_rows = [
        {"id": f"po-{idx}", "number": f"PO-{idx}", "status": "open", "brand_name": "Grohe", "supplier_name": "Supplier", "grand_total": 1000 + idx, "created_at": "2026-08-01T10:00:00+00:00", "expected_delivery_at": None, "items": [{}, {}, {}]}
        for idx in range(1, 10)
    ]

    aggregate_rows: list[dict] = []
    expected_rows: list[dict] = []
    for idx in range(1, 301):
        po_doc = {
            "id": f"po-{idx % 9}",
            "number": f"PO-{idx % 9}",
            "customer_id": "cust-1",
            "customer_name": "Aarav Residency",
            "brand_id": "grohe" if idx % 2 else "vitra",
            "brand_name": "Grohe" if idx % 2 else "Vitra",
            "quotation_id": None,
            "quotation_number": None,
            "created_at": "2026-07-01T10:00:00+00:00",
            "created_by_name": "Buyer",
            "status": "open",
            "supplier_id": "sup-1",
            "supplier_name": "Supplier",
            "expected_delivery_at": None,
        }
        item_doc = {
            "id": f"item-{idx}",
            "product_id": f"prod-{idx}",
            "sku": f"SKU-{idx}",
            "name": f"Bathroom Fixture {idx}",
            "brand_id": po_doc["brand_id"],
            "brand_name": po_doc["brand_name"],
            "customer_id": "cust-1",
            "customer_name": "Aarav Residency",
            "stage": "order_in_company" if idx % 3 == 0 else "dispatched",
            "qty": 1 + (idx % 4),
            "unit_cost": 500 + idx,
            "room": "Master Bath",
            "last_moved_at": "2026-07-20T10:00:00+00:00" if idx % 3 == 0 else "2026-08-04T10:00:00+00:00",
        }
        aggregate_rows.append({**po_doc, "items": item_doc})
        expected_rows.append(tracker._flatten_item(po_doc, item_doc, 7))
    expected_rows.sort(key=lambda r: (r["stage"] == "dispatched", -(r.get("age_days") or 0)))

    purchase_orders = _AggregatePurchaseOrders(aggregate_rows, po_rows, calls)
    monkeypatch.setattr(tracker, "db", _Db(calls, pos=po_rows, purchase_orders=purchase_orders))
    monkeypatch.setattr(tracker, "_hydrate_workspace_images", lambda _rows: asyncio.sleep(0))
    monkeypatch.setattr(tracker, "_load_settings", lambda: asyncio.sleep(0, result=tracker.TrackerSettings(sla_days=7)))
    monkeypatch.setattr(tracker, "timeline_for", lambda **kwargs: _fake_timeline_for_factory(calls, **kwargs))
    monkeypatch.setattr(payment_routes, "_paid_by_quotation", lambda ids, **_kwargs: asyncio.sleep(0, result={quote_id: 0.0 for quote_id in ids}))

    workspace = asyncio.run(tracker.customer_workspace("cust-1", user=_user()))

    _assert_workspace_matches_rows(workspace, expected_rows)
    assert calls["purchase_orders.aggregate"] == 2
    assert calls["purchase_orders.aggregate.to_list"] == 2
    assert calls["customers.find_one"] == 1
    assert calls["purchase_orders.find"] == 1
    assert calls["purchase_orders.to_list"] == 1
    assert calls["purchase_shortages.find"] == 1
    assert calls["purchase_shortages.to_list"] == 1
    assert calls["quotations.find"] == 1
    assert calls["quotations.to_list"] == 1
    assert calls["payments.find"] == 1
    assert calls["payments.to_list"] == 1
    assert calls["followups.find"] == 1
    assert calls["followups.to_list"] == 1
    assert calls["timeline_for"] == 1
    assert purchase_orders.last_pipeline is not None
    assert purchase_orders.last_pipeline[0]["$match"]["floor_id"] == {"$in": ["first-floor"]}
    assert purchase_orders.last_pipeline[1] == {"$unwind": "$items"}
    assert purchase_orders.last_pipeline[2] == {"$match": {"items.cancelled": {"$ne": True}}}
    assert "$expr" in purchase_orders.last_pipeline[3]["$match"]
    assert purchase_orders.last_pipeline[4]["$project"]["items"] == 1


@pytest.mark.parametrize('received', [0, 39000])
def test_unpaid_order_balance_uses_the_same_commercial_value_as_order_tile(monkeypatch, received):
    calls = {}
    rows = [{**row, 'qty': 1, 'unit_cost': 743000} for row in _workspace_rows()[:1]]
    _set_common_patches(monkeypatch, rows, calls)
    tracker.db.quotations = _Collection([{'id': 'quote-vitra', 'grand_total': 782000}], calls, 'quotations')
    monkeypatch.setattr(payment_routes, '_paid_by_quotation', lambda ids, **kwargs: asyncio.sleep(
        0, result={quote_id: received for quote_id in ids}))
    workspace = asyncio.run(tracker.customer_workspace('cust-1', user=_user()))
    assert workspace['summary']['order_value'] == 782000
    assert workspace['summary']['outstanding_balance'] == 782000 - received
    assert workspace['summary']['outstanding_value'] == 743000  # physical goods, not money due
