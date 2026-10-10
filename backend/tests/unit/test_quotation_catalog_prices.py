import asyncio
import pytest
from fastapi import HTTPException
from services.quotation_catalog_prices import price_review, apply_price_choice

class Products:
    def __init__(self, documents):
        self.documents = documents
        self.queries = []
    def find(self, query, projection, **kwargs):
        self.queries.append((query, kwargs))
        matching = [p for p in self.documents if p['id'] in query['id']['$in'] and p['floor_id'] == query['floor_id'] and p.get('active', True)]
        class Cursor:
            async def to_list(self, count):
                return matching[:count]
        return Cursor()

def draft():
    return {'id': 'q1', 'floor_id': 'first-floor', 'status': 'draft', 'updated_at': '2026-10-09', 'items': [{'id': 'line1', 'product_id': 'product1', 'sku': 'A', 'name': 'A', 'qty': 2, 'unit_price': 90, 'mrp': 100, 'catalog_price': 90, 'catalog_mrp': 100, 'discount_pct': 10}]}

def products():
    return Products([{'id': 'product1', 'floor_id': 'first-floor', 'price': 110, 'mrp': 125, 'catalog_version': 2, 'updated_at': '2026-10-10'}, {'id': 'product1', 'floor_id': 'ground-floor', 'price': 999, 'mrp': 999}])

def test_draft_requires_explicit_choice_and_rejects_stale_catalog_token():
    doc = draft(); store = products()
    review = asyncio.run(price_review(doc, store, session='transaction'))
    assert review['changes'][0]['new_unit_price'] == 110
    assert store.queries[0][0]['floor_id'] == 'first-floor'
    assert store.queries[0][1] == {'session': 'transaction'}
    for choice, token in [(None, None), ('latest', 'outdated')]:
        with pytest.raises(HTTPException) as error:
            apply_price_choice(doc, review, choice, token)
        assert error.value.status_code == 409
    assert apply_price_choice(doc, review, 'keep', review['token']) == doc['items']
    latest = apply_price_choice(doc, review, 'latest', review['token'])
    assert latest[0]['unit_price'] == 110
    assert latest[0]['discount_pct'] == 10
    assert doc['items'][0]['unit_price'] == 90

@pytest.mark.parametrize('status', ['sent', 'approved', 'ordered', 'won', 'lost', 'cancelled'])
def test_finalized_prices_never_join_or_change_catalog(status):
    doc = draft(); doc['status'] = status; store = products()
    review = asyncio.run(price_review(doc, store))
    assert review == {'changes': [], 'token': None}
    assert not store.queries
    assert apply_price_choice(doc, review, 'latest', 'anything') == doc['items']

def test_catalog_token_changes_when_supplier_prices_change_again():
    doc = draft(); store = products()
    first = asyncio.run(price_review(doc, store))
    store.documents[0]['price'] = 120
    second = asyncio.run(price_review(doc, store))
    assert first['token'] != second['token']
    with pytest.raises(HTTPException):
        apply_price_choice(doc, second, 'latest', first['token'])

def test_negotiated_legacy_price_is_explicitly_unverified_without_claiming_a_change():
    doc = draft(); line = doc['items'][0]; line.pop('catalog_price'); line.pop('catalog_mrp'); line['unit_price'] = 75
    store = products(); store.documents[0].update({'price': 90, 'mrp': 100})
    review = asyncio.run(price_review(doc, store))
    assert review['changes'][0]['reason'] == 'source_price_unverified'
    assert apply_price_choice(doc, review, 'keep', review['token']) == doc['items']
    with pytest.raises(HTTPException):
        apply_price_choice(doc, review, None, None)


def test_duplicate_line_ids_preserve_each_products_own_price_by_row_position():
    doc = draft()
    doc['items'].append({**doc['items'][0], 'product_id': 'product2', 'unit_price': 190,
                         'catalog_price': 190, 'catalog_mrp': 200, 'mrp': 200})
    store = products()
    store.documents.append({'id': 'product2', 'floor_id': 'first-floor', 'price': 210, 'mrp': 225})
    review = asyncio.run(price_review(doc, store))
    assert [change['position'] for change in review['changes']] == [0, 1]
    assert [line['unit_price'] for line in apply_price_choice(doc, review, 'latest', review['token'])] == [110, 210]
    assert [line['unit_price'] for line in doc['items']] == [90, 190]


@pytest.mark.parametrize('changes', [{'price_status': 'unspecified', 'price': 0},
    {'price_unknown': True, 'price': 0}, {'price_status': 'unknown', 'price': 0},
    {'price': float('nan')}, {'price': float('inf')}, {'price': None}, {'mrp': float('inf')}])
def test_unspecified_or_invalid_catalog_prices_cannot_replace_offers(changes):
    store = products()
    store.documents[0].update(changes)
    assert asyncio.run(price_review(draft(), store)) == {'changes': [], 'token': None}


def test_snapshot_catalog_price_matches_preserve_negotiated_offer_without_prompt():
    doc = draft()
    doc['items'][0]['unit_price'] = 75
    store = products()
    store.documents[0].update(price=90, mrp=100)
    assert asyncio.run(price_review(doc, store))['changes'] == []


def test_review_token_invalidates_when_quotation_rows_change():
    doc = draft()
    original = asyncio.run(price_review(doc, products()))
    doc['items'][0]['unit_price'] = 80
    updated = asyncio.run(price_review(doc, products()))
    assert updated['token'] != original['token']
    with pytest.raises(HTTPException):
        apply_price_choice(doc, updated, 'latest', original['token'])

def test_tile_per_sqft_changes_recalculate_boxes_but_piece_rates_stay_per_piece():
    doc = draft(); doc['doc_type'] = 'tiles_quotation'
    doc['items'][0].update({'quantity_unit': 'Box', 'box_sqft': 16, 'unit_price': 1440, 'rate_sqft': 90})
    review = asyncio.run(price_review(doc, products()))
    updated = apply_price_choice(doc, review, 'latest', review['token'])[0]
    assert updated['unit_price'] == 1760
    assert updated['offer_rate'] == updated['rate_sqft'] == 110
    doc['items'][0]['quantity_unit'] = 'Pieces'
    review = asyncio.run(price_review(doc, products()))
    assert apply_price_choice(doc, review, 'latest', review['token'])[0]['unit_price'] == 110
