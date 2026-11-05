import assert from 'node:assert/strict';
import test from 'node:test';
import { clearsManualTileTotal, tileLineTotal, tileRateWithoutCoverage } from '../src/components/tiles/tilePriceEdits.ts';

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
