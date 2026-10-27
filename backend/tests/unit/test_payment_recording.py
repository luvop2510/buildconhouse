"""Collection writes validate money, retry safely, and serialize on the order."""
from __future__ import annotations

import asyncio
from time import monotonic
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from models import PaymentCreate, UserPublic
import routes.payment_routes as routes


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, _limit):
        return self.rows


class Quotations:
    def __init__(self, doc):
        self.doc = doc
        self.updates = []
        self.projections = []

    async def find_one(self, _query, projection=None, **_kwargs):
        self.projections.append(projection)
        return {key: value for key, value in self.doc.items() if projection is None or key in projection or not any(projection.values())}

    async def update_one(self, query, update, **_kwargs):
        self.updates.append((query, update))
        return SimpleNamespace(matched_count=1)


class Payments:
    def __init__(self):
        self.docs = []
        self.matches = []
        self.lookup_queries = []

    async def find_one(self, query, *_args, **_kwargs):
        self.lookup_queries.append(query)
        def value(query, field):
            return query.get(field) or next((value(part, field) for operator in ('$or', '$and') for part in query.get(operator, []) if value(part, field)), None)
        key = value(query, 'idempotency_key')
        # Tests use a one-floor accounts user, whose scope flattens to this shape.
        return next((doc for doc in self.docs if key and doc.get('idempotency_key') == key), None)

    def aggregate(self, pipeline, **_kwargs):
        match = pipeline[0]['$match']
        self.matches.append(match)
        total = sum(doc['amount'] for doc in self.docs if doc['quotation_id'] == match.get('quotation_id') and doc['floor_id'] == match.get('floor_id'))
        return Cursor([{'total': total}])

    async def insert_one(self, doc, **_kwargs):
        self.docs.append(doc)


class Session:
    def __init__(self):
        self.calls = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def with_transaction(self, callback):
        self.calls += 1
        return await callback(self)


@pytest.fixture
def context(monkeypatch):
    user = UserPublic(email='accounts@forge.app', full_name='Accounts', role='accounts', floor_ids=['first-floor'], active_floor_id='first-floor')
    quotations = Quotations({'id': 'q-one', 'number': 'Q-1', 'customer_id': 'c-one', 'customer_name': 'Customer', 'floor_id': 'first-floor', 'status': 'ordered', 'grand_total': 1000, 'payment_extra_amount': 999, 'payment_extra_history': [{'amount': 200}]})
    payments = Payments()
    session = Session()

    async def start_session():
        return session

    async def noop(*_args, **_kwargs):
        pass

    async def paid(*_args, **_kwargs):
        return {'q-one': sum(doc['amount'] for doc in payments.docs)}

    monkeypatch.setattr(routes, 'db', SimpleNamespace(quotations=quotations, payments=payments))
    monkeypatch.setattr(routes, 'client', SimpleNamespace(start_session=start_session))
    monkeypatch.setattr(routes, 'log_event', noop)
    monkeypatch.setattr(routes, 'notify', noop)
    monkeypatch.setattr(routes, 'reconcile_followups', noop)
    monkeypatch.setattr(routes, '_paid_by_quotation', paid)
    monkeypatch.setattr(routes, 'cache', SimpleNamespace(bump=noop))
    return user, quotations, payments, session


def record(context, amount=1200, key='payment-one', **fields):
    return asyncio.run(routes.create_payment(PaymentCreate(quotation_id='q-one', amount=amount, idempotency_key=key, **fields), idempotency_header=None, user=context[0]))


def test_full_payment_uses_extra_history_and_serializes_with_order_write(context):
    payment = record(context)
    assert payment.amount == 1200
    _, quotations, payments, session = context
    assert session.calls == 1
    assert quotations.updates[0][1] == {'$inc': {'payment_revision': 1}}
    assert 'payment_extra_history' in quotations.projections[-1]
    assert payments.matches[0]['floor_id'] == 'first-floor'
    assert len(payments.docs) == 1


def test_identical_retry_returns_committed_payment_without_new_insert(context):
    first = record(context, amount=600.25)
    replay = record(context, amount=600.25)
    assert replay['id'] == first.id
    assert len(context[2].docs) == 1
    assert context[3].calls == 1
    assert 'first-floor' in str(context[2].lookup_queries[-1])


def test_key_reuse_with_different_details_is_rejected(context):
    record(context, amount=100)
    with pytest.raises(HTTPException) as error:
        record(context, amount=200)
    assert error.value.status_code == 409
    assert len(context[2].docs) == 1


@pytest.mark.parametrize('amount', [1200.01, 0.001, float('inf')])
def test_invalid_or_overpaid_amount_never_inserts(context, amount):
    with pytest.raises(HTTPException) as error:
        record(context, amount=amount)
    assert error.value.status_code == 400
    assert context[2].docs == []


def test_invalid_receipt_date_never_inserts(context):
    with pytest.raises(HTTPException) as error:
        record(context, amount=10, paid_at='2026-02-31')
    assert error.value.status_code == 400
    assert context[2].docs == []


def test_post_commit_activity_failure_does_not_report_payment_failed(context, monkeypatch):
    async def failed_log(**_kwargs):
        raise RuntimeError('activity store unavailable')
    monkeypatch.setattr(routes, 'log_event', failed_log)
    assert record(context, amount=100).amount == 100
    assert len(context[2].docs) == 1


def test_hung_post_commit_effects_return_http_success_and_replay_without_another_payment(context, monkeypatch):
    """Use real timeout clocks: neither ancillary store may hold a committed receipt."""
    effects = {"started": [], "cancelled": []}

    async def hang(name):
        effects["started"].append(name)
        try:
            await asyncio.Event().wait()
        finally:
            effects["cancelled"].append(name)

    async def activity(**_kwargs):
        await hang("activity")

    async def notification(*_args, **_kwargs):
        await hang("notification")

    async def reconcile():
        return {}

    monkeypatch.setattr(routes, "log_event", activity)
    monkeypatch.setattr(routes, "notify", notification)
    monkeypatch.setattr(routes, "reconcile_followups_admitted", reconcile)
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[routes.get_current_user] = lambda: context[0]
    payload = {"quotation_id": "q-one", "amount": 100, "mode": "cash", "idempotency_key": "hung-effects-receipt"}

    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            started = monotonic()
            response = await asyncio.wait_for(client.post("/payments", json=payload), timeout=2.8)
            elapsed = monotonic() - started
            replay = await asyncio.wait_for(client.post("/payments", json=payload), timeout=0.3)
        assert response.status_code == replay.status_code == 200
        assert response.json() == replay.json()
        assert response.json()["amount"] == 100
        assert response.json()["status"] == "completed"
        assert 1.8 <= elapsed < 2.8

    asyncio.run(run())
    assert effects == {"started": ["activity", "notification"], "cancelled": ["activity", "notification"]}
    assert len(context[2].docs) == 1
    assert context[2].docs[0]["amount"] == 100
    assert context[3].calls == 1


def test_equivalent_iso_dates_replay_same_receipt(context):
    first = record(context, amount=100, paid_at='2026-10-01T12:00:00Z')
    replay = record(context, amount=100, paid_at='2026-10-01T17:30:00+05:30')
    assert replay['id'] == first.id
    assert len(context[2].docs) == 1


def test_concurrent_collectors_cannot_both_spend_same_balance(context, monkeypatch):
    """An interleaved DB fake requires the shared-order lock before reading.

    Payment inserts yield deliberately; without the order update both balance
    reads see zero and both inserts spend the same remaining amount.
    """
    async def run():
        lock = asyncio.Lock()
        quotations = context[1]
        payments = context[2]
        original_update = quotations.update_one
        original_insert = payments.insert_one

        class LockedSession:
            acquired = False

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def with_transaction(self, callback):
                try:
                    return await callback(self)
                finally:
                    if self.acquired:
                        lock.release()

        async def start_session():
            return LockedSession()

        async def update(query, change, *, session):
            await lock.acquire()
            session.acquired = True
            await asyncio.sleep(0)
            return await original_update(query, change, session=session)

        async def insert(doc, **kwargs):
            await asyncio.sleep(0)
            await original_insert(doc, **kwargs)

        monkeypatch.setattr(routes, 'client', SimpleNamespace(start_session=start_session))
        monkeypatch.setattr(quotations, 'update_one', update)
        monkeypatch.setattr(payments, 'insert_one', insert)
        results = await asyncio.gather(*[
            routes.create_payment(PaymentCreate(quotation_id='q-one', amount=800, idempotency_key=f'collector-{i}'), idempotency_header=None, user=context[0])
            for i in range(2)
        ], return_exceptions=True)
        assert len(payments.docs) == 1
        assert sum(doc['amount'] for doc in payments.docs) == 800
        rejected = [result for result in results if isinstance(result, HTTPException)]
        assert len(rejected) == 1
        assert rejected[0].status_code == 400

    asyncio.run(run())
