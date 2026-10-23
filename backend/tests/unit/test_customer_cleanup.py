"""Hermetic deletion graphs: money, stock, imports and isolation, no Mongo I/O."""
from __future__ import annotations

import asyncio
from copy import deepcopy
import re
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import db as db_module
from models import UserPublic
import routes.customer_routes as customer_routes
import routes.quotation_routes as quotation_routes
from services.customer_deletion import (
    cleanup_deleted_customer_files, delete_customer_graph, plan_deletion, public_plan,
)


def values(row, path):
    if not path:
        return [row]
    if isinstance(row, list):
        return [value for item in row for value in values(item, path)]
    if not isinstance(row, dict) or path[0] not in row:
        return []
    return values(row[path[0]], path[1:])


def matches(row, query):
    for field, expected in query.items():
        if field == '$or':
            if not any(matches(row, branch) for branch in expected):
                return False
        elif field == '$and':
            if not all(matches(row, branch) for branch in expected):
                return False
        else:
            actual = values(row, field.split('.'))
            if isinstance(expected, dict):
                if '$in' in expected and not any(value in expected['$in'] for value in actual):
                    return False
                if '$exists' in expected and bool(actual) != expected['$exists']:
                    return False
                if '$regex' in expected and not any(re.search(expected['$regex'], str(value)) for value in actual):
                    return False
            elif expected not in actual and not (expected is None and not actual):
                return False
    return True


class Cursor:
    def __init__(self, rows):
        self.rows = deepcopy(rows)

    def limit(self, n):
        self.rows = self.rows[:n]
        return self

    async def to_list(self, n):
        return self.rows[:n]


class Collection:
    def __init__(self, rows=()):
        self.rows = deepcopy(list(rows))
        self.fail_delete = False
        for n, row in enumerate(self.rows):
            row.setdefault('_id', f"row:{row.get('id', n)}")

    def find(self, query, projection=None, session=None):
        rows = [row for row in self.rows if matches(row, query)]
        if projection:
            rows = [{key: value for key, value in row.items() if projection.get(key) != 0} for row in rows]
        return Cursor(rows)

    async def find_one(self, query, projection=None, session=None):
        rows = await self.find(query, projection).to_list(1)
        return rows[0] if rows else None

    async def count_documents(self, query, session=None):
        return len([row for row in self.rows if matches(row, query)])

    async def update_one(self, query, update, session=None):
        for row in self.rows:
            if not matches(row, query):
                continue
            for op, entries in update.items():
                for field, value in entries.items():
                    parent = row
                    parts = field.split('.')
                    for part in parts[:-1]:
                        parent = parent.setdefault(part, {})
                    key = parts[-1]
                    if op == '$set':
                        parent[key] = deepcopy(value)
                    elif op == '$unset':
                        parent.pop(key, None)
                    elif op == '$inc':
                        parent[key] = parent.get(key, 0) + value
                    elif op == '$pull':
                        parent[key] = [item for item in parent[key] if item != value]
            return SimpleNamespace(modified_count=1)
        return SimpleNamespace(modified_count=0)

    async def delete_many(self, query, session=None):
        assert query and query != {'$or': []}, 'Never issue an unscoped delete'
        if self.fail_delete:
            raise RuntimeError('Simulated storage transaction failure')
        original = len(self.rows)
        self.rows = [row for row in self.rows if not matches(row, query)]
        return SimpleNamespace(deleted_count=original - len(self.rows))

    async def insert_one(self, row, session=None):
        self.rows.append(deepcopy(row))


class Database:
    def __init__(self, records=None):
        self.collections = {name: Collection(rows) for name, rows in (records or {}).items()}

    def __getitem__(self, name):
        return self.collections.setdefault(name, Collection())

    def __getattr__(self, name):
        return self[name]


class Session:
    def __init__(self, database):
        self.database = database

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def with_transaction(self, operation, **kwargs):
        assert kwargs['read_concern'].level == 'snapshot'
        assert kwargs['write_concern'].document == {'w': 'majority'}
        original = deepcopy(self.database.collections)
        try:
            return await operation(self)
        except Exception:
            self.database.collections = original
            raise


class Client:
    def __init__(self, database):
        self.database = database

    async def start_session(self):
        return Session(self.database)


def user(role='owner', **kwargs):
    return UserPublic(id='owner-1', email='owner@example.test', full_name='Owner', role=role,
                      floor_ids=[], active_floor_id='first-floor', **kwargs)


def sample():
    return Database({
        'customers': [
            {'id': 'c1', 'name': 'Selected', 'floor_id': 'ground-floor', 'phone': '9876543210'},
            {'id': 'c2', 'name': 'Imported', 'floor_id': 'first-floor', 'phone': '9876543210'},
            {'id': 'c3', 'name': 'Same phone, unrelated', 'floor_id': 'first-floor', 'phone': '9876543210'},
        ],
        'activity_events': [
            {'id': 'import', 'event_type': 'customer.imported', 'customer_id': 'c2', 'entity_id': 'c2', 'payload': {'source_customer_id': 'c1'}},
            {'id': 'sale', 'customer_id': 'c2', 'summary': 'Private payment details'},
            {'id': 'unrelated', 'customer_id': 'c3'},
        ],
        'quotations': [
            {'id': 'q1', 'customer_id': 'c1', 'floor_id': 'ground-floor', 'status': 'draft'},
            {'id': 'q2', 'customer_id': 'c2', 'floor_id': 'first-floor', 'status': 'ordered'},
            {'id': 'q3', 'customer_id': 'c3', 'floor_id': 'first-floor', 'status': 'draft', 'items': [
                {'id': 'other-line', 'godown_stock_id': 'stock', 'godown_source_customer_name': 'Imported'}]},
        ],
        'purchase_orders': [
            {'id': 'p2', 'customer_id': 'c2', 'quotation_id': 'q2', 'floor_id': 'first-floor', 'items': [
                {'id': 'delivered', 'qty': 2, 'unit_cost': 10, 'stage': 'delivered', 'godown_allocation_id': 'a2'},
                {'id': 'unshipped', 'qty': 2, 'unit_cost': 10, 'stage': 'in_box', 'godown_allocation_id': 'a2'}]},
            {'id': 'shared', 'customer_id': 'c2', 'quotation_id': 'q2', 'floor_id': 'first-floor', 'items': [
                {'id': 'selected', 'customer_id': 'c2', 'qty': 1, 'unit_cost': 100},
                {'id': 'other', 'customer_id': 'c3', 'qty': 2, 'unit_cost': 50}]},
            {'id': 'supplier-stock', 'supplier_id': 'supplier-1', 'items': [{'id': 'restock', 'qty': 5}]},
        ],
        'payments': [
            {'id': 'paid', 'quotation_id': 'q2', 'customer_id': 'c2', 'status': 'completed', 'amount': 100},
            {'id': 'pending', 'quotation_id': 'q1', 'status': 'pending'},
            {'id': 'other', 'quotation_id': 'q3', 'customer_id': 'c3', 'status': 'completed', 'amount': 200},
        ],
        'followups': [{'id': 'f1', 'customer_id': 'c1'}, {'id': 'f2', 'quotation_id': 'q2'}, {'id': 'f3', 'customer_id': 'c3'}],
        'walkins': [{'id': 'w1', 'customer_id': 'c1'}, {'id': 'w3', 'customer_id': 'c3'}],
        'customer_orders': [{'id': 'order', 'customer_id': 'c1'}],
        'ready_batches': [{'id': 'batch', 'customer_order_id': 'order'}],
        'dispatches': [{'id': 'dispatch', 'customer_order_id': 'order'}],
        'chalans': [{'id': 'delivery', 'customer_order_id': 'order'}],
        'material_movements': [{'id': 'movement', 'purchase_order_id': 'p2'}],
        'purchase_shortages': [{'id': 'shortage', 'customer_id': 'c2'}],
        'godown_stock': [{'id': 'stock', 'source_customer_id': 'c2', 'source_customer_name': 'Imported',
            'floor_id': 'first-floor', 'available_qty': 5, 'received_qty': 12, 'allocations': [
                {'id': 'a1', 'quotation_id': 'q1', 'customer_id': 'c1', 'qty': 2},
                {'id': 'a2', 'quotation_id': 'q2', 'customer_id': 'c2', 'qty': 4},
                {'id': 'a3', 'quotation_id': 'q3', 'customer_id': 'c3', 'qty': 1}]}],
        'purchase_transfers': [{'id': 'shared-transfer', 'source_customer_id': 'c2', 'source_customer_name': 'Imported',
            'destination_customer_id': 'c3', 'destination_customer_name': 'Survivor', 'qty': 1, 'reason': 'Customer address'}],
        'event_outbox': [{'id': 'pending-order', 'payload': {'quotation_id': 'q2'}}, {'id': 'other-event', 'payload': {'quotation_id': 'q3'}}],
        'notifications': [{'id': 'selected', 'link': '/(admin)/quotations/q2'}, {'id': 'other', 'link': '/quotations/q20'}],
        'kitchen_projects': [{'id': 'kitchen', 'customer_id': 'c1', 'floor_id': 'second-floor', 'attachments': [
            {'bucket': 'private', 'storage_key': 'kitchen/second-floor/kitchen/private.pdf'}]}],
        'kitchen_file_transfers': [{'project_id': 'kitchen', 'transfer_id': 'transfer'}],
        'kitchen_file_parts': [{'_id': 'part', 'transfer_id': 'transfer', 'data': b'private file'}],
        'furniture_quotations': [{'id': 'furniture', 'customer_id': 'c2'}],
        'user_sessions': [{'id': 'customer-session', 'user_type': 'customer', 'user_id': 'c2'},
                          {'id': 'staff-session', 'user_type': 'staff', 'user_id': 'c2'}],
        'download_tokens': [{'id': 'customer-token', 'kind': 'customer', 'user_id': 'c2'},
                            {'id': 'staff-token', 'kind': 'staff', 'user_id': 'c2'}],
        'whatsapp_deliveries': [{'id': 'delivery', 'source_id': 'q2', 'message_id': 'wa-1'}],
        'whatsapp_status_events': [{'id': 'status', 'message_id': 'wa-1'}, {'id': 'keep', 'message_id': 'wa-2'}],
        'followup_saved_views': [{'id': 'view', 'filters': {'customer_id': 'c2', 'status': 'open'}}],
        'products': [{'id': 'catalog', 'name': 'Keep'}], 'users': [{'id': 'staff', 'name': 'Keep'}],
    })


def preview(database, actor='owner-1', target='c1'):
    return asyncio.run(_preview(database, actor, target))


async def _preview(database, actor, target):
    return public_plan(await plan_deletion(database, customer_id=target), actor)


def remove(database, confirmation=None):
    confirmation = confirmation if confirmation is not None else preview(database)['confirmation']
    return asyncio.run(delete_customer_graph(database, Client(database), 'c1', 'owner-1', confirmation))


def ids(database, collection):
    return {row.get('id') for row in database[collection].rows}


def test_preview_counts_paid_orders_explicit_imports_and_all_floor_workspaces_without_mutation():
    database = sample()
    original = deepcopy(database.collections)
    result = preview(database)
    assert result['counts']['customers'] == 2
    assert result['counts']['payments'] == 2
    assert result['counts']['kitchen_projects'] == 1
    assert result['counts']['furniture_quotations'] == 1
    assert result['counts']['purchase_orders'] == 1
    assert result['private_files'] == 1
    for name, collection in original.items():
        assert collection.rows == database[name].rows


def test_customer_removal_deletes_paid_graph_and_preserves_unrelated_same_phone_customer():
    database = sample()
    result = remove(database)
    assert result['deleted']['customers'] == 2
    assert ids(database, 'customers') == {'c3'}
    assert ids(database, 'quotations') == {'q3'}
    assert ids(database, 'payments') == {'other'}
    assert ids(database, 'followups') == {'f3'}
    assert ids(database, 'walkins') == {'w3'}
    for name in ('customer_orders', 'ready_batches', 'dispatches', 'chalans', 'material_movements', 'purchase_shortages',
                 'kitchen_projects', 'kitchen_file_transfers', 'kitchen_file_parts', 'furniture_quotations'):
        assert database[name].rows == [], name
    assert ids(database, 'products') == {'catalog'}
    assert ids(database, 'users') == {'staff'}


def test_shared_supplier_purchase_survives_with_other_customer_lines_and_total():
    database = sample()
    remove(database)
    assert ids(database, 'purchase_orders') == {'shared', 'supplier-stock'}
    po = next(row for row in database.purchase_orders.rows if row['id'] == 'shared')
    assert [line['id'] for line in po['items']] == ['other']
    assert po['grand_total'] == 100
    assert po['customer_id'] == ''
    assert po['quotation_id'] is None


def test_reservations_release_but_delivered_material_does_not_reappear_as_stock():
    database = sample()
    remove(database)
    stock = database.godown_stock.rows[0]
    assert stock['available_qty'] == 9  # +2 draft reserved, +2 ordered but not shipped
    assert stock['received_qty'] == 12
    assert [allocation['id'] for allocation in stock['allocations']] == ['a3']
    assert 'source_customer_name' not in stock
    assert 'source_customer_id' not in stock
    assert 'godown_source_customer_name' not in database.quotations.rows[0]['items'][0]


def test_shared_transfers_keep_other_customer_and_numerical_inventory_history():
    database = sample()
    remove(database)
    transfer = database.purchase_transfers.rows[0]
    assert transfer['destination_customer_id'] == 'c3'
    assert transfer['qty'] == 1
    assert 'source_customer_id' not in transfer
    assert 'source_customer_name' not in transfer
    assert 'reason' not in transfer


def test_outbox_sessions_downloads_whatsapp_and_saved_views_cannot_resurrect_data():
    database = sample()
    remove(database)
    assert ids(database, 'event_outbox') == {'other-event'}
    assert ids(database, 'notifications') == {'other'}
    assert ids(database, 'user_sessions') == {'staff-session'}
    assert ids(database, 'download_tokens') == {'staff-token'}
    assert database.whatsapp_deliveries.rows == []
    assert ids(database, 'whatsapp_status_events') == {'keep'}
    assert database.followup_saved_views.rows[0]['filters'] == {'status': 'open'}


@pytest.mark.parametrize('actor,confirmation', [('owner-2', None), ('owner-1', ''), ('owner-1', 'forged')])
def test_confirmation_is_explicit_and_bound_to_owner_and_snapshot(actor, confirmation):
    database = sample()
    token = preview(database, actor)['confirmation'] if confirmation is None else confirmation
    with pytest.raises(HTTPException) as error:
        remove(database, token)
    assert error.value.status_code == 409
    assert ids(database, 'customers') == {'c1', 'c2', 'c3'}


def test_new_payment_since_preview_requires_review_again_and_no_partial_deletion():
    database = sample()
    token = preview(database)['confirmation']
    database.payments.rows.append({'_id': 'new-payment', 'id': 'new', 'customer_id': 'c1', 'status': 'completed'})
    with pytest.raises(HTTPException) as error:
        remove(database, token)
    assert error.value.status_code == 409
    assert ids(database, 'customers') == {'c1', 'c2', 'c3'}
    assert database.godown_stock.rows[0]['available_qty'] == 5


def test_transaction_failure_rolls_back_money_stock_and_every_parent_record():
    database = sample()
    token = preview(database)['confirmation']
    database.payments.fail_delete = True
    with pytest.raises(RuntimeError):
        remove(database, token)
    assert database.godown_stock.rows[0]['available_qty'] == 5
    assert ids(database, 'customers') == {'c1', 'c2', 'c3'}
    assert ids(database, 'quotations') == {'q1', 'q2', 'q3'}
    assert ids(database, 'purchase_orders') == {'p2', 'shared', 'supplier-stock'}
    assert database.settings.rows == []


def test_retry_is_idempotent_and_does_not_release_stock_twice():
    database = sample()
    token = preview(database)['confirmation']
    remove(database, token)
    result = remove(database, token)
    assert result['already_deleted'] is True
    assert database.godown_stock.rows[0]['available_qty'] == 9
    receipt = database.settings.rows[0]
    assert receipt['kind'] == 'customer_deletion_receipt'
    assert set(receipt) == {'id', 'kind', 'actor_id', 'completed_at', 'deleted', 'pending_private_files'}


@pytest.mark.parametrize('role', ['sales', 'manager', 'admin', 'worker'])
def test_all_customer_deletion_requires_owner_even_with_custom_page_grants(role):
    with pytest.raises(HTTPException) as error:
        asyncio.run(customer_routes.delete_customer('c1', user=user(role, custom_access=True)))
    assert error.value.status_code == 403


def test_explicit_import_field_works_without_historical_activity_and_reverse_selection():
    database = Database({'customers': [
        {'id': 'c1', 'floor_id': 'ground-floor'},
        {'id': 'c2', 'floor_id': 'first-floor', 'imported_from_customer_id': 'c1'},
        {'id': 'c3', 'floor_id': 'third-floor', 'imported_from_customer_id': 'c2'},
    ]})
    assert preview(database, target='c3')['counts']['customers'] == 3


def draft_database():
    return Database({
        'customers': [{'id': 'customer', 'floor_id': 'first-floor', 'name': 'Keep', 'gender': 'legacy'}],
        'quotations': [{'id': 'draft', 'customer_id': 'customer', 'floor_id': 'first-floor', 'status': 'draft'},
                       {'id': 'other', 'customer_id': 'customer', 'floor_id': 'first-floor', 'status': 'draft'}],
        'payments': [{'id': 'pending', 'quotation_id': 'draft', 'floor_id': 'first-floor', 'status': 'pending'},
                     {'id': 'other-floor', 'quotation_id': 'draft', 'floor_id': 'ground-floor', 'status': 'pending'}],
        'followups': [{'id': 'linked', 'quotation_id': 'draft', 'floor_id': 'first-floor'},
                      {'id': 'keep', 'customer_id': 'customer', 'floor_id': 'first-floor'}],
        'godown_stock': [{'id': 'stock', 'floor_id': 'first-floor', 'available_qty': 1,
                          'allocations': [{'id': 'reserve', 'quotation_id': 'draft', 'qty': 2}]}],
    })


def quote_remove(database, monkeypatch):
    async def authorized(*args, **kwargs):
        return deepcopy(database.quotations.rows[0])
    monkeypatch.setattr(quotation_routes, 'db', database)
    monkeypatch.setattr(db_module, 'client', Client(database))
    monkeypatch.setattr(quotation_routes, 'get_floor_scoped_or_404', authorized)
    return asyncio.run(quotation_routes.delete_quotation('draft', user=user('manager')))


def test_delete_draft_preserves_customer_other_quotes_floor_records_and_releases_stock(monkeypatch):
    database = draft_database()
    quote_remove(database, monkeypatch)
    assert ids(database, 'customers') == {'customer'}
    assert database.customers.rows[0]['gender'] == 'legacy'  # no unrelated profile edits
    assert ids(database, 'quotations') == {'other'}
    assert ids(database, 'followups') == {'keep'}
    assert ids(database, 'payments') == {'other-floor'}
    assert database.godown_stock.rows[0]['available_qty'] == 3
    assert database.godown_stock.rows[0]['allocations'] == []


@pytest.mark.parametrize('protection', ['paid', 'purchase', 'ordered'])
def test_ordered_or_paid_quotation_cannot_cascade_from_quotation_action(monkeypatch, protection):
    database = draft_database()
    if protection == 'paid':
        database.payments.rows[0]['status'] = 'completed'
    elif protection == 'purchase':
        database.purchase_orders.rows.append({'id': 'po', 'quotation_id': 'draft', 'floor_id': 'first-floor'})
    else:
        database.quotations.rows[0]['status'] = 'ordered'
    with pytest.raises(HTTPException) as error:
        quote_remove(database, monkeypatch)
    assert error.value.status_code == 409
    assert 'Customers' in error.value.detail
    assert ids(database, 'quotations') == {'draft', 'other'}
    assert database.godown_stock.rows[0]['available_qty'] == 1


def test_private_files_remain_retryable_after_provider_failure():
    database = Database({'settings': [{'id': 'receipt', 'kind': 'customer_deletion_receipt',
        'pending_private_files': [{'bucket': 'private', 'key': 'quotation-shares/q/file.pdf'}]}]})
    # Array index handling for the background selection is covered by the
    # production Mongo integration contract; adapt fixture selection only.
    original_find = database.settings.find
    database.settings.find = lambda query: original_find({'kind': 'customer_deletion_receipt'})
    async def failed(**kwargs):
        raise RuntimeError('Provider temporarily unavailable')
    asyncio.run(cleanup_deleted_customer_files(database, SimpleNamespace(delete=failed)))
    assert len(database.settings.rows[0]['pending_private_files']) == 1
    deleted = []
    async def success(**kwargs):
        deleted.append(kwargs)
    asyncio.run(cleanup_deleted_customer_files(database, SimpleNamespace(delete=success)))
    assert deleted == [{'bucket': 'private', 'key': 'quotation-shares/q/file.pdf'}]
    assert database.settings.rows[0]['pending_private_files'] == []


@pytest.mark.parametrize('dispatched,expected', [(0, 11), (2, 9), (4, 7)])
def test_embedded_dispatch_evidence_preserves_consumed_stock(dispatched, expected):
    database = sample()
    po = next(row for row in database.purchase_orders.rows if row['id'] == 'p2')
    po['items'] = [{'id':'partial','qty':4,'unit_cost':10,'stage':'in_box','godown_allocation_id':'a2'}]
    po['chalans'] = [{'id':'delivery','stage':'dispatched','items':[{'po_item_id':'partial','qty':dispatched}]}]
    remove(database)
    assert database.godown_stock.rows[0]['available_qty'] == expected


def test_shared_supplier_dispatch_survives_deleted_parent_identity():
    database = sample()
    po = next(row for row in database.purchase_orders.rows if row['id'] == 'shared')
    po['chalans'] = [{'id':'mixed','stage':'dispatched','receiver_name':'Private target',
        'items':[{'po_item_id':'selected','qty':1},{'po_item_id':'other','qty':2}]}]
    remove(database)
    survivor = next(row for row in database.purchase_orders.rows if row['id'] == 'shared')
    assert survivor['chalans'][0]['items'] == [{'po_item_id':'other','qty':2}]
    assert 'receiver_name' not in survivor['chalans'][0]
    from services.purchase_stages import normalized_stage
    assert normalized_stage(survivor['items'][0],survivor) == 'dispatched'


def test_legacy_furniture_requires_explicit_review_and_selection():
    database = Database({'customers':[{'id':'customer','phone':'9876543210','floor_id':'third-floor'}],
        'furniture_quotations':[
            {'id':'legacy','customer_phone':'9876543210','floor_id':'third-floor'},
            {'id':'keep','customer_phone':'9000000000','floor_id':'third-floor'}]})
    async def scenario():
        unselected = await plan_deletion(database,customer_id='customer')
        assert unselected['delete']['furniture_quotations'] == []
        assert [row['id'] for row in unselected['furniture_candidates']] == ['legacy']
        selected = await plan_deletion(database,customer_id='customer',furniture_ids=['legacy'])
        confirmation = public_plan(selected,'owner')['confirmation']
        with pytest.raises(HTTPException):
            await delete_customer_graph(database,Client(database),'customer','owner',confirmation)
        await delete_customer_graph(database,Client(database),'customer','owner',confirmation,['legacy'])
        assert ids(database,'furniture_quotations') == {'keep'}
    asyncio.run(scenario())
