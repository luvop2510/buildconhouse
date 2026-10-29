"""Currency-specific comparisons and exports match the exact visible scope."""
import asyncio
from datetime import datetime, timezone

from services.analytics import unified as sales
from services.analytics import unified_profiles as profiles
from services.analytics.unified_exports import report_sections

NOW = datetime(2026, 10, 29, tzinfo=timezone.utc)


def furniture(identity, amount, date):
    return sales.normalize('furniture', {'id': identity, 'floor_id': 'third-floor', 'customer_id': 'customer',
        'status': 'final', 'total_payable_rmb': str(amount), 'total_received_rmb': '0', 'balance_rmb': str(amount),
        'finalized_at': date}, {}, {}, [])


def test_furniture_trend_and_change_use_rnb_without_inr_comparison():
    rows = [furniture('prior', 100, '2026-10-01T10:00:00+00:00'), furniture('current', 250, '2026-10-02T10:00:00+00:00')]
    query = sales.Query(floor_id='third-floor', preset='custom', date_from='2026-10-02', date_to='2026-10-02', granularity='day')
    report = sales.dashboard(rows, query, ['third-floor'], NOW)
    assert report['currencies'] == ['RNB']
    assert report['kpis']['sales_rnb'] == 250 and report['kpis']['change_pct_rnb'] == 150
    assert report['kpis']['sales'] == 0 and report['kpis']['change_pct'] is None
    assert report['trend'][0]['previous_sales_rnb'] == 100 and report['trend'][0]['sales_rnb'] == 250


def test_prior_payment_buckets_use_each_receipt_date_not_first_payment_date():
    payments = [{'id': f'p{day}', 'amount': day * 100, 'paid_at': f'2026-10-0{day}T10:00:00+00:00'} for day in range(1, 5)]
    row = sales.normalize('catalog', {'id': 'order', 'floor_id': 'ground-floor', 'customer_id': 'customer', 'status': 'ordered',
        'ordered_at': '2026-10-01T10:00:00+00:00', 'grand_total': 1000}, {}, {}, payments)
    query = sales.Query(floor_id='ground-floor', preset='custom', date_from='2026-10-03', date_to='2026-10-04', date_basis='payment', granularity='day')
    report = sales.dashboard([row], query, ['ground-floor'], NOW)
    assert [point['sales'] for point in report['trend']] == [300, 400]
    assert [point['previous_sales'] for point in report['trend']] == [100, 200]
    assert report['kpis']['sales'] == 700
    assert report['currencies'] == ['INR']
    assert not any('RNB' in note for note in report['coverage']['notes'])


def test_furniture_directory_sorts_by_its_own_sales_and_aov():
    rows = [{'id': 'first', 'sales': 0, 'sales_rnb': 40, 'average_order_value': None, 'average_order_value_rnb': 40},
            {'id': 'last', 'sales': 0, 'sales_rnb': 20, 'average_order_value': None, 'average_order_value_rnb': 10}]
    assert sales.sorted_rows(rows, 'sales_asc', 'RNB')[0]['id'] == 'last'
    assert sales.sorted_rows(rows, 'aov_desc', 'RNB')[0]['id'] == 'first'


def test_profile_attributes_use_selected_currency_only(monkeypatch):
    async def identity(*args, **kwargs): return {'id': 'customer', 'name': 'Customer', 'attributes': []}
    async def history(*args, **kwargs): return {'quotations': [], 'projects': [], 'activity': []}
    monkeypatch.setattr(profiles, 'identity_for', identity)
    monkeypatch.setattr(profiles, 'profile_history', history)
    for floor, expected, excluded in [('ground-floor', 'INR', 'RNB'), ('third-floor', 'RNB', 'INR'), ('all', 'INR', 'RNB')]:
        rows = [furniture('one', 25, '2026-10-01T10:00:00+00:00')] if floor == 'third-floor' else []
        report = asyncio.run(profiles.profile(None, rows, sales.Query(floor_id=floor, preset='all'), None, 'customers', 'customer'))
        labels = [attribute['label'] for attribute in report['identity']['attributes']]
        assert f'Lifetime confirmed sales ({expected})' in labels
        assert f'Current outstanding balance ({expected})' in labels
        assert not any(excluded in label for label in labels)


def test_export_aggregate_columns_follow_floor_and_overall_retains_furniture_section():
    report = {'filters': {'floor_id': 'ground-floor'}, 'kpis': {'sales': 100, 'sales_rnb': 0, 'orders': 1},
              'trend': [{'label': 'day', 'sales': 100, 'sales_rnb': 0, 'previous_sales': 50, 'previous_sales_rnb': 0}]}
    sections = dict(report_sections(report))
    assert all('rnb' not in row['metric'] for row in sections['Summary'])
    assert not any(key.endswith('_rnb') for row in sections['Trend'] for key in row)
    report['filters']['floor_id'] = 'third-floor'
    sections = dict(report_sections(report))
    assert [row['metric'] for row in sections['Summary']] == ['sales rnb', 'orders']
    assert set(sections['Trend'][0]) == {'label', 'sales_rnb', 'previous_sales_rnb'}
    report['filters']['floor_id'] = 'all'
    report['floors'] = [{'floor_id': 'third-floor', 'currency': 'RNB', 'sales': 25}]
    report['kpis']['sales_rnb'] = 25
    sections = dict(report_sections(report, [{'id': 'furniture-order', 'currency': 'RNB', 'sales': 25}]))
    assert sections['Furniture ledger'] == [{'metric': 'sales rnb', 'value': 25}]
    assert sections['Floors'][0]['sales'] == sections['Source Details'][0]['sales'] == 25


def test_currency_supporting_records_and_exports_match_selected_measure():
    from dataclasses import replace
    catalog = sales.normalize('catalog', {'id': 'inr-order', 'floor_id': 'ground-floor', 'customer_id': 'customer',
        'status': 'ordered', 'ordered_at': '2026-10-01T10:00:00+00:00', 'grand_total': 100}, {}, {}, [])
    rows = [catalog, furniture('rnb-order', 25, '2026-10-01T10:00:00+00:00')]
    for currency, identity, amount in [('INR', 'inr-order', 100), ('RNB', 'rnb-order', 25)]:
        query = sales.Query(currency=currency, preset='all')
        selected = sales.select_period(rows, query, sales.period_for(query, NOW))
        assert [row['id'] for row in selected] == [identity]
        assert selected[0]['sales'] == amount
        assert query.public()['currency'] == currency
        report = sales.dashboard(rows, query, None, NOW)
        assert report['kpis']['orders'] == 1 and report['currencies'] == [currency]
        key = 'orders_rnb' if currency == 'RNB' else 'orders_inr'
        assert sum(point[key] for point in report['trend']) == 1
    # A currency query only narrows the already floor-authorized model.
    query = sales.Query(floor_id='ground-floor', currency='RNB', preset='all')
    assert sales.select_period([catalog], query, sales.period_for(query, NOW)) == []
