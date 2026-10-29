"""Legacy transfer URLs must enforce the current stock-loan workflow."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from models import UserPublic
from routes import purchases_tracker as tracker
from services import transfer_workflow as workflow


def _user():
    return UserPublic(id="warehouse-dummy", email="warehouse@example.test", full_name="Dummy warehouse",
                      role="warehouse", floor_ids=["first-floor"], active_floor_id="first-floor")


@pytest.mark.parametrize("field", ["new_customer_id", "destination_customer_id"])
def test_legacy_transfer_delegates_alias_and_idempotency_to_canonical_command(monkeypatch, field):
    canonical = AsyncMock(return_value={"idempotent": True, "transfer_id": "dummy-transfer"})
    monkeypatch.setattr(tracker, "execute_transfer", canonical)
    user = _user()
    body = tracker.TransferBody(**{field: "dummy-recipient"}, qty=2, reason="Dummy loan", idempotency_key="dummy-request")

    result = asyncio.run(tracker.transfer_item("dummy-item", body, user))

    assert result == {"idempotent": True, "transfer_id": "dummy-transfer"}
    canonical.assert_awaited_once_with(item_id="dummy-item", destination_customer_id="dummy-recipient",
                                      new_customer=None, qty=2.0, reason="Dummy loan",
                                      idempotency_key="dummy-request", user=user)


def test_legacy_transfer_does_not_swallow_canonical_floor_rejection(monkeypatch):
    canonical = AsyncMock(side_effect=HTTPException(404, "Destination customer not found"))
    monkeypatch.setattr(tracker, "execute_transfer", canonical)
    with pytest.raises(HTTPException) as error:
        asyncio.run(tracker.transfer_item("dummy-item", tracker.TransferBody(new_customer_id="other-floor", qty=1), _user()))
    assert error.value.status_code == 404
    canonical.assert_awaited_once()


@pytest.mark.parametrize("changes", [{"stage": "dispatched"}, {"cancelled": True},
                                    {"stage": "in_box", "loaned_qty": 5}])
def test_legacy_url_cannot_bypass_canonical_stock_commitments(monkeypatch, changes):
    """Exercise the real canonical guard through the compatibility endpoint."""
    class Session:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *_):
            return False
        def start_transaction(self):
            return self

    class Client:
        async def start_session(self):
            return Session()

    source = {"id": "dummy-po", "floor_id": "first-floor", "customer_id": "dummy-source",
              "items": [{"id": "dummy-item", "product_id": "dummy-product", "qty": 5,
                         "stage": "in_box", **changes}]}
    purchases = SimpleNamespace(find_one=AsyncMock(return_value=source), insert_one=AsyncMock())
    monkeypatch.setattr(workflow, "db", SimpleNamespace(purchase_orders=purchases))
    monkeypatch.setattr(workflow, "client", Client())

    async def canonical(**kwargs):
        return await workflow._create_loan_transfer(
            item_id=kwargs["item_id"], destination_customer_id=kwargs["destination_customer_id"],
            new_customer=kwargs["new_customer"], qty=kwargs["qty"], reason=kwargs["reason"],
            key="dummy-request", user=kwargs["user"],
        )

    monkeypatch.setattr(tracker, "execute_transfer", canonical)
    with pytest.raises(HTTPException) as error:
        asyncio.run(tracker.transfer_item("dummy-item", tracker.TransferBody(new_customer_id="dummy-recipient", qty=1), _user()))
    assert error.value.status_code in {400, 409}
    purchases.insert_one.assert_not_awaited()
