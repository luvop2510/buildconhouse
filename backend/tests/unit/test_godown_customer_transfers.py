"""Customer loans preserve stock/accounting while linking PO Final demand."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from models import UserPublic
from routes import godown_stock_routes as route


class Cursor:
    def __init__(self, rows): self.rows = rows
    def sort(self, *_args): return self
    async def to_list(self, _limit): return self.rows


class Session:
    async def __aenter__(self): return self
    async def __aexit__(self, *_args): return False
    def start_transaction(self): return self


class Client:
    async def start_session(self): return Session()


class Collection:
    def __init__(self, rows): self.rows = rows; self.inserted = []; self.updates = []
    async def find_one(self, query, *_args, **_kwargs):
        idem = query.get("idempotency_key") or next((part["idempotency_key"] for part in query.get("$and", []) if "idempotency_key" in part), None)
        if idem:
            return next((row for row in self.rows if row.get("idempotency_key") == idem), None)
        wanted = query.get("id") or next((part["id"] for part in query.get("$and", []) if "id" in part), None)
        if not wanted and query.get("items.id"):
            return next((row for row in self.rows if any(item.get("id") == query["items.id"] for item in row.get("items", []))), None)
        return next((row for row in self.rows if row.get("id") == wanted), None)
    def find(self, *_args, **_kwargs): return Cursor(self.rows)
    async def insert_one(self, row, **_kwargs): self.inserted.append(row); self.rows.append(row)
    async def update_one(self, query, update, **_kwargs):
        self.updates.append((query, update))
        row = await self.find_one(query)
        if not row: return SimpleNamespace(modified_count=0)
        for key, val in update.get("$inc", {}).items(): row[key] = row.get(key, 0) + val
        row.update(update.get("$set", {}))
        return SimpleNamespace(modified_count=1)


def user():
    return UserPublic(id="u-1", email="staff@example.com", full_name="Staff", role="warehouse", floor_ids=["first-floor"], active_floor_id="first-floor")


def lot():
    return {"id": "stock-1", "floor_id": "first-floor", "product_id": "product-1", "sku": "ABC", "name": "Mixer", "available_qty": 5, "qty_received": 5, "loaned_out_qty": 0, "source_customer_id": "source-1", "source_customer_name": "Source"}


def po():
    return {"id": "po-1", "floor_id": "first-floor", "customer_id": "recipient-1", "customer_name": "Recipient", "items": [{"id": "item-1", "product_id": "product-1", "sku": "ABC", "name": "Mixer", "stage": "po_final", "qty": 3}]}


def test_matching_po_final_reports_ordered_and_transferable_quantities(monkeypatch):
    monkeypatch.setattr(route, "db", SimpleNamespace(purchase_orders=Collection([po()])))
    result = asyncio.run(route._po_final_matches(lot()))
    assert result["total_ordered_qty"] == 3
    assert result["transferable_qty"] == 3
    assert result["matches"][0]["matched_by"] == "product_id"


def test_customer_transfer_keeps_stock_and_payments_unchanged(monkeypatch):
    stock = Collection([lot()]); transfers = Collection([])
    purchases = Collection([po()]); customers = Collection([{"id": "recipient-1", "floor_id": "first-floor", "name": "Recipient"}])
    fake_db = SimpleNamespace(godown_stock=stock, godown_customer_transfers=transfers, purchase_orders=purchases, customers=customers, payments=Collection([]))
    monkeypatch.setattr(route, "db", fake_db)
    monkeypatch.setattr(route, "client", Client())
    monkeypatch.setattr(route, "log_event", lambda **_kwargs: asyncio.sleep(0))
    body = route.CustomerTransfer(qty=2, recipient_customer_id="recipient-1", recipient_purchase_item_id="item-1", idempotency_key="request-123")
    result = asyncio.run(route.transfer_stock_to_customer("stock-1", body, user()))
    assert result["recipient_inbox_stage"] == "in_box"
    assert result["status"] == "awaiting_return"
    assert stock.rows[0]["available_qty"] == 5
    assert stock.rows[0]["loaned_out_qty"] == 2
    assert purchases.rows[0]["items"][0]["qty"] == 3
    assert purchases.rows[0]["items"][0]["stage"] == "po_final"
    assert not fake_db.payments.updates and not fake_db.payments.inserted
    repeated = asyncio.run(route.transfer_stock_to_customer("stock-1", body, user()))
    assert repeated["idempotent"] is True
    assert stock.rows[0]["loaned_out_qty"] == 2


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
