"""GoDown transfers create customer orders or replace PO Final demand."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from models import PurchaseOrderItem, UserPublic
from routes import godown_stock_routes as route


class Cursor:
    def __init__(self, rows): self.rows = rows
    def sort(self, key, direction):
        self.rows = sorted(self.rows, key=lambda row: row.get(key) or "", reverse=direction == -1)
        return self
    async def to_list(self, _limit): return self.rows[:_limit]


class Session:
    async def __aenter__(self): return self
    async def __aexit__(self, *_args): return False
    def start_transaction(self): return self


class Client:
    async def start_session(self): return Session()


class Collection:
    def __init__(self, rows): self.rows = rows; self.inserted = []; self.updates = []
    async def find_one(self, query, *_args, **_kwargs):
        if "transfer_group_key" in query:
            return next((row for row in self.rows if matches(row, query)), None)
        idem = query.get("idempotency_key") or next((part["idempotency_key"] for part in query.get("$and", []) if "idempotency_key" in part), None)
        if idem:
            return next((row for row in self.rows if row.get("idempotency_key") == idem), None)
        wanted = query.get("id") or next((part["id"] for part in query.get("$and", []) if "id" in part), None)
        if not wanted and query.get("items.id"):
            return next((row for row in self.rows if any(item.get("id") == query["items.id"] for item in row.get("items", []))), None)
        return next((row for row in self.rows if row.get("id") == wanted), None)
    def find(self, query=None, *_args, **_kwargs):
        if query and "transfer_group_key" in query:
            return Cursor([row for row in self.rows if matches(row, query)])
        return Cursor(self.rows)
    async def insert_one(self, row, **_kwargs): self.inserted.append(row); self.rows.append(row)
    async def update_one(self, query, update, **_kwargs):
        self.updates.append((query, update))
        row = await self.find_one(query)
        if not row: return SimpleNamespace(modified_count=0)
        if "items" in query and row.get("items") != query["items"]:
            return SimpleNamespace(modified_count=0)
        for key, val in update.get("$inc", {}).items(): row[key] = row.get(key, 0) + val
        row.update(update.get("$set", {}))
        return SimpleNamespace(modified_count=1)


def matches(row, query):
    import re
    for key, wanted in query.items():
        value = row.get(key)
        if key == "items.godown_stock_id":
            value = next((item.get("godown_stock_id") for item in row.get("items", []) if item.get("godown_stock_id")), None)
        if isinstance(wanted, dict):
            if "$exists" in wanted and (value is not None) != wanted["$exists"]:
                return False
            if "$in" in wanted and value not in wanted["$in"]:
                return False
            if "$regex" in wanted and not re.search(wanted["$regex"], value or ""):
                return False
        elif value != wanted:
            return False
    return True


def user():
    return UserPublic(id="u-1", email="staff@example.com", full_name="Staff", role="warehouse", floor_ids=["first-floor"], active_floor_id="first-floor")


def lot():
    return {"id": "stock-1", "floor_id": "first-floor", "product_id": "product-1", "sku": "ABC", "name": "Mixer", "unit_price": 100, "mrp": 100, "available_qty": 5, "qty_received": 5, "loaned_out_qty": 0, "source_customer_id": "source-1", "source_customer_name": "Source"}


def po():
    return {"id": "po-1", "floor_id": "first-floor", "customer_id": "recipient-1", "customer_name": "Recipient", "items": [{"id": "item-1", "product_id": "product-1", "sku": "ABC", "name": "Mixer", "stage": "po_final", "qty": 3}]}


def test_matching_po_final_reports_ordered_and_transferable_quantities(monkeypatch):
    monkeypatch.setattr(route, "db", SimpleNamespace(purchase_orders=Collection([po()])))
    result = asyncio.run(route._po_final_matches(lot()))
    assert result["total_ordered_qty"] == 3
    assert result["transferable_qty"] == 3
    assert result["matches"][0]["matched_by"] == "product_id"


def test_customer_transfer_consumes_stock_replaces_po_final_and_is_idempotent(monkeypatch):
    stock = Collection([lot()]); transfers = Collection([])
    purchases = Collection([po()]); customers = Collection([{"id": "recipient-1", "floor_id": "first-floor", "name": "Recipient"}])
    fake_db = SimpleNamespace(godown_stock=stock, godown_customer_transfers=transfers, purchase_orders=purchases, customers=customers, payments=Collection([]), quotations=Collection([]))
    monkeypatch.setattr(route, "db", fake_db)
    monkeypatch.setattr(route, "client", Client())
    monkeypatch.setattr(route, "log_event", lambda **_kwargs: asyncio.sleep(0))
    async def number(*_args, **_kwargs): return "FQ-2026-0001"
    monkeypatch.setattr(route, "next_number", number)
    body = route.CustomerTransfer(qty=2, recipient_customer_id="recipient-1", recipient_purchase_item_id="item-1", unit_price=100, discount_pct=10, idempotency_key="request-123")
    result = asyncio.run(route.transfer_stock_to_customer("stock-1", body, user()))
    assert result["recipient_inbox_stage"] == "in_box"
    assert result["status"] == "completed"
    assert result["transfer_type"] == "godown_stock"
    assert result["net_unit_price"] == 90
    assert result["total"] == 180
    assert stock.rows[0]["available_qty"] == 3
    assert stock.rows[0]["loaned_out_qty"] == 0
    assert purchases.rows[0]["items"][0]["qty"] == 1
    assert purchases.rows[0]["items"][0]["stage"] == "po_final"
    assert purchases.rows[0]["items"][1]["stage"] == "in_box"
    assert purchases.rows[0]["items"][1]["qty"] == 2
    assert purchases.rows[0]["items"][1]["godown_transfer_net_unit_price"] == 90
    assert purchases.rows[0]["items"][1]["unit_cost"] == 0
    assert result["replacement_item_id"] == purchases.rows[0]["items"][1]["id"]
    assert result["recipient_quotation_id"] == fake_db.quotations.inserted[0]["id"]
    assert fake_db.quotations.inserted[0]["grand_total"] == 180
    assert PurchaseOrderItem.model_validate(purchases.rows[0]["items"][1]).godown_customer_transfer_id == result["id"]
    assert purchases.updates[0][0]["items"][0]["qty"] == 3  # optimistic demand compare
    assert stock.updates[0][0]["$expr"]["$gte"][1] == 2  # atomic free-stock check
    assert stock.updates[0][1]["$inc"] == {"available_qty": -2}
    assert not fake_db.payments.updates and not fake_db.payments.inserted
    repeated = asyncio.run(route.transfer_stock_to_customer("stock-1", body, user()))
    assert repeated["idempotent"] is True
    assert stock.rows[0]["available_qty"] == 3
    changed = body.model_copy(update={"qty": 1})
    with pytest.raises(HTTPException) as exc:
        asyncio.run(route.transfer_stock_to_customer("stock-1", changed, user()))
    assert exc.value.status_code == 409
    assert stock.rows[0]["available_qty"] == 3


def test_customer_transfer_rejects_non_matching_po_item(monkeypatch):
    wrong_po = po(); wrong_po["items"][0]["stage"] = "in_box"
    stock = Collection([lot()]); transfers = Collection([])
    monkeypatch.setattr(route, "db", SimpleNamespace(godown_stock=stock, godown_customer_transfers=transfers, purchase_orders=Collection([wrong_po]), customers=Collection([{"id": "recipient-1", "floor_id": "first-floor", "name": "Recipient"}])))
    monkeypatch.setattr(route, "client", Client())
    body = route.CustomerTransfer(qty=1, recipient_customer_id="recipient-1", recipient_purchase_item_id="item-1", idempotency_key="request-456")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(route.transfer_stock_to_customer("stock-1", body, user()))
    assert exc.value.status_code == 409
    assert stock.rows[0]["loaned_out_qty"] == 0


def test_customer_transfer_rejects_cancelled_purchase_order(monkeypatch):
    cancelled_po = po()
    cancelled_po["status"] = "cancelled"
    stock = Collection([lot()])
    purchases = Collection([cancelled_po])
    monkeypatch.setattr(route, "db", SimpleNamespace(
        godown_stock=stock, godown_customer_transfers=Collection([]),
        purchase_orders=purchases,
        customers=Collection([{"id": "recipient-1", "floor_id": "first-floor", "name": "Recipient"}]),
    ))
    monkeypatch.setattr(route, "client", Client())
    body = route.CustomerTransfer(
        qty=1, recipient_customer_id="recipient-1", recipient_purchase_item_id="item-1",
        idempotency_key="cancelled-po-123",
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(route.transfer_stock_to_customer("stock-1", body, user()))
    assert exc.value.status_code == 409
    assert purchases.updates == []
    assert stock.rows[0]["available_qty"] == 5


def test_matching_po_with_existing_order_does_not_duplicate_amount_due(monkeypatch):
    existing_po = po(); existing_po["quotation_id"] = "quote-1"
    quotations = Collection([])
    monkeypatch.setattr(route, "db", SimpleNamespace(
        godown_stock=Collection([lot()]), godown_customer_transfers=Collection([]),
        purchase_orders=Collection([existing_po]),
        customers=Collection([{"id": "recipient-1", "floor_id": "first-floor", "name": "Recipient"}]),
        quotations=quotations,
    ))
    monkeypatch.setattr(route, "client", Client())
    monkeypatch.setattr(route, "log_event", lambda **_kwargs: asyncio.sleep(0))
    body = route.CustomerTransfer(qty=1, recipient_customer_id="recipient-1", recipient_purchase_item_id="item-1", idempotency_key="existing-order-123")
    result = asyncio.run(route.transfer_stock_to_customer("stock-1", body, user()))
    assert result["recipient_quotation_id"] == "quote-1"
    assert result["recipient_inbox_stage"] == "in_box"
    assert quotations.inserted == []


def test_direct_customer_transfer_creates_order_payment_due_and_inbox_item(monkeypatch):
    stock = Collection([lot()]); transfers = Collection([]); purchases = Collection([po()]); quotations = Collection([])
    fake_db = SimpleNamespace(
        godown_stock=stock, godown_customer_transfers=transfers, purchase_orders=purchases,
        customers=Collection([{"id": "recipient-1", "floor_id": "first-floor", "name": "Recipient"}]),
        quotations=quotations,
    )
    monkeypatch.setattr(route, "db", fake_db)
    monkeypatch.setattr(route, "client", Client())
    monkeypatch.setattr(route, "log_event", lambda **_kwargs: asyncio.sleep(0))
    async def number(kind, *_args, **_kwargs): return "FQ-2026-0001" if kind == "quotation" else "FPO-2026-0001"
    monkeypatch.setattr(route, "next_number", number)
    body = route.CustomerTransfer(qty=5, recipient_customer_id="recipient-1", unit_price=100, discount_pct=10, idempotency_key="direct-123")
    result = asyncio.run(route.transfer_stock_to_customer("stock-1", body, user()))
    assert result["recipient_purchase_item_id"] is None
    assert result["replacement_item_id"] == purchases.inserted[0]["items"][0]["id"]
    assert result["recipient_inbox_stage"] == "in_box"
    assert result["recipient_purchase_order_id"] == purchases.inserted[0]["id"]
    assert result["recipient_quotation_id"] == quotations.inserted[0]["id"]
    assert result["status"] == "completed"
    assert stock.rows[0]["available_qty"] == 0
    assert purchases.rows[0]["items"][0]["qty"] == 3
    assert not purchases.updates
    assert quotations.inserted[0]["status"] == "ordered"
    assert quotations.inserted[0]["grand_total"] == 450
    assert quotations.inserted[0]["items"][0]["net_amount"] == 450
    assert purchases.inserted[0]["items"][0]["stage"] == "in_box"
    assert purchases.inserted[0]["items"][0]["unit_cost"] == 90
    assert purchases.inserted[0]["customer_id"] == "recipient-1"
    assert asyncio.run(route.transfer_stock_to_customer("stock-1", body, user()))["idempotent"] is True
    assert len(quotations.inserted) == len(purchases.inserted) == 1


def test_new_customer_transfer_creates_customer_order_and_inbox_item(monkeypatch):
    stock = Collection([lot()]); transfers = Collection([]); purchases = Collection([])
    customers = Collection([]); quotations = Collection([])
    monkeypatch.setattr(route, "db", SimpleNamespace(
        godown_stock=stock, godown_customer_transfers=transfers, purchase_orders=purchases,
        customers=customers, quotations=quotations,
    ))
    monkeypatch.setattr(route, "client", Client())
    monkeypatch.setattr(route, "log_event", lambda **_kwargs: asyncio.sleep(0))
    async def number(kind, *_args, **_kwargs): return "FQ-2026-0002" if kind == "quotation" else "FPO-2026-0002"
    monkeypatch.setattr(route, "next_number", number)
    body = route.CustomerTransfer(qty=2, new_customer=route.NewTransferCustomer(name="New Customer"), unit_price=80, idempotency_key="new-customer-123")
    result = asyncio.run(route.transfer_stock_to_customer("stock-1", body, user()))
    assert result["created_customer"] is True
    assert customers.inserted[0]["id"] == quotations.inserted[0]["customer_id"] == purchases.inserted[0]["customer_id"]
    assert purchases.inserted[0]["items"][0]["stage"] == "in_box"
    assert quotations.inserted[0]["grand_total"] == 160
    assert stock.rows[0]["available_qty"] == 3


def test_transfer_rejects_quantity_above_remaining_stock(monkeypatch):
    stock = Collection([lot()])
    monkeypatch.setattr(route, "db", SimpleNamespace(godown_stock=stock, godown_customer_transfers=Collection([])))
    monkeypatch.setattr(route, "client", Client())
    body = route.CustomerTransfer(qty=6, recipient_customer_id="recipient-1", idempotency_key="too-many-123")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(route.transfer_stock_to_customer("stock-1", body, user()))
    assert exc.value.status_code == 409
    assert stock.rows[0]["available_qty"] == 5


def test_replacement_keeps_unrelated_lines_and_drops_fulfilled_final_line():
    lines = [po()["items"][0], {"id": "other", "qty": 4, "stage": "po_final"}]
    replacement = {"id": "inbox", "qty": 3, "stage": "in_box"}
    result = route._replacement_items(lines, "item-1", replacement, 3)
    assert [item["id"] for item in result] == ["other", "inbox"]
    assert lines[0]["qty"] == 3


def setup_transfers(monkeypatch, quotes=None):
    database = SimpleNamespace(
        godown_stock=Collection([lot()]), godown_customer_transfers=Collection([]),
        purchase_orders=Collection([]), quotations=Collection(quotes or []),
        customers=Collection([{"id": "recipient-1", "floor_id": "first-floor", "name": "Recipient"}]),
    )
    monkeypatch.setattr(route, "db", database)
    monkeypatch.setattr(route, "client", Client())
    monkeypatch.setattr(route, "log_event", lambda **_kwargs: asyncio.sleep(0))
    async def number(kind, *_args, **_kwargs):
        return f"{kind}-{len(database.quotations.rows) + len(database.purchase_orders.rows) + 1}"
    monkeypatch.setattr(route, "next_number", number)
    return database


def transfer_request(key, **kwargs):
    return route.CustomerTransfer(qty=1, recipient_customer_id="recipient-1", unit_price=100,
                                  idempotency_key=key, **kwargs)


def test_repeated_direct_transfers_keep_one_quote_and_revision_history(monkeypatch):
    database = setup_transfers(monkeypatch)
    events = []
    async def record_event(**event): events.append(event)
    monkeypatch.setattr(route, "log_event", record_event)
    first = asyncio.run(route.transfer_stock_to_customer("stock-1", transfer_request("first-sale"), user()))
    second = asyncio.run(route.transfer_stock_to_customer("stock-1", transfer_request("second-sale"), user()))
    assert first["recipient_quotation_id"] == second["recipient_quotation_id"]
    assert len(database.quotations.inserted) == 1
    quote = database.quotations.rows[0]
    assert quote["grand_total"] == 200
    assert len(quote["items"]) == 2
    assert quote["revisions"][0]["snapshot"]["grand_total"] == 100
    assert len(quote["revisions"][0]["snapshot"]["items"]) == 1
    assert len(database.purchase_orders.inserted) == 2
    assert all(po["grand_total"] == 100 for po in database.purchase_orders.inserted)
    assert all(po["quotation_id"] == quote["id"] for po in database.purchase_orders.inserted)
    assert database.godown_stock.rows[0]["available_qty"] == 3
    assert database.customers.rows[0]["godown_transfer_revision"] == 2
    assert [event["quotation_id"] for event in events] == [quote["id"], quote["id"]]
    assert all(event["payload"]["amount"] == 100 for event in events)
    replay = asyncio.run(route.transfer_stock_to_customer("stock-1", transfer_request("second-sale"), user()))
    assert replay["idempotent"]
    assert len(quote["items"]) == 2
    assert database.customers.rows[0]["godown_transfer_revision"] == 2


def test_new_goods_reopen_the_same_fully_paid_transfer_quote(monkeypatch):
    import routes.payment_routes as payments
    database = setup_transfers(monkeypatch)
    first = asyncio.run(route.transfer_stock_to_customer("stock-1", transfer_request("paid-first"), user()))
    monkeypatch.setattr(payments, "db", database)
    async def paid(_ids, **_kwargs): return {first["recipient_quotation_id"]: 100}
    monkeypatch.setattr(payments, "_paid_by_quotation", paid)
    monkeypatch.setattr(payments, "_godown_value_by_quotation", lambda _ids: asyncio.sleep(0, result={}))
    def queue():
        return asyncio.run(payments.list_orders(status_filter=None, overdue_period=None,
            custom_min_days=None, custom_max_days=None, limit=200, user=user()))
    assert queue() == []
    asyncio.run(route.transfer_stock_to_customer("stock-1", transfer_request("paid-extra"), user()))
    assert len(queue()) == 1
    assert queue()[0]["id"] == first["recipient_quotation_id"]
    assert queue()[0]["paid"] == 100
    assert queue()[0]["outstanding"] == 100


def test_grouping_does_not_adopt_another_customer_floor_or_cancelled_quote(monkeypatch):
    group = "godown-customer:first-floor:recipient-1"
    others = [
        {"id": "other-customer", "customer_id": "other", "floor_id": "first-floor", "status": "ordered", "transfer_group_key": group},
        {"id": "other-floor", "customer_id": "recipient-1", "floor_id": "ground-floor", "status": "ordered", "transfer_group_key": group},
        {"id": "cancelled", "customer_id": "recipient-1", "floor_id": "first-floor", "status": "cancelled", "transfer_group_key": group},
        {"id": "project", "customer_id": "recipient-1", "floor_id": "first-floor", "status": "ordered", "grand_total": 500},
    ]
    original_ids = {quote["id"] for quote in others}
    database = setup_transfers(monkeypatch, others)
    result = asyncio.run(route.transfer_stock_to_customer("stock-1", transfer_request("scoped-sale"), user()))
    assert result["recipient_quotation_id"] not in original_ids
    assert not database.quotations.updates


def test_append_uses_shared_pricing_and_preserves_transport_and_extra_costs(monkeypatch):
    database = setup_transfers(monkeypatch)
    asyncio.run(route.transfer_stock_to_customer("stock-1", transfer_request("edited-first"), user()))
    quote = database.quotations.rows[0]
    quote["items"][0]["discount_pct"] = None
    quote.update(project_discount_pct=10, transportation_fee=25, grand_total=115,
                 payment_extra_history=[{"amount": 20, "name": "Labour"}])
    body = route.CustomerTransfer(qty=3, recipient_customer_id="recipient-1", unit_price=0.05,
                                  discount_pct=10, idempotency_key="edited-extra")
    result = asyncio.run(route.transfer_stock_to_customer("stock-1", body, user()))
    # Shared pricing rounds at the line total, not at the per-unit price.
    assert quote["grand_total"] == 115.14
    assert quote["items"][0]["net_amount"] == 90
    assert quote["items"][1]["net_amount"] == 0.14
    assert result["total"] == 0.14
    assert quote["payment_extra_history"] == [{"amount": 20, "name": "Labour"}]
    assert quote["revisions"][0]["snapshot"]["transportation_fee"] == 25


def test_legacy_stock_sale_adoption_preserves_quote_identity_and_old_revisions(monkeypatch):
    database = setup_transfers(monkeypatch)
    asyncio.run(route.transfer_stock_to_customer("stock-1", transfer_request("legacy-first"), user()))
    quote = database.quotations.rows[0]
    quote.pop("transfer_group_key")
    quote["revisions"] = [{"revision_no": 1, "snapshot": {"grand_total": 80}}]
    result = asyncio.run(route.transfer_stock_to_customer("stock-1", transfer_request("legacy-extra"), user()))
    assert result["recipient_quotation_id"] == quote["id"]
    assert len(database.quotations.inserted) == 1
    assert [revision["revision_no"] for revision in quote["revisions"]] == [1, 2]
    assert quote["grand_total"] == 200


def test_first_transfer_with_fractional_quantity_uses_shared_rounding(monkeypatch):
    database = setup_transfers(monkeypatch)
    body = route.CustomerTransfer(qty=1.5, recipient_customer_id="recipient-1", unit_price=10.01,
                                  discount_pct=10, idempotency_key="fraction-sale")
    result = asyncio.run(route.transfer_stock_to_customer("stock-1", body, user()))
    quote = database.quotations.rows[0]
    assert quote["subtotal"] == 15.02
    assert quote["discount_total"] == 1.50
    assert quote["grand_total"] == result["total"] == 13.51


def test_transfer_requires_explicit_price_for_unpriced_stock(monkeypatch):
    unpriced = lot(); unpriced["unit_price"] = None
    monkeypatch.setattr(route, "db", SimpleNamespace(godown_stock=Collection([unpriced]), godown_customer_transfers=Collection([])))
    monkeypatch.setattr(route, "client", Client())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(route.transfer_stock_to_customer("stock-1", route.CustomerTransfer(qty=1, recipient_customer_id="recipient-1", idempotency_key="unpriced-stock-123"), user()))
    assert exc.value.status_code == 422
    assert "price" in exc.value.detail


@pytest.mark.parametrize("flag", ["quantity_missing", "archived"])
def test_transfer_rejects_unknown_quantity_or_archived_stock(monkeypatch, flag):
    unavailable = {**lot(), flag: True}
    monkeypatch.setattr(route, "db", SimpleNamespace(godown_stock=Collection([unavailable]), godown_customer_transfers=Collection([])))
    monkeypatch.setattr(route, "client", Client())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(route.transfer_stock_to_customer("stock-1", route.CustomerTransfer(qty=1, recipient_customer_id="recipient-1", unit_price=100, idempotency_key="unavailable-stock-123"), user()))
    assert exc.value.status_code == 409
