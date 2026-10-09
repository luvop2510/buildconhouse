from __future__ import annotations

import asyncio
import re
from copy import deepcopy
from types import SimpleNamespace

import pytest

from services.customer_data_reset import (
    CUSTOMER_COLLECTIONS, cleanup_reset_files, customer_reset_maintenance,
    reset_customer_data,
)


def matches(row, query):
    for field, condition in query.items():
        if field == '$or':
            if not any(matches(row, branch) for branch in condition):
                return False
            continue
        if field == '$and':
            if not all(matches(row, branch) for branch in condition):
                return False
            continue
        value = row.get(field)
        if isinstance(condition, dict):
            if '$exists' in condition and (field in row) != condition['$exists']:
                return False
            if '$in' in condition and value not in condition['$in']:
                return False
            if '$nin' in condition and value in condition['$nin']:
                return False
            if '$regex' in condition and not re.search(condition['$regex'], str(value or '')):
                return False
        elif value != condition:
            return False
    return True


class Cursor:
    def __init__(self, rows):
        self.rows = iter(rows)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self.rows)
        except StopIteration:
            raise StopAsyncIteration


class Collection:
    def __init__(self, rows=()):
        self.rows = deepcopy(list(rows))

    def find(self, query, projection=None, *, session=None):
        return Cursor([deepcopy(row) for row in self.rows if matches(row, query)])

    async def find_one(self, query, *, session=None):
        return next((deepcopy(row) for row in self.rows if matches(row, query)), None)

    async def delete_many(self, query, *, session=None):
        original = len(self.rows)
        self.rows = [row for row in self.rows if not matches(row, query)]
        return SimpleNamespace(deleted_count=original - len(self.rows))

    async def update_one(self, query, update, *, session=None):
        for row in self.rows:
            if matches(row, query):
                for key in update.get('$unset', {}):
                    row.pop(key, None)
                row.update(deepcopy(update.get('$set', {})))
                return SimpleNamespace(modified_count=1)
        return SimpleNamespace(modified_count=0)

    async def update_many(self, query, update, *, session=None):
        return SimpleNamespace(modified_count=0)

    async def insert_one(self, row, *, session=None):
        self.rows.append(deepcopy(row))


class Database:
    def __init__(self):
        self.collections = {name: Collection([{'id': name, 'floor_id': floor} for floor in
            ('ground-floor', 'first-floor', 'second-floor')]) for name in CUSTOMER_COLLECTIONS}
        self.collections.update({
            'purchase_orders': Collection([
                {'id': 'customer-po', 'customer_id': 'deleted-customer'},
                {'id': 'restock-po', 'supplier_id': 'keep-supplier'},
            ]),
            'activity_events': Collection([
                {'id': 'customer-event', 'entity_type': 'customer'},
                {'id': 'catalog-event', 'entity_type': 'product'},
                {'id': 'restock-event', 'entity_type': 'restock', 'purchase_id': 'restock-po'},
            ]),
            'notifications': Collection([
                {'id': 'customer-notification', 'link': '/(admin)/quotations/q1'},
                {'id': 'catalog-notification', 'link': '/catalog'},
            ]),
            'user_sessions': Collection([{'id': 'customer-session', 'user_type': 'customer'},
                {'id': 'staff-session', 'user_type': 'staff'}]),
            'event_outbox': Collection([{'event_type': 'OrderPlaced'}, {'event_type': 'CatalogImported'}]),
            'godown_stock': Collection([{'_id': 'stock', 'product_id': 'product', 'image': 'keep.png',
                'available_qty': 7, 'source_customer_name': 'Delete Name', 'source_customer_id': 'delete-id',
                'allocations': [{'customer_name': 'Delete Name', 'qty': 3}]}]),
            'products': Collection([{'id': 'product', 'image': 'keep.png'}]),
            'settings': Collection([{'id': 'company', 'name': 'Buildcon House'}]),
        })

    def __getitem__(self, key):
        return self.collections.setdefault(key, Collection())

    def __getattr__(self, key):
        return self[key]


class Session:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def with_transaction(self, callback, **kwargs):
        assert kwargs['read_concern'].level == 'snapshot'
        assert kwargs['write_concern'].document == {'w': 'majority'}
        return await callback(self)


class Client:
    async def start_session(self):
        return Session()


def apply(database):
    return asyncio.run(reset_customer_data(database, Client(), request_id='customer-reset-20261010'))


def test_reset_requires_maintenance_before_touching_database(monkeypatch):
    monkeypatch.delenv('FORGE_CUSTOMER_RESET_MAINTENANCE', raising=False)
    with pytest.raises(RuntimeError):
        apply(None)


def test_reset_requires_known_explicit_request(monkeypatch):
    monkeypatch.setenv('FORGE_CUSTOMER_RESET_MAINTENANCE', 'true')
    with pytest.raises(ValueError):
        asyncio.run(reset_customer_data(None, None, request_id='unexpected'))


def test_reset_removes_all_floors_but_preserves_catalog_staff_and_restock(monkeypatch):
    monkeypatch.setenv('FORGE_CUSTOMER_RESET_MAINTENANCE', 'true')
    db = Database()
    catalog = deepcopy(db.products.rows)
    receipt = apply(db)
    assert all(db[name].rows == [] for name in CUSTOMER_COLLECTIONS)
    assert db.products.rows == catalog
    assert db.purchase_orders.rows == [{'id': 'restock-po', 'supplier_id': 'keep-supplier'}]
    assert db.user_sessions.rows == [{'id': 'staff-session', 'user_type': 'staff'}]
    assert db.notifications.rows == [{'id': 'catalog-notification', 'link': '/catalog'}]
    assert {row['id'] for row in db.activity_events.rows} == {'catalog-event', 'restock-event'}
    assert db.event_outbox.rows == [{'event_type': 'CatalogImported'}]
    assert db.settings.rows[0] == {'id': 'company', 'name': 'Buildcon House'}
    assert receipt['deleted']['customers'] == 3


def test_stock_keeps_product_image_and_quantities_without_customer_snapshots(monkeypatch):
    monkeypatch.setenv('FORGE_CUSTOMER_RESET_MAINTENANCE', 'true')
    db = Database()
    apply(db)
    assert db.godown_stock.rows == [{'_id': 'stock', 'product_id': 'product', 'image': 'keep.png',
        'available_qty': 7, 'allocations': [{'qty': 3}]}]


def test_receipt_prevents_replay_from_deleting_new_customers(monkeypatch):
    monkeypatch.setenv('FORGE_CUSTOMER_RESET_MAINTENANCE', 'true')
    db = Database()
    apply(db)
    db.customers.rows.append({'id': 'new-customer'})
    assert apply(db)['already_applied'] is True
    assert db.customers.rows == [{'id': 'new-customer'}]


def test_private_cleanup_retry_does_not_access_catalog_storage():
    calls = []

    async def delete(**kwargs):
        calls.append(kwargs)

    db = Database()
    receipt = {'request_id': 'customer-reset-20261010',
        'pending_private_files': ['purchase-orders/customer-po/attachment.pdf']}
    result = asyncio.run(cleanup_reset_files(db, SimpleNamespace(delete=delete),
        bucket='forge-private', receipt=receipt))
    assert calls == [{'bucket': 'forge-private', 'key': 'purchase-orders/customer-po/attachment.pdf'}]
    assert 'pending_private_files' not in result
    assert result['private_files_deleted'] == 1


def test_background_writers_are_paused_in_maintenance(monkeypatch):
    import services.domain_outbox as outbox
    import services.followup_engine as followups
    monkeypatch.setenv('FORGE_CUSTOMER_RESET_MAINTENANCE', 'true')
    monkeypatch.setattr(outbox, 'db', None)
    monkeypatch.setattr(followups, 'db', None)
    assert asyncio.run(outbox.dispatch_pending()) == []
    assert asyncio.run(followups.reconcile_followups())['reason'] == 'customer reset maintenance'


def test_maintenance_blocks_business_but_leaves_deployment_health_available(monkeypatch):
    from fastapi import Request
    import server
    monkeypatch.setenv('FORGE_CUSTOMER_RESET_MAINTENANCE', 'true')

    async def next_handler(request):
        return 'health-handler'

    business = Request({'type': 'http', 'method': 'GET', 'path': '/api/customers', 'headers': []})
    health = Request({'type': 'http', 'method': 'GET', 'path': '/api/health/ready', 'headers': []})
    response = asyncio.run(server.customer_reset_maintenance_gate(business, next_handler))
    assert response.status_code == 503
    assert response.headers['retry-after'] == '60'
    assert asyncio.run(server.customer_reset_maintenance_gate(health, next_handler)) == 'health-handler'
    monkeypatch.delenv('FORGE_CUSTOMER_RESET_MAINTENANCE')
    assert not customer_reset_maintenance()
    assert asyncio.run(server.customer_reset_maintenance_gate(business, next_handler)) == 'health-handler'
