from decimal import Decimal

import pytest

from services.money import format_indian_money


@pytest.mark.parametrize('value,expected', [(0,'0.00'), (1234.5,'1,234.50'), (123456.78,'1,23,456.78'),
    (12345678.9,'1,23,45,678.90'), (-123456.78,'-1,23,456.78'), (Decimal('1234567890.12'),'1,23,45,67,890.12'),
    (None,'0.00'), ('invalid','0.00'), (float('inf'),'0.00'), (float('nan'),'0.00')])
def test_indian_money_groups_lakhs_and_crores(value, expected):
    assert format_indian_money(value) == expected


def test_rounded_whole_amount_keeps_grouping_and_sign():
    assert format_indian_money(99999.99, decimals=0) == '1,00,000'
    assert format_indian_money(-123456.78, decimals=0) == '-1,23,457'


def test_followup_and_payment_badges_never_fall_back_to_western_thousands():
    from services.followup_engine import money_short
    from routes.payment_routes import _short_amount
    assert money_short(74300) == '74,300'
    assert money_short(12345678) == '1.2 Cr'
    assert _short_amount(74300) == '₹74,300'
