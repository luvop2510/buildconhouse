import asyncio
from types import SimpleNamespace
from models import UserPublic
from routes import customer_routes
from services.referrer_identity import acquired_counts, legacy_referrer_name, referrer_code, referrer_label


def test_identity_preserves_complete_id_and_legacy_name_case():
    assert referrer_code('a1-b2', 'architect') == 'ARC-A1-B2'
    assert referrer_code('a1-b2', 'interior_designer') == 'INT-A1-B2'
    assert referrer_label({'referrer_id': 'a1-b2', 'referrer_type': 'architect', 'architect_interior_designer': 'NTS'}) == 'NTS · ARC-A1-B2'
    assert legacy_referrer_name({'reference_source': 'Instagram'}) is None


def test_acquisition_identity_lookup_is_floor_scoped_and_not_top_100():
    seen = []
    class Cursor:
        async def to_list(self, limit):
            assert limit == 2
            return [{'id': 'outside-top-100', 'customers_acquired': 2}]
    class Collection:
        def aggregate(self, pipeline):
            seen.extend(pipeline)
            return Cursor()
    result = asyncio.run(acquired_counts({'customers': Collection()}, ['outside-top-100', 'second'], ['ground-floor']))
    assert result == {'outside-top-100': 2}
    matches = [seen[0]['$match']] + [stage['$unionWith']['pipeline'][0]['$match'] for stage in seen if '$unionWith' in stage]
    assert len(matches) == 6
    for match in matches:
        assert match['floor_id'] == {'$in': ['ground-floor']}
        assert match['referrer_id'] == {'$in': ['outside-top-100', 'second']}
    assert not any('$limit' in stage for stage in seen)


def test_customer_recovers_legacy_architect_name_from_own_floor(monkeypatch):
    async def scoped(*_args, **_kwargs):
        return {'id': 'customer-1', 'name': 'Customer', 'floor_id': 'first-floor'}
    class Leads:
        async def find_one(self, selector, projection, **_kwargs):
            assert selector['customer_id'] == 'customer-1'
            assert selector['floor_id'] == 'first-floor'
            assert selector['is_deleted'] == {'$ne': True}
            return {'architect_interior_designer': 'NTS'}
    monkeypatch.setattr(customer_routes, 'get_floor_scoped_or_404', scoped)
    monkeypatch.setattr(customer_routes, 'db', SimpleNamespace(customers=None, followups=Leads(), walkins=Leads()))
    user = UserPublic(id='u', email='u@example.com', full_name='Sales', role='sales', floor_ids=['first-floor'], active_floor_id='first-floor')
    assert asyncio.run(customer_routes.get_customer('customer-1', user=user)).referrer_name == 'NTS'


def test_customer_preserves_customer_legacy_name(monkeypatch):
    async def scoped(*_args, **_kwargs):
        return {'id': 'customer-1', 'name': 'Customer', 'floor_id': 'first-floor', 'architect_name': 'NTS'}
    monkeypatch.setattr(customer_routes, 'get_floor_scoped_or_404', scoped)
    monkeypatch.setattr(customer_routes, 'db', SimpleNamespace(customers=None))
    user = UserPublic(id='u', email='u@example.com', full_name='Sales', role='sales', floor_ids=['first-floor'], active_floor_id='first-floor')
    assert asyncio.run(customer_routes.get_customer('customer-1', user=user)).referrer_name == 'NTS'


def test_all_pdf_formats_include_reference_name_and_stable_identity():
    from io import BytesIO
    from pypdf import PdfReader
    from pdf_generator import build_quotation_pdf
    from pdf_tiles import build_tiles_quotation_pdf, build_tiles_selection_pdf
    from services.furniture_quotations import build_pdf
    referral = {'referrer_id': '4d2a6042-78a7-453b-a7be-97d60ed4571d', 'referrer_name': 'NTS', 'referrer_type': 'architect'}
    quote = {**referral, 'id': 'q', 'customer_name': 'Reference contract', 'items': [], 'subtotal': 0, 'grand_total': 0}
    furniture = {**quote, 'charges': [], 'deposits': [], 'total_payable_rmb': '0', 'total_received_rmb': '0', 'balance_rmb': '0'}
    documents = [build_quotation_pdf(quote, {'name': 'Reference contract'}), build_tiles_quotation_pdf(quote, {'name': 'Reference contract'}), build_tiles_selection_pdf(quote, {'name': 'Reference contract'}), build_pdf(furniture)[0]]
    for data in documents:
        text = ''.join(page.extract_text() or '' for page in PdfReader(BytesIO(data)).pages).replace('\n', '')
        assert 'NTS' in text
        assert 'ARC-4D2A6042-78A7-453B-A7BE-97D60ED4571D' in ''.join(text.split())


def test_addressed_reference_preserves_accessible_floor_scope_and_shared_reuse():
    import pytest
    from fastapi import HTTPException
    from services.referrer_identity import resolve_referrer
    class Directory:
        async def find_one(self, query, projection):
            assert query == {'id': 'reference'}
            return self.document
    directory = Directory()
    database = SimpleNamespace(referrers=directory)
    directory.document = {'id': 'reference', 'floor_id': 'first-floor', 'name': 'Architect'}
    owner = UserPublic(id='owner', full_name='Owner', role='owner', active_floor_id='ground-floor')
    assert asyncio.run(resolve_referrer(database, 'reference', owner))['name'] == 'Architect'
    worker = UserPublic(id='worker', full_name='Worker', role='sales', floor_ids=['first-floor', 'ground-floor'], active_floor_id='ground-floor')
    assert asyncio.run(resolve_referrer(database, 'reference', worker))['floor_id'] == 'first-floor'
    worker.floor_ids = ['ground-floor']
    with pytest.raises(HTTPException) as hidden:
        asyncio.run(resolve_referrer(database, 'reference', worker))
    assert hidden.value.status_code == 404
    directory.document['shared_across_floors'] = True
    assert asyncio.run(resolve_referrer(database, 'reference', worker))['id'] == 'reference'
    worker.floor_ids = []
    with pytest.raises(HTTPException) as no_access:
        asyncio.run(resolve_referrer(database, 'reference', worker))
    assert no_access.value.status_code == 404
    directory.document.pop('floor_id')
    with pytest.raises(HTTPException) as no_floor:
        asyncio.run(resolve_referrer(database, 'reference', owner))
    assert no_floor.value.status_code == 404
