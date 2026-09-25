"""A stock loan preserves the source order and both customers' balances."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from models import UserPublic
from services import transfer_workflow as workflow


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


def base(query):
    return next((part for part in query.get('$and', []) if 'floor_id' not in part), query)


def allowed_floor(query, floor):
    scopes = [part.get('floor_id') for part in query.get('$and', []) if 'floor_id' in part]
    return not scopes or floor in scopes[0].get('$in', [])


class PurchaseOrders:
    def __init__(self, source):
        self.source = source
        self.destination = {'id': 'po-recipient', 'floor_id': 'first-floor',
                            'customer_id': 'recipient', 'status': 'ordered',
                            'items': [{'id': 'recipient-order-item', 'product_id': 'product-1',
                                       'stage': 'company_billing', 'qty': 2}]}
        self.inserted = []
        self.reservation_query = None

    async def find_one(self, query, *_args, **_kwargs):
        terms = base(query)
        if terms.get('customer_id') == self.destination['customer_id']:
            matched = any(i['product_id'] == terms['items']['$elemMatch']['product_id']
                          for i in self.destination['items'])
            return deepcopy(self.destination) if matched and allowed_floor(query, 'first-floor') else None
        wanted = terms.get('items.id')
        if allowed_floor(query, self.source['floor_id']) and any(i['id'] == wanted for i in self.source['items']):
            return deepcopy(self.source)
        return None

    async def update_one(self, query, update, **_kwargs):
        terms = base(query)
        condition = terms['items']['$elemMatch']
        if terms['id'] == self.destination['id']:
            row = self.destination['items'][0]
            promised = row.get('loan_replenishment_promised_qty', 0)
            if promised > row['qty'] - update['$inc']['items.$.loan_replenishment_promised_qty']:
                return SimpleNamespace(modified_count=0)
            row['loan_replenishment_promised_qty'] = promised + update['$inc']['items.$.loan_replenishment_promised_qty']
            row['loan_replenishment_for_customer_name'] = update['$set']['items.$.loan_replenishment_for_customer_name']
            return SimpleNamespace(modified_count=1)
        self.reservation_query = query
        item = self.source['items'][0]
        limit = condition['$and'][0]['$or'][1]['loaned_qty']['$lte']
        godown_guard = condition['$and'][1]
        expected_godown = (godown_guard.get('godown_transferred_qty')
                           if 'godown_transferred_qty' in godown_guard else 0)
        if item['stage'] != 'in_box' or item['qty'] != condition['qty'] or item.get('loaned_qty', 0) > limit or item.get('godown_transferred_qty', 0) != expected_godown:
            return SimpleNamespace(modified_count=0)
        item['loaned_qty'] = item.get('loaned_qty', 0) + update['$inc']['items.$.loaned_qty']
        item.setdefault('stage_history', []).append(update['$push']['items.$.stage_history'])
        item.setdefault('customer_loan_history', []).append(update['$push']['items.$.customer_loan_history'])
        return SimpleNamespace(modified_count=1)

    async def insert_one(self, doc, **_kwargs):
        self.inserted.append(doc)


class Customers:
    def __init__(self):
        self.docs = [
            {'id': 'source', 'name': 'Source', 'floor_id': 'first-floor'},
            {'id': 'recipient', 'name': 'Recipient', 'floor_id': 'first-floor'},
            {'id': 'other-floor', 'name': 'Other', 'floor_id': 'ground-floor'},
        ]
        self.updated = []

    async def find_one(self, query, *_args, **_kwargs):
        terms = base(query)
        return next((deepcopy(c) for c in self.docs if allowed_floor(query, c['floor_id']) and all(c.get(k) == v for k, v in terms.items())), None)

    async def insert_one(self, doc, **_kwargs):
        self.docs.append(doc)

    async def update_one(self, query, update, **_kwargs):
        self.updated.append((base(query)['id'], update['$addToSet']))


class Transfers:
    def __init__(self):
        self.inserted = []
        self.updated = []

    async def insert_one(self, doc, **_kwargs):
        self.inserted.append(doc)

    async def find_one(self, *_args, **_kwargs):
        return self.inserted[0]

    async def update_one(self, query, update, **_kwargs):
        self.updated.append(update)


def setup(monkeypatch, *, stage='in_box', loaned=0, godown_transferred=0):
    source = {
        'id': 'po-source', 'number': 'FPO-1', 'floor_id': 'first-floor',
        'customer_id': 'source', 'customer_name': 'Source',
        'items': [{'id': 'item-source', 'product_id': 'product-1', 'sku': 'SKU-1',
                   'name': 'Basin', 'qty': 5, 'loaned_qty': loaned,
                   'godown_transferred_qty': godown_transferred,
                   'stage': stage, 'customer_id': 'source', 'unit_cost': 100,
                   'stage_history': []}],
    }
    po = PurchaseOrders(source)
    customers = Customers()
    transfers = Transfers()
    db = SimpleNamespace(purchase_orders=po, customers=customers, purchase_transfers=transfers)
    monkeypatch.setattr(workflow, 'db', db)
    monkeypatch.setattr(workflow, 'client', Client())

    async def number(*_args):
        return 'FPO-LOAN-1'

    async def enqueue(**_kwargs):
        return {'id': 'event-1'}

    monkeypatch.setattr(workflow, '_next_number', number)
    monkeypatch.setattr(workflow, 'enqueue_after_primary_commit', enqueue)
    user = UserPublic(email='warehouse@forge.app', full_name='Warehouse', role='warehouse',
                      floor_ids=['first-floor'], active_floor_id='first-floor')
    return db, user


def create(monkeypatch, *, stage='in_box', loaned=0, godown_transferred=0, qty=2, destination='recipient'):
    db, user = setup(monkeypatch, stage=stage, loaned=loaned,
                     godown_transferred=godown_transferred)
    async def run():
        return await workflow._create_loan_transfer(
            item_id='item-source', destination_customer_id=destination,
            new_customer=None, qty=qty, reason='Needed now', key='test-key', user=user,
        )
    return db, run


def test_loan_preserves_source_quantity_and_creates_borrowed_in_box_item(monkeypatch):
    db, run = create(monkeypatch)
    assert asyncio.run(run()) == {'id': 'event-1'}
    source = db.purchase_orders.source['items'][0]
    assert source['qty'] == 5
    assert source['stage'] == 'in_box'
    assert source['loaned_qty'] == 2
    assert 'Recipient' in source['stage_history'][0]['note']
    assert source['customer_loan_history'][0]['destination_customer_name'] == 'Recipient'
    borrowed_po = db.purchase_orders.inserted[0]
    borrowed = borrowed_po['items'][0]
    assert borrowed_po['grand_total'] == borrowed_po['subtotal'] == 0
    assert borrowed['stage'] == 'in_box'
    assert borrowed['qty'] == 2
    assert borrowed['unit_cost'] == 0
    assert borrowed['borrowed_from_customer_id'] == 'source'
    assert borrowed['borrowed_at']
    assert borrowed['borrowing_note'] == 'Needed now'
    assert borrowed['loan_return_status'] == 'awaiting_return'
    assert borrowed['return_due_on_replenishment'] is True
    assert db.purchase_transfers.inserted[0]['status'] == 'awaiting_return'
    assert db.purchase_transfers.inserted[0]['source_remaining_qty'] == 5
    assert db.purchase_orders.destination['items'][0]['loan_replenishment_promised_qty'] == 2
    assert {customer for customer, _ in db.customers.updated} == {'source', 'recipient'}
    reservation = base(db.purchase_orders.reservation_query)['items']['$elemMatch']
    assert reservation['stage'] == 'in_box'
    assert reservation['qty'] == 5
    assert reservation['$and'][0]['$or'][1]['loaned_qty']['$lte'] == 3


@pytest.mark.parametrize('stage', ['po_final', 'company_billing', 'dispatched'])
def test_only_in_box_stock_can_be_lent(monkeypatch, stage):
    db, run = create(monkeypatch, stage=stage)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(run())
    assert exc.value.status_code == 409
    assert db.purchase_orders.inserted == []


def test_loan_cannot_exceed_unreserved_quantity(monkeypatch):
    db, run = create(monkeypatch, loaned=4, qty=2)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(run())
    assert exc.value.status_code == 400
    assert db.purchase_orders.source['items'][0]['qty'] == 5


def test_godown_transferred_units_are_not_available_for_customer_loan(monkeypatch):
    db, run = create(monkeypatch, loaned=1, godown_transferred=3, qty=2)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(run())
    assert exc.value.status_code == 400
    assert 'Only 1 available' in exc.value.detail
    assert db.purchase_orders.source['items'][0]['qty'] == 5
    assert db.purchase_orders.inserted == []


def test_godown_quantity_is_part_of_reservation_compare_and_swap(monkeypatch):
    db, run = create(monkeypatch, godown_transferred=2, qty=2)
    asyncio.run(run())
    reservation = base(db.purchase_orders.reservation_query)['items']['$elemMatch']
    assert reservation['$and'][1] == {'godown_transferred_qty': 2.0}
    assert reservation['$and'][0]['$or'][1]['loaned_qty']['$lte'] == 1
    assert db.purchase_orders.source['items'][0]['qty'] == 5
    assert db.purchase_orders.source['items'][0]['loaned_qty'] == 2


def test_destination_must_belong_to_users_floor(monkeypatch):
    db, run = create(monkeypatch, destination='other-floor')
    with pytest.raises(HTTPException) as exc:
        asyncio.run(run())
    assert exc.value.status_code == 404
    assert db.purchase_orders.inserted == []


def test_new_customer_cannot_borrow_without_existing_order(monkeypatch):
    db, user = setup(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(workflow._create_loan_transfer(
            item_id='item-source', destination_customer_id=None,
            new_customer={'name': 'New Recipient', 'email': 'new@example.com'},
            qty=1, reason=None, key='new-customer-key', user=user,
        ))
    assert exc.value.status_code == 409
    assert db.purchase_orders.inserted == []


def test_new_customer_without_email_cannot_borrow(monkeypatch):
    db, user = setup(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(workflow._create_loan_transfer(
            item_id='item-source', destination_customer_id=None,
            new_customer={'name': 'No Email Recipient'}, qty=1,
            reason=None, key='no-email-key', user=user,
        ))
    assert exc.value.status_code == 409


def test_recipient_without_matching_product_cannot_borrow(monkeypatch):
    db, run = create(monkeypatch)
    db.purchase_orders.destination['items'][0]['product_id'] = 'different-product'
    with pytest.raises(HTTPException) as exc:
        asyncio.run(run())
    assert exc.value.status_code == 409
    assert db.purchase_orders.inserted == []


def test_recipient_order_cannot_promise_more_than_its_quantity(monkeypatch):
    db, run = create(monkeypatch)
    db.purchase_orders.destination['items'][0]['qty'] = 1
    with pytest.raises(HTTPException) as exc:
        asyncio.run(run())
    assert exc.value.status_code == 409
    assert db.purchase_orders.inserted == []


def test_second_loan_cannot_reserve_units_already_lent(monkeypatch):
    db, run = create(monkeypatch, loaned=3, qty=2)
    asyncio.run(run())
    assert db.purchase_orders.source['items'][0]['loaned_qty'] == 5
    db2, user = db, UserPublic(email='warehouse@forge.app', full_name='Warehouse',
                              role='warehouse', floor_ids=['first-floor'],
                              active_floor_id='first-floor')
    with pytest.raises(HTTPException) as exc:
        asyncio.run(workflow._create_loan_transfer(
            item_id='item-source', destination_customer_id='recipient',
            new_customer=None, qty=1, reason=None, key='second-key', user=user,
        ))
    assert exc.value.status_code == 400
    assert len(db2.purchase_orders.inserted) == 1


def test_loan_handler_writes_bilateral_activity_without_payments(monkeypatch):
    db, _ = create(monkeypatch)
    db.purchase_transfers.inserted.append({
        'id': 'loan-1', 'type': 'loan', 'status': 'awaiting_return',
        'source_po_id': 'po-source', 'source_item_id': 'item-source',
        'source_customer_id': 'source', 'source_customer_name': 'Source',
        'destination_po_id': 'po-dest', 'destination_po_number': 'FPO-2',
        'destination_item_id': 'item-dest', 'destination_customer_id': 'recipient',
        'destination_customer_name': 'Recipient', 'qty': 2, 'sku': 'SKU-1',
        'name': 'Basin', 'source_remaining_qty': 5, 'source_loaned_qty_after': 2,
    })
    activities = []

    async def activity(**kwargs):
        activities.append(kwargs)

    monkeypatch.setattr(workflow, '_upsert_activity', activity)
    result = asyncio.run(workflow.handle_purchase_transferred(
        {'payload': {'transfer_id': 'loan-1'}, 'idempotency_key': 'test-key',
         'actor_id': 'user-1', 'actor_name': 'Warehouse'}, Session(),
    ))
    assert result['payment_amount'] == 0
    assert result['shortage'] is None
    assert len(activities) == 2
    assert 'Recipient' in activities[0]['summary']
    assert 'Source' in activities[1]['summary']
    assert not hasattr(db, 'payments')


def test_settle_return_releases_reservation_and_keeps_purchase_lines(monkeypatch):
    db, user = setup(monkeypatch)
    loan = {
        'id': 'loan-1', 'type': 'loan', 'status': 'return_due',
        'floor_id': 'first-floor', 'qty': 2, 'name': 'Basin',
        'source_po_id': 'po-source', 'source_item_id': 'item-source',
        'source_customer_name': 'Source',
        'destination_po_id': 'po-dest', 'destination_item_id': 'item-dest',
        'destination_customer_name': 'Recipient',
        'replenishment_po_id': 'po-replenishment', 'replenishment_item_id': 'item-replenishment',
    }
    source = {'qty': 5, 'loaned_qty': 2, 'customer_loan_history': [
        {'transfer_id': 'loan-1', 'status': 'awaiting_return'}]}
    dest = {'qty': 2, 'loan_return_status': 'awaiting_return', 'loan_return_due': True}
    replenishment = {'id': 'item-replenishment', 'qty': 2, 'stage': 'in_box',
                     'loan_replenishment_returned_qty': 0}

    class TransferCollection:
        async def find_one(self, query, *_args, **_kwargs):
            return deepcopy(loan) if base(query).get('id') == loan['id'] else None

        async def update_one(self, query, update, **_kwargs):
            if loan['status'] != base(query)['status']:
                return SimpleNamespace(modified_count=0)
            loan.update(update['$set'])
            return SimpleNamespace(modified_count=1)

    class POCollection:
        async def find_one(self, query, *_args, **_kwargs):
            return {'items': [deepcopy(replenishment)]} if base(query).get('id') == 'po-replenishment' else None

        async def update_one(self, query, update, **_kwargs):
            po_id = base(query)['id']
            if po_id == 'po-replenishment':
                replenishment['loan_replenishment_returned_qty'] += update['$inc']['items.$.loan_replenishment_returned_qty']
            elif po_id == 'po-source':
                source['loaned_qty'] += update['$inc']['items.$[source].loaned_qty']
                source['customer_loan_history'][0]['status'] = 'returned'
            elif po_id == 'po-dest':
                dest['loan_return_status'] = update['$set']['items.$.loan_return_status']
                dest['loan_return_due'] = update['$set']['items.$.loan_return_due']
            else:
                return SimpleNamespace(modified_count=0)
            return SimpleNamespace(modified_count=1)

    monkeypatch.setattr(workflow, 'db', SimpleNamespace(
        purchase_transfers=TransferCollection(), purchase_orders=POCollection()))
    result = asyncio.run(workflow.settle_loan_transfer(
        transfer_id='loan-1', user=user, reason='Replacement arrived'))
    assert result['status'] == 'returned'
    assert loan['status'] == 'returned'
    assert source['qty'] == 5
    assert source['loaned_qty'] == 0
    assert source['customer_loan_history'][0]['status'] == 'returned'
    assert dest['qty'] == 2
    assert dest['loan_return_status'] == 'returned'
    assert dest['loan_return_due'] is False
    assert replenishment['loan_replenishment_returned_qty'] == 2
    repeat = asyncio.run(workflow.settle_loan_transfer(transfer_id='loan-1', user=user))
    assert repeat['idempotent'] is True


@pytest.mark.parametrize('arrival_stage', ['in_box', 'delivered'])
def test_replenished_order_returns_matching_loan_on_in_box(monkeypatch, arrival_stage):
    db, user = setup(monkeypatch)
    ordered_po = {
        'id': 'ordered-po', 'floor_id': 'first-floor', 'customer_id': 'recipient',
        'items': [{'id': 'ordered-item', 'product_id': 'product-1', 'qty': 3,
                   'stage': arrival_stage, 'loan_replenishment_reserved_qty': 0}],
    }
    loan = {
        'id': 'loan-1', 'type': 'loan', 'status': 'awaiting_return',
        'floor_id': 'first-floor', 'destination_customer_id': 'recipient',
        'destination_po_id': 'po-dest', 'destination_item_id': 'item-dest',
        'product_id': 'product-1', 'qty': 2,
    }
    borrowed_status = {'value': 'awaiting_return', 'due': False}

    class Cursor:
        def sort(self, *_args):
            return self

        async def to_list(self, *_args):
            return [deepcopy(loan)] if loan['status'] == 'awaiting_return' else []

    class TransferCollection:
        def find(self, *_args):
            return Cursor()

        async def update_one(self, query, update, **_kwargs):
            if loan['status'] != base(query)['status']:
                return SimpleNamespace(modified_count=0)
            loan.update(update['$set'])
            return SimpleNamespace(modified_count=1)

    class POCollection:
        async def find_one(self, *_args, **_kwargs):
            return deepcopy(ordered_po)

        async def update_one(self, query, update, **_kwargs):
            if base(query)['id'] == 'ordered-po':
                item = ordered_po['items'][0]
                limit = base(query)['items']['$elemMatch']['$or'][1]['loan_replenishment_reserved_qty']['$lte']
                if item['loan_replenishment_reserved_qty'] > limit:
                    return SimpleNamespace(modified_count=0)
                item['loan_replenishment_reserved_qty'] += update['$inc']['items.$.loan_replenishment_reserved_qty']
            else:
                borrowed_status['value'] = update['$set']['items.$.loan_return_status']
                borrowed_status['due'] = update['$set']['items.$.loan_return_due']
            return SimpleNamespace(modified_count=1)

    monkeypatch.setattr(workflow, 'db', SimpleNamespace(
        purchase_transfers=TransferCollection(), purchase_orders=POCollection()))
    settled = []
    async def settle(*, transfer_id, user, reason):
        settled.append(transfer_id)
        loan['status'] = 'returned'
        return {'status': 'returned'}
    monkeypatch.setattr(workflow, 'settle_loan_transfer', settle)
    result = asyncio.run(workflow.mark_loans_due_for_replenishment(
        item_id='ordered-item', user=user))
    if arrival_stage == 'delivered':
        assert result['return_due_transfer_ids'] == []
        assert settled == []
        return
    assert result['return_due_transfer_ids'] == ['loan-1']
    assert ordered_po['items'][0]['loan_replenishment_reserved_qty'] == 2
    assert loan['status'] == 'returned'
    assert borrowed_status['value'] == 'return_due'
    assert borrowed_status['due'] is True
    assert settled == ['loan-1']
    repeat = asyncio.run(workflow.mark_loans_due_for_replenishment(
        item_id='ordered-item', user=user))
    assert repeat['return_due_transfer_ids'] == []
    assert ordered_po['items'][0]['loan_replenishment_reserved_qty'] == 2


def test_repeated_idempotency_key_reuses_existing_transfer(monkeypatch):
    from services import domain_outbox

    class Outbox:
        async def find_one(self, query, *_args):
            assert query['idempotency_key'] == 'purchase-transfer:repeat-key'
            return {'id': 'existing-event'}

    async def dispatch(event_id):
        assert event_id == 'existing-event'
        return {'transfer_id': 'existing-loan', 'payment_amount': 0}

    monkeypatch.setattr(workflow, 'db', SimpleNamespace(event_outbox=Outbox()))
    monkeypatch.setattr(domain_outbox, 'dispatch_event', dispatch)
    user = UserPublic(email='warehouse@forge.app', full_name='Warehouse', role='warehouse')
    response = asyncio.run(workflow.execute_transfer(
        item_id='item-source', destination_customer_id='recipient', new_customer=None,
        qty=2, reason=None, idempotency_key='repeat-key', user=user,
    ))
    assert response == {'idempotent': True, 'transfer_id': 'existing-loan',
                        'payment_amount': 0}
