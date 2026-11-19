import assert from 'node:assert/strict';
import test from 'node:test';
import { clearsManualTileTotal, savedTileUnitRate, tileLineTotal, tileQuotationBoxRate, tileRateWithoutCoverage } from '../src/components/tiles/tilePriceEdits.ts';

test('price and quantity changes invalidate a manually entered total', () => {
  for (const key of ['offerRate', 'rateSqft', 'rateBox', 'boxSqft', 'totalBox', 'quantityUnit']) {
    assert.equal(clearsManualTileTotal({ [key]: '20' }), true, key);
  }
  assert.equal(clearsManualTileTotal({ area: 'Kitchen' }), false);
  assert.equal(clearsManualTileTotal({ total: '100' }), false);
});

test('clearing an offer before typing retains legacy conversion', () => {
  const original = { offerRate: '100', rateSqft: '100', rateBox: '1000', boxSqft: '', totalBox: '2', total: '', totalEdited: false, quantityUnit: 'Box', priceBasis: 'sqft', inferredCoverage: 10 };
  const cleared = { ...original, offerRate: '', rateBox: tileRateWithoutCoverage(original, '') };
  const typed = { ...cleared, offerRate: '120', rateBox: tileRateWithoutCoverage(cleared, '120') };
  assert.equal(tileLineTotal(typed), 2400);
});

test('offer edits recalculate totals for boxed, box-priced and piece products', () => {
  const row = { offerRate: '100', rateSqft: '100', rateBox: '1000', boxSqft: '10', totalBox: '2', total: '9000', totalEdited: true, quantityUnit: 'Box', priceBasis: 'sqft' };
  assert.equal(tileLineTotal(row), 9000);
  const patch = { offerRate: '120' };
  const edited = { ...row, ...patch, totalEdited: !clearsManualTileTotal(patch) };
  assert.equal(tileLineTotal(edited), 2400);
  assert.equal(tileLineTotal({ ...edited, boxSqft: '', rateBox: tileRateWithoutCoverage(row, '120') }), 2400);
  assert.equal(tileLineTotal({ ...edited, priceBasis: 'box', rateBox: '120' }), 240);
  assert.equal(tileLineTotal({ ...edited, quantityUnit: 'Pieces', priceBasis: 'piece', rateBox: '120' }), 240);
});

test('quotation box rate uses its offer and coverage unless a saved price is present', () => {
  const row = { offerRate: '120', rateSqft: '150', rateBox: '', boxSqft: '16', totalBox: '5', total: '', totalEdited: false, quantityUnit: 'Box', priceBasis: 'sqft' };
  assert.equal(tileQuotationBoxRate(row), 1920);
  assert.equal(tileLineTotal(row), 9600);
  assert.equal(tileQuotationBoxRate({ ...row, boxSqft: '8.5' }), 1020);
  assert.equal(tileQuotationBoxRate({ ...row, quantityUnit: 'Pieces' }), null);
  assert.equal(tileQuotationBoxRate({ ...row, priceBasis: 'box', rateBox: '900' }), 900);
  assert.equal(tileQuotationBoxRate({ ...row, savedUnitRate: savedTileUnitRate({ unit_price: 0, rate_box: 900 }) }), 0);
  const saved = { ...row, savedUnitRate: savedTileUnitRate({ rate_box: 1700 }), savedLineTotal: 8000 };
  assert.equal(tileQuotationBoxRate(saved), 1700);
  assert.equal(tileLineTotal(saved), 8000);
});
