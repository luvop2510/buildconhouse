import assert from 'node:assert/strict';
import test from 'node:test';
import { tileQuantityUnit } from '../src/components/tiles/tileQuantityUnit.ts';

test('catalog piece pricing maps to pieces, including imported pcs', () => {
  for (const unit of ['pcs', 'per piece', 'Piece', 'per tile', 'per-pcs']) assert.equal(tileQuantityUnit(unit), 'Pieces', unit);
});

test('square-foot pricing maps to boxes; missing units default to pieces', () => {
  for (const unit of ['sqft', 'per square foot']) assert.equal(tileQuantityUnit(unit), 'Box', String(unit));
  for (const unit of [null, '']) assert.equal(tileQuantityUnit(unit), 'Pieces', String(unit));
});

test('price labels preserve the supplier unit', async () => {
  const { tilePriceUnit } = await import('../src/components/tiles/tileQuantityUnit.ts');
  assert.equal(tilePriceUnit('pcs'), 'per piece');
  assert.equal(tilePriceUnit('sqft'), 'per sq.ft');
  assert.equal(tilePriceUnit('per box'), 'per box');
  assert.equal(tilePriceUnit(null), 'per piece');
});

test('catalog source supports rate_unit while preserving explicit price_unit', async () => {
  const { tileSourcePriceUnit } = await import('../src/components/tiles/tileQuantityUnit.ts');
  assert.equal(tileQuantityUnit(tileSourcePriceUnit({ rate_unit: 'pcs' })), 'Pieces');
  assert.equal(tileQuantityUnit(tileSourcePriceUnit({ price_unit: 'sqft', rate_unit: 'pcs' })), 'Box');
});

test('legacy branded square-foot imports keep their rate and boxed quantity basis', async () => {
  const { tileSourcePriceUnit, tilePriceUnit } = await import('../src/components/tiles/tileQuantityUnit.ts');
  for (const specs of [{ rate_per_sqft: 125 }, { rate_per_sqft: 0 }, { sqft_per_box: '15.5' }, { sqft_per_box: null }]) {
    const unit = tileSourcePriceUnit(specs);
    assert.equal(tilePriceUnit(unit), 'per sq.ft', JSON.stringify(specs));
    assert.equal(tileQuantityUnit(unit), 'Box', JSON.stringify(specs));
  }
});

test('explicit piece pricing overrides legacy square-foot metadata', async () => {
  const { tileSourcePriceUnit } = await import('../src/components/tiles/tileQuantityUnit.ts');
  for (const specs of [{ price_unit: 'pcs', rate_per_sqft: 125 }, { rate_unit: 'pcs', sqft_per_box: '15.5' }]) {
    assert.equal(tileQuantityUnit(tileSourcePriceUnit(specs)), 'Pieces');
  }
  assert.equal(tileQuantityUnit(tileSourcePriceUnit({})), 'Pieces');
});
