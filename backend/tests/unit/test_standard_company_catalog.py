import pytest
from catalog_pipeline.adapters import get_adapter
from catalog_pipeline.adapters.standard import StandardAdapter
from catalog_pipeline.parse_worker import extract_document

def test_standard_company_csv_is_deterministic_and_keeps_sku_leading_zeroes():
    adapter = get_adapter('Acme Furniture')
    assert isinstance(adapter, StandardAdapter)
    rows, report = adapter.extract(b'sku,name,category,mrp,dealer_price\n00123,Chair,Furniture,100,80\n', 'company.csv')
    assert rows[0].sku == '00123'
    assert rows[0].mrp == 100
    assert rows[0].dealer_price == 80
    assert rows[0].images == []
    assert 'no AI tokens' in report.warnings[0]
    result = extract_document('Acme Furniture', 'company.csv', b'sku,name,category,mrp\n00123,Chair,Furniture,100\n')
    assert result['rows'][0]['sku'] == '00123'

def test_standard_company_requires_explicit_headers_and_never_guesses():
    with pytest.raises(ValueError, match='requires'):
        StandardAdapter('Acme').extract(b'article,price\nA,30\n', 'company.csv')

def test_standard_company_supports_xlsx():
    import io
    import openpyxl
    workbook = openpyxl.Workbook()
    workbook.active.append(['sku', 'name', 'category', 'mrp'])
    workbook.active.append(['007', 'Desk', 'Furniture', 150])
    output = io.BytesIO(); workbook.save(output)
    rows, _ = StandardAdapter('Acme').extract(output.getvalue(), 'company.xlsx')
    assert rows[0].sku == '007'
    assert rows[0].mrp == 150
