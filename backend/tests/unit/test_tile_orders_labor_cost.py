from __future__ import annotations

import asyncio

import pytest

from routes import tile_orders as router_module


class _Result:
    matched_count = 1


class _Collection:
    def __init__(self):
        self.calls = []

    async def update_one(self, query, update, session=None, upsert=False):
        self.calls.append((query, update, session, upsert))
        return _Result()


class _Db:
    def __init__(self):
        self.quotations = _Collection()
        self.payments = _Collection()
        self.customer_orders = _Collection()


def test_labor_cost_creates_a_visible_idempotent_pending_payment(monkeypatch):
    fake_db = _Db()
    monkeypatch.setattr(router_module, "db", fake_db)

    po = {
        "quotation_id": "q-1", "quotation_number": "FQ-0001", "customer_order_id": "co-1",
        "customer_id": "cust-1", "customer_name": "Asha", "floor_id": "ground-floor",
    }
    dispatch = {"id": "dispatch-1", "dispatch_number": "DSP-0001", "created_by": "user-1", "created_by_name": "Warehouse"}
    asyncio.run(router_module._apply_dispatch_labor_cost(po, dispatch, 3000.0, session=None))

    quote_query, quote_update, _, _ = fake_db.quotations.calls[0]
    assert quote_query == {"id": "q-1", "floor_id": "ground-floor"}
    assert quote_update["$inc"] == {"grand_total": 3000.0, "labor_cost_total": 3000.0}

    payment_query, payment_update, _, payment_upsert = fake_db.payments.calls[0]
    assert payment_query == {"automation_key": "dispatch:dispatch-1:labor_cost"}
    assert payment_upsert is True
    payment = payment_update["$setOnInsert"]
    assert payment["amount"] == 3000.0
    assert payment["status"] == "pending"
    assert payment["label"] == "labor cost"
    assert payment["note"] == "₹3,000 labor cost added via dispatch DSP-0001"
    assert "idempotency_key" not in payment

    customer_query, customer_update, _, _ = fake_db.customer_orders.calls[0]
    assert customer_query == {"id": "co-1", "floor_id": "ground-floor"}
    assert customer_update["$inc"] == {"total_value": 3000.0}


@pytest.mark.parametrize("path", ["dispatch", "dispatch-from-released", "dispatch-from-godown"])
@pytest.mark.parametrize("raw_cost", ['"Infinity"', "1e309"])
def test_dispatch_rejects_nonfinite_labour_before_entering_mutation(monkeypatch, path, raw_cost):
    """Real request parsing/error serialization must reject before stock writes."""
    import httpx
    from fastapi import FastAPI, HTTPException
    from fastapi.exceptions import RequestValidationError
    from auth import get_current_user
    from models import UserPublic
    from server import safe_request_validation_error

    sessions_started = []
    class NoMutationClient:
        async def start_session(self):
            sessions_started.append(True)
            raise HTTPException(status_code=418, detail="Mutation handler entered")
    monkeypatch.setattr(router_module, "client", NoMutationClient())
    app = FastAPI()
    app.add_exception_handler(RequestValidationError, safe_request_validation_error)
    app.dependency_overrides[get_current_user] = lambda: UserPublic(
        id="warehouse-qa", email="warehouse@test.local", full_name="Warehouse", role="warehouse",
        floor_ids=["ground-floor"], active_floor_id="ground-floor",
    )
    app.include_router(router_module.router, prefix="/api")
    destination = ',"destination_type":"Customer","destination_name":"Site","destination_address":"QA","destination_city":"Mumbai"' if path == "dispatch" else ""
    body = '{"items":[{"po_item_id":"line","qty":1}],"labor_cost":' + raw_cost + destination + '}'

    async def request():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-qa") as http:
            return await http.post(f"/api/tile-orders/purchase-orders/po/{path}", content=body,
                                   headers={"Content-Type": "application/json"})
    response = asyncio.run(request())
    assert response.status_code == 422, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["detail"] == [{"loc": ["body", "labor_cost"], "type": "finite_number", "msg": "Invalid value"}]
    assert sessions_started == []


@pytest.mark.parametrize("model", [router_module.DispatchBody, router_module.SimpleDispatchBody])
@pytest.mark.parametrize("cost", [0, 123.45, "123.45"])
def test_dispatch_retains_finite_nonnegative_labour(model, cost):
    destination = dict(destination_type="Customer", destination_name="Site", destination_address="QA", destination_city="Mumbai") if model is router_module.DispatchBody else {}
    body = model(items=[{"po_item_id": "line", "qty": 1}], labor_cost=cost, **destination)
    assert body.labor_cost == float(cost)
