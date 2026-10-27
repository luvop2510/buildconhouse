"""User search punctuation must not become executable Mongo regular expressions."""
import asyncio
import re
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from models import UserPublic
from routes import payment_routes, purchase_routes, walkin_routes
from services import activity_log, duplicate_detection


class SearchCollection:
    def __init__(self):
        self.queries = []

    def find(self, query, *args):
        self.queries.append(query)
        for pattern in patterns(query):
            re.compile(pattern)
        return self

    def sort(self, *args):
        return self

    async def to_list(self, *args):
        return []


def patterns(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == '$regex':
                yield item
            else:
                yield from patterns(item)
    elif isinstance(value, list):
        for item in value:
            yield from patterns(item)


def user():
    return UserPublic(id='test-owner', full_name='Test Owner', role='owner', floor_ids=['first-floor'], active_floor_id='first-floor')


@pytest.mark.parametrize('term', ['(', '[broken', r'back\slash', 'A+B (West)', '.*'])
@pytest.mark.parametrize('page', ['purchases', 'collections', 'payment-history', 'fully-paid', 'walkins'])
def test_user_search_is_literal_and_does_not_crash(monkeypatch, term, page):
    rows = SearchCollection()
    fake = SimpleNamespace(quotations=rows, purchase_orders=rows, walkins=rows)
    monkeypatch.setattr(purchase_routes, 'db', fake)
    monkeypatch.setattr(payment_routes, 'db', fake)
    monkeypatch.setattr(walkin_routes, 'db', fake)
    monkeypatch.setattr(payment_routes, '_paid_by_quotation', AsyncMock(return_value={}))
    monkeypatch.setattr(payment_routes, '_godown_value_by_quotation', AsyncMock(return_value={}))
    monkeypatch.setattr(payment_routes, '_floor_names', AsyncMock(return_value={}))
    if page == 'purchases':
        asyncio.run(purchase_routes.list_purchase_orders(q=term, limit=20, user=user()))
    elif page == 'collections':
        asyncio.run(payment_routes.list_orders(q=term, status_filter=None, overdue_period=None, custom_min_days=None, custom_max_days=None, limit=20, user=user()))
    elif page == 'fully-paid':
        asyncio.run(payment_routes.fully_paid_orders(q=term, business_unit=None, sort='date_desc', skip=0, limit=20, user=user()))
    elif page == 'walkins':
        asyncio.run(walkin_routes.list_walkins(search=term, user=user()))
    else:
        rows.find(payment_routes._history_filter(['first-floor'], term, None, None, None, None, None))
    expressions = list(patterns(rows.queries[-1]))
    assert expressions
    for expression in expressions:
        regex = re.compile(expression)
        assert regex.search(term)
        assert not regex.search('Unrelated Customer'), 'Search symbols must not broaden the matching set'


@pytest.mark.parametrize('term', ['(', '[broken', 'A+B (West)', '.*'])
def test_duplicate_detection_uses_literal_identity_fields(monkeypatch, term):
    rows = SearchCollection()
    monkeypatch.setattr(duplicate_detection, 'db', SimpleNamespace(customers=rows))
    asyncio.run(duplicate_detection.find_customer_matches(name=term, city=term, address=term, floor_ids=['first-floor']))
    expressions = [expression for query in rows.queries for expression in patterns(query)]
    assert expressions
    for expression in expressions:
        regex = re.compile(expression, re.I)
        assert regex.search(term)
        assert not regex.search('Unrelated Customer')


def test_warehouse_activity_events_are_persisted(monkeypatch):
    events = SimpleNamespace(insert_one=AsyncMock())
    monkeypatch.setattr(activity_log, 'db', SimpleNamespace(activity_events=events))
    event = asyncio.run(activity_log.log_event(event_type='godown_stock.details_updated', entity_type='godown_stock', entity_id='stock-1', floor_id='first-floor'))
    assert event is not None, 'Stock mutations must not silently lose their audit event'
    events.insert_one.assert_awaited_once()
    assert events.insert_one.await_args.args[0]['entity_type'] == 'godown_stock'
    assert events.insert_one.await_args.args[0]['floor_id'] == 'first-floor'
